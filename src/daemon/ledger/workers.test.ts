// M3 账本里的 Worker（m3-plan 第 3 节测试表 W2）：派活、在哪干活、按角色放行、汇报回到项目经理、出错、打回、收工、建 worktree。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import { askOf, workerEventOf } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId, WorkerId, WorkerRecord } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { HubArgs, HubCommand, WorkerHubStatus } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { HubCallContext, LedgerErrorCode, SetupOutcome, WorkspaceProbe } from "../../shared/ledger.ts";
import type { VendorAvailability } from "../../shared/vendors.ts";
import { MAX_SETUP_COMMAND_BYTES, MAX_TASK_BYTES, MAX_WORKER_TITLE_CHARS, SETUP_TIMEOUT_MS, WORKER_BACKGROUND_HOLD_MAX_MS } from "../../shared/limits.ts";
import { projectWorktreesDir, workerWorktreePath } from "../../shared/paths.ts";
import { REPORT_END, REPORT_START, workerBranchName } from "../../shared/worker.ts";
import { listActions } from "../actions/index.ts";
import { buildLaunchPrompt, SETUP_RECEIPT_NOTE, setupNote } from "../prompt.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

let db: Db;
let root: string;
let dataHome: string;
let worktreesDir: string;
let work: string;
let now: number;
let ledger: SqliteLedger;
let changes: Change[];
let enqueued: AnyActionRow[];
/** 假 git：哪些文件夹是有提交的仓库、哪些有没提交的改动。 */
let repos: Set<string>;
let dirty: Set<string>;
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
/** 小林的项目 foo 的主文件夹。 */
let main: string;
let projectId: number;

/** agent 接口探 git 的结果（这里按 repos、dirty 假装）。gitFails 不是 null 就是 git 没跑成。 */
let gitFails: string | null;
function probeOf(folder: string): WorkspaceProbe {
  if (gitFails !== null) return { kind: "failed", error: gitFails };
  return { kind: "ok", isRepoWithCommit: repos.has(folder), hasUncommittedChanges: dirty.has(folder) };
}

function options(extra: Partial<LedgerOptions> = {}): LedgerOptions {
  return {
    now: () => now,
    initialSeq: 9_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    ...extra,
  };
}

function folder(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync.native(dir);
}

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-ledger-m3-")));
  dataHome = join(root, ".agent-hub");
  worktreesDir = join(dataHome, "worktrees");
  work = join(root, "work");
  mkdirSync(work, { recursive: true });
  repos = new Set();
  dirty = new Set();
  gitFails = null;
  now = 1_000;
  ledger = createLedger(db, options());
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", defaultModel: "claude-sonnet-5-5" });
  const b = ledger.createPm({ name: "阿周", mode: "hands_on", persona: "" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId };
  main = folder("foo");
  projectId = ledger.hubCall(lin.sessionId, "project.create", { folder: main }).data.project.id;
  changes = [];
  enqueued = [];
  ledger.onChange((c) => changes.push(c));
  ledger.onActionEnqueued((x) => enqueued.push(x));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function hub<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>) {
  return ledger.hubCall(sessionId, command, args);
}

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

function count(table: string, where = "1 = 1", ...params: (string | number)[]): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;
}

function tableCounts() {
  return ["conversations", "agent_sessions", "messages", "actions", "workers"].map((t) => [t, count(t)]);
}

function messagesIn(conversationId: ConversationId): Message[] {
  return db
    .all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId)
    .map((r) => ledger.getMessage(r.id)!);
}

/** 项目经理对话里 Worker 的那几行。 */
function workerLines(conversationId: ConversationId = lin.conversationId): Message[] {
  return messagesIn(conversationId).filter((m) => m.kind === "worker");
}

function sessionRow(id: SessionId) {
  return createSessionStore(db).get(id)!;
}

function workerSessionId(workerId: WorkerId): SessionId {
  return db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!.id;
}

function actionsOf(type: AnyActionRow["type"]) {
  return listActions(db).filter((a) => a.type === type);
}

/** 像 agent 接口那样：没带 noWorktree 就先探主文件夹（workerStartFolder），把结果交给 hubCall。 */
function start(args: Partial<HubArgs<"worker.start">> = {}, caller: SessionId = lin.sessionId, extra: HubCallContext = {}) {
  const full = { title: "修 X", task: "把 X 修好，测试要过", ...args };
  const folder = full.noWorktree === true ? null : ledger.workerStartFolder(caller);
  const context: HubCallContext = { ...(folder === null ? {} : { workspace: probeOf(folder) }), ...extra };
  return ledger.hubCall(caller, "worker.start", full, context);
}

/** Worker 对话里第一条消息（任务说明）。 */
function taskMessage(worker: WorkerRecord): Message {
  return messagesIn(worker.workerConversationId)[0]!;
}

const report = (status: string, summary: string) =>
  `改好了。\n\n${REPORT_START}\n状态: ${status}\n摘要: ${summary}\n提交: abc123\n测试: pnpm test 通过\n问题: 无\n${REPORT_END}`;

/** Worker 的会话跑完一轮：送达、处理中、一段文字、result。 */
function runTurn(worker: WorkerRecord, messageIds: MessageId[], text: string | null, end: Partial<Extract<DriverEvent, { type: "turn.ended" }>> = {}) {
  const sessionId = workerSessionId(worker.id);
  ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds, at: now });
  ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds, at: now });
  if (text !== null) ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: `u-${messageIds.join("-")}-${now}`, text, at: now });
  ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds, durationMs: 10, at: now, ...end });
}

describe("派活：在 worktree 里干（主文件夹是有提交的 git 仓库）", () => {
  it("workers 一行、Worker 的对话和会话、任务说明、会话里一行“已派出”、登记 worktree.create、hub_calls 一行", () => {
    repos.add(main);
    now = 2_000;
    const result = start({ model: "claude-haiku-5-5" });
    const worker = result.data.worker;
    const path = workerWorktreePath(worktreesDir, projectId, worker.id);
    expect(worker).toEqual({
      id: 1,
      projectId,
      pmId: lin.pmId,
      pmConversationId: lin.conversationId,
      workerConversationId: expect.any(Number),
      title: "修 X",
      task: "把 X 修好，测试要过",
      model: "claude-haiku-5-5",
      effort: null,
      readonly: false,
      workspace: "worktree",
      branch: workerBranchName(1, "修 X"),
      worktreePath: path,
      baseCommit: null,
      status: "open",
      createdAt: 2_000,
      updatedAt: 2_000,
    });
    expect(db.get("SELECT kind, pm_id, project_id, title FROM conversations WHERE id = ?", worker.workerConversationId)).toEqual({
      kind: "worker",
      pm_id: lin.pmId,
      project_id: projectId,
      title: "修 X",
    });
    const session = sessionRow(workerSessionId(worker.id));
    expect(session).toMatchObject({
      role: "worker",
      conversationId: worker.workerConversationId,
      pmId: null,
      workerId: worker.id,
      cwd: path,
      addDirs: [],
      generation: 1,
      model: "claude-haiku-5-5",
      status: "idle",
    });
    expect(messagesIn(worker.workerConversationId)).toEqual([
      expect.objectContaining({ sender: "pm", kind: "text", text: "把 X 修好，测试要过", status: "queued", sessionId: session.id, workerId: worker.id }),
    ]);
    const [line] = workerLines();
    expect(line).toMatchObject({ sender: "system", kind: "worker", status: null, workerId: worker.id, sessionId: null });
    expect(workerEventOf(line!)).toEqual({
      workerId: worker.id,
      workerConversationId: worker.workerConversationId,
      title: "修 X",
      readonly: false,
      event: "started",
      status: null,
      summary: null,
    });
    expect(line!.text).toBe("Worker「修 X」已派出");
    // worktree 先建，建好了才起 Worker 的会话
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["worktree.create", { workerId: worker.id }]]);
    expect(actionsOf("session.start").filter((a) => a.type === "session.start" && a.params.sessionId === session.id)).toEqual([]);
    expect(db.get("SELECT command, ok FROM hub_calls ORDER BY id DESC LIMIT 1")).toEqual({ command: "worker.start", ok: 1 });
    expect(changes.map((c) => c.type)).toEqual(["conversation.created", "session.created", "message.created", "message.created"]);
    expect(result.text).toContain(path);
    expect(result.text).toContain(worker.branch!);
    expect(result.text).not.toContain("看不到");
  });

  it("项目经理的会话带上这个项目的 worktrees 目录（验收时能看 Worker 的改动），附加文件夹照旧", () => {
    repos.add(main);
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    expect(sessionRow(lin.sessionId).addDirs).toEqual([extra]);
    start();
    expect(sessionRow(lin.sessionId).addDirs).toEqual([extra, projectWorktreesDir(worktreesDir, projectId)]);
    // 之后再挂、移除文件夹也一直带着
    hub(lin.sessionId, "project.detach", { folder: extra });
    expect(sessionRow(lin.sessionId).addDirs).toEqual([projectWorktreesDir(worktreesDir, projectId)]);
  });

  it("不给 --model 就用项目经理自己的模型；--readonly 记在记录上，“已派出”那一行写明只读", () => {
    repos.add(main);
    const worker = start({ readonly: true }).data.worker;
    expect(worker).toMatchObject({ model: null, readonly: true });
    expect(sessionRow(workerSessionId(worker.id)).model).toBe("claude-sonnet-5-5");
    expect(workerLines()[0]!.text).toBe("Worker「修 X」已派出（只读）");
    expect(workerEventOf(workerLines()[0]!)?.readonly).toBe(true);
  });

  it("没有 OS 沙箱的机器上派只读 agy：直接报错说清原因（不建 Worker）；claude、codex 的只读、非只读的 agy 照派；有沙箱照派", () => {
    repos.add(main);
    ledger = createLedger(db, options({ osSandboxed: () => false }));
    const before = tableCounts();
    expectLedgerError(() => start({ vendor: "agy", readonly: true }), "invalid", /只读的 agy Worker 需要 OS 沙箱/);
    expect(tableCounts()).toEqual(before);
    expect(start({ vendor: "agy", readonly: false, title: "a" }).data.worker.readonly).toBe(false);
    expect(start({ vendor: "codex", readonly: true, title: "b" }).data.worker.readonly).toBe(true);
    expect(start({ vendor: "claude", readonly: true, title: "c" }).data.worker.readonly).toBe(true);
    ledger = createLedger(db, options({ osSandboxed: () => true }));
    expect(start({ vendor: "agy", readonly: true, title: "d" }).data.worker.readonly).toBe(true);
  });

  it("跨厂商派 Worker（--vendor）：换厂商时未显式传 model/effort 用 null（不把 claude 模型继承给 agy/codex），按目标厂商校验", () => {
    repos.add(main);
    // 项目经理 lin 默认是 claude + claude-sonnet-5-5
    const agyWorker = start({ vendor: "agy" }).data.worker;
    expect(sessionRow(workerSessionId(agyWorker.id))).toMatchObject({
      vendor: "agy",
      model: null,
      effort: null,
    });
    const codexWorker = start({ vendor: "codex", model: "gpt-5.4", effort: "xhigh" }).data.worker;
    expect(sessionRow(workerSessionId(codexWorker.id))).toMatchObject({
      vendor: "codex",
      model: "gpt-5.4",
      effort: "xhigh",
    });
    // codex 不支持 effort max
    expectLedgerError(() => start({ vendor: "codex", effort: "max" }), "invalid", /思考程度只能是 low、medium、high、xhigh/);
    // 非法厂商
    expectLedgerError(() => start({ vendor: "unknown" as never }), "invalid", /厂商只能是 claude、agy、codex/);
  });

  it("--vendor 选的厂商这台设备没装、没登录：报清楚是哪台、怎么登录，不派；能用、认不出的照派", () => {
    repos.add(main);
    const on = (availability: VendorAvailability) => ({ vendorStatus: { vendor: "codex" as const, availability, device: "东京" } });
    expectLedgerError(() => start({ vendor: "codex" }, lin.sessionId, on("not_installed")), "invalid", /^这台设备（东京）没装 codex$/);
    expectLedgerError(() => start({ vendor: "codex" }, lin.sessionId, on("signed_out")), "invalid", /这台设备（东京）的 codex 没登录.*`codex login`/);
    expect(start({ vendor: "codex", title: "a" }, lin.sessionId, on("available")).data.worker.id).toBeGreaterThan(0);
    expect(start({ vendor: "codex", title: "b" }, lin.sessionId, on("unknown")).data.worker.id).toBeGreaterThan(0);
  });

  it("agy 两种写法存成一样：--model gemini-4-argon-high（完整 ID，老用法）和 --model gemini-4-argon --effort high 都是 模型 gemini-4-argon + 思考程度 high", () => {
    repos.add(main);
    for (const args of [
      { model: "gemini-4-argon-high" },
      { model: "gemini-4-argon", effort: "high" },
      { model: "gemini-4-argon-high", effort: "high" },
    ]) {
      const worker = start({ vendor: "agy", ...args }).data.worker;
      expect(worker).toMatchObject({ model: "gemini-4-argon", effort: "high" });
      expect(sessionRow(workerSessionId(worker.id))).toMatchObject({ vendor: "agy", model: "gemini-4-argon", effort: "high" });
    }
    // 单一档位的模型、只有思考程度（模型沿用默认）
    expect(sessionRow(workerSessionId(start({ vendor: "agy", model: "gpt-oss-120b-medium" }).data.worker.id))).toMatchObject({ model: "gpt-oss-120b", effort: "medium" });
    expect(sessionRow(workerSessionId(start({ vendor: "agy", effort: "low" }).data.worker.id))).toMatchObject({ model: null, effort: "low" });
  });

  it("agy：完整 ID 的档位和 --effort 对不上、思考程度不是 low/medium/high：invalid，说清楚怎么改", () => {
    repos.add(main);
    expectLedgerError(() => start({ vendor: "agy", model: "gemini-4-argon-low", effort: "high" }), "invalid", /gemini-4-argon-low.*low.*high/);
    expectLedgerError(() => start({ vendor: "agy", model: "gemini-4-argon", effort: "xhigh" }), "invalid", /思考程度只能是 low、medium、high/);
  });

  it("主文件夹有没提交的改动：返回的话提醒 Worker 看不到这些改动", () => {
    repos.add(main);
    dirty.add(main);
    expect(start().text).toContain("Worker 是从最后一次提交开始的，看不到这些改动");
  });

  it("标题去首尾空白，超长截断，不报错", () => {
    repos.add(main);
    const worker = start({ title: `  ${"长".repeat(MAX_WORKER_TITLE_CHARS + 20)}  ` }).data.worker;
    expect([...worker.title]).toHaveLength(MAX_WORKER_TITLE_CHARS);
    expect(worker.title.endsWith("…")).toBe(true);
  });
});

describe("派活：在主文件夹里干", () => {
  it("主文件夹不是 git 仓库：workspace main，cwd 是主文件夹、附加文件夹和项目经理一样；不建 worktree，直接登记 session.start 和第一条 session.send", () => {
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    enqueued = [];
    const result = start();
    const worker = result.data.worker;
    expect(worker).toMatchObject({ workspace: "main", branch: null, worktreePath: null, baseCommit: null });
    const sessionId = workerSessionId(worker.id);
    expect(sessionRow(sessionId)).toMatchObject({ role: "worker", cwd: main, addDirs: [extra] });
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([
      ["session.start", { sessionId, generation: 1 }],
      ["session.send", { sessionId, messageId: taskMessage(worker).id, source: "user" }],
    ]);
    expect(actionsOf("worktree.create")).toEqual([]);
    expect(result.text).toContain(main);
    // 不用 worktree 的不给项目经理加 worktrees 目录
    expect(sessionRow(lin.sessionId).addDirs).toEqual([extra]);
  });

  it("是仓库但带 --no-worktree：也在主文件夹里干", () => {
    repos.add(main);
    const worker = start({ noWorktree: true }).data.worker;
    expect(worker.workspace).toBe("main");
    expect(sessionRow(workerSessionId(worker.id)).cwd).toBe(main);
    expect(actionsOf("worktree.create")).toEqual([]);
  });

  it("之后挂上的附加文件夹，在主文件夹里干活的 Worker 也带上", () => {
    const worker = start().data.worker;
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    expect(sessionRow(workerSessionId(worker.id)).addDirs).toEqual([extra]);
  });

  it("git 没跑成（超时、找不到 git、Xcode 许可证……）：报错说清楚原因和 --no-worktree，不默默改成在主文件夹里干，什么都没写", () => {
    repos.add(main);
    gitFails = "git 超过 5 秒没有结束，已中止（git rev-parse --verify --quiet HEAD）。";
    const before = tableCounts();
    let caught: unknown;
    try {
      start();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(LedgerRequestError);
    expect((caught as Error).message).toContain("git 没跑成");
    expect((caught as Error).message).toContain("超过 5 秒");
    expect((caught as Error).message).toContain("--no-worktree");
    expect(tableCounts()).toEqual(before);
    expect(db.get("SELECT ok, error_code FROM hub_calls ORDER BY id DESC LIMIT 1")).toEqual({ ok: 0, error_code: "internal" });
    // 明确选主文件夹就不看 git
    expect(start({ noWorktree: true }).data.worker.workspace).toBe("main");
  });

  it("没带 noWorktree 又没给探的结果：是调用方的错，抛错，什么都没写", () => {
    const before = tableCounts();
    expect(() => hub(lin.sessionId, "worker.start", { title: "修 X", task: "t" })).toThrow(/workspace/);
    expect(tableCounts()).toEqual(before);
  });

  it("workerStartFolder：项目经理的项目主文件夹；还没有项目、Worker 的会话、不存在的会话 → null", () => {
    expect(ledger.workerStartFolder(lin.sessionId)).toBe(main);
    expect(ledger.workerStartFolder(zhou.sessionId)).toBeNull();
    expect(ledger.workerStartFolder(999)).toBeNull();
    const worker = start({ noWorktree: true }).data.worker;
    expect(ledger.workerStartFolder(workerSessionId(worker.id))).toBeNull();
  });
});

describe("派活：边界", () => {
  it("没有项目、任务说明是空的或太长、标题不对：invalid，什么都没写", () => {
    const before = tableCounts();
    expectLedgerError(() => start({}, zhou.sessionId), "invalid", /项目/);
    expectLedgerError(() => start({ task: "  \n " }), "invalid");
    expectLedgerError(() => start({ task: "长".repeat(MAX_TASK_BYTES) }), "invalid");
    expectLedgerError(() => start({ title: "  " }), "invalid");
    expectLedgerError(() => start({ title: "a\nb" }), "invalid");
    expectLedgerError(() => start({ model: "m".repeat(101) }), "invalid");
    expect(tableCounts()).toEqual(before);
    expect(changes).toEqual([]);
    // 失败的调用也记 hub_calls
    expect(count("hub_calls", "command = 'worker.start' AND ok = 0")).toBe(6);
  });

  it("不限数量：连派 10 个都成功，各有各的分支和 worktree", () => {
    repos.add(main);
    const workers = Array.from({ length: 10 }, (_, i) => start({ title: `活 ${i}` }).data.worker);
    expect(workers.map((w) => w.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(workers.map((w) => w.branch)).size).toBe(10);
    expect(new Set(workers.map((w) => w.worktreePath)).size).toBe(10);
    expect(actionsOf("worktree.create")).toHaveLength(10);
  });
});

describe("同一个文件夹的两个项目经理各派 Worker", () => {
  it("分支名按全局的 Worker 编号，worktree 按项目编号分目录，不撞；准备命令各用各的", () => {
    repos.add(main);
    const zhouProject = hub(zhou.sessionId, "project.create", { folder: main }).data.project;
    hub(zhou.sessionId, "project.setup", { command: "pnpm install" });
    const a = start({ title: "修 X" }).data.worker;
    const b = start({ title: "修 X" }, zhou.sessionId).data.worker;
    expect([a.projectId, b.projectId]).toEqual([projectId, zhouProject.id]);
    expect(a.id).not.toBe(b.id);
    expect(a.branch).not.toBe(b.branch);
    expect([a.branch, b.branch]).toEqual([`hub/${a.id}-修-x`, `hub/${b.id}-修-x`]);
    expect(a.worktreePath).toBe(join(worktreesDir, String(projectId), String(a.id)));
    expect(b.worktreePath).toBe(join(worktreesDir, String(zhouProject.id), String(b.id)));
    expect(ledger.getWorktreeTask(a.id)).toMatchObject({ repo: main, setupCommand: null });
    expect(ledger.getWorktreeTask(b.id)).toMatchObject({ repo: main, setupCommand: "pnpm install" });
    // 项目经理的会话只带自己项目那一层 worktrees 目录
    expect(sessionRow(lin.sessionId).addDirs).toEqual([join(worktreesDir, String(projectId))]);
    expect(sessionRow(zhou.sessionId).addDirs).toEqual([join(worktreesDir, String(zhouProject.id))]);
    // 各自只看到自己派的
    expect(hub(lin.sessionId, "worker.list", {}).data.workers.map((w) => w.id)).toEqual([a.id]);
    expect(hub(zhou.sessionId, "worker.list", {}).data.workers.map((w) => w.id)).toEqual([b.id]);
  });
});

describe("按角色放行", () => {
  it("Worker 调 persona.edit、project.create、worker.* → forbidden；status 能用，返回自己的记录", () => {
    repos.add(main);
    const worker = start().data.worker;
    const sessionId = workerSessionId(worker.id);
    const before = tableCounts();
    expectLedgerError(() => hub(sessionId, "persona.edit", { text: "改" }), "forbidden", /Worker/);
    expectLedgerError(() => hub(sessionId, "persona.show", {}), "forbidden");
    expectLedgerError(() => hub(sessionId, "project.create", { folder: folder("bar") }), "forbidden");
    expectLedgerError(() => hub(sessionId, "project.attach", { folder: folder("bar") }), "forbidden");
    expectLedgerError(() => start({}, sessionId), "forbidden");
    expectLedgerError(() => hub(sessionId, "worker.list", {}), "forbidden");
    expectLedgerError(() => hub(sessionId, "worker.end", { workerId: worker.id }), "forbidden");
    expect(tableCounts()).toEqual(before);
    expect(count("hub_calls", "session_id = ? AND error_code = 'forbidden'", sessionId)).toBe(7);

    const status = hub(sessionId, "status", {});
    const data = status.data as WorkerHubStatus;
    expect(data).toMatchObject({
      role: "worker",
      pm: { id: lin.pmId, name: "小林" },
      sessionId,
      conversationId: worker.workerConversationId,
      worker: { id: worker.id, title: "修 X", task: "把 X 修好，测试要过", workspace: "worktree" },
      project: { id: projectId, mainFolder: main },
    });
    expect(status.text).toContain("Worker #1");
    expect(status.text).toContain(worker.worktreePath!);
    expect(status.text).toContain("把 X 修好，测试要过");
  });

  it("项目经理照常能用 status（PmHubStatus）", () => {
    expect(hub(lin.sessionId, "status", {}).data).toMatchObject({ role: "pm", pm: { id: lin.pmId } });
  });
});

describe("Worker 的启动上下文", () => {
  it("role worker、Worker 的记录、项目名片、派它的项目经理", () => {
    repos.add(main);
    const worker = start().data.worker;
    const sessionId = workerSessionId(worker.id);
    expect(ledger.getLaunchContext(sessionId)).toEqual({
      sessionId,
      role: "worker",
      conversationId: worker.workerConversationId,
      pm: { id: lin.pmId, name: "小林", mode: "manage_only", persona: "" },
      project: { id: projectId, name: "foo", description: null, mainFolder: main, otherFolders: [] },
      worker,
      // Worker 自己那家（提示词按它写长命令怎么等）
      vendor: "claude",
    });
    expect(ledger.getLaunchContext(lin.sessionId)).toMatchObject({ role: "pm", worker: null });
  });
});

describe("建 worktree（worktree.create 处理函数用）", () => {
  it("getWorktreeTask：主文件夹、分支、目录；在主文件夹里干的、不存在的 → null", () => {
    repos.add(main);
    const worker = start().data.worker;
    expect(ledger.getWorktreeTask(worker.id)).toEqual({
      workerId: worker.id,
      sessionId: workerSessionId(worker.id),
      repo: main,
      branch: worker.branch,
      worktreePath: worker.worktreePath,
      status: "open",
      setupCommand: null,
    });
    expect(ledger.getWorktreeTask(999)).toBeNull();
    expect(ledger.getWorktreeTask(start({ noWorktree: true }).data.worker.id)).toBeNull();
  });

  it("onWorktreeCreated：记下起点提交，登记 Worker 的 session.start 和任务说明的 session.send；重复调用不重复登记、不改提交", () => {
    repos.add(main);
    const worker = start().data.worker;
    const sessionId = workerSessionId(worker.id);
    enqueued = [];
    now = 3_000;
    ledger.onWorktreeCreated(worker.id, "c0ffee");
    expect(db.get("SELECT base_commit, updated_at FROM workers WHERE id = ?", worker.id)).toEqual({ base_commit: "c0ffee", updated_at: 3_000 });
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([
      ["session.start", { sessionId, generation: 1 }],
      ["session.send", { sessionId, messageId: taskMessage(worker).id, source: "user" }],
    ]);
    enqueued = [];
    ledger.onWorktreeCreated(worker.id, "other");
    expect(enqueued).toEqual([]);
    expect(db.get<{ base_commit: string }>("SELECT base_commit FROM workers WHERE id = ?", worker.id)!.base_commit).toBe("c0ffee");
  });

  it("Worker 已经收工：onWorktreeCreated 什么也不做", () => {
    repos.add(main);
    const worker = start().data.worker;
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    enqueued = [];
    ledger.onWorktreeCreated(worker.id, "c0ffee");
    expect(enqueued).toEqual([]);
    expect(db.get<{ base_commit: string | null }>("SELECT base_commit FROM workers WHERE id = ?", worker.id)!.base_commit).toBeNull();
  });

  it("建 worktree 彻底失败：Worker 标 ended，项目经理会话里一行写明原因并交给它，任务说明标 failed", () => {
    repos.add(main);
    const worker = start().data.worker;
    const action = actionsOf("worktree.create")[0]!;
    enqueued = [];
    ledger.onActionFailed(action, "git worktree add 失败：磁盘满了");
    expect(db.get<{ status: string }>("SELECT status FROM workers WHERE id = ?", worker.id)!.status).toBe("ended");
    const line = workerLines().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "worktree_failed", summary: "git worktree add 失败：磁盘满了", status: null });
    expect(line).toMatchObject({ status: "queued", sessionId: lin.sessionId });
    expect(line.text.startsWith("【Worker #1 · 修 X 的汇报】")).toBe(true);
    expect(line.text).toContain("磁盘满了");
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([
      ["session.end", { sessionId: workerSessionId(worker.id), generation: 1 }],
      ["session.send", { sessionId: lin.sessionId, messageId: line.id, source: "system" }],
    ]);
    expect(taskMessage(worker)).toMatchObject({ status: "failed", failureReason: "git worktree add 失败：磁盘满了" });
    // 重复调用不出第二行
    ledger.onActionFailed(action, "git worktree add 失败：磁盘满了");
    expect(workerLines().filter((m) => workerEventOf(m)?.event === "worktree_failed")).toHaveLength(1);
  });
});

describe("汇报回到项目经理", () => {
  let worker: WorkerRecord;
  beforeEach(() => {
    worker = start().data.worker;
    enqueued = [];
  });

  it("这一轮 result：会话里一行（状态、摘要），全文交给项目经理（session.send，开头“【Worker #N”）；重放同一个 result 只有一行", () => {
    const text = report("做完了", "X 修好了");
    runTurn(worker, [taskMessage(worker).id], text);
    const lines = workerLines().filter((m) => workerEventOf(m)?.event === "report");
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(workerEventOf(line)).toEqual({
      workerId: worker.id,
      workerConversationId: worker.workerConversationId,
      title: "修 X",
      readonly: false,
      event: "report",
      status: "done",
      summary: "X 修好了",
    });
    expect(line).toMatchObject({ sender: "system", status: "queued", sessionId: lin.sessionId, workerId: worker.id });
    expect(line.text).toBe(`【Worker #1 · 修 X 的汇报】\n\n${text}`);
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId: lin.sessionId, messageId: line.id, source: "system" }]]);
    expect(taskMessage(worker).status).toBe("replied");
    // 重放
    enqueued = [];
    ledger.applyDriverEvent(workerSessionId(worker.id), {
      type: "turn.ended",
      ok: true,
      interrupted: false,
      messageIds: [taskMessage(worker).id],
      durationMs: 10,
      at: now,
    });
    expect(workerLines().filter((m) => workerEventOf(m)?.event === "report")).toHaveLength(1);
    expect(enqueued).toEqual([]);
  });

  it("没按格式：那一行写“没按格式”、摘要是原文第一行，原文照样交给项目经理", () => {
    runTurn(worker, [taskMessage(worker).id], "我看了一下\n还没想好");
    const line = workerLines().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "report", status: "unformatted", summary: "我看了一下" });
    expect(line.text).toContain("我看了一下\n还没想好");
  });

  it("取这一轮最后一段文字", () => {
    const sessionId = workerSessionId(worker.id);
    const id = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "a", text: report("有问题", "前一段"), at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.tool", uuid: "b", toolUseId: "t", name: "Bash", input: { command: "ls" }, at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "c", text: report("做完了", "最后一段"), at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [id], durationMs: 1, at: now });
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ status: "done", summary: "最后一段" });
  });

  it("项目经理自己的会话的一轮结束不发这一行", () => {
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: now });
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started"]);
  });
});

describe("出错、停止", () => {
  let worker: WorkerRecord;
  beforeEach(() => {
    worker = start().data.worker;
    enqueued = [];
  });

  const lastLine = () => workerLines().at(-1)!;

  it("被停止（turn.ended 打断）：一行“被停止了”，交给项目经理", () => {
    runTurn(worker, [taskMessage(worker).id], null, { ok: false, interrupted: true });
    expect(workerEventOf(lastLine())).toMatchObject({ event: "turn_failed", summary: "被停止了" });
    expect(lastLine().text.startsWith("【Worker #1 · 修 X 的汇报】")).toBe(true);
    expect(enqueued.map((a) => a.params)).toEqual([{ sessionId: lin.sessionId, messageId: lastLine().id, source: "system" }]);
  });

  it("这一轮出错（ok=false）：一行写明错误", () => {
    runTurn(worker, [taskMessage(worker).id], null, { ok: false, error: { subtype: "error_during_execution", message: "炸了" } });
    expect(workerEventOf(lastLine())).toMatchObject({ event: "turn_failed", summary: "error_during_execution: 炸了" });
    expect(lastLine().text).toContain("炸了");
  });

  it("断网重试用完（result 是 success 但 is_error）：turn_failed 写 claude 给的原因，不带 “success:” 前缀", () => {
    const sessionId = workerSessionId(worker.id);
    ledger.applyDriverEvent(sessionId, {
      type: "api_retry",
      info: { attempt: 10, maxRetries: 10, retryAt: now + 1_000, errorStatus: null, error: "unknown" },
      at: now,
    });
    runTurn(worker, [taskMessage(worker).id], null, {
      ok: false,
      error: { subtype: "success", message: "API Error: Unable to connect to API (ConnectionRefused)" },
    });
    expect(workerEventOf(lastLine())).toMatchObject({ event: "turn_failed", summary: "API Error: Unable to connect to API (ConnectionRefused)" });
    expect(lastLine().text).toContain("Unable to connect to API");
  });

  it("进程崩溃、打断没回应（没有 result 就退出）：一行写明退出码或信号", () => {
    const sessionId = workerSessionId(worker.id);
    const id = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: false, messageIds: [id], at: now });
    expect(workerEventOf(lastLine())).toMatchObject({ event: "turn_failed", summary: "crash: exit code 1" });
  });

  it("守护进程关机打断的一轮、空闲退出：不发这一行；重启后接着做完照常汇报", () => {
    const sessionId = workerSessionId(worker.id);
    const id = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "shutdown", exitCode: null, signal: "SIGTERM", hadResult: false, messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: now });
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started"]);
    expect(enqueued).toEqual([]);
    // 消息不标已停止，还是处理中：重启恢复把它重发给同一个会话
    expect(ledger.getMessage(id)!.status).toBe("processing");
    expect(ledger.recoverAfterRestart().resentMessageIds).toEqual([id]);
  });

  it("关机时 SIGINT 结束的一轮（turn.ended 打断、带 shutdown）：不发“被停止了”，消息还是处理中；重启后接着做完再汇报", () => {
    const sessionId = workerSessionId(worker.id);
    const id = taskMessage(worker).id;
    runTurn(worker, [id], "做到一半", { ok: false, interrupted: true, shutdown: true, error: { subtype: "error_during_execution", message: "interrupted" } });
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started"]);
    expect(enqueued).toEqual([]);
    expect(ledger.getMessage(id)!.status).toBe("processing");
    // 动作表清空，模拟上次运行的动作都做完了
    db.run("DELETE FROM actions");
    const recovered = ledger.recoverAfterRestart();
    expect(recovered.resentMessageIds).toEqual([id]);
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId, messageId: id, source: "user", resend: true, recovery: true }]]);
    // 重启后接着做完：照常一行汇报
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "after-restart", text: report("做完了", "接着做完了"), at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [id], durationMs: 1, at: now });
    expect(ledger.getMessage(id)!.status).toBe("replied");
    expect(workerLines().map((m) => workerEventOf(m))).toEqual([
      expect.objectContaining({ event: "started" }),
      expect.objectContaining({ event: "report", status: "done", summary: "接着做完了" }),
    ]);
  });

  it("项目经理的会话被关机打断：用户自己发的照 M2 标已停止；交给它的汇报不改状态，重启后重发给同一个会话", () => {
    const user = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "c1", text: "在吗" }).messageId;
    runTurn(worker, [taskMessage(worker).id], report("做完了", "好了"));
    const delivered = workerLines().at(-1)!.id;
    for (const [ids, type] of [[[user, delivered], "message.delivered"], [[user, delivered], "message.processing"]] as const) {
      ledger.applyDriverEvent(lin.sessionId, { type, messageIds: [...ids], at: now });
    }
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, shutdown: true, messageIds: [user, delivered], durationMs: 1, at: now });
    expect(ledger.getMessage(user)!.status).toBe("stopped");
    expect(ledger.getMessage(delivered)!.status).toBe("processing");
    db.run("DELETE FROM actions");
    enqueued = [];
    expect(ledger.recoverAfterRestart().resentMessageIds).toEqual([delivered]);
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([
      ["session.send", { sessionId: lin.sessionId, messageId: delivered, source: "system", resend: true, recovery: true }],
    ]);
  });

  it("项目经理的会话关机时没等到 result 就退出（session.exited shutdown）：同样只留下交给它的汇报", () => {
    const user = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "c2", text: "在吗" }).messageId;
    runTurn(worker, [taskMessage(worker).id], report("做完了", "好了"));
    const delivered = workerLines().at(-1)!.id;
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [user, delivered], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "session.exited", reason: "shutdown", exitCode: null, signal: "SIGKILL", hadResult: false, messageIds: [user, delivered], at: now });
    expect(ledger.getMessage(user)!.status).toBe("stopped");
    expect(ledger.getMessage(delivered)!.status).toBe("delivered");
  });

  it("同一条消息先失败、重发后跑出结果：两行都有，后来的汇报不被吞掉", () => {
    const id = taskMessage(worker).id;
    runTurn(worker, [id], null, { ok: false, error: { subtype: "error_during_execution", message: "炸了" } });
    // 重发由执行器做：消息 failed → 再送达、处理中
    runTurn(worker, [id], report("做完了", "好了"));
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "turn_failed", "report"]);
  });
});

describe("向用户提问（hub ask）", () => {
  it("在项目经理的对话里发一条带 needsUser 标记的消息，不发给 agent、推 message.created、记 hub_calls", () => {
    enqueued = [];
    changes = [];
    const result = hub(lin.sessionId, "ask", { text: "用 **A** 还是 B？" });
    const message = ledger.getMessage(result.data.messageId)!;
    expect(message).toMatchObject({
      conversationId: lin.conversationId,
      sessionId: lin.sessionId,
      workerId: null,
      sender: "agent",
      kind: "text",
      text: "用 **A** 还是 B？",
      status: null,
    });
    expect(askOf(message)).toEqual({ needsUser: true });
    expect(enqueued).toEqual([]);
    expect(changes).toMatchObject([{ type: "message.created", data: { message: { id: message.id } } }]);
    expect(count("hub_calls", "command = 'ask' AND ok = 1")).toBe(1);
  });

  it("连问两次是两条消息", () => {
    const a = hub(lin.sessionId, "ask", { text: "问 1" }).data.messageId;
    const b = hub(lin.sessionId, "ask", { text: "问 1" }).data.messageId;
    expect(b).not.toBe(a);
  });

  it("Worker 不能用 → forbidden，什么也没写；正文空的 → invalid", () => {
    const worker = start().data.worker;
    const before = tableCounts();
    expectLedgerError(() => hub(workerSessionId(worker.id), "ask", { text: "问" }), "forbidden");
    expectLedgerError(() => hub(lin.sessionId, "ask", { text: "  " }), "invalid");
    expect(tableCounts()).toEqual(before);
  });
});

describe("打回", () => {
  it("worker.send：Worker 对话里一条项目经理的话，发给同一个 Worker 会话", () => {
    const worker = start().data.worker;
    const sessionId = workerSessionId(worker.id);
    enqueued = [];
    const result = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "测试没过，再看看" });
    const message = ledger.getMessage(result.data.messageId)!;
    expect(message).toMatchObject({
      conversationId: worker.workerConversationId,
      sessionId,
      workerId: worker.id,
      sender: "pm",
      kind: "text",
      text: "测试没过，再看看",
      status: "queued",
    });
    expect(result.data.worker.id).toBe(worker.id);
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId, messageId: message.id, source: "user" }]]);
    expect(changes.at(-1)).toMatchObject({ type: "message.created" });
    expect(count("agent_sessions", "worker_id = ?", worker.id)).toBe(1);
  });

  it("别的项目经理派的 → forbidden；不存在 → not_found；已收工 → conflict；正文空的、太长 → invalid", () => {
    const worker = start().data.worker;
    const zhouMain = folder("zhou");
    hub(zhou.sessionId, "project.create", { folder: zhouMain });
    const before = tableCounts();
    expectLedgerError(() => hub(zhou.sessionId, "worker.send", { workerId: worker.id, text: "x" }), "forbidden");
    expectLedgerError(() => hub(zhou.sessionId, "worker.end", { workerId: worker.id }), "forbidden");
    expectLedgerError(() => hub(lin.sessionId, "worker.send", { workerId: 999, text: "x" }), "not_found");
    expectLedgerError(() => hub(lin.sessionId, "worker.send", { workerId: worker.id, text: " " }), "invalid");
    expectLedgerError(() => hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "长".repeat(MAX_TASK_BYTES) }), "invalid");
    expect(tableCounts()).toEqual(before);
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expectLedgerError(() => hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "x" }), "conflict");
  });

  it("worker.send 发隐藏的命令（/clear 会换会话 ID）：拦下，invalid 带厂商给的原因，不存不发；别的命令照常发", () => {
    const worker = start().data.worker;
    const before = tableCounts();
    expectLedgerError(() => hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "/clear" }), "invalid", /^\/clear：.*会话/);
    expectLedgerError(() => hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "/model opus" }), "invalid", /资料页/);
    expect(tableCounts()).toEqual(before);
    expect(hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "/compact" }).data.messageId).toBeGreaterThan(0);
  });
});

describe("收工", () => {
  it("worker.end：登记 session.end，Worker 标 ended，会话里一行“已收工”；再调一次什么也不做", () => {
    repos.add(main);
    const worker = start().data.worker;
    const sessionId = workerSessionId(worker.id);
    enqueued = [];
    now = 5_000;
    const result = hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(result.data.worker).toMatchObject({ id: worker.id, status: "ended", updatedAt: 5_000 });
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.end", { sessionId, generation: 1 }]]);
    const line = workerLines().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "ended", status: null, summary: null });
    expect(line).toMatchObject({ status: null, text: "Worker「修 X」已收工" });
    // worktree 留给项目经理自己删
    expect(result.text).toContain("git worktree remove");

    const before = tableCounts();
    enqueued = [];
    const again = hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(again.data.worker.status).toBe("ended");
    expect(tableCounts()).toEqual(before);
    expect(enqueued).toEqual([]);
  });

  describe.each(["claude", "agy", "codex"] as const)("收工时打断正在跑的一轮（%s）", (vendor) => {
    let worker: WorkerRecord;
    let stops: SessionId[];
    const activityOf = (workerId: WorkerId) => ledger.snapshot().sessions.find((s) => s.sessionId === workerSessionId(workerId))!.activity;
    beforeEach(() => {
      worker = start({ vendor, noWorktree: true }).data.worker;
      stops = [];
      ledger.onStopRequested(({ sessionId }) => stops.push(sessionId));
      enqueued = [];
    });

    it("在跑：先走停止的路径（通知打断、标正在停），回复写“已打断正在跑的那一轮”，这一轮被停止了也不给项目经理汇报", () => {
      const sessionId = workerSessionId(worker.id);
      const id = taskMessage(worker).id;
      ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
      ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [id], at: now });
      const result = hub(lin.sessionId, "worker.end", { workerId: worker.id });
      expect(result.text).toContain("已打断正在跑的那一轮");
      expect(result.data.worker.status).toBe("ended");
      expect(stops).toEqual([sessionId]);
      expect(activityOf(worker.id)).toBe("stopping");
      expect(enqueued.map((a) => a.type)).toEqual(["session.end"]);
      const before = workerLines().length;
      ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: false, interrupted: true, messageIds: [id], durationMs: 1, at: now });
      expect(ledger.getMessage(id)!.status).toBe("stopped");
      expect(workerLines().length).toBe(before);
      expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "ended"]);
    });

    it("有排队待送的消息（没人在跑）：用户的标已取消，项目经理的标已停止，也算打断", () => {
      const sessionId = workerSessionId(worker.id);
      const queuedPm = taskMessage(worker).id;
      const userMessage = ledger.postUserMessage({ conversationId: worker.workerConversationId, clientId: "c1", text: "插一句" }).messageId;
      const result = hub(lin.sessionId, "worker.end", { workerId: worker.id });
      expect(result.text).toContain("已打断正在跑的那一轮");
      expect(stops).toEqual([sessionId]);
      expect(ledger.getMessage(userMessage)!.status).toBe("cancelled");
      expect(ledger.getMessage(queuedPm)!.status).toBe("stopped");
    });

    it("没在跑：和以前一样，不通知打断，回复里没有“已打断”", () => {
      runTurn(worker, [taskMessage(worker).id], report("做完了", "好了"));
      expect(activityOf(worker.id)).toBe("idle");
      const result = hub(lin.sessionId, "worker.end", { workerId: worker.id });
      expect(result.text).not.toContain("已打断");
      expect(result.text).toContain("已收工");
      expect(stops).toEqual([]);
      // 跑完那一轮的汇报还在发给项目经理，收工只多一个 session.end
      expect(enqueued.map((a) => a.type)).toEqual(["session.send", "session.end"]);
    });
  });

  it("worker.list：我派出去的 Worker，按编号，含已收工的；别的项目经理的不在里面", () => {
    const a = start({ title: "甲" }).data.worker;
    const b = start({ title: "乙" }).data.worker;
    hub(lin.sessionId, "worker.end", { workerId: a.id });
    hub(zhou.sessionId, "project.create", { folder: folder("zhou") });
    start({ title: "丙" }, zhou.sessionId);
    const result = hub(lin.sessionId, "worker.list", {});
    expect(result.data.workers.map((w) => [w.id, w.title, w.status])).toEqual([
      [a.id, "甲", "ended"],
      [b.id, "乙", "open"],
    ]);
    expect(result.text).toContain("甲");
    expect(result.text).toContain("乙");
    expect(hub(zhou.sessionId, "worker.list", {}).data.workers.map((w) => w.title)).toEqual(["丙"]);
  });
});

describe("派活：思考程度（--effort）", () => {
  it("给了就记在 Worker 记录和会话上；没给就和项目经理现在的一样（资料页改过的话是改过的）", () => {
    const own = start({ title: "甲", effort: "high" }).data.worker;
    expect(own).toMatchObject({ model: null, effort: "high" });
    expect(sessionRow(workerSessionId(own.id))).toMatchObject({ vendor: "claude", model: "claude-sonnet-5-5", effort: "high" });
    // 项目经理的思考程度是默认：Worker 也是默认（不传 --effort）
    const inherit = start({ title: "乙" }).data.worker;
    expect(inherit).toMatchObject({ model: null, effort: null });
    expect(sessionRow(workerSessionId(inherit.id))).toMatchObject({ model: "claude-sonnet-5-5", effort: null });
    // 用户在资料页改了项目经理的模型、思考程度：之后派的 Worker 跟着新的
    ledger.editPersona(lin.pmId, { model: "opus", effort: "max" }, { kind: "user" });
    const after = start({ title: "丙" }).data.worker;
    expect(sessionRow(workerSessionId(after.id))).toMatchObject({ model: "opus", effort: "max" });
    // 已经派出去的不变
    expect(sessionRow(workerSessionId(inherit.id))).toMatchObject({ model: "claude-sonnet-5-5", effort: null });
  });

  it("思考程度不在清单里、模型名带不合规的字符：invalid，什么都没写", () => {
    const before = tableCounts();
    expectLedgerError(() => start({ effort: "ultra" }), "invalid", /思考程度只能是 low、medium、high、xhigh、max/);
    expectLedgerError(() => start({ effort: "LOW" }), "invalid", /思考程度/);
    expectLedgerError(() => start({ model: "haiku; rm -rf" }), "invalid", /模型名只能用/);
    expect(tableCounts()).toEqual(before);
  });

  it("worker.list 写明每个 Worker 实际用的模型和思考程度", () => {
    const a = start({ title: "甲", model: "haiku", effort: "low" }).data.worker;
    const b = start({ title: "乙" }).data.worker;
    const text = hub(lin.sessionId, "worker.list", {}).text;
    expect(text).toContain(`#${a.id} 甲 · 进行中 · `);
    expect(text).toContain("模型 Haiku · 思考程度 low");
    expect(text).toContain(`#${b.id} 乙`);
    expect(text).toContain("模型 Sonnet 5.5 · 思考程度 默认");
  });
});

describe("审查后补的（PR #34）", () => {
  it("重启恢复：worktree 还没建好的 Worker，任务说明不提前登记；建好之后才登记", () => {
    repos.add(main);
    const worker = start().data.worker;
    enqueued = [];
    const recovered = ledger.recoverAfterRestart();
    expect(recovered.requeuedMessageIds).not.toContain(taskMessage(worker).id);
    expect(enqueued).toEqual([]);
    ledger.onWorktreeCreated(worker.id, "c0ffee");
    expect(enqueued.map((a) => a.type)).toEqual(["session.start", "session.send"]);
  });

  it("重启恢复：已收工的 Worker 的消息不再发；在主文件夹里干的照常恢复", () => {
    const ended = start({ noWorktree: true }).data.worker;
    const open = start({ noWorktree: true, title: "另一个" }).data.worker;
    const endedMessage = hub(lin.sessionId, "worker.send", { workerId: ended.id, text: "再看看" }).data.messageId;
    const sessionId = workerSessionId(ended.id);
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [endedMessage], at: now });
    hub(lin.sessionId, "worker.end", { workerId: ended.id });
    // 动作表清空，模拟上次运行留下的消息都没有活动动作
    db.run("DELETE FROM actions");
    const recovered = ledger.recoverAfterRestart();
    expect([...recovered.resentMessageIds, ...recovered.requeuedMessageIds]).not.toContain(endedMessage);
    expect(recovered.recoveredSessionIds).not.toContain(sessionId);
    expect(recovered.requeuedMessageIds).toContain(taskMessage(open).id);
  });

  it("worktree 建好之前就收工：任务说明标已停止，不会一直排队", () => {
    repos.add(main);
    const worker = start().data.worker;
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(taskMessage(worker).status).toBe("stopped");
  });

  it("Worker 的消息发不出去（session.send 次数用完）：项目经理收到一行 turn_failed，去重键是那条消息", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const send = actionsOf("session.send").find((a) => a.type === "session.send" && a.params.messageId === taskMessage(worker).id)!;
    enqueued = [];
    ledger.onActionFailed(send, "claude_not_found: 找不到 claude");
    expect(taskMessage(worker)).toMatchObject({ status: "failed", failureReason: "claude_not_found: 找不到 claude" });
    const line = workerLines().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "turn_failed", summary: "claude_not_found: 找不到 claude" });
    expect(line.dedupeKey).toBe(`worker:${worker.id}:turn_failed:${taskMessage(worker).id}`);
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId: lin.sessionId, messageId: line.id, source: "system" }]]);
    ledger.onActionFailed(send, "claude_not_found: 找不到 claude");
    expect(workerLines().filter((m) => workerEventOf(m)?.event === "turn_failed")).toHaveLength(1);
  });

  it("已收工的 Worker 的消息发不出去：不再给项目经理发一行", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const messageId = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "再看看" }).data.messageId;
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    const send = actionsOf("session.send").find((a) => a.type === "session.send" && a.params.messageId === messageId)!;
    ledger.onActionFailed(send, "这个会话已经结束，发不出去了");
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "ended"]);
  });

  it("项目经理自己的消息发不出去：不发 Worker 那一行", () => {
    const worker = start({ noWorktree: true }).data.worker;
    runTurn(worker, [taskMessage(worker).id], report("做完了", "好了"));
    const line = workerLines().at(-1)!;
    const send = actionsOf("session.send").find((a) => a.type === "session.send" && a.params.messageId === line.id)!;
    ledger.onActionFailed(send, "claude_not_found: 找不到 claude");
    expect(ledger.getMessage(line.id)!.status).toBe("failed");
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "report"]);
  });

  it("驱动层报了带消息编号的错（driver.error）：一行 turn_failed 交给项目经理", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const id = taskMessage(worker).id;
    ledger.applyDriverEvent(workerSessionId(worker.id), {
      type: "driver.error",
      code: "invalid_input",
      message: "invalid_input: 写不进去",
      messageIds: [id],
      at: now,
    });
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ event: "turn_failed", summary: "invalid_input: 写不进去" });
  });

  it("这一轮没有自己的文字：按“没有文字回复”处理，不拿上一轮的旧文字", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    const first = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [first], at: now });
    // 第一轮还在跑时项目经理又发了一句（编号比第一轮的文字小）
    const second = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "顺便看看 Y" }).data.messageId;
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "first", text: "第一轮的结论", at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [first], durationMs: 1, at: now });
    runTurn(worker, [second], null);
    const line = workerLines().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "report", status: "unformatted", summary: "" });
    expect(line.text).not.toContain("第一轮的结论");
    expect(line.text).toContain("没有文字回复");
  });

  it("一轮中途送达的话（message.delivered midTurn）不算这一轮的开头：这一轮前面写的汇报照样交给项目经理", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    const first = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "r1", text: report("做完了", "前半段就做完了")!, at: now });
    const second = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "顺便看看 Y" }).data.messageId;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [second], midTurn: true, at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [second], at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [first, second], durationMs: 1, at: now });
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ event: "report", status: "done", summary: "前半段就做完了" });
  });

  it("中途写进去的话没赶上这一轮、claude 为它另起的下一轮只调工具没文字：不把上一轮的汇报再发一遍", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    const first = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [first], at: now });
    // 中途写进去（编号比这一轮最后那段文字小），这一轮没读到它就结束了
    const second = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "顺便看看 Y" }).data.messageId;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [second], midTurn: true, at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "r1", text: report("做完了", "第一轮做完了")!, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [first], durationMs: 1, at: now });
    // claude 为它另起一轮：只调工具，没有文字
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [second], at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.tool", uuid: "t1", toolUseId: "tu1", name: "Bash", input: { command: "ls" }, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [second], durationMs: 1, at: now });
    const reports = workerLines().filter((m) => workerEventOf(m)?.event === "report");
    expect(reports.map((m) => workerEventOf(m)?.summary)).toEqual(["第一轮做完了", ""]);
    expect(reports[1]!.text).toContain("没有文字回复");
  });

  it("只做了 /compact、没有文字的一轮：不给项目经理发汇报；Worker 对话里那行“已压缩上下文”照留", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    runTurn(worker, [taskMessage(worker).id], report("做完了", "第一轮"));
    const reportsBefore = workerLines().filter((l) => workerEventOf(l)?.event === "report").length;
    const compact = ledger.postUserMessage({ conversationId: worker.workerConversationId, clientId: "compact", text: "/compact" }).messageId;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [compact], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [compact], at: now });
    ledger.applyDriverEvent(sessionId, { type: "context.compacted", uuid: "cb-w", trigger: "manual", preTokens: 100, postTokens: 10, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [compact], durationMs: 10, at: now });
    expect(workerLines().filter((l) => workerEventOf(l)?.event === "report")).toHaveLength(reportsBefore);
    expect(ledger.getMessage(compact)?.status).toBe("replied");
    expect(messagesIn(worker.workerConversationId).some((m) => m.sender === "system" && m.text === "已压缩上下文")).toBe(true);
    // 下一轮照常汇报（压缩只算那一轮）
    const next = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "接着做" }).data.messageId;
    runTurn(worker, [next], report("做完了", "第二轮"));
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ event: "report", summary: "第二轮" });
  });

  it("压缩了但这一轮也有文字（自动压缩后接着干活）：照常汇报", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    const first = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "context.compacted", uuid: "cb-auto", trigger: "auto", preTokens: 100, postTokens: 10, at: now });
    runTurn(worker, [first], report("做完了", "压缩后做完"));
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ event: "report", summary: "压缩后做完" });
  });

  it("自动压缩（trigger: auto）、这一轮以工具调用收尾没有文字：照常汇报，项目经理不干等", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    const first = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.tool", uuid: "t1", toolUseId: "tu1", name: "Bash", input: { command: "ls" }, at: now });
    ledger.applyDriverEvent(sessionId, { type: "context.compacted", uuid: "cb-auto2", trigger: "auto", preTokens: 100, postTokens: 10, at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.tool", uuid: "t2", toolUseId: "tu2", name: "Bash", input: { command: "pwd" }, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [first], durationMs: 10, at: now });
    const line = workerLines().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "report", status: "unformatted" });
    expect(line.text).toContain("没有文字回复");
  });

  it("自动压缩、这一轮什么 agent 消息都没有：也照常汇报（只有手动 /compact 才跳过）", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    const first = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [first], at: now });
    ledger.applyDriverEvent(sessionId, { type: "context.compacted", uuid: "cb-auto3", trigger: "auto", preTokens: 100, postTokens: 10, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [first], durationMs: 10, at: now });
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ event: "report" });
  });

  it("手动 /compact 但这一轮还做了别的（有工具调用）：照常汇报", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    runTurn(worker, [taskMessage(worker).id], report("做完了", "第一轮"));
    const reportsBefore = workerLines().filter((l) => workerEventOf(l)?.event === "report").length;
    const compact = ledger.postUserMessage({ conversationId: worker.workerConversationId, clientId: "compact2", text: "/compact" }).messageId;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [compact], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [compact], at: now });
    ledger.applyDriverEvent(sessionId, { type: "context.compacted", uuid: "cb-m2", trigger: "manual", preTokens: 100, postTokens: 10, at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.tool", uuid: "t3", toolUseId: "tu3", name: "Bash", input: { command: "ls" }, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [compact], durationMs: 10, at: now });
    expect(workerLines().filter((l) => workerEventOf(l)?.event === "report")).toHaveLength(reportsBefore + 1);
  });

  it("hub worker send /compact：返回文案说这一轮只压缩上下文、不会有汇报；别的话还是“做完一轮汇报会自动发给你”", () => {
    const worker = start({ noWorktree: true }).data.worker;
    runTurn(worker, [taskMessage(worker).id], report("做完了", "第一轮"));
    for (const text of ["/compact", "/compact 只留结论"]) {
      const reply = hub(lin.sessionId, "worker.send", { workerId: worker.id, text }).text;
      expect(reply, text).toMatch(/只压缩上下文，不会有汇报/);
      expect(reply, text).not.toMatch(/自动发给你/);
    }
    expect(hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "接着做" }).text).toMatch(/做完一轮汇报会自动发给你/);
  });

  it("建 worktree 彻底失败：也登记 Worker 会话的 session.end", () => {
    repos.add(main);
    const worker = start().data.worker;
    const action = actionsOf("worktree.create")[0]!;
    enqueued = [];
    ledger.onActionFailed(action, "git worktree add 失败");
    expect(enqueued.map((a) => [a.type, a.params])).toContainEqual(["session.end", { sessionId: workerSessionId(worker.id), generation: 1 }]);
  });

  it("收工后正在跑的那一轮照样汇报给项目经理", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = workerSessionId(worker.id);
    const id = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [id], at: now });
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "late", text: report("做完了", "收工前做完的"), at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [id], durationMs: 1, at: now });
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "ended", "report"]);
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ summary: "收工前做完的" });
  });
});

describe("worktree 准备命令（hub project setup）", () => {
  const outcome = (over: Partial<SetupOutcome> = {}): SetupOutcome => ({
    kind: "ok",
    command: "pnpm install",
    exitCode: 0,
    signal: null,
    error: null,
    timeoutMs: SETUP_TIMEOUT_MS,
    durationMs: 23_400,
    tail: "",
    logPath: "/data/state/logs/setup/worker-1.log",
    logError: null,
    ...over,
  });
  const setup = (command: string | null) => hub(lin.sessionId, "project.setup", { command });
  const activityOf = (workerId: WorkerId) =>
    ledger.snapshot().sessions.find((s) => s.sessionId === workerSessionId(workerId))!.activity;

  it("24 设置、清除：写进 projects.setup_command，hub_calls 都记；不推变化、不改会话", () => {
    changes = [];
    const set = setup("pnpm install --frozen-lockfile --ignore-scripts");
    expect(set.data.setupCommand).toBe("pnpm install --frozen-lockfile --ignore-scripts");
    expect(set.text).toContain("已设好");
    expect(db.get("SELECT setup_command FROM projects WHERE id = ?", projectId)).toEqual({ setup_command: "pnpm install --frozen-lockfile --ignore-scripts" });
    const cleared = setup(null);
    expect(cleared.data.setupCommand).toBeNull();
    expect(cleared.text).toContain("已清除");
    expect(db.get("SELECT setup_command FROM projects WHERE id = ?", projectId)).toEqual({ setup_command: null });
    expect(count("hub_calls", "command = 'project.setup' AND ok = 1")).toBe(2);
    expect(changes).toEqual([]);
  });

  it("24b 空的、带 NUL、超长 → invalid；没有项目 → not_found；Worker 调 → forbidden；失败的也记 hub_calls", () => {
    expectLedgerError(() => setup("  \n"), "invalid", /--clear/);
    expectLedgerError(() => setup("a\0b"), "invalid", /NUL/);
    expectLedgerError(() => setup("中".repeat(Math.floor(MAX_SETUP_COMMAND_BYTES / 3) + 1)), "invalid", /字节/);
    expectLedgerError(() => hub(zhou.sessionId, "project.setup", { command: "x" }), "not_found");
    const worker = start({ noWorktree: true }).data.worker;
    expectLedgerError(() => hub(workerSessionId(worker.id), "project.setup", { command: "x" }), "forbidden");
    expect(db.get("SELECT setup_command FROM projects WHERE id = ?", projectId)).toEqual({ setup_command: null });
    expect(count("hub_calls", "command = 'project.setup' AND ok = 0")).toBe(5);
  });

  it("25 hub status：显示准备命令，没配说没配", () => {
    expect(hub(lin.sessionId, "status", {} as never).text).toContain("准备命令：没配");
    setup("pnpm install");
    const status = hub(lin.sessionId, "status", {} as never);
    expect(status.data).toMatchObject({ setupCommand: "pnpm install" });
    expect(status.text).toContain("pnpm install");
    // 没有项目：不提准备命令
    const none = hub(zhou.sessionId, "status", {} as never);
    expect(none.data).toMatchObject({ project: null, setupCommand: null });
    expect(none.text).not.toContain("准备命令");
  });

  it("26 改准备命令：项目经理会话的提示词（指纹的来源）不变，不重启", () => {
    const before = buildLaunchPrompt(ledger.getLaunchContext(lin.sessionId), main);
    const row = sessionRow(lin.sessionId);
    setup("pnpm install");
    expect(buildLaunchPrompt(ledger.getLaunchContext(lin.sessionId), main)).toBe(before);
    expect(sessionRow(lin.sessionId)).toEqual(row);
  });

  it("27 派活回执：配了命令又用 worktree 才有那一句；--no-worktree、没配都没有", () => {
    repos.add(main);
    expect(start().text).not.toContain(SETUP_RECEIPT_NOTE);
    setup("pnpm install");
    expect(start({ title: "乙" }).text).toContain(SETUP_RECEIPT_NOTE);
    expect(start({ title: "丙", noWorktree: true }).text).not.toContain(SETUP_RECEIPT_NOTE);
  });

  it("getWorktreeTask 带着现在的准备命令（跑的那一刻取）", () => {
    repos.add(main);
    const worker = start().data.worker;
    expect(ledger.getWorktreeTask(worker.id)!.setupCommand).toBeNull();
    setup("pnpm install");
    expect(ledger.getWorktreeTask(worker.id)!.setupCommand).toBe("pnpm install");
  });

  it("19 onSetupStarted：会话推 session.status preparing；hub worker list 显示“准备中”；跑完回到空闲", () => {
    repos.add(main);
    const worker = start().data.worker;
    changes = [];
    ledger.onSetupStarted(worker.id);
    expect(changes).toEqual([{ type: "session.status", seq: expect.any(Number), data: { session: expect.objectContaining({ sessionId: workerSessionId(worker.id), activity: "preparing" }) } }]);
    expect(activityOf(worker.id)).toBe("preparing");
    expect(hub(lin.sessionId, "worker.list", {}).text).toContain(`#${worker.id} 修 X · 准备中`);
    ledger.onWorktreeCreated(worker.id, "c0ffee", outcome());
    expect(activityOf(worker.id)).toBe("idle");
    expect(hub(lin.sessionId, "worker.list", {}).text).toContain(`#${worker.id} 修 X · 进行中`);
  });

  it("19b onSetupStarted：已收工、已经开工的什么也不做", () => {
    repos.add(main);
    const ended = start().data.worker;
    hub(lin.sessionId, "worker.end", { workerId: ended.id });
    const started = start({ title: "乙" }).data.worker;
    ledger.onWorktreeCreated(started.id, "c0ffee");
    changes = [];
    ledger.onSetupStarted(ended.id);
    ledger.onSetupStarted(started.id);
    expect(changes).toEqual([]);
  });

  it("19c 准备中点停止：标“正在停”、通知停止的监听者（组装代码接到 setup.cancel）；跑完回到空闲", () => {
    repos.add(main);
    const worker = start().data.worker;
    ledger.onSetupStarted(worker.id);
    const stops: SessionId[] = [];
    ledger.onStopRequested(({ sessionId }) => stops.push(sessionId));
    ledger.requestStop(worker.workerConversationId);
    expect(stops).toEqual([workerSessionId(worker.id)]);
    expect(activityOf(worker.id)).toBe("stopping");
    ledger.onWorktreeCreated(worker.id, "c0ffee", outcome({ kind: "stopped", exitCode: null }));
    expect(activityOf(worker.id)).toBe("idle");
    expect(taskMessage(worker).text).toContain("被用户停止了");
  });

  it("20 失败：任务说明前面加上原因、命令、输出最后几行和日志，推 message.updated；登记第一轮；workers.task 是原文", () => {
    repos.add(main);
    const worker = start().data.worker;
    ledger.onSetupStarted(worker.id);
    changes = [];
    enqueued = [];
    ledger.onWorktreeCreated(worker.id, "c0ffee", outcome({ kind: "failed", exitCode: 1, tail: "ERR_PNPM_OUTDATED_LOCKFILE\n第二行" }));
    const task = taskMessage(worker);
    expect(task.text.startsWith("【系统】建好 worktree 后跑项目的准备命令没成功（退出码 1，用时 23 秒，日志：/data/state/logs/setup/worker-1.log）")).toBe(true);
    expect(task.text).toContain("```\npnpm install\n```");
    expect(task.text).toContain("```\nERR_PNPM_OUTDATED_LOCKFILE\n第二行\n```");
    expect(task.text.endsWith("下面是任务说明。\n\n把 X 修好，测试要过")).toBe(true);
    expect(task.status).toBe("queued");
    expect(changes.filter((c) => c.type === "message.updated")).toEqual([{ type: "message.updated", seq: expect.any(Number), data: { message: task } }]);
    expect(enqueued.map((a) => a.type)).toEqual(["session.start", "session.send"]);
    expect(db.get("SELECT task, base_commit FROM workers WHERE id = ?", worker.id)).toEqual({ task: "把 X 修好，测试要过", base_commit: "c0ffee" });
  });

  it("20b 超时、起不来、被信号结束、日志没写成、没有输出：附注写对原因", () => {
    const note = (o: SetupOutcome) => setupNote(o);
    expect(note(outcome({ kind: "timeout", exitCode: null }))).toContain(`超过 ${SETUP_TIMEOUT_MS / 60_000} 分钟没跑完，被中止了`);
    expect(note(outcome({ kind: "failed", exitCode: null, error: "准备命令起不来：spawn /bin/nope ENOENT" }))).toContain("spawn /bin/nope ENOENT");
    expect(note(outcome({ kind: "failed", exitCode: null, signal: "SIGKILL" }))).toContain("被信号 SIGKILL 结束了");
    expect(note(outcome({ kind: "failed", exitCode: 2, logError: "EACCES" }))).toContain("日志没写成：EACCES");
    expect(note(outcome({ kind: "failed", exitCode: 2, tail: "" }))).toContain("（没有输出）");
  });

  it("21 成功：任务说明前面只加一行（用时、日志），登记第一轮", () => {
    repos.add(main);
    const worker = start().data.worker;
    enqueued = [];
    ledger.onWorktreeCreated(worker.id, "c0ffee", outcome());
    expect(taskMessage(worker).text).toBe(
      "【系统】已经在这个 worktree 里跑过项目的准备命令（用时 23 秒，日志：/data/state/logs/setup/worker-1.log）。\n\n把 X 修好，测试要过",
    );
    expect(enqueued.map((a) => a.type)).toEqual(["session.start", "session.send"]);
    // 重复调用（重启恢复撞上）不再加一遍
    ledger.onWorktreeCreated(worker.id, "c0ffee", outcome());
    expect(taskMessage(worker).text.match(/【系统】/g)).toHaveLength(1);
  });

  it("22 准备中收工：跑完后 onWorktreeCreated 什么也不做（不登记第一轮、不改任务说明），状态回到空闲", () => {
    repos.add(main);
    const worker = start().data.worker;
    ledger.onSetupStarted(worker.id);
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    enqueued = [];
    ledger.onWorktreeCreated(worker.id, "c0ffee", outcome({ kind: "stopped", exitCode: null }));
    expect(enqueued).toEqual([]);
    expect(taskMessage(worker)).toMatchObject({ text: "把 X 修好，测试要过", status: "stopped" });
    expect(activityOf(worker.id)).toBe("idle");
  });

  it("23 重启恢复：只给 open、在 worktree 里、还没开工的重新登记 worktree.create（做完了的那一行重置成 pending）", () => {
    repos.add(main);
    const waiting = start({ title: "等着" }).data.worker;
    const ended = start({ title: "收工了" }).data.worker;
    hub(lin.sessionId, "worker.end", { workerId: ended.id });
    const started = start({ title: "开工了" }).data.worker;
    ledger.onWorktreeCreated(started.id, "c0ffee");
    start({ title: "主文件夹", noWorktree: true });
    // 上次运行 worktree.create 都做完了（准备命令在后台跑的时候关机了）
    db.run("UPDATE actions SET status = 'done' WHERE type = 'worktree.create'");
    enqueued = [];
    ledger.recoverAfterRestart();
    expect(enqueued.filter((a) => a.type === "worktree.create").map((a) => [a.params, a.status])).toEqual([[{ workerId: waiting.id }, "pending"]]);
    expect(actionsOf("worktree.create").filter((a) => a.status === "pending").map((a) => a.params)).toEqual([{ workerId: waiting.id }]);
  });
});

describe("准备命令：审查后补的（PR #47）", () => {
  const sessionOfWorker = (workerId: WorkerId) => workerSessionId(workerId);
  const activityOf = (workerId: WorkerId) =>
    ledger.snapshot().sessions.find((s) => s.sessionId === workerSessionId(workerId))!.activity;

  it("R1 还没开工（准备中）的 Worker：hub worker send 拒绝（conflict，说清楚原因），什么都没写", () => {
    repos.add(main);
    const worker = start().data.worker;
    ledger.onSetupStarted(worker.id);
    const before = tableCounts();
    expectLedgerError(() => hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "顺便看看 Y" }), "conflict", /Worker 还在准备，等它开工后再发/);
    expect(tableCounts()).toEqual(before);
    // 开工以后照常能发
    ledger.onWorktreeCreated(worker.id, "c0ffee");
    expect(hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "顺便看看 Y" }).data.worker.id).toBe(worker.id);
  });

  it("R1 waitsForFirstTurn：没开工的、任务说明还没写进去时别的消息都要等；任务说明本身、写进去之后、项目经理的会话不等", () => {
    repos.add(main);
    const worker = start().data.worker;
    const sessionId = sessionOfWorker(worker.id);
    const task = taskMessage(worker).id;
    // 准备中：什么都等（连任务说明也还没到发的时候）
    expect(ledger.waitsForFirstTurn(sessionId, task)).toBe(true);
    expect(ledger.waitsForFirstTurn(sessionId, 9_999)).toBe(true);
    ledger.onWorktreeCreated(worker.id, "c0ffee");
    const other = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "再补一句" }).data.messageId;
    // 开工了、任务说明还在排队：任务说明先走，别的等它
    expect(ledger.waitsForFirstTurn(sessionId, task)).toBe(false);
    expect(ledger.waitsForFirstTurn(sessionId, other)).toBe(true);
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [task], at: now });
    expect(ledger.waitsForFirstTurn(sessionId, other)).toBe(false);
    expect(ledger.waitsForFirstTurn(lin.sessionId, 1)).toBe(false);
  });

  it("R1 在主文件夹里干的 Worker：任务说明还在排队时，别的消息也等它", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const sessionId = sessionOfWorker(worker.id);
    const other = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "再补一句" }).data.messageId;
    expect(ledger.waitsForFirstTurn(sessionId, taskMessage(worker).id)).toBe(false);
    expect(ledger.waitsForFirstTurn(sessionId, other)).toBe(true);
  });

  it("R1 准备中不会被驱动层的事件盖成“干活中”", () => {
    repos.add(main);
    const worker = start().data.worker;
    ledger.onSetupStarted(worker.id);
    const sessionId = sessionOfWorker(worker.id);
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [taskMessage(worker).id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.tool", uuid: "t", toolUseId: "t", name: "Bash", input: { command: "ls" }, at: now });
    expect(activityOf(worker.id)).toBe("preparing");
  });

  it("R2 onSetupStarted 返回有没有真的进准备中：已收工、已经开工的返回 false", () => {
    repos.add(main);
    const worker = start().data.worker;
    expect(ledger.onSetupStarted(worker.id)).toBe(true);
    const ended = start({ title: "乙" }).data.worker;
    hub(lin.sessionId, "worker.end", { workerId: ended.id });
    expect(ledger.onSetupStarted(ended.id)).toBe(false);
    const started = start({ title: "丙" }).data.worker;
    ledger.onWorktreeCreated(started.id, "c0ffee");
    expect(ledger.onSetupStarted(started.id)).toBe(false);
    expect(ledger.onSetupStarted(9_999)).toBe(false);
  });
});

describe("用户直接对 Worker 说（网页上的 Worker 页面）", () => {
  let worker: WorkerRecord;
  let sessionId: SessionId;
  beforeEach(() => {
    worker = start({ noWorktree: true }).data.worker;
    sessionId = workerSessionId(worker.id);
    enqueued = [];
    changes = [];
  });

  const post = (text: string, clientId = `c-${text}`) =>
    ledger.postUserMessage({ conversationId: worker.workerConversationId, clientId, text }).messageId;
  const userMessageLines = () => workerLines().filter((m) => workerEventOf(m)?.event === "user_message");

  it("发一条：Worker 对话里一条 sender user、带 Worker 编号的排队消息，登记 session.send（source user）；项目经理那边这时还没有那一行", () => {
    const id = post("顺便把 README 也改了");
    expect(ledger.getMessage(id)).toMatchObject({
      conversationId: worker.workerConversationId,
      sessionId,
      workerId: worker.id,
      sender: "user",
      kind: "text",
      text: "顺便把 README 也改了",
      status: "queued",
    });
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId, messageId: id, source: "user" }]]);
    expect(userMessageLines()).toEqual([]);
  });

  it("项目经理对话里用户发的消息照旧不带 Worker 编号", () => {
    const id = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "pm-1", text: "在吗" }).messageId;
    expect(ledger.getMessage(id)!.workerId).toBeNull();
  });

  it("Worker 收到了（message.delivered）：同一个事务里项目经理对话多一行 user_message，全文带标签和原文，交给项目经理（source system）", () => {
    const id = post("顺便把 README 也改了");
    enqueued = [];
    changes = [];
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    const [line] = userMessageLines();
    expect(workerEventOf(line!)).toEqual({
      workerId: worker.id,
      workerConversationId: worker.workerConversationId,
      title: "修 X",
      readonly: false,
      event: "user_message",
      status: null,
      summary: "顺便把 README 也改了",
    });
    expect(line).toMatchObject({ sender: "system", kind: "worker", status: "queued", sessionId: lin.sessionId, workerId: worker.id });
    expect(line!.text).toBe("【用户直接对 Worker #1 · 修 X 说的话（Worker 已收到）】\n\n顺便把 README 也改了");
    expect(line!.dedupeKey).toBe(`worker:${worker.id}:user_message:${id}`);
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId: lin.sessionId, messageId: line!.id, source: "system" }]]);
    // 消息状态和那一行在同一批变化里
    expect(changes.map((c) => c.type)).toEqual(["message.updated", "message.created", "session.status"]);
  });

  it("带附件：交给项目经理的全文里有附件的完整路径，那一行的摘要还是用户写的字", () => {
    const attachment = { id: "u1", name: "图.png", path: "/data/uploads/u1/图.png", size: 10, mime: "image/png" };
    const id = ledger.postUserMessage({ conversationId: worker.workerConversationId, clientId: "f", text: "看这张图", attachments: [attachment] }).messageId;
    expect(ledger.getMessage(id)).toMatchObject({ workerId: worker.id, meta: { attachments: [attachment] } });
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    const line = userMessageLines()[0]!;
    expect(workerEventOf(line)?.summary).toBe("看这张图");
    expect(line.text).toContain(attachment.path);
  });

  it("一轮中途送达的（midTurn）：等 Worker 真的读到（处理中）才交给项目经理；读到之前点了停止、被取消的，项目经理那边没有这一行", () => {
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [taskMessage(worker).id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [taskMessage(worker).id], at: now });
    const cancelled = post("先别动 Y");
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [cancelled], midTurn: true, at: now });
    expect(userMessageLines()).toEqual([]);
    ledger.requestStop(worker.workerConversationId);
    ledger.applyDriverEvent(sessionId, { type: "message.cancelled", messageIds: [cancelled], reason: "stop", at: now });
    expect(ledger.getMessage(cancelled)!.status).toBe("cancelled");
    expect(userMessageLines()).toEqual([]);
    // 读到了的：处理中时交给项目经理，只一行
    const taken = post("改 README");
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [taken], midTurn: true, at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [taken], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [taken], at: now });
    expect(userMessageLines().map((m) => workerEventOf(m)?.summary)).toEqual(["改 README"]);
  });

  it("同一个 delivered 重放（重启后重发）：还是只有一行，只登记一次", () => {
    const id = post("改 README");
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    enqueued = [];
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    expect(userMessageLines()).toHaveLength(1);
    expect(enqueued).toEqual([]);
  });

  it("Worker 已收工：发消息、重试失败的消息都是 conflict，什么都没写", () => {
    const failed = post("先发一条");
    const send = actionsOf("session.send").find((a) => a.type === "session.send" && a.params.messageId === failed)!;
    ledger.onActionFailed(send, "claude_not_found: 找不到 claude");
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    const before = tableCounts();
    enqueued = [];
    expectLedgerError(() => post("还在吗"), "conflict", /收工/);
    expectLedgerError(() => ledger.retryMessage(failed), "conflict", /收工/);
    expect(tableCounts()).toEqual(before);
    expect(enqueued).toEqual([]);
    expect(ledger.getMessage(failed)!.status).toBe("failed");
  });

  it("收工前同一个 clientId 已经发过：重发返回已有的编号，不报错", () => {
    const id = post("改 README", "same");
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(post("改 README", "same")).toBe(id);
  });

  it("收工时用户的话还在排队（Worker 正忙）：照停止的规则标已取消，项目经理不会收到 user_message", () => {
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [taskMessage(worker).id], at: now });
    const id = post("先别动 Y");
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(ledger.getMessage(id)!.status).toBe("cancelled");
    expect(userMessageLines()).toEqual([]);
  });

  it("worktree 还没建好（Worker 还在准备）：发消息是 conflict（还在准备），什么都没写；建好之后能发，排在任务说明后面", () => {
    repos.add(main);
    const w = start({ title: "等 worktree" }).data.worker;
    const before = tableCounts();
    const postTo = () => ledger.postUserMessage({ conversationId: w.workerConversationId, clientId: "early", text: "先别动 Y" });
    expectLedgerError(postTo, "conflict", /还在准备/);
    expect(tableCounts()).toEqual(before);
    ledger.onWorktreeCreated(w.id, "c0ffee");
    const id = postTo().messageId;
    // 任务说明先进驱动层，用户的话排在后面
    const sends = actionsOf("session.send").filter((a) => a.type === "session.send" && a.params.sessionId === workerSessionId(w.id));
    expect(sends.map((a) => a.type === "session.send" && a.params.messageId)).toEqual([taskMessage(w).id, id]);
  });

  it("worktree 没建好时重试一条失败的消息也是 conflict（还在准备）", () => {
    repos.add(main);
    const w = start({ title: "等 worktree" }).data.worker;
    ledger.onWorktreeCreated(w.id, "c0ffee");
    const id = ledger.postUserMessage({ conversationId: w.workerConversationId, clientId: "r", text: "改 README" }).messageId;
    db.run("UPDATE messages SET status = 'failed' WHERE id = ?", id);
    // 模拟“准备中”（PR #47 起准备命令跑完才写 base_commit）
    db.run("UPDATE workers SET base_commit = NULL WHERE id = ?", w.id);
    expectLedgerError(() => ledger.retryMessage(id), "conflict", /还在准备/);
    expect(ledger.getMessage(id)!.status).toBe("failed");
  });

  it("消息已经取消了才收到 delivered（收工时被标已取消，驱动层的事件晚到）：不发“Worker 已收到”那一行", () => {
    const id = post("改 README");
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(ledger.getMessage(id)!.status).toBe("cancelled");
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    expect(userMessageLines()).toEqual([]);
  });

  it("这一轮里有用户的话、这一轮出错：turn_failed 交给项目经理的话里带用户的原文，写明用户可以自己点重试", () => {
    runTurn(worker, [taskMessage(worker).id], report("做完了", "第一轮"));
    const id = post("顺便改 README");
    runTurn(worker, [id], null, { ok: false, error: { subtype: "error_during_execution", message: "炸了" } });
    expect(ledger.getMessage(id)!.status).toBe("failed");
    const line = workerLines().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "turn_failed" });
    expect(line.text).toContain("「顺便改 README」");
    expect(line.text).toContain("自己点重试");
  });

  it("用户的话发不出去（session.send 次数用完）：turn_failed 里同样带原文和重试说明；项目经理的话发不出去不带", () => {
    const id = post("顺便改 README");
    const send = actionsOf("session.send").find((a) => a.type === "session.send" && a.params.messageId === id)!;
    ledger.onActionFailed(send, "claude_not_found: 找不到 claude");
    const line = workerLines().at(-1)!;
    expect(line.text).toContain("「顺便改 README」");
    expect(line.text).toContain("自己点重试");
    const fromPm = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "再看看" }).data.messageId;
    const pmSend = actionsOf("session.send").find((a) => a.type === "session.send" && a.params.messageId === fromPm)!;
    ledger.onActionFailed(pmSend, "claude_not_found: 找不到 claude");
    expect(workerLines().at(-1)!.text).not.toContain("重试");
  });

  it("Worker 正忙时用户连发两条：都排队；一起送达后项目经理收到两行，各带各的原文", () => {
    const task = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [task], at: now });
    const a = post("第一条");
    const b = post("第二条");
    expect([a, b].map((id) => ledger.getMessage(id)!.status)).toEqual(["queued", "queued"]);
    expect(userMessageLines()).toEqual([]);
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [task], durationMs: 1, at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [a, b], at: now });
    expect(userMessageLines().map((m) => workerEventOf(m)?.summary)).toEqual(["第一条", "第二条"]);
  });

  it("项目经理和用户同时发：一起送达，只有用户那条通知项目经理；这一轮结束照常一行汇报，去重键用这一轮最大的编号", () => {
    const task = taskMessage(worker).id;
    runTurn(worker, [task], report("做完了", "第一轮"));
    const fromPm = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "再跑一遍测试" }).data.messageId;
    const fromUser = post("顺便改 README");
    runTurn(worker, [fromPm, fromUser], report("做完了", "都做了"));
    expect(userMessageLines().map((m) => workerEventOf(m)?.summary)).toEqual(["顺便改 README"]);
    const last = workerLines().at(-1)!;
    expect(workerEventOf(last)).toMatchObject({ event: "report", summary: "都做了" });
    expect(last.dedupeKey).toBe(`worker:${worker.id}:report:${Math.max(fromPm, fromUser)}`);
    expect([fromPm, fromUser].map((id) => ledger.getMessage(id)!.status)).toEqual(["replied", "replied"]);
  });

  it("用户的消息发不出去（session.send 次数用完）：标失败，项目经理收到一行 turn_failed", () => {
    const id = post("改 README");
    const send = actionsOf("session.send").find((a) => a.type === "session.send" && a.params.messageId === id)!;
    ledger.onActionFailed(send, "claude_not_found: 找不到 claude");
    expect(ledger.getMessage(id)).toMatchObject({ status: "failed", failureReason: "claude_not_found: 找不到 claude" });
    expect(workerLines().at(-1)!.dedupeKey).toBe(`worker:${worker.id}:turn_failed:${id}`);
    // 重试：回到排队，重新登记（执行器在调 onActionFailed 前已经把动作标 failed）
    db.run("UPDATE actions SET status = 'failed' WHERE id = ?", send.id);
    enqueued = [];
    ledger.retryMessage(id);
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId, messageId: id, source: "user" }]]);
  });

  it("关机打断有用户的话的那一轮：消息不标已停止，重启后重发给同一个会话；交给项目经理的那一行也重发", () => {
    const task = taskMessage(worker).id;
    runTurn(worker, [task], report("做完了", "第一轮"));
    const id = post("改 README");
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: false, interrupted: true, shutdown: true, messageIds: [id], durationMs: 1, at: now });
    expect(ledger.getMessage(id)!.status).toBe("processing");
    const line = userMessageLines()[0]!;
    // 项目经理那边也在处理那一行时被关机打断
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [line.id], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, shutdown: true, messageIds: [line.id], durationMs: 1, at: now });
    db.run("DELETE FROM actions");
    enqueued = [];
    const recovered = ledger.recoverAfterRestart();
    expect(recovered.resentMessageIds).toEqual(expect.arrayContaining([id, line.id]));
    expect(enqueued.map((a) => [a.type, a.params])).toEqual(
      expect.arrayContaining([
        ["session.send", { sessionId, messageId: id, source: "user", resend: true, recovery: true }],
        ["session.send", { sessionId: lin.sessionId, messageId: line.id, source: "system", resend: true, recovery: true }],
      ]),
    );
    // 重启后再送达：不多出一行
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    expect(userMessageLines()).toHaveLength(1);
  });

  it("老数据：Worker 对话里没有 Worker 编号的消息送达了，不发 user_message", () => {
    const id = post("老的");
    db.run("UPDATE messages SET worker_id = NULL WHERE id = ?", id);
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    expect(userMessageLines()).toEqual([]);
  });
});

describe("项目经理开新会话（ledger/handover.ts）时 Worker 的汇报", () => {
  /** 小林这一轮跑完（送达、处理中、文字、正常结束）。 */
  function pmTurn(sessionId: SessionId, messageIds: MessageId[], text: string) {
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds, at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds, at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: `pm-${messageIds.join("-")}`, text, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds, durationMs: 10, at: now });
  }

  it("换代前交给旧会话；交接写好、小林还在忙这一轮时压着，换代后改发给新会话；之后的直接给新会话。Worker 照常干活", () => {
    const worker = start({ noWorktree: true }).data.worker;
    const task = taskMessage(worker);
    runTurn(worker, [task.id], report("做完了", "第一轮"));
    const before = workerLines().at(-1)!;
    expect(before.sessionId).toBe(lin.sessionId);
    pmTurn(lin.sessionId, [before.id], "收到");

    // 后台写交接：跑腿的领走、复制好；小林这时在忙一轮，交接写好了先等着
    ledger.renewSession(lin.pmId);
    const job = ledger.claimHandover()!;
    ledger.handoverForked(job.handoverId, { kind: "native", ref: { forker: "fake", handle: { forkId: "f" } } });
    const busy = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "busy", text: "在吗" }).messageId;
    ledger.applyDriverEvent(lin.sessionId, { type: "message.delivered", messageIds: [busy], at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "message.processing", messageIds: [busy], at: now });
    ledger.handoverWritten(job.handoverId, { text: "交接：Worker 在改 X", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 } });
    hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "再改改" });
    const again = messagesIn(worker.workerConversationId).at(-1)!;
    runTurn(worker, [again.id], report("做完了", "第二轮"));
    const during = workerLines().at(-1)!;
    expect(during).toMatchObject({ sessionId: lin.sessionId, status: "queued" });
    expect(ledger.waitsForHandover(during.id)).toBe(true);

    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [busy], durationMs: 10, at: now });
    const g2 = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? AND generation = 2", lin.conversationId)!.id;
    expect(ledger.getMessage(during.id)).toMatchObject({ sessionId: g2, status: "queued" });
    expect(listActions(db).find((a) => a.type === "session.send" && a.params.messageId === during.id)!.params).toEqual({ sessionId: g2, messageId: during.id, source: "system" });
    // Worker 的会话没动
    expect(sessionRow(workerSessionId(worker.id)).status).not.toBe("ended");

    hub(g2, "worker.send", { workerId: worker.id, text: "第三轮" });
    const third = messagesIn(worker.workerConversationId).at(-1)!;
    runTurn(worker, [third.id], report("做完了", "第三轮"));
    expect(workerLines().at(-1)!.sessionId).toBe(g2);
  });
});

describe("claude 自己开的一轮（后台任务完成）", () => {
  let worker: WorkerRecord;
  let sessionId: SessionId;
  beforeEach(() => {
    worker = start().data.worker;
    sessionId = workerSessionId(worker.id);
    enqueued = [];
  });

  /** 自己开的一轮：turn.started、若干段文字、没有消息的 turn.ended。 */
  const selfTurn = (uuid: string, text: string | null, end: Partial<Extract<DriverEvent, { type: "turn.ended" }>> = {}) => {
    ledger.applyDriverEvent(sessionId, { type: "turn.started", at: now });
    if (text !== null) ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid, text, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now, ...end });
  };
  const reports = () => workerLines().filter((m) => workerEventOf(m)?.event === "report");

  it("两次汇报都交给项目经理，先后顺序对，各自是各自那一轮最后的文字", () => {
    runTurn(worker, [taskMessage(worker).id], "已推送，在等 CI。");
    selfTurn("self-1", report("做完了", "CI 过了"));
    expect(reports().map((m) => [workerEventOf(m)!.status, workerEventOf(m)!.summary])).toEqual([
      ["unformatted", "已推送，在等 CI。"],
      ["done", "CI 过了"],
    ]);
    expect(reports()[1]!.text.startsWith("【Worker #1 · 修 X 的汇报】")).toBe(true);
    expect(enqueued.map((a) => (a.params as { messageId: number }).messageId)).toEqual(reports().map((m) => m.id));
  });

  it("同一个 result 重放（只重放 turn.ended，没有 turn.started）：不多出一行；连着自己开两轮：两行都在（去重键不吞）", () => {
    runTurn(worker, [taskMessage(worker).id], "在等");
    selfTurn("self-1", "第一次好了");
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now });
    expect(reports()).toHaveLength(2);
    selfTurn("self-2", "第二次好了");
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["在等", "第一次好了", "第二次好了"]);
  });

  it("没有 turn.started 的游离 turn.ended（没带消息）：不出汇报", () => {
    runTurn(worker, [taskMessage(worker).id], "在等");
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: false, interrupted: true, messageIds: [], durationMs: 5, at: now });
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["在等"]);
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "report"]);
  });

  it("这一轮只有工具调用、没有文字：不给项目经理发汇报（不拿上一轮的旧文字顶替）", () => {
    runTurn(worker, [taskMessage(worker).id], "上一轮的话");
    ledger.applyDriverEvent(sessionId, { type: "turn.started", at: now });
    ledger.applyDriverEvent(sessionId, { type: "agent.tool", uuid: "t1", toolUseId: "tu", name: "Bash", input: { command: "ls" }, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now });
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["上一轮的话"]);
  });

  it("什么都没做的一轮（没有任何消息）：不发汇报", () => {
    runTurn(worker, [taskMessage(worker).id], "在等");
    selfTurn("x", null);
    expect(reports()).toHaveLength(1);
  });

  it("自己开的一轮出错、被停止：一行 turn_failed 交给项目经理", () => {
    runTurn(worker, [taskMessage(worker).id], "在等");
    selfTurn("self-1", "做到一半", { ok: false, error: { subtype: "error_during_execution", message: "炸了" } });
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ event: "turn_failed", summary: "error_during_execution: 炸了" });
    selfTurn("self-2", "又做到一半", { ok: false, interrupted: true });
    expect(workerEventOf(workerLines().at(-1)!)).toMatchObject({ event: "turn_failed", summary: "被停止了" });
  });

  it("关机 SIGINT 结束的自己开的一轮：不发", () => {
    runTurn(worker, [taskMessage(worker).id], "在等");
    selfTurn("self-1", "做到一半", { ok: false, interrupted: true, shutdown: true });
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "report"]);
  });

  it("turn.started 让会话显示在处理，turn.ended 回到空闲", () => {
    runTurn(worker, [taskMessage(worker).id], "在等");
    ledger.applyDriverEvent(sessionId, { type: "turn.started", at: now });
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity).toBe("working");
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now });
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity).toBe("idle");
  });

  it("项目经理自己开的一轮：文字进对话，不发 Worker 汇报", () => {
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.started", at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "agent.text", uuid: "pm-self", text: "Worker 做完了", at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now });
    expect(messagesIn(lin.conversationId).at(-1)).toMatchObject({ sender: "agent", kind: "text", text: "Worker 做完了" });
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started"]);
  });
});

describe("Worker 还有后台命令时这一轮不算汇报（等后台命令跑完、它真结束一轮再汇报）", () => {
  let worker: WorkerRecord;
  let sessionId: SessionId;
  let stops: SessionId[];
  beforeEach(() => {
    worker = start().data.worker;
    sessionId = workerSessionId(worker.id);
    stops = [];
    ledger.onStopRequested(({ sessionId: id }) => stops.push(id));
    enqueued = [];
  });

  const reports = () => workerLines().filter((m) => ["report", "turn_failed"].includes(workerEventOf(m)?.event ?? ""));
  const activity = () => ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity;
  const background = (count: number) => ledger.applyDriverEvent(sessionId, { type: "background.changed", count, at: now });
  /** 后台命令跑完、claude 自己开的那一轮。 */
  const wakeTurn = (uuid: string, text: string | null, end: Partial<Extract<DriverEvent, { type: "turn.ended" }>> = {}) => {
    ledger.applyDriverEvent(sessionId, { type: "turn.started", at: now });
    if (text !== null) ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid, text, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now, ...end });
  };
  /** 任务说明这一轮：中途放了一个后台命令，结束时它还在跑。 */
  const firstTurnWithBackground = (text = "已推送，放后台等 CI。") => {
    const id = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [id], at: now });
    background(1);
    ledger.applyDriverEvent(sessionId, { type: "agent.text", uuid: "first", text, at: now });
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [id], durationMs: 10, at: now });
  };

  it("一轮结束时还有后台命令：不汇报，会话显示在等后台命令；跑完它自己开的一轮结束才汇报一次（那一轮最后的文字）", () => {
    firstTurnWithBackground();
    expect(reports()).toEqual([]);
    expect(enqueued.filter((a) => a.type === "session.send")).toEqual([]);
    expect(activity()).toBe("background");
    background(0);
    expect(activity()).toBe("background");
    wakeTurn("wake", report("做完了", "CI 过了"));
    expect(reports().map((m) => [workerEventOf(m)!.status, workerEventOf(m)!.summary])).toEqual([["done", "CI 过了"]]);
    expect(activity()).toBe("idle");
  });

  it("叫醒的那一轮没写文字：汇报等后台命令那一轮最后的文字", () => {
    firstTurnWithBackground(report("做完了", "等 CI"));
    background(0);
    wakeTurn("wake", null);
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["等 CI"]);
  });

  it("叫醒的那一轮又放了一个后台命令：还是不汇报，等第二个也跑完", () => {
    firstTurnWithBackground();
    background(0);
    ledger.applyDriverEvent(sessionId, { type: "turn.started", at: now });
    background(1);
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now });
    expect(reports()).toEqual([]);
    expect(activity()).toBe("background");
    background(0);
    wakeTurn("wake-2", report("做完了", "两个都好了"));
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["两个都好了"]);
  });

  it("等的时候用户直接对它说话：照常插进来（交给项目经理一行 user_message），那一轮结束也不汇报，后台命令跑完汇报一次", () => {
    firstTurnWithBackground();
    const said = ledger.postUserMessage({ conversationId: worker.workerConversationId, clientId: "u1", text: "顺便看下 README" }).messageId;
    runTurn(worker, [said], "好的，README 看过了，CI 还在跑。");
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "user_message"]);
    expect(activity()).toBe("background");
    background(0);
    wakeTurn("wake", report("做完了", "CI 过了"));
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["CI 过了"]);
  });

  it("后台命令太久没结束、进程被关（session.exited idle）：照常汇报，正文前面说明后台命令被停了", () => {
    firstTurnWithBackground(report("有问题", "CI 卡住了"));
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: now });
    const line = reports().at(-1)!;
    expect(workerEventOf(line)).toMatchObject({ event: "report", status: "problem", summary: "CI 卡住了" });
    const delivered = ledger.getMessage(enqueued.filter((a) => a.type === "session.send").map((a) => (a.params as { messageId: number }).messageId).at(-1)!)!;
    expect(delivered.text).toContain(`${WORKER_BACKGROUND_HOLD_MAX_MS / 60_000} 分钟`);
    expect(delivered.text).toContain("CI 卡住了");
    expect(activity()).toBe("idle");
  });

  it("后台命令跑完了却没自己开一轮、空闲关进程：照常汇报，不说被停了", () => {
    firstTurnWithBackground(report("做完了", "等 CI"));
    background(0);
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "idle", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: now });
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["等 CI"]);
    const delivered = ledger.getMessage(enqueued.filter((a) => a.type === "session.send").map((a) => (a.params as { messageId: number }).messageId).at(-1)!)!;
    expect(delivered.text).not.toContain("分钟");
  });

  it("用户在等的时候点停止：通知驱动层停（它会关掉后台命令），进程退出后一行“被停止了”交给项目经理", () => {
    firstTurnWithBackground();
    ledger.requestStop(worker.workerConversationId);
    expect(stops).toEqual([sessionId]);
    expect(activity()).toBe("stopping");
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "interrupt", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: now });
    expect(reports().map((m) => [workerEventOf(m)!.event, workerEventOf(m)!.summary])).toEqual([["turn_failed", "被停止了"]]);
    expect(activity()).toBe("idle");
  });

  it("进程崩了：一行 turn_failed", () => {
    firstTurnWithBackground();
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "crash", exitCode: 1, signal: null, hadResult: true, messageIds: [], at: now });
    expect(workerEventOf(reports().at(-1)!)).toMatchObject({ event: "turn_failed" });
  });

  it("等的时候项目经理收工：打断（驱动层关掉后台命令），之后不再汇报", () => {
    firstTurnWithBackground();
    const result = hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(result.data.worker.status).toBe("ended");
    expect(stops).toEqual([sessionId]);
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "interrupt", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: now });
    expect(reports()).toEqual([]);
    expect(workerLines().map((m) => workerEventOf(m)?.event)).toEqual(["started", "ended"]);
  });

  it("这一轮出错（有后台命令也一样）：马上一行 turn_failed，不等", () => {
    const id = taskMessage(worker).id;
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [id], at: now });
    background(1);
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: false, interrupted: false, messageIds: [id], durationMs: 5, at: now, error: { subtype: "error_during_execution", message: "炸了" } });
    expect(workerEventOf(reports().at(-1)!)).toMatchObject({ event: "turn_failed" });
    expect(activity()).toBe("idle");
  });

  it("没有后台命令（后台个数 0 或没有这个信号）：照常马上汇报", () => {
    background(0);
    runTurn(worker, [taskMessage(worker).id], report("做完了", "好了"));
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["好了"]);
    expect(activity()).toBe("idle");
  });

  /** 守护进程被杀后重启（没走关机，驱动层的 session.exited 没来）：新开账本、跑重启恢复。 */
  const restart = () => {
    ledger = createLedger(db, options());
    ledger.onActionEnqueued((x) => enqueued.push(x));
    return ledger.recoverAfterRestart();
  };
  const deliveredText = () =>
    ledger.getMessage(enqueued.filter((a) => a.type === "session.send").map((a) => (a.params as { messageId: number }).messageId).at(-1)!)!.text;

  it("在等后台命令时守护进程被杀：重启后补一次汇报（说明后台命令因重启中断，带它最后一轮的内容），只补一次", () => {
    firstTurnWithBackground(report("做完了", "等 CI"));
    expect(reports()).toEqual([]);
    restart();
    expect(reports().map((m) => [workerEventOf(m)!.event, workerEventOf(m)!.status, workerEventOf(m)!.summary])).toEqual([["report", "done", "等 CI"]]);
    expect(deliveredText()).toContain("重启");
    expect(deliveredText()).toContain("等 CI");
    expect(enqueued.filter((a) => a.type === "session.send").map((a) => (a.params as { sessionId: number }).sessionId)).toEqual([lin.sessionId]);
    expect(activity()).toBe("idle");
    restart();
    expect(reports()).toHaveLength(1);
  });

  it("后台命令跑完了、叫醒那一轮还没来就被杀：重启后照样补一次", () => {
    firstTurnWithBackground(report("做完了", "等 CI"));
    background(0);
    restart();
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["等 CI"]);
    expect(deliveredText()).toContain("重启");
  });

  it("叫醒那一轮已经汇报过：重启后不再补", () => {
    firstTurnWithBackground();
    background(0);
    wakeTurn("wake", report("做完了", "CI 过了"));
    restart();
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["CI 过了"]);
  });

  it("关机时已经按 session.exited 交代过：重启后不再补", () => {
    firstTurnWithBackground(report("做完了", "等 CI"));
    ledger.applyDriverEvent(sessionId, { type: "session.exited", reason: "shutdown", exitCode: 0, signal: null, hadResult: true, messageIds: [], at: now });
    expect(reports()).toHaveLength(1);
    restart();
    expect(reports()).toHaveLength(1);
  });

  it("等的时候收工、进程还没退守护进程就被杀：重启后不补（项目经理自己收的工）", () => {
    firstTurnWithBackground();
    hub(lin.sessionId, "worker.end", { workerId: worker.id });
    restart();
    expect(reports()).toEqual([]);
  });

  it("重启后它又接着干（补发的汇报之后又一轮）：照常汇报，不再当成在等后台命令", () => {
    firstTurnWithBackground(report("做完了", "等 CI"));
    restart();
    const again = hub(lin.sessionId, "worker.send", { workerId: worker.id, text: "重跑 CI" }).data.messageId;
    runTurn(worker, [again], report("做完了", "重跑过了"));
    expect(reports().map((m) => workerEventOf(m)!.summary)).toEqual(["等 CI", "重跑过了"]);
  });

  it("项目经理的会话有后台命令：照旧回到空闲（不显示在等后台命令）", () => {
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.started", at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "background.changed", count: 1, at: now });
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 5, at: now });
    expect(ledger.snapshot().sessions.find((s) => s.sessionId === lin.sessionId)?.activity).toBe("idle");
  });
});
