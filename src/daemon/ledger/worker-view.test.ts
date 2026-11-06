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
import { WORKER_LOG_MAX_STEPS, WORKER_STALL_HINT_MS, WORKER_VIEW_TEXT_MAX_CHARS } from "../../shared/limits.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";
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

function startWorker(vendor: AgentVendor, extra: { title?: string; noWorktree?: boolean } = {}): WorkerId {
  const probe: WorkspaceProbe = { kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false };
  const context: HubCallContext = extra.noWorktree === false ? { workspace: { ...probe, isRepoWithCommit: true } } : {};
  return ledger.hubCall(lin.sessionId, "worker.start", { title: extra.title ?? "修 X", task: "把 X 修好", vendor, noWorktree: extra.noWorktree ?? true }, context).data
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

describe("clipText", () => {
  it("不超长原样，超长截断加省略号，按字符不按字节", () => {
    expect(clipText("abc", 5)).toBe("abc");
    expect(clipText("一二三四五六", 4)).toBe("一二三…");
  });
});
