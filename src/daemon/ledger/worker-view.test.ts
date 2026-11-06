// hub worker show / log（账本这一半）：三家厂商各造一段事件序列（在跑工具、在思考、一轮成功结束、被打断、出错、已收工、准备中），
// 看 show、log 讲得对不对；--last、参数截断、遮密钥、只能看自己派的 Worker。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationId, PmId, SessionId, WorkerId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { HubCallContext, LedgerErrorCode, WorkspaceProbe } from "../../shared/ledger.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { WORKER_LOG_MAX_STEPS, WORKER_SEARCH_CONTEXT_CHARS, WORKER_SEARCH_DEFAULT_LIMIT, WORKER_SEARCH_MAX_LIMIT, WORKER_STALL_HINT_MS, WORKER_VIEW_TEXT_MAX_CHARS } from "../../shared/limits.ts";
import { bundledModelCatalog } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";
import { snippetOf } from "./worker-search.ts";
import { clipText, formatClock } from "./worker-view.ts";

let db: Db;
let root: string;
let now: number;
let ledger: SqliteLedger;
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let main: string;

const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-worker-view-")));
  const dataHome = join(root, ".agent-hub");
  now = T0;
  ledger = createLedger(db, {
    now: () => now,
    initialSeq: 9_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", defaultModel: "claude-sonnet-5-5" });
  const b = ledger.createPm({ name: "阿周", mode: "hands_on", persona: "" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId };
  main = join(root, "work", "foo");
  mkdirSync(main, { recursive: true });
  main = realpathSync.native(main);
  ledger.hubCall(lin.sessionId, "project.create", { folder: main });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function expectLedgerError(fn: () => unknown, code: LedgerErrorCode, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LedgerRequestError);
  expect((caught as LedgerRequestError).code).toBe(code);
  if (message) expect((caught as LedgerRequestError).message).toMatch(message);
}

const sessionOf = (workerId: WorkerId): SessionId => db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!.id;

function startWorker(vendor: AgentVendor, extra: { title?: string; noWorktree?: boolean; model?: string; effort?: string } = {}): WorkerId {
  const probe: WorkspaceProbe = { kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false };
  const context: HubCallContext = extra.noWorktree === false ? { workspace: { ...probe, isRepoWithCommit: true } } : {};
  return ledger.hubCall(lin.sessionId, "worker.start", { title: extra.title ?? "修 X", task: "把 X 修好", vendor, noWorktree: extra.noWorktree ?? true, ...(extra.model ? { model: extra.model } : {}), ...(extra.effort ? { effort: extra.effort } : {}) }, context).data
    .worker.id;
}

const show = (workerId: WorkerId, caller = lin.sessionId, context: HubCallContext = {}) => ledger.hubCall(caller, "worker.show", { workerId }, context);
const log = (workerId: WorkerId, last?: number, caller = lin.sessionId) =>
  ledger.hubCall(caller, "worker.log", last === undefined ? { workerId } : { workerId, last }, {});

const emit = (workerId: WorkerId, event: DriverEvent) => ledger.applyDriverEvent(sessionOf(workerId), event);
const at = () => ({ at: now });
const advance = (ms: number) => void (now += ms);

/** 各家的“跑命令”工具长什么样（驱动层原样交给账本的 name、input）。 */
const COMMAND_TOOLS: Record<AgentVendor, (command: string) => { name: string; input: unknown }> = {
  claude: (command) => ({ name: "Bash", input: { command, description: "x" } }),
  codex: (command) => ({ name: "commandExecution", input: { command } }),
  agy: (command) => ({ name: "run_command", input: { CommandLine: command } }),
};

let seq = 0;
const startTurn = (workerId: WorkerId) => {
  emit(workerId, { type: "message.delivered", messageIds: [1], ...at() });
  emit(workerId, { type: "message.processing", messageIds: [1], ...at() });
};
function runTool(vendor: AgentVendor, workerId: WorkerId, command: string, opts: { finish?: boolean; sub?: string } = {}) {
  const tool = COMMAND_TOOLS[vendor](command);
  const id = `tool-${++seq}`;
  emit(workerId, { type: "agent.tool", uuid: `u-${id}`, toolUseId: id, name: tool.name, input: tool.input, ...at(), ...(opts.sub ? { parentToolUseId: opts.sub } : {}) });
  if (opts.finish !== false) {
    advance(2_000);
    emit(workerId, { type: "agent.tool_result", toolUseIds: [id], ...at() });
  }
  return id;
}
const endTurn = (workerId: WorkerId, extra: Partial<Extract<DriverEvent, { type: "turn.ended" }>> = {}) =>
  emit(workerId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [1], durationMs: null, ...at(), ...extra });

function mark(workerId: WorkerId, patch: { pid?: number | null; lastEventAt?: number | null; context?: number }) {
  const store = createSessionStore(db);
  const { context, ...rest } = patch;
  store.update(sessionOf(workerId), { ...rest, ...(context === undefined ? {} : { usage: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1, context } }) });
}

describe.each(["claude", "codex", "agy"] as const)("%s 的 Worker", (vendor) => {
  it("在跑工具：现在在干什么写出工具和参数、已经跑了多久；这一轮跑了多久、走了几步；进程和最后一次有动静", () => {
    const w = startWorker(vendor);
    startTurn(w);
    advance(30_000);
    runTool(vendor, w, "pnpm test");
    advance(5_000);
    runTool(vendor, w, "gh pr checks 90 --watch", { finish: false });
    advance(125_000);
    mark(w, { pid: 4242, lastEventAt: now - 125_000, context: 158_400 });
    const text = show(w).text;
    expect(text).toContain("Worker #" + w + "“修 X”：在干活");
    expect(text).toContain("现在：Running command: gh pr checks 90 --watch，已跑 2m 5s");
    expect(text).toContain("这一轮跑了 2m 42s，走了 2 步");
    expect(text).toContain("上一轮：还没有");
    expect(text).toContain("进程在跑，最后一次有动静是 2m 5s 前");
    expect(text).toContain("对话 158K context");
    expect(text).toMatch(/^厂商 .+，模型 .+，思考程度 .+$/m);
    expect(text).toContain("在项目主文件夹里干活");
    // 没有这个信号的厂商不写后台任务
    expect(text).not.toContain("后台任务");
  });

  it("在思考：写出思考了多久；写回复；工具结果回来后在想下一步", () => {
    const w = startWorker(vendor);
    startTurn(w);
    emit(w, { type: "agent.thinking", uuid: "t1", ...at() });
    advance(4_000);
    emit(w, { type: "agent.thinking", uuid: "t2", ...at() });
    advance(6_000);
    expect(show(w).text).toContain("现在：在思考，已 10s");
    emit(w, { type: "agent.text", uuid: "x1", text: "我先看看", ...at() });
    expect(show(w).text).toContain("现在：在写回复");
    advance(1_000);
    runTool(vendor, w, "ls");
    expect(show(w).text).toContain("现在：在想下一步");
  });

  it("一轮成功结束：空闲等验收，上一轮成功、用时、步数", () => {
    const w = startWorker(vendor);
    startTurn(w);
    runTool(vendor, w, "pnpm test");
    advance(60_000);
    endTurn(w, { durationMs: 62_000 });
    const text = show(w).text;
    expect(text).toContain("：空闲，等验收");
    expect(text).toContain("现在：没在干活，等项目经理验收或发下一条");
    expect(text).toContain("上一轮：成功，用了 1m 2s，走了 1 步");
    expect(text).not.toContain("这一轮跑了");
  });

  it("厂商没报用时就用开始到结束的时间", () => {
    const w = startWorker(vendor);
    startTurn(w);
    advance(90_000);
    endTurn(w);
    expect(show(w).text).toContain("上一轮：成功，用了 1m 30s，走了 0 步");
  });

  it("被打断：上一轮写被打断", () => {
    const w = startWorker(vendor);
    startTurn(w);
    runTool(vendor, w, "sleep 100", { finish: false });
    endTurn(w, { ok: false, interrupted: true });
    const text = show(w).text;
    expect(text).toContain("：空闲，上一轮被打断了");
    expect(text).toContain("现在：没在干活：上一轮被打断了，等项目经理（或用户）发话");
    expect(text).toContain("上一轮：被打断，");
  });

  it("出错：上一轮写出错和原因", () => {
    const w = startWorker(vendor);
    startTurn(w);
    endTurn(w, { ok: false, error: { subtype: "error_during_execution", message: "context window exceeded" } });
    const text = show(w).text;
    expect(text).toContain("：空闲，上一轮出错了");
    expect(text).toContain("现在：没在干活：上一轮出错了，等项目经理处理");
    expect(text).toContain("上一轮：出错：error_during_execution: context window exceeded，");
  });

  it("进程崩溃（没有 result）也算这一轮结束：出错，带退出码", () => {
    const w = startWorker(vendor);
    startTurn(w);
    emit(w, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [1], ...at() });
    expect(show(w).text).toContain("上一轮：出错：crash: exit code 1，");
  });

  it("已收工：状态已收工，没有“现在”，上一轮还在", () => {
    const w = startWorker(vendor);
    startTurn(w);
    endTurn(w);
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: w });
    const text = show(w).text;
    expect(text).toContain("：已收工");
    expect(text).not.toContain("现在：");
    expect(text).toContain("上一轮：成功");
  });

  it("准备中：worktree 还没建好、没开工", () => {
    const w = startWorker(vendor, { noWorktree: false });
    const text = show(w).text;
    expect(text).toContain("：准备中");
    expect(text).toContain("现在：worktree 还没建好，没开工");
    expect(text).toContain("分支 hub/");
  });

  it("进程不在：写没在跑；还没有过动静", () => {
    const w = startWorker(vendor);
    expect(show(w).text).toContain("进程没在跑，还没有过动静");
  });

  it("工作中、没有工具在跑、太久没动静：提醒可能卡住了；有工具在跑不提醒", () => {
    const w = startWorker(vendor);
    startTurn(w);
    emit(w, { type: "agent.thinking", uuid: "t1", ...at() });
    mark(w, { pid: 1, lastEventAt: now });
    advance(WORKER_STALL_HINT_MS + 1_000);
    expect(show(w).text).toContain("可能卡住了");
    runTool(vendor, w, "sleep 600", { finish: false });
    expect(show(w).text).not.toContain("可能卡住了");
  });

  it("log：一行一步，从旧到新；工具带用时、思考写多久、回复、一轮结束和结果", () => {
    const w = startWorker(vendor);
    startTurn(w);
    emit(w, { type: "agent.thinking", uuid: "t1", ...at() });
    advance(3_000);
    const t1 = now;
    runTool(vendor, w, "gh pr checks 90 --watch"); // 2s 后结果回来
    const t2 = now;
    advance(1_000);
    emit(w, { type: "agent.text", uuid: "x1", text: "CI 还在跑\n等一下", ...at() });
    const t3 = now;
    advance(500);
    endTurn(w);
    const t4 = now;
    const result = log(w);
    expect(result.text.split("\n")).toEqual([
      "Worker #" + w + "“修 X”最近 4 步（从旧到新）：",
      `${formatClock(T0)} 思考了 3s`,
      `${formatClock(t1)} Running command: gh pr checks 90 --watch（用了 2s）`,
      `${formatClock(t2 + 1_000)} 回复了一段：CI 还在跑 等一下`,
      `${formatClock(t4)} 这一轮结束：成功`,
    ]);
    expect(t3).toBe(t2 + 1_000);
    expect(result.data.steps.map((s) => s.kind)).toEqual(["thinking", "tool", "text", "turn_ended"]);
  });

  it("log --last N 只留最近 N 步；默认 20 步；范围不对报 invalid", () => {
    const w = startWorker(vendor);
    startTurn(w);
    for (let i = 1; i <= 25; i++) runTool(vendor, w, `echo ${i}`);
    expect(log(w, 3).data.steps.map((s) => s.text)).toEqual([
      "Running command: echo 23（用了 2s）",
      "Running command: echo 24（用了 2s）",
      "Running command: echo 25（用了 2s）",
    ]);
    expect(log(w).data.steps).toHaveLength(20);
    expect(log(w, WORKER_LOG_MAX_STEPS).data.steps).toHaveLength(25);
    expectLedgerError(() => log(w, 0), "invalid", /1 到 200/);
    expectLedgerError(() => log(w, WORKER_LOG_MAX_STEPS + 1), "invalid");
    expectLedgerError(() => log(w, 1.5), "invalid");
  });

  it("log：太长的参数截断，show 里也一样", () => {
    const w = startWorker(vendor);
    startTurn(w);
    const long = `echo ${"x".repeat(500)}`;
    runTool(vendor, w, long, { finish: false });
    const line = log(w).data.steps[0]!.text;
    expect(line.startsWith("Running command: echo xxx")).toBe(true);
    expect(line).toContain("…");
    expect([...line.split("…")[0]!]).toHaveLength(WORKER_VIEW_TEXT_MAX_CHARS - 1);
    expect(show(w).text).toContain("…，已跑 0s");
  });

  it("log：还在跑的工具写还在跑；一轮结束了还没结果的写没等到结果", () => {
    const w = startWorker(vendor);
    startTurn(w);
    runTool(vendor, w, "sleep 600", { finish: false });
    advance(65_000);
    expect(log(w).data.steps[0]!.text).toBe("Running command: sleep 600（还在跑，已 1m 5s）");
    endTurn(w, { ok: false, interrupted: true });
    expect(log(w).data.steps.map((s) => s.text)).toEqual(["Running command: sleep 600（没等到结果）", "这一轮结束：被打断"]);
  });

  it("log：出错的一轮写原因；没有记录写没有", () => {
    const w = startWorker(vendor);
    expect(log(w).text).toBe(`Worker #${w}“修 X”还没有记录到任何一步。`);
    startTurn(w);
    endTurn(w, { ok: false, error: { subtype: "error_during_execution", message: "boom" } });
    expect(log(w).data.steps.at(-1)!.text).toBe("这一轮结束：出错：error_during_execution: boom");
  });

  it("命令里的密钥、令牌不出现在 show、log、库里", () => {
    const w = startWorker(vendor);
    startTurn(w);
    runTool(vendor, w, 'curl -H "Authorization: Bearer abcdef1234567890" https://x.test?token=hunter2hunter2', { finish: false });
    runTool(vendor, w, "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh pr list", { finish: false });
    emit(w, { type: "agent.text", uuid: "x1", text: "key is sk-abcdefghijklmnopqrstuvwxyz123456", ...at() });
    const all = `${show(w).text}\n${log(w).text}\n${JSON.stringify(db.all("SELECT summary FROM session_steps"))}`;
    for (const secret of ["abcdef1234567890", "hunter2hunter2", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "sk-abcdefghijklmnopqrstuvwxyz123456"]) {
      expect(all).not.toContain(secret);
    }
    expect(log(w).text).toContain("***");
  });

  it("子任务里的事件不算主 agent 的步骤", () => {
    const w = startWorker(vendor);
    startTurn(w);
    runTool(vendor, w, "ls");
    runTool(vendor, w, "inner", { sub: "parent-1" });
    emit(w, { type: "agent.thinking", uuid: "t-sub", parentToolUseId: "parent-1", ...at() });
    expect(log(w).data.steps).toHaveLength(1);
  });

  it("重放同一个事件不记两遍", () => {
    const w = startWorker(vendor);
    startTurn(w);
    for (let i = 0; i < 2; i++) {
      emit(w, { type: "agent.tool", uuid: "same", toolUseId: "tool-same", name: "Bash", input: { command: "ls" }, ...at() });
      emit(w, { type: "agent.text", uuid: "same-text", text: "hi", ...at() });
    }
    expect(log(w).data.steps.map((s) => s.kind)).toEqual(["tool", "text"]);
  });

  it("新进程起来时还开着的一轮算被打断，下一轮从头计", () => {
    const w = startWorker(vendor);
    startTurn(w);
    advance(500_000);
    emit(w, { type: "session.started", resumed: true, model: null, tools: [], ...at() });
    expect(show(w).text).toContain("上一轮：被打断（进程重启，这一轮被打断了）");
    startTurn(w);
    advance(10_000);
    expect(show(w).text).toContain("这一轮跑了 10s");
  });
});

describe("模型名、思考程度：和网页右栏、资料页一样的写法", () => {
  const line = (w: WorkerId) => show(w).text.split("\n")[1];

  it("claude 的完整模型名写成显示名；默认写“默认”", () => {
    expect(line(startWorker("claude", { model: "claude-opus-5-5" }))).toBe("厂商 Claude Code，模型 Opus 5.5，思考程度 默认");
    expect(line(startWorker("claude", { model: "claude-sonnet-5-5", effort: "high" }))).toBe("厂商 Claude Code，模型 Sonnet 5.5，思考程度 high");
  });

  it("agy：模型和思考程度分开写（另存的、写在模型 ID 末尾的老数据都拆开）", () => {
    expect(line(startWorker("agy", { model: "gemini-4-argon", effort: "high" }))).toBe("厂商 Antigravity，模型 Gemini 4 Argon，思考程度 high");
    const old = startWorker("agy");
    db.run("UPDATE agent_sessions SET model = 'gpt-oss-120b-medium', effort = NULL WHERE worker_id = ?", old);
    expect(line(old)).toMatch(/，思考程度 medium$/);
    expect(line(old)).not.toContain("gpt-oss-120b-medium");
  });

  it("hub worker list 和 show 写法一致", () => {
    const ids = [startWorker("claude", { model: "claude-opus-5-5" }), startWorker("agy", { model: "gemini-4-argon", effort: "high" }), startWorker("codex")];
    const list = ledger.hubCall(lin.sessionId, "worker.list", {}, {}).text.split("\n");
    for (const id of ids) {
      const shown = show(id).text.match(/，模型 (.+)，思考程度 (.+)$/m)!;
      expect(list.find((l) => l.startsWith(`#${id} `))).toContain(`模型 ${shown[1]} · 思考程度 ${shown[2]}`);
    }
  });

  it("厂商报了“默认”实际用哪个模型就写它", () => {
    const withCatalog = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(root, ".agent-hub", "pm-home"),
      dataHome: join(root, ".agent-hub"),
      resolveFolder: createResolveFolder({ dataHome: join(root, ".agent-hub"), userHome: root }),
      modelCatalog: (vendor) => ({ ...bundledModelCatalog(vendor), source: "vendor", defaultModel: "Opus 5.5" }),
    });
    const w = startWorker("claude");
    db.run("UPDATE agent_sessions SET model = NULL WHERE worker_id = ?", w);
    const text = withCatalog.hubCall(lin.sessionId, "worker.show", { workerId: w }, {}).text;
    expect(text).toContain("模型 Opus 5.5，思考程度 默认");
  });
});

describe("后台任务：有这个信号的厂商（claude）才显示", () => {
  it("background.changed 来了写个数，进程退出后不写", () => {
    const w = startWorker("claude");
    startTurn(w);
    mark(w, { pid: 7 });
    emit(w, { type: "background.changed", count: 2, ...at() });
    expect(show(w).text).toContain("后台任务 2 个，对话 —");
    emit(w, { type: "background.changed", count: 0, ...at() });
    expect(show(w).text).toContain("后台任务 0 个");
    emit(w, { type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], ...at() });
    mark(w, { pid: null });
    expect(show(w).text).not.toContain("后台任务");
  });

  it("没有信号（codex、agy）不写", () => {
    for (const vendor of ["codex", "agy"] as const) {
      const w = startWorker(vendor);
      mark(w, { pid: 7 });
      expect(show(w).text).not.toContain("后台任务");
    }
  });
});

describe("原始记录：厂商自己存的会话文件在哪", () => {
  it("show 多一行“原始记录：<路径>”；找不到（没给、给了 null）写“找不到”", () => {
    const w = startWorker("claude");
    expect(show(w).text).toContain("\n原始记录：找不到");
    expect(show(w, lin.sessionId, { transcript: null }).text).toContain("\n原始记录：找不到");
    expect(show(w, lin.sessionId, { transcript: "/h/.claude/projects/-p/v.jsonl" }).text).toContain("\n原始记录：/h/.claude/projects/-p/v.jsonl");
  });

  it("workerTranscriptTarget：自己派的 Worker 给当前会话的 vendor、vendor_session_id、cwd；别人的、Worker 自己调的是 null", () => {
    const w = startWorker("codex", { title: "转写" });
    const store = createSessionStore(db);
    store.update(sessionOf(w), { vendorSessionId: "thread-9" });
    const session = store.get(sessionOf(w))!;
    expect(ledger.workerTranscriptTarget(lin.sessionId, w)).toEqual({ vendor: "codex", vendorSessionId: "thread-9", cwd: session.cwd });
    expect(ledger.workerTranscriptTarget(zhou.sessionId, w)).toBeNull();
    expect(ledger.workerTranscriptTarget(sessionOf(w), w)).toBeNull();
    expect(ledger.workerTranscriptTarget(lin.sessionId, 999)).toBeNull();
  });
});

describe("PR、分支", () => {
  it("agent 接口查到的 PR 写一行；没有就不写", () => {
    const w = startWorker("claude");
    expect(show(w).text).not.toContain("PR #");
    expect(show(w, lin.sessionId, { pr: { number: 97, state: "OPEN", url: "https://github.com/o/r/pull/97" } }).text).toContain(
      "PR #97（开着）https://github.com/o/r/pull/97",
    );
    expect(show(w, lin.sessionId, { pr: { number: 97, state: "MERGED", url: "u" } }).text).toContain("PR #97（已合并）u");
  });

  it("worktree 的 Worker 写分支和 worktree 路径", () => {
    const w = startWorker("claude", { noWorktree: false });
    const worker = ledger.hubCall(lin.sessionId, "worker.show", { workerId: w }).data.worker;
    expect(show(w).text).toContain(`分支 ${worker.branch}，worktree ${worker.worktreePath}`);
  });

  it("workerPrTarget：自己派的、已开工的 worktree Worker 才给；主文件夹里干的、别人的、没开工的都是 null", () => {
    const wt = startWorker("claude", { noWorktree: false });
    const inMain = startWorker("claude", { title: "主" });
    expect(ledger.workerPrTarget(lin.sessionId, inMain)).toBeNull();
    expect(ledger.workerPrTarget(lin.sessionId, wt)).toBeNull(); // 还没建好
    db.run("UPDATE workers SET base_commit = 'abc' WHERE id = ?", wt);
    const worker = ledger.hubCall(lin.sessionId, "worker.show", { workerId: wt }).data.worker;
    expect(ledger.workerPrTarget(lin.sessionId, wt)).toEqual({ cwd: worker.worktreePath, branch: worker.branch });
    expect(ledger.workerPrTarget(zhou.sessionId, wt)).toBeNull();
    expect(ledger.workerPrTarget(sessionOf(wt), wt)).toBeNull();
    expect(ledger.workerPrTarget(lin.sessionId, 999)).toBeNull();
  });
});

describe("权限：和 hub worker list 一样，只能看自己派的", () => {
  it("别的项目经理的 Worker：forbidden；不存在：not_found；Worker 自己调：forbidden", () => {
    const w = startWorker("claude");
    startTurn(w);
    runTool("claude", w, "ls");
    // 阿周还没有项目，先建
    const other = join(root, "work", "bar");
    mkdirSync(other, { recursive: true });
    ledger.hubCall(zhou.sessionId, "project.create", { folder: realpathSync.native(other) });
    expectLedgerError(() => show(w, zhou.sessionId), "forbidden", /不是你派的/);
    expectLedgerError(() => log(w, undefined, zhou.sessionId), "forbidden", /不是你派的/);
    expectLedgerError(() => show(999), "not_found");
    expectLedgerError(() => log(999), "not_found");
    expectLedgerError(() => show(w, sessionOf(w)), "forbidden", /Worker 只能用/);
    expectLedgerError(() => log(w, undefined, sessionOf(w)), "forbidden", /Worker 只能用/);
    // 阿周自己的 Worker 看得了，看不到别人的步骤
    const mine = ledger.hubCall(zhou.sessionId, "worker.start", { title: "我的", task: "x", noWorktree: true }, {}).data.worker.id;
    expect(log(mine, undefined, zhou.sessionId).text).toContain("还没有记录");
  });
});

describe("留多少：只留最近的若干条", () => {
  it("超过上限，一轮结束时把更老的删掉", () => {
    const w = startWorker("claude");
    startTurn(w);
    for (let i = 0; i < 1_100; i++) runTool("claude", w, `echo ${i}`, { finish: false });
    endTurn(w);
    const n = db.get<{ n: number }>("SELECT count(*) AS n FROM session_steps WHERE session_id = ?", sessionOf(w))!.n;
    expect(n).toBeLessThanOrEqual(1_001);
    expect(log(w, 1).data.steps[0]!.text).toBe("这一轮结束：成功");
  });
});

/** 各家的“读文件”“搜索”“改文件”“上网”工具（驱动层原样交给账本的 name、input）。 */
const OTHER_TOOLS: Record<AgentVendor, Record<"read" | "search" | "edit" | "web", (arg: string) => { name: string; input: unknown }>> = {
  claude: {
    read: (p) => ({ name: "Read", input: { file_path: p } }),
    search: (q) => ({ name: "Grep", input: { pattern: q } }),
    edit: (p) => ({ name: "Edit", input: { file_path: p } }),
    web: (q) => ({ name: "WebSearch", input: { query: q } }),
  },
  codex: {
    read: (p) => ({ name: "read_file", input: { path: p } }),
    search: (q) => ({ name: "grep_search", input: { query: q } }),
    edit: (p) => ({ name: "apply_patch", input: { path: p } }),
    web: (q) => ({ name: "webSearch", input: { query: q } }),
  },
  agy: {
    read: (p) => ({ name: "view_file", input: { AbsolutePath: p } }),
    search: (q) => ({ name: "find_by_name", input: { Pattern: q, SearchPath: "." } }),
    edit: (p) => ({ name: "replace_file_content", input: { TargetFile: p } }),
    web: (q) => ({ name: "search_web", input: { query: q } }),
  },
};
const runNamed = (workerId: WorkerId, tool: { name: string; input: unknown }, wait = 1_000) => {
  const id = `tool-${++seq}`;
  emit(workerId, { type: "agent.tool", uuid: `u-${id}`, toolUseId: id, name: tool.name, input: tool.input, ...at() });
  advance(wait);
  emit(workerId, { type: "agent.tool_result", toolUseIds: [id], ...at() });
};
const stats = (workerId: WorkerId) => ledger.hubCall(lin.sessionId, "worker.log", { workerId, stats: true }, {});

describe.each(Object.keys(OTHER_TOOLS) as AgentVendor[])("%s 的 hub worker log --stats", (vendor) => {
  it("各类别计数、读得最多的文件、重复最多的命令、思考和等工具的用时、轮的结局", () => {
    const w = startWorker(vendor);
    const t = OTHER_TOOLS[vendor];
    startTurn(w);
    emit(w, { type: "agent.thinking", uuid: "t1", ...at() });
    advance(4_000);
    emit(w, { type: "agent.thinking", uuid: "t2", ...at() });
    advance(6_000);
    for (const f of ["/x/a.ts", "/y/a.ts", "/x/b.ts"]) runNamed(w, t.read(f), 2_000);
    runNamed(w, t.search("foo"));
    runNamed(w, t.edit("/x/a.ts"));
    runNamed(w, t.web("q"));
    runTool(vendor, w, "pnpm test");
    runTool(vendor, w, "pnpm test");
    runTool(vendor, w, "ls");
    endTurn(w);
    startTurn(w);
    endTurn(w, { ok: false, interrupted: true });
    startTurn(w);
    endTurn(w, { ok: false, error: { subtype: "x", message: "boom" } });
    const text = stats(w).text;
    expect(text).toContain("共 9 步，3 轮：ok 1 / interrupted 1 / failed 1");
    expect(text).toContain("读文件 3，搜索 1，跑命令 3，改文件 1，上网 1，其它 0");
    expect(text).not.toContain("认不出");
    expect(text).toContain("读得最多的文件：a.ts ×2，b.ts ×1");
    expect(text).toContain("重复最多的命令：pnpm test ×2");
    expect(text).not.toContain("ls ×");
    expect(text).toContain("思考 10s（1 次），等工具结果 ");
    expect(text.split("\n").length).toBeLessThanOrEqual(15);
    expect(stats(w).data.steps).toEqual([]);
  });
});

describe("hub worker log --stats：认不出的工具、其它、多会话、没有步骤", () => {
  it("认不出的工具按原名单独计数；技能、连接器、子代理算其它", () => {
    const w = startWorker("claude");
    startTurn(w);
    runNamed(w, { name: "FooTool", input: {} });
    runNamed(w, { name: "FooTool", input: {} });
    runNamed(w, { name: "BarTool", input: {} });
    runNamed(w, { name: "Skill", input: { skill: "x" } });
    runNamed(w, { name: "mcp__codegraph__explore", input: {} });
    const text = stats(w).text;
    expect(text).toContain("共 5 步，1 轮：ok 0 / interrupted 0 / failed 0 / running 1");
    expect(text).toContain("读文件 0，搜索 0，跑命令 0，改文件 0，上网 0，其它 2");
    expect(text).toContain("认不出的工具：FooTool ×2，BarTool ×1");
    expect(text).toContain("读得最多的文件：—");
    expect(text).toContain("重复最多的命令：—");
  });

  it("换代后合计所有会话的步骤", () => {
    const w = startWorker("claude");
    startTurn(w);
    runTool("claude", w, "pnpm test");
    runTool("claude", w, "pnpm test");
    endTurn(w);
    // 换代：同一个对话里再来一个 generation 2 的会话
    const cols = db.all<{ name: string }>("PRAGMA table_info(agent_sessions)").map((c) => c.name).filter((n) => n !== "id");
    const list = cols.map((c) => (c === "generation" ? "generation + 1" : c === "vendor_session_id" ? "vendor_session_id || '-gen2'" : c)).join(", ");
    db.run(`INSERT INTO agent_sessions (${cols.join(", ")}) SELECT ${list} FROM agent_sessions WHERE id = ?`, sessionOf(w));
    const second = db.get<{ id: number }>("SELECT max(id) AS id FROM agent_sessions")!.id;
    ledger.applyDriverEvent(second, { type: "message.processing", messageIds: [1], ...at() });
    ledger.applyDriverEvent(second, { type: "agent.tool", uuid: "g2", toolUseId: "g2", name: "Bash", input: { command: "pnpm test" }, ...at() });
    ledger.applyDriverEvent(second, { type: "turn.ended", ok: true, interrupted: false, messageIds: [1], durationMs: null, ...at() });
    const text = stats(w).text;
    expect(text).toContain("（2 个会话）");
    expect(text).toContain("共 3 步，2 轮：ok 2 / interrupted 0 / failed 0");
    expect(text).toContain("重复最多的命令：pnpm test ×3");
  });

  it("没有步骤：一句话；不能和 --last 一起用；只能看自己派的", () => {
    const w = startWorker("claude");
    expect(stats(w).text).toBe(`Worker #${w}“修 X”还没有记录到任何一步。`);
    expectLedgerError(() => ledger.hubCall(lin.sessionId, "worker.log", { workerId: w, stats: true, last: 5 }, {}), "invalid", /--last/);
    expectLedgerError(() => ledger.hubCall(zhou.sessionId, "worker.log", { workerId: w, stats: true }, {}), "forbidden", /不是你派的/);
  });
});

describe("clipText", () => {
  it("不超长原样，超长截断加省略号，按字符不按字节", () => {
    expect(clipText("abc", 5)).toBe("abc");
    expect(clipText("一二三四五六", 4)).toBe("一二三…");
  });
});

// ---- hub worker search / show --task / --report ----

const REPORT_START = "=== 汇报 ===";
const REPORT_END = "=== 汇报结束 ===";
const reportText = (summary: string, extra = "") => `${extra}\n\n${REPORT_START}\n状态: 做完了\n摘要: ${summary}\n提交: abc\n测试: ok\n问题: 无\n${REPORT_END}`;

function startTask(title: string, task: string, caller = lin.sessionId): WorkerId {
  return ledger.hubCall(caller, "worker.start", { title, task, noWorktree: true }, {}).data.worker.id;
}
/** Worker 干完一轮并汇报：第一轮回任务说明那条消息，之后的先由项目经理 send 一条。 */
function reportTurn(workerId: WorkerId, text: string, caller = lin.sessionId): void {
  const first = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", `pm:worker:${workerId}:task`)!.id;
  const hasReport = db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE worker_id = ? AND kind = 'worker' AND json_extract(meta, '$.event') = 'report'", workerId)!.n;
  const id = hasReport === 0 ? first : (ledger.hubCall(caller, "worker.send", { workerId, text: "接着做" }, {}).data as { messageId: number }).messageId;
  emit(workerId, { type: "message.delivered", messageIds: [id], ...at() });
  emit(workerId, { type: "message.processing", messageIds: [id], ...at() });
  emit(workerId, { type: "agent.text", uuid: `rt-${workerId}-${id}`, text, ...at() });
  endTurn(workerId, { messageIds: [id] });
  advance(1_000);
}
const search = (keywords: string[], limit?: number, caller = lin.sessionId) =>
  ledger.hubCall(caller, "worker.search", limit === undefined ? { keywords } : { keywords, limit }, {});
const showTask = (workerId: WorkerId, caller = lin.sessionId) => ledger.hubCall(caller, "worker.show", { workerId, task: true }, {});
const showReport = (workerId: WorkerId, n?: number, caller = lin.sessionId) => ledger.hubCall(caller, "worker.show", { workerId, report: n ?? "latest" }, {});

describe("hub worker search", () => {
  it("标题、任务说明、汇报都能搜；一处一行，写编号、标题、状态、命中在哪和上下文", () => {
    const w = startTask("修登录", "登录页的 Bug：点按钮没反应");
    reportTurn(w, reportText("按钮修好了", "改了 handler"));
    const hits = search(["登录"]).data.hits;
    expect(hits.map((h) => h.where)).toEqual(["task", "title"]);
    const text = search(["按钮"]).text;
    expect(text).toContain("搜到 2 处包含 “按钮”");
    expect(text).toContain(`#${w}“修登录” · 进行中 · 汇报 #1：`);
    expect(text).toContain(`#${w}“修登录” · 进行中 · 任务：登录页的 Bug：点按钮没反应`);
    expect(search(["handler"]).data.hits).toMatchObject([{ workerId: w, where: "report", report: 1 }]);
  });

  it("多个关键词都要包含（在同一处）；中文按子串；英文不分大小写", () => {
    const a = startTask("A", "修 Login 页面的 Timeout");
    startTask("B", "修登录页面");
    startTask("C", "Login 之外的事，Timeout 在别的地方");
    expect(search(["login"]).data.hits.map((h) => h.workerId)).toHaveLength(2);
    expect(search(["LOGIN", "timeout"]).data.hits.map((h) => h.workerId)).toEqual([a + 2, a]);
    expect(search(["登录", "页面"]).data.hits.map((h) => h.workerId)).toEqual([a + 1]);
    // 子串：不是整词
    expect(search(["录页"]).data.hits.map((h) => h.workerId)).toEqual([a + 1]);
    // 一个关键词没有就不算
    expect(search(["Login", "不存在"]).data.hits).toEqual([]);
  });

  it("只搜自己派的：别的项目经理派的搜不到；已收工的也搜得到，状态写已收工", () => {
    const mine = startTask("我的", "独一无二的暗号 alpha");
    ledger.hubCall(zhou.sessionId, "project.create", { folder: main }, {});
    const theirs = startTask("别人的", "也有暗号 alpha", zhou.sessionId);
    expect(search(["alpha"]).data.hits.map((h) => h.workerId)).toEqual([mine]);
    expect(search(["alpha"], undefined, zhou.sessionId).data.hits.map((h) => h.workerId)).toEqual([theirs]);
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: mine }, {});
    const text = search(["alpha"]).text;
    expect(text).toContain(`#${mine}“我的” · 已收工 · 任务：`);
  });

  it("最新的在前：按汇报或派活的时间倒序", () => {
    const old = startTask("旧", "话题 zeta");
    advance(10_000);
    const fresh = startTask("新", "话题 zeta");
    advance(10_000);
    reportTurn(old, reportText("zeta 的新结论"));
    expect(search(["zeta"]).data.hits.map((h) => `${h.workerId}${h.where}`)).toEqual([`${old}report`, `${fresh}task`, `${old}task`]);
  });

  it("上下文：前后合计不超过 80 个字，被截掉的那头有省略号；换行并成空格", () => {
    const long = `${"前".repeat(100)}关键${"后".repeat(100)}`;
    const w = startTask("长", long);
    const hit = search(["关键"]).data.hits[0]!;
    expect(hit.workerId).toBe(w);
    const body = hit.snippet.replace(/…/g, "");
    expect([...body].length).toBe(WORKER_SEARCH_CONTEXT_CHARS);
    expect(body).toContain("关键");
    expect(hit.snippet.startsWith("…") && hit.snippet.endsWith("…")).toBe(true);
    // 命中在开头：只有后面有省略号；短文本原样
    expect(snippetOf(`关键${"后".repeat(200)}`, ["关键"])).toMatch(/^关键后+…$/);
    expect(snippetOf("短 文\n本", ["文"])).toBe("短 文 本");
    expect(snippetOf("Hello WORLD", ["world"])).toBe("Hello WORLD");
  });

  it("--limit：默认 20 条，可调，超过上限报错；超出的提示还有几处", () => {
    for (let i = 0; i < WORKER_SEARCH_DEFAULT_LIMIT + 3; i++) startTask(`W${i}`, "批量 omega");
    const all = search(["omega"]);
    expect(all.data.hits).toHaveLength(WORKER_SEARCH_DEFAULT_LIMIT);
    expect(all.text).toContain(`搜到 ${WORKER_SEARCH_DEFAULT_LIMIT + 3} 处`);
    expect(all.text).toContain("还有 3 处没列");
    expect(search(["omega"], 2).data.hits).toHaveLength(2);
    expect(search(["omega"], WORKER_SEARCH_MAX_LIMIT).data.hits).toHaveLength(WORKER_SEARCH_DEFAULT_LIMIT + 3);
    for (const bad of [0, -1, 1.5, WORKER_SEARCH_MAX_LIMIT + 1]) expectLedgerError(() => search(["omega"], bad), "invalid", /--limit/);
  });

  it("没命中：一句话；关键词不合法报错", () => {
    startTask("X", "什么都没有");
    const r = search(["不存在", "foo"]);
    expect(r.data.hits).toEqual([]);
    expect(r.text).toBe("没有搜到同时包含 “不存在” “foo” 的 Worker 标题、任务说明或汇报。");
    expectLedgerError(() => search([]), "invalid", /关键词/);
    expectLedgerError(() => search(["  "]), "invalid", /关键词/);
    expectLedgerError(() => search(Array.from({ length: 11 }, (_, i) => `k${i}`)), "invalid", /最多/);
    expectLedgerError(() => search(["x".repeat(101)]), "invalid", /最多/);
  });

  it("项目经理之外不能用：Worker 调是 forbidden", () => {
    const w = startTask("X", "任务");
    expectLedgerError(() => search(["任务"], undefined, sessionOf(w)), "forbidden");
  });
});

describe("hub worker show --task / --report", () => {
  it("--task 输出任务说明原文，不加任何别的", () => {
    const task = "第一行\n第二行 `代码`\n  缩进";
    const w = startTask("T", task);
    expect(showTask(w).text).toBe(task);
  });

  it("--report 是最新一轮，--report N 是第 N 轮（从旧到新，和 search 的“汇报 #N”一致）；输出汇报原文，不带“【Worker … 的汇报】”开头", () => {
    const w = startTask("R", "任务");
    const r1 = reportText("第一轮", "一");
    const r2 = reportText("第二轮", "二");
    const r3 = reportText("第三轮", "三");
    reportTurn(w, r1);
    reportTurn(w, r2);
    reportTurn(w, r3);
    expect(showReport(w).text).toBe(r3);
    expect(showReport(w, 1).text).toBe(r1);
    expect(showReport(w, 2).text).toBe(r2);
    expect(showReport(w, 3).text).toBe(r3);
    expect(showReport(w).text).not.toContain("的汇报】");
    expectLedgerError(() => showReport(w, 4), "invalid", /只汇报过 3 次/);
    expectLedgerError(() => showReport(w, 0), "invalid", /正整数/);
    // search 里的“汇报 #2”读出来就是 show --report 2
    expect(search(["第二轮"]).text).toContain("汇报 #2：");
    expect(showReport(w, search(["第二轮"]).data.hits[0]!.report).text).toBe(r2);
  });

  it("还没汇报过：报错；--task 和 --report 不能一起；只能看自己派的；不带参数的 show 不变", () => {
    const w = startTask("R", "任务");
    expectLedgerError(() => showReport(w), "invalid", /还没有汇报过/);
    expectLedgerError(() => ledger.hubCall(lin.sessionId, "worker.show", { workerId: w, task: true, report: "latest" }, {}), "invalid", /只能用一个/);
    expectLedgerError(() => showTask(w, zhou.sessionId), "forbidden", /不是你派的/);
    expectLedgerError(() => showReport(w, 1, zhou.sessionId), "forbidden", /不是你派的/);
    expect(show(w).text).toContain(`Worker #${w}“R”：`);
  });
});
