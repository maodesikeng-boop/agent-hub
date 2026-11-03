// M3 账本里的 Worker（m3-plan 第 3 节测试表 W2）：派活、在哪干活、按角色放行、汇报回到项目经理、出错、打回、收工、建 worktree。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import { workerEventOf } from "../../shared/domain.ts";
import type { ConversationId, Message, MessageId, PmId, SessionId, WorkerId, WorkerRecord } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { HubArgs, HubCommand, WorkerHubStatus } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { HubCallContext, LedgerErrorCode, WorkspaceProbe } from "../../shared/ledger.ts";
import { MAX_TASK_BYTES, MAX_WORKER_TITLE_CHARS } from "../../shared/limits.ts";
import { projectWorktreesDir, workerWorktreePath } from "../../shared/paths.ts";
import { REPORT_END, REPORT_START, workerBranchName } from "../../shared/worker.ts";
import { listActions } from "../actions/index.ts";
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
function start(args: Partial<HubArgs<"worker.start">> = {}, caller: SessionId = lin.sessionId) {
  const full = { title: "修 X", task: "把 X 修好，测试要过", ...args };
  const folder = full.noWorktree === true ? null : ledger.workerStartFolder(caller);
  const context: HubCallContext = folder === null ? {} : { workspace: probeOf(folder) };
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
    expect(line!.text).toBe("Worker · 修 X · 已派出");
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
    expect(workerLines()[0]!.text).toBe("Worker · 修 X · 已派出（只读）");
    expect(workerEventOf(workerLines()[0]!)?.readonly).toBe(true);
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
      repo: main,
      branch: worker.branch,
      worktreePath: worker.worktreePath,
      status: "open",
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
    expect(line).toMatchObject({ status: null, text: "Worker · 修 X · 已收工" });
    // worktree 留给项目经理自己删
    expect(result.text).toContain("git worktree remove");

    const before = tableCounts();
    enqueued = [];
    const again = hub(lin.sessionId, "worker.end", { workerId: worker.id });
    expect(again.data.worker.status).toBe("ended");
    expect(tableCounts()).toEqual(before);
    expect(enqueued).toEqual([]);
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
