// 编排简化第 3 步（docs/orchestration-simplify-design.md 第 4.4、5.2、9.4、11 节、第 13 节验收）：
// - 重放 441：节点上的前任在 worktree 里跑了几步、留下没提交的文件后失败（或还在跑），hub worker start --node 一条命令换人：
//   旧 Worker 自动收工，新 Worker 第一条消息带前任的原因、汇报、最后的文字、最后几步操作、原始记录路径，接着用前任的目录和分支，
//   可写范围放行这个目录，旧会话结束前新 Worker 不开工；
// - 目录与记录保护：同一个 worktree 后任还在用、或所属任务图还 active 时，自动清理和 30 天记录清理都跳过；
// - 超时计时落盘：守护进程重启后 --max-time / hub worker max-time 到点照常叫醒项目经理，已提醒过的不再提醒。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { systemEventOf, workerEventOf } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId, WorkerId, WorkerRecord } from "../../shared/domain.ts";
import type { HubArgs, HubCommand } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { HubCallContext, WorkspaceProbe } from "../../shared/ledger.ts";
import {
  DEFAULT_WORKER_MAX_TIME_MS,
  TAKEOVER_PREDECESSORS_MAX,
  TAKEOVER_REPORTS_MAX_CHARS,
  TAKEOVER_STEPS_MAX,
  TAKEOVER_TAIL_TEXT_MAX_CHARS,
  WORKER_RETENTION_MS,
  WORKTREE_RETENTION_MS,
} from "../../shared/limits.ts";
import { workerWorktreePath } from "../../shared/paths.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { scopeAllowsWrite, workerWriteScope } from "../../shared/write-scope.ts";
import { buildLaunchPrompt } from "../prompt.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

let db: Db;
let root: string;
let dataHome: string;
let worktreesDir: string;
let now: number;
let ledger: SqliteLedger;
let enqueued: AnyActionRow[];
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let main: string;
let projectId: number;

const TRANSCRIPT = "/fake/vendor/transcript.jsonl";

function options(extra: Partial<LedgerOptions> = {}): LedgerOptions {
  return {
    now: () => now,
    initialSeq: 9_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    osSandboxed: () => true,
    findTranscript: () => TRANSCRIPT,
    ...extra,
  };
}

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-takeover-")));
  dataHome = join(root, ".agent-hub");
  worktreesDir = join(dataHome, "worktrees");
  mkdirSync(join(root, "work", "foo"), { recursive: true });
  main = realpathSync.native(join(root, "work", "foo"));
  now = 1_000;
  ledger = createLedger(db, options());
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", defaultModel: "claude-sonnet-5-5" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  projectId = ledger.hubCall(lin.sessionId, "project.create", { folder: main }).data.project.id;
  enqueued = [];
  ledger.onActionEnqueued((x) => enqueued.push(x));
});

afterEach(() => {
  vi.useRealTimers();
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function hub<C extends HubCommand>(command: C, args: HubArgs<C>, context: HubCallContext = {}) {
  return ledger.hubCall(lin.sessionId, command, args, context);
}

/** 主文件夹是有提交的 git 仓库（agent 接口探好的）。 */
const repoProbe: WorkspaceProbe = { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false };
const start = (args: HubArgs<"worker.start">) => hub("worker.start", args, { workspace: repoProbe }).data.worker;

function messagesIn(conversationId: ConversationId): Message[] {
  return db
    .all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId)
    .map((r) => ledger.getMessage(r.id)!);
}
const firstMessage = (w: WorkerRecord) => messagesIn(w.workerConversationId)[0]!;
const sessionIdOf = (workerId: WorkerId): SessionId =>
  db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!.id;
const workerRow = (id: WorkerId) => db.get<{ status: string; worktree_path: string | null }>("SELECT status, worktree_path FROM workers WHERE id = ?", id)!;
const nodeOf = (graphId: number, key: string) =>
  hub("graph.show", { graphId }).data.graph.nodes.find((n) => n.key === key)!;

const report = (status: string, summary: string, body = "改了一些") =>
  `${body}\n\n${REPORT_START}\n状态: ${status}\n摘要: ${summary}\n提交: 无\n测试: 跑了一半\n问题: 无\n${REPORT_END}`;

function createGraph() {
  return hub("graph.create", {
    title: "修三家压缩",
    specJson: JSON.stringify({ nodes: [{ key: "s1", title: "实测与实现" }, { key: "s2", title: "审查", deps: ["s1"] }] }),
  }).data.graph;
}

/** worktree 建好（假 git）：登记起点提交，目录真的建出来。 */
function worktreeReady(w: WorkerRecord, base = "base-1"): string {
  ledger.onWorktreeCreated(w.id, base);
  mkdirSync(w.worktreePath!, { recursive: true });
  return w.worktreePath!;
}

let uuid = 0;
/** 一轮：送达、处理中、几步工具调用（带结果）、一段文字；end 是 null 就停在这一轮中间（还在跑）。 */
function turn(w: WorkerRecord, messageId: MessageId, tools: string[], text: string | null, end: "ok" | "failed" | null) {
  const sid = sessionIdOf(w.id);
  ledger.applyDriverEvent(sid, { type: "message.delivered", messageIds: [messageId], at: now });
  ledger.applyDriverEvent(sid, { type: "message.processing", messageIds: [messageId], at: now });
  for (const command of tools) {
    const id = `t${++uuid}`;
    ledger.applyDriverEvent(sid, { type: "agent.tool", uuid: `u${uuid}`, toolUseId: id, name: "Bash", input: { command }, at: now });
    now += 2_000;
    ledger.applyDriverEvent(sid, { type: "agent.tool_result", toolUseIds: [id], at: now });
  }
  if (text !== null) ledger.applyDriverEvent(sid, { type: "agent.text", uuid: `x${++uuid}`, text, at: now });
  if (end === "ok") ledger.applyDriverEvent(sid, { type: "turn.ended", ok: true, interrupted: false, messageIds: [messageId], durationMs: 10, at: now });
  if (end === "failed") {
    ledger.applyDriverEvent(sid, {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      messageIds: [messageId],
      durationMs: 10,
      at: now,
      error: { subtype: "error_during_execution", message: "网络断了" },
    });
  }
}

describe("换人接手同一步：重放 441", () => {
  it("前任跑了几步、留下没提交的文件后失败：一条 --node 命令换人，旧的收工、新的带上前任记录、接着用前任的目录和分支、沙箱放行这个目录、旧会话结束前不开工", () => {
    const graph = createGraph();
    const w1 = start({ title: "实测压缩", task: "原始任务：实测三家压缩后提示词还在不在", node: "s1" });
    const dir = worktreeReady(w1);
    writeFileSync(join(dir, "experiment.md"), "48 分钟的实测记录");
    turn(w1, firstMessage(w1).id, ["pnpm test compaction"], report("有问题", "断网了一次，测到一半"), "ok");
    const again = hub("worker.send", { workerId: w1.id, text: "网好了，接着测" }).data.messageId;
    turn(w1, again, ["claude -p 测第二轮", "codex exec 测第三轮"], "测到第 48 分钟：claude 压缩后提示词还在，codex 丢了。", "failed");
    // 进程还在（还没退）
    db.run("UPDATE agent_sessions SET pid = 4242 WHERE id = ?", sessionIdOf(w1.id));
    expect(nodeOf(graph.id, "s1")).toMatchObject({ status: "waiting", waitingFor: "pm", activeWorkerId: w1.id });

    enqueued = [];
    // 不给标题、不给正文
    const result = hub("worker.start", { node: "s1" }, { workspace: repoProbe });
    const w2 = result.data.worker;

    // ① 旧 Worker 已自动收工，节点换成新的在干，不标完成，下游不动
    expect(workerRow(w1.id).status).toBe("ended");
    expect(nodeOf(graph.id, "s1")).toMatchObject({ status: "running", activeWorkerId: w2.id, workerIds: [w1.id, w2.id] });
    expect(nodeOf(graph.id, "s2").status).toBe("pending");
    expect(result.text).toContain(`已先把节点上还挂着的 Worker #${w1.id} 收工`);
    expect(enqueued).toContainEqual(expect.objectContaining({ type: "session.end", params: expect.objectContaining({ sessionId: sessionIdOf(w1.id) }) }));

    // ② 第一条消息：前任的原因、汇报、最后的文字、最后几步操作、原始记录路径
    const first = firstMessage(w2).text;
    expect(first.startsWith(`【系统 · 接手】任务图 #${graph.id}「修三家压缩」第 1/2 步「实测与实现」。`)).toBe(true);
    expect(first).toContain(`## 前任 Worker #${w1.id}（Claude Code）停下的原因`);
    expect(first).toContain("最后一轮没做完：error_during_execution: 网络断了");
    expect(first).toContain("换人时它还开着");
    expect(first).toContain("## 它的汇报（从新到旧）");
    expect(first).toContain("摘要: 断网了一次，测到一半");
    expect(first).toContain("## 它最后说的话\n\n测到第 48 分钟：claude 压缩后提示词还在，codex 丢了。");
    expect(first).toMatch(/## 它最后 \d+ 步操作/);
    expect(first).toContain("codex exec 测第三轮");
    expect(first).toContain(`原始记录：${TRANSCRIPT}`);
    expect(first).toContain(`你就在前任 Worker #${w1.id} 的工作目录 ${dir} 和分支 ${w1.branch} 上`);
    expect(first).not.toContain("## 项目经理的补充");
    // 原始任务说明不丢：标题、任务沿用第一个前任的，进系统提示词的“你的任务”
    expect(w2).toMatchObject({ title: "实测压缩", task: "原始任务：实测三家压缩后提示词还在不在" });

    // ③ 工作目录和分支就是前任那个，前任没提交的文件还在；不建 worktree、不跑准备命令
    expect(w2).toMatchObject({ workspace: "worktree", worktreePath: dir, branch: w1.branch, baseCommit: "base-1" });
    expect(readFileSync(join(dir, "experiment.md"), "utf8")).toBe("48 分钟的实测记录");
    expect(enqueued.filter((a) => a.type === "worktree.create")).toEqual([]);
    expect(enqueued.filter((a) => a.type === "session.start")).toEqual([]);
    const w2Session = sessionIdOf(w2.id);
    expect(enqueued).toContainEqual(
      expect.objectContaining({ type: "session.send", params: { sessionId: w2Session, messageId: firstMessage(w2).id, source: "user" } }),
    );
    // 沙箱：可写范围按会话的工作目录放行前任的目录（目录名是前任的编号），自己编号的目录不在范围里
    const cwd = db.get<{ cwd: string }>("SELECT cwd FROM agent_sessions WHERE id = ?", w2Session)!.cwd;
    expect(cwd).toBe(dir);
    const scope = workerWriteScope({ role: "worker", dataDir: dataHome, cwd })!;
    expect(scope.writableDirs).toEqual([dir]);
    expect(scopeAllowsWrite(scope, join(dir, "src", "a.ts"))).toBe(true);
    expect(scopeAllowsWrite(scope, join(workerWorktreePath(worktreesDir, projectId, w2.id), "a.ts"))).toBe(false);
    // 提示词里写明是前任的目录
    const prompt = buildLaunchPrompt(ledger.getLaunchContext(w2Session), cwd);
    expect(prompt).toContain(`它是前任 Worker #${w1.id} 的工作目录和分支，你接着用`);
    expect(prompt).toContain("原始任务：实测三家压缩后提示词还在不在");

    // 旧会话还没结束（进程在）：新 Worker 的第一条先等；旧会话结束后才发
    expect(ledger.waitsForFirstTurn(w2Session, firstMessage(w2).id)).toBe(true);
    // 哪怕旧会话当时 pid 还是 NULL（例如正在 #spawn 启动前半段、session.end 还没把 status 标成 ended），也绝不提前放行双写
    db.run("UPDATE agent_sessions SET pid = NULL, status = 'idle' WHERE id = ?", sessionIdOf(w1.id));
    expect(ledger.waitsForFirstTurn(w2Session, firstMessage(w2).id)).toBe(true);
    // 反过来：归档等路径先把 status 标成了 ended，但旧进程 pid 还没退完，同样要等
    db.run("UPDATE agent_sessions SET pid = 4242, status = 'ended' WHERE id = ?", sessionIdOf(w1.id));
    expect(ledger.waitsForFirstTurn(w2Session, firstMessage(w2).id)).toBe(true);
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE id = ?", sessionIdOf(w1.id));
    expect(ledger.waitsForFirstTurn(w2Session, firstMessage(w2).id)).toBe(false);
  });

  it("前任还在跑准备命令（base_commit 还是 null）就换人：不复用未就绪目录，新开独立 worktree，旧人收工；经 graph done 放行后再打回重派也会把仍 open 的前任自动收工", () => {
    const graph = createGraph();
    const wPrep = start({ title: "准备阶段", task: "原始任务 P", node: "s1" });
    mkdirSync(wPrep.worktreePath!, { recursive: true });
    // base_commit 尚未登记（setup 仍在跑）
    const wNext = hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
    expect(workerRow(wPrep.id).status).toBe("ended");
    expect(wNext.worktreePath).toBe(workerWorktreePath(worktreesDir, projectId, wNext.id));
    expect(wNext.worktreePath).not.toBe(wPrep.worktreePath);

    // wNext 建成目录后汇报“有问题”，PM 先用 graph.done 放行（清空了 active_worker_id，但 wNext 自身仍 open），再重派 w3
    worktreeReady(wNext);
    turn(wNext, firstMessage(wNext).id, ["pnpm lint"], report("有问题", "卡在一半"), "ok");
    hub("graph.done", { nodeKey: "s1", graphId: graph.id });
    expect(nodeOf(graph.id, "s1")).toMatchObject({ status: "done", activeWorkerId: null });
    expect(workerRow(wNext.id).status).toBe("open");

    const w3 = hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
    // 仍 open 的前任 wNext 已被自动收工，等其 session 结束后 w3 即可顺利开工，不会永久卡在 waitsForFirstTurn
    expect(workerRow(wNext.id).status).toBe("ended");
    expect(w3.worktreePath).toBe(wNext.worktreePath);
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE id = ?", sessionIdOf(wNext.id));
    expect(ledger.waitsForFirstTurn(sessionIdOf(w3.id), firstMessage(w3).id)).toBe(false);
  });

  it("前任还在跑这一轮：直接 --node 换人会先打断并收工它；正文是项目经理的补充，任务说明 = 原始任务 + 补充", () => {
    createGraph();
    const w1 = start({ title: "实现", task: "原始任务 A", node: "s1" });
    worktreeReady(w1);
    turn(w1, firstMessage(w1).id, ["pnpm build"], null, null);
    const result = hub("worker.start", { node: "s1", task: "换一家，先跑 X" }, { workspace: repoProbe });
    const w2 = result.data.worker;
    expect(workerRow(w1.id).status).toBe("ended");
    expect(result.text).toContain("打断了它正在跑的那一轮");
    const first = firstMessage(w2).text;
    expect(first).toContain("换人时它还在跑这一轮，后台已打断它");
    expect(first).toContain("## 它的汇报（从新到旧）\n\n（没有汇报）");
    expect(first.endsWith("## 项目经理的补充\n\n换一家，先跑 X")).toBe(true);
    expect(w2.task).toBe("原始任务 A\n\n## 项目经理的补充（换人接手时）\n\n换一家，先跑 X");
    expect(w2.worktreePath).toBe(w1.worktreePath);
    // 打断的那一轮不再作为“没做完”汇报给项目经理（项目经理自己换的人）
    ledger.applyDriverEvent(sessionIdOf(w1.id), { type: "turn.ended", ok: false, interrupted: true, messageIds: [firstMessage(w1).id], durationMs: 1, at: now });
    const failed = messagesIn(lin.conversationId).filter((m) => workerEventOf(m)?.event === "turn_failed" && m.workerId === w1.id);
    expect(failed).toEqual([]);
  });

  it("显式 --no-worktree：不接手前任目录，在主文件夹干；前任目录已经没了：新建 worktree；第一次给没前任的节点派人仍要正文", () => {
    createGraph();
    expect(() => hub("worker.start", { node: "s1" }, { workspace: repoProbe })).toThrow(LedgerRequestError);
    const w1 = start({ title: "实现", task: "原始任务", node: "s1" });
    worktreeReady(w1);
    hub("worker.end", { workerId: w1.id, incomplete: true });

    const w2 = hub("worker.start", { node: "s1", noWorktree: true }).data.worker;
    expect(w2).toMatchObject({ workspace: "main", worktreePath: null });
    expect(firstMessage(w2).text).toContain("--no-worktree");
    hub("worker.end", { workerId: w2.id, incomplete: true });

    rmSync(w1.worktreePath!, { recursive: true, force: true });
    enqueued = [];
    const w3 = hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
    expect(w3.worktreePath).toBe(workerWorktreePath(worktreesDir, projectId, w3.id));
    expect(enqueued).toContainEqual(expect.objectContaining({ type: "worktree.create", params: { workerId: w3.id } }));
    expect(firstMessage(w3).text).toContain("前任没有还能接手的工作目录");
    expect(firstMessage(w3).text).toContain(w1.branch!);
    // 前任里只取最近的 TAKEOVER_PREDECESSORS_MAX 个；原始任务仍取第一个前任的
    expect(w3.task).toBe("原始任务");
  });

  it("上限：最多带最近 TAKEOVER_PREDECESSORS_MAX 个前任，汇报合计不超过 TAKEOVER_REPORTS_MAX_CHARS 字，最后的文字不超过 TAKEOVER_TAIL_TEXT_MAX_CHARS 字，每个最多 TAKEOVER_STEPS_MAX 步", () => {
    createGraph();
    const ids: WorkerId[] = [];
    const long = "长".repeat(5_000);
    for (let i = 0; i <= TAKEOVER_PREDECESSORS_MAX; i++) {
      const w = i === 0 ? start({ title: "实现", task: "原始任务", node: "s1" }) : hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
      ids.push(w.id);
      if (i === 0) worktreeReady(w);
      db.run("UPDATE agent_sessions SET status = 'ended' WHERE worker_id != ? AND role = 'worker'", w.id);
      const tools = Array.from({ length: TAKEOVER_STEPS_MAX + 5 }, (_, k) => `step-${i}-${k}`);
      turn(w, firstMessage(w).id, tools, report("有问题", `第 ${i} 个`, long), "ok");
      const more = hub("worker.send", { workerId: w.id, text: "接着做" }).data.messageId;
      turn(w, more, [], "尾".repeat(4_000), "failed");
    }
    const last = hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
    const first = firstMessage(last).text;
    const heads = [...first.matchAll(/## 前任 Worker #(\d+)/g)].map((m) => Number(m[1]));
    expect(heads).toEqual(ids.slice(-TAKEOVER_PREDECESSORS_MAX).reverse());
    // 操作步骤那几行（“时:分:秒 …”）里的摘要另有每行上限，不算进汇报、最后的文字
    const withoutSteps = first.split("\n").filter((l) => !/^\d\d:\d\d:\d\d /.test(l)).join("\n");
    expect([...withoutSteps.matchAll(/长/g)].length).toBeLessThanOrEqual(TAKEOVER_REPORTS_MAX_CHARS);
    expect([...withoutSteps.matchAll(/长/g)].length).toBeGreaterThan(TAKEOVER_REPORTS_MAX_CHARS - 100);
    expect([...withoutSteps.matchAll(/尾/g)].length).toBeLessThanOrEqual(TAKEOVER_TAIL_TEXT_MAX_CHARS);
    expect([...withoutSteps.matchAll(/尾/g)].length).toBeGreaterThan(TAKEOVER_TAIL_TEXT_MAX_CHARS - 100);
    expect(first).toContain("份汇报放不下了");
    for (const m of first.matchAll(/## 它最后 (\d+) 步操作/g)) expect(Number(m[1])).toBeLessThanOrEqual(TAKEOVER_STEPS_MAX);
    // 整条消息有上限（各项上限加起来），不会随前任数量和汇报长度无限变长
    expect([...first].length).toBeLessThan(TAKEOVER_REPORTS_MAX_CHARS + TAKEOVER_TAIL_TEXT_MAX_CHARS + TAKEOVER_PREDECESSORS_MAX * TAKEOVER_STEPS_MAX * 140 + 3_000);
  });

  it("单前任多份汇报与多段未汇报文字：连同段落分隔符在内总码点数严格不超过 8000 / 6000，多行失败原因收敛为单行", () => {
    createGraph();
    const w = start({ title: "多轮", task: "原始任务", node: "s1" });
    worktreeReady(w);
    for (let r = 0; r < 6; r++) {
      const msgId = r === 0 ? firstMessage(w).id : hub("worker.send", { workerId: w.id, text: `第 ${r} 次继续` }).data.messageId;
      turn(w, msgId, [], report("有问题", `第 ${r} 轮`, "报".repeat(2_000)), "ok");
    }
    const lastMsg = hub("worker.send", { workerId: w.id, text: "最后一次" }).data.messageId;
    const sid = sessionIdOf(w.id);
    ledger.applyDriverEvent(sid, { type: "message.delivered", messageIds: [lastMsg], at: now });
    ledger.applyDriverEvent(sid, { type: "message.processing", messageIds: [lastMsg], at: now });
    for (let p = 0; p < 10; p++) {
      ledger.applyDriverEvent(sid, { type: "agent.text", uuid: `multi-tail-${p}`, text: "段".repeat(1_000), at: now });
    }
    ledger.applyDriverEvent(sid, {
      type: "turn.ended",
      ok: false,
      interrupted: false,
      messageIds: [lastMsg],
      durationMs: 10,
      at: now,
      error: { subtype: "error_during_execution", message: `第一行报错\n第二行堆栈\n${"错".repeat(800)}` },
    });

    const next = hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
    const first = firstMessage(next).text;
    const reasonSec = first.split("## 它的汇报（从新到旧）")[0]!.split("停下的原因\n\n")[1]!.trim();
    expect(reasonSec.includes("\n")).toBe(false);

    const reportsSec = first
      .split("## 它的汇报（从新到旧）\n\n")[1]!
      .split("\n\n## 它最后说的话\n\n")[0]!
      .replace(/\n\n---\n\n（更早的 \d+ 份汇报放不下了.*$/, "");
    expect([...reportsSec].length).toBeLessThanOrEqual(TAKEOVER_REPORTS_MAX_CHARS);

    const tailSec = first.split("## 它最后说的话\n\n")[1]!.split("\n\n## 它最后 ")[0]!;
    expect([...tailSec].length).toBeLessThanOrEqual(TAKEOVER_TAIL_TEXT_MAX_CHARS);
  });
});

describe("清理保护：同一个目录后任还在用、或所属任务图还 active", () => {
  it("worktree 自动清理与 30 天记录清理都跳过；图结束、后任收工后才能清", () => {
    const graph = createGraph();
    const w1 = start({ title: "实现", task: "原始任务", node: "s1" });
    worktreeReady(w1);
    turn(w1, firstMessage(w1).id, ["pnpm test"], report("有问题", "卡住了"), "ok");
    const w2 = hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE worker_id = ?", w1.id);
    // 前任已收工，但后任还在用同一个目录
    expect(workerRow(w1.id).status).toBe("ended");
    expect(ledger.isWorkerCleanable(w1.id)).toBe(false);
    expect(ledger.listEndedWorktreeWorkers().map((c) => c.workerId)).toEqual([w1.id]);
    // 后任也收工了，但图还 active（随时可能再换人接着用）
    hub("worker.end", { workerId: w2.id, incomplete: true });
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE worker_id = ?", w2.id);
    expect(ledger.isWorkerCleanable(w1.id)).toBe(false);
    expect(ledger.isWorkerCleanable(w2.id)).toBe(false);
    // 30 天记录清理：图还 active 的前任不清，换人时记录一定在（动作都做完了，不是因为有没做完的动作才不清）
    db.run("UPDATE actions SET status = 'done' WHERE status IN ('pending', 'running')");
    const far = now + WORKER_RETENTION_MS + 1;
    expect(ledger.purgeExpiredWorkerConversations(far).purged).toEqual([]);
    expect(messagesIn(w1.workerConversationId).length).toBeGreaterThan(0);

    // 不在图上的已收工 Worker 照常清（对照）
    const solo = start({ title: "临时", task: "临时活", noWorktree: true });
    hub("worker.end", { workerId: solo.id });
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE worker_id = ?", solo.id);
    db.run("UPDATE actions SET status = 'done' WHERE status IN ('pending', 'running')");
    expect(ledger.purgeExpiredWorkerConversations(now + WORKER_RETENTION_MS + 1).purged).toEqual([solo.id]);

    // 图结束后都能清
    hub("graph.cancel", { graphId: graph.id });
    db.run("UPDATE actions SET status = 'done' WHERE status IN ('pending', 'running')");
    expect(ledger.isWorkerCleanable(w1.id)).toBe(true);
    expect(ledger.isWorkerCleanable(w2.id)).toBe(true);
    expect(ledger.purgeExpiredWorkerConversations(now + WORKER_RETENTION_MS + 1).purged.sort()).toEqual([w1.id, w2.id].sort());
  });

  it("不在图上：共用目录的另一个 Worker 还开着时不清（按目录判断，不只看自己）", () => {
    const w1 = start({ title: "实现", task: "原始任务" });
    worktreeReady(w1);
    hub("worker.end", { workerId: w1.id });
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE worker_id = ?", w1.id);
    expect(ledger.isWorkerCleanable(w1.id)).toBe(true);
    // 模拟同一个目录又被别的 Worker 用着（换人接手留下的共享）
    const w2 = start({ title: "另一个", task: "另一个活" });
    db.run("UPDATE workers SET worktree_path = ? WHERE id = ?", w1.worktreePath, w2.id);
    expect(ledger.isWorkerCleanable(w1.id)).toBe(false);
    expect(existsSync(w1.worktreePath!)).toBe(true);
  });

  it("共享目录的 3 天到期按最后一个用它的 Worker 算（前任 4 天前收工、后任刚收工时不提前误判到期），退出中的 pid 也挡住清理", () => {
    const graph = createGraph();
    const w1 = start({ title: "实现", task: "原始任务", node: "s1" });
    worktreeReady(w1);
    turn(w1, firstMessage(w1).id, ["pnpm test"], report("有问题", "卡住"), "ok");
    const w1EndedAt = now;
    hub("worker.end", { workerId: w1.id, incomplete: true });
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE worker_id = ?", w1.id);

    // 4 天后后任 w2 接手并在同一天收工，图取消结束
    now += WORKTREE_RETENTION_MS + 86_400_000;
    const w2 = hub("worker.start", { node: "s1" }, { workspace: repoProbe }).data.worker;
    const w2EndedAt = now + 60_000;
    now = w2EndedAt;
    hub("worker.end", { workerId: w2.id, incomplete: true });
    hub("graph.cancel", { graphId: graph.id });

    // 后任进程 pid 还没退完时不可清理
    db.run("UPDATE agent_sessions SET status = 'idle', pid = 9999 WHERE worker_id = ?", w2.id);
    expect(ledger.isWorkerCleanable(w1.id)).toBe(false);
    db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE worker_id = ?", w2.id);
    expect(ledger.isWorkerCleanable(w1.id)).toBe(true);

    // 候选按目录去重，且 endedAt 是后任 w2 的收工时刻（不是 4 天前 w1 的时刻）
    const candidates = ledger.listEndedWorktreeWorkers();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.endedAt).toBe(w2EndedAt);
    expect(candidates[0]!.endedAt).toBeGreaterThan(w1EndedAt + WORKTREE_RETENTION_MS);
  });
});

describe("单轮超时计时落盘：守护进程重启后照常提醒", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const wakes = () => messagesIn(lin.conversationId).filter((m) => systemEventOf(m)?.event === "worker.max_time_exceeded");
  const restart = () => {
    ledger.close();
    ledger = createLedger(db, options());
    ledger.onActionEnqueued((x) => enqueued.push(x));
    return ledger.recoverAfterRestart();
  };
  const advance = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };
  const timeoutRow = (workerId: WorkerId) =>
    db.get<{ max_time_ms: number; deadline_at: number; notified: number }>("SELECT max_time_ms, deadline_at, notified FROM worker_turn_timeouts WHERE worker_id = ?", workerId);

  it("--max-time：跑到一半守护进程重启，到点照样叫醒项目经理一次；重启前后都不重复", () => {
    const w = start({ title: "修 X", task: "修", noWorktree: true, maxTimeMs: 20 * 60_000 });
    expect(timeoutRow(w.id)).toEqual({ max_time_ms: 20 * 60_000, deadline_at: now + 20 * 60_000, notified: 0 });
    turn(w, firstMessage(w).id, [], null, null);
    advance(10 * 60_000);
    restart();
    advance(10 * 60_000 - 1);
    expect(wakes()).toEqual([]);
    advance(1);
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]!.text).toContain("已超过最大时间（20m）");
    expect(timeoutRow(w.id)?.notified).toBe(1);
    restart();
    advance(60 * 60_000);
    expect(wakes()).toHaveLength(1);
    // 这一轮结束：计时清掉
    const sid = sessionIdOf(w.id);
    ledger.applyDriverEvent(sid, { type: "agent.text", uuid: "done", text: report("做完了", "好了"), at: now });
    ledger.applyDriverEvent(sid, { type: "turn.ended", ok: true, interrupted: false, messageIds: [firstMessage(w).id], durationMs: 1, at: now });
    expect(timeoutRow(w.id)).toBeUndefined();
  });

  it("hub worker max-time 续的时长落盘；守护进程停着的时候过了截止时刻：重启后马上提醒一次", () => {
    const w = start({ title: "修 X", task: "修", noWorktree: true, maxTimeMs: 20 * 60_000 });
    turn(w, firstMessage(w).id, [], null, null);
    advance(5 * 60_000);
    hub("worker.max-time", { workerId: w.id, maxTimeMs: 60 * 60_000 });
    expect(timeoutRow(w.id)).toMatchObject({ max_time_ms: 60 * 60_000, deadline_at: now + 60 * 60_000 });
    advance(30 * 60_000);
    restart();
    advance(29 * 60_000);
    expect(wakes()).toEqual([]);
    advance(60_000);
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]!.text).toContain("已超过最大时间（1h）");

    // 另一个：守护进程停着时过了截止时刻
    const w2 = start({ title: "修 Y", task: "修", noWorktree: true, maxTimeMs: 10 * 60_000 });
    turn(w2, firstMessage(w2).id, [], null, null);
    ledger.close();
    now += 30 * 60_000;
    ledger = createLedger(db, options());
    ledger.recoverAfterRestart();
    vi.advanceTimersByTime(0);
    expect(wakes().filter((m) => m.workerId === w2.id)).toHaveLength(1);
  });

  it("收工清掉库里的计时；关机（close）不清，留给重启恢复", () => {
    const w = start({ title: "修 X", task: "修", noWorktree: true, maxTimeMs: 20 * 60_000 });
    ledger.close();
    expect(timeoutRow(w.id)).toBeDefined();
    ledger = createLedger(db, options());
    ledger.recoverAfterRestart();
    hub("worker.end", { workerId: w.id });
    expect(timeoutRow(w.id)).toBeUndefined();
    advance(60 * 60_000);
    expect(wakes()).toEqual([]);
  });

  it("已超时提醒过的一轮在等后台命令时重启，或自发轮异常退出：残留计时行被清掉，用户直接发下一轮消息时照常重新计时并提醒", () => {
    const w = start({ title: "修后台", task: "修", noWorktree: true, maxTimeMs: 10 * 60_000 });
    const sid = sessionIdOf(w.id);
    const firstId = firstMessage(w).id;
    ledger.applyDriverEvent(sid, { type: "message.delivered", messageIds: [firstId], at: now });
    ledger.applyDriverEvent(sid, { type: "message.processing", messageIds: [firstId], at: now });
    // 本轮先触发了一次超时提醒（notified = 1）
    advance(10 * 60_000);
    expect(wakes()).toHaveLength(1);
    expect(timeoutRow(w.id)?.notified).toBe(1);

    // 随后进入等后台命令（awaitingBackground），期间守护进程重启：recoverBackgroundWaits 结算本轮且清空计时死行
    ledger.applyDriverEvent(sid, { type: "background.changed", count: 1, at: now });
    ledger.applyDriverEvent(sid, { type: "agent.text", uuid: "bg-1", text: "放后台了", at: now });
    ledger.applyDriverEvent(sid, { type: "turn.ended", ok: true, interrupted: false, messageIds: [firstId], durationMs: 10, at: now });
    expect(timeoutRow(w.id)?.notified).toBe(1);
    restart();
    expect(timeoutRow(w.id)).toBeUndefined();

    // 用户直接在网页发下一轮消息（靠 ensureTurnMaxTime 兜底挂默认计时）：不会因残留 notified=1 而漏挂计时
    const { messageId: userMsgId } = ledger.postUserMessage({ conversationId: w.workerConversationId, clientId: "c-1", text: "继续查" });
    ledger.applyDriverEvent(sid, { type: "message.delivered", messageIds: [userMsgId], at: now });
    ledger.applyDriverEvent(sid, { type: "message.processing", messageIds: [userMsgId], at: now });
    expect(timeoutRow(w.id)).toEqual({ max_time_ms: DEFAULT_WORKER_MAX_TIME_MS, deadline_at: now + DEFAULT_WORKER_MAX_TIME_MS, notified: 0 });
    advance(DEFAULT_WORKER_MAX_TIME_MS);
    expect(wakes()).toHaveLength(2);
    ledger.applyDriverEvent(sid, { type: "turn.ended", ok: false, interrupted: true, messageIds: [userMsgId], durationMs: 1, at: now });
    expect(timeoutRow(w.id)).toBeUndefined();

    // 自发轮（turn.started）中途进程异常退出（session.exited 无在途消息）：同样清掉计时无死行
    ledger.applyDriverEvent(sid, { type: "turn.started", at: now });
    expect(timeoutRow(w.id)).toBeDefined();
    ledger.applyDriverEvent(sid, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [], at: now });
    expect(timeoutRow(w.id)).toBeUndefined();
  });
});
