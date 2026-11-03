// M3 账本里的 Worker（m3-plan 第 3 节测试表 W2）：派活、在哪干活、按角色放行、汇报回到项目经理、出错、打回、收工、建 worktree。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import type { LedgerErrorCode } from "../../shared/ledger.ts";
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
import type { WorkerGit } from "./workers.ts";

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

const fakeGit: WorkerGit = {
  isRepoWithCommit: (folder) => repos.has(folder),
  hasUncommittedChanges: (folder) => dirty.has(folder),
};

function options(extra: Partial<LedgerOptions> = {}): LedgerOptions {
  return {
    now: () => now,
    initialSeq: 9_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    git: fakeGit,
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

function start(args: Partial<HubArgs<"worker.start">> = {}, caller: SessionId = lin.sessionId) {
  return hub(caller, "worker.start", { title: "修 X", task: "把 X 修好，测试要过", ...args });
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

  it("用真 git 判断（默认实现）：有提交的仓库用 worktree，普通文件夹用主文件夹", () => {
    const real = createLedger(db, options({ git: undefined }));
    const repo = folder("repo");
    // 身份写死，不读用户的全局配置（本机开了签名也不会卡住）
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", ".");
    git("commit", "-qm", "init");
    const a = real.createPm({ name: "老王", mode: "manage_only", persona: "", folder: repo });
    expect(real.hubCall(a.sessionId, "worker.start", { title: "a", task: "t" }).data.worker.workspace).toBe("worktree");
    writeFileSync(join(repo, "b.txt"), "b");
    expect(real.hubCall(a.sessionId, "worker.start", { title: "b", task: "t" }).text).toContain("看不到这些改动");
    const b = real.createPm({ name: "老李", mode: "manage_only", persona: "", folder: folder("plain") });
    expect(real.hubCall(b.sessionId, "worker.start", { title: "c", task: "t" }).data.worker.workspace).toBe("main");
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
    expect(enqueued.map((a) => [a.type, a.params])).toEqual([["session.send", { sessionId: lin.sessionId, messageId: line.id, source: "system" }]]);
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
