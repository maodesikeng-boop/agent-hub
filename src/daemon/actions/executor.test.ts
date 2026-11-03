import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriverError } from "../../shared/driver.ts";
import type { ActionResult, AnyActionRow } from "../../shared/actions.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { openStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger } from "../ledger/index.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import { createActionExecutor, enqueueAction, getAction, setActionStatus } from "./index.ts";
import type { ActionExecutorDeps } from "./index.ts";

const T0 = 1_000_000;
let db: Db;
let ledger: SqliteLedger;
let deps: ActionExecutorDeps;
let home: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-exec-"));
  ledger = createLedger(db, { pmHomeRoot: home });
  deps = {
    reportHealth: vi.fn((m, e) => ledger.reportHealth(m, e)),
    onActionFailed: vi.fn((a, e) => ledger.onActionFailed(a, e)),
  };
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const flush = () => vi.advanceTimersByTimeAsync(0);

function sendAction(messageId = 1, sessionId = 1) {
  return enqueueAction(db, { type: "session.send", params: { sessionId, messageId, source: "user" } }, Date.now()).row;
}

describe("执行器", () => {
  it("取到点的动作执行，做完标完成", async () => {
    const action = sendAction();
    const handler = vi.fn((_a: AnyActionRow): ActionResult => ({ kind: "done" }));
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", handler);
    executor.start();
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ id: action.id, status: "running", attempts: 0 });
    expect(getAction(db, action.id)).toMatchObject({ status: "done", attempts: 0 });
    await executor.stop();
  });

  it("退避重试：一直抛错，5 秒、10 秒后各重试一次，第 3 次失败后状态失败，health 记下错误", async () => {
    const { conversation } = ledger.createPm({ name: "项目经理", mode: "manage_only", persona: "" });
    const { messageId } = ledger.postUserMessage({ conversationId: conversation.id, clientId: "c1", text: "hi" });
    const handler = vi.fn(() => {
      throw new DriverError("claude_not_found", "no such file");
    });
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", handler);
    executor.start();

    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    const [action] = db.all<{ id: number }>("SELECT id FROM actions");
    const id = action!.id;
    expect(getAction(db, id)).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: T0 + 5_000, lastError: "claude_not_found: no such file" });
    expect(deps.reportHealth).toHaveBeenLastCalledWith("driver", "claude_not_found: no such file");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(getAction(db, id)).toMatchObject({ status: "pending", attempts: 2, nextAttemptAt: T0 + 15_000 });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(handler).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(getAction(db, id)).toMatchObject({ status: "failed", attempts: 3, lastError: "claude_not_found: no such file" });
    expect(deps.onActionFailed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.onActionFailed).mock.calls[0]?.[0]).toMatchObject({ id, status: "failed", attempts: 3 });
    expect(deps.reportHealth).toHaveBeenCalledTimes(3);
    expect(ledger.snapshot().health).toEqual([
      expect.objectContaining({ module: "driver", consecutiveFailures: 3, lastError: "claude_not_found: no such file" }),
    ]);
    // 账本把消息标失败
    expect(ledger.getMessage(messageId)).toMatchObject({ status: "failed", failureReason: "claude_not_found: no such file" });

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(handler).toHaveBeenCalledTimes(3);
    await executor.stop();
  });

  it("不是 DriverError 的错误记在 actions 模块；之后成功一次清零", async () => {
    sendAction();
    let fail = true;
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", () => {
      if (fail) throw new Error("handler bug");
      return { kind: "done" };
    });
    executor.start();
    await flush();
    expect(deps.reportHealth).toHaveBeenLastCalledWith("actions", "handler bug");
    fail = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.reportHealth).toHaveBeenLastCalledWith("actions", null);
    expect(ledger.snapshot().health).toEqual([expect.objectContaining({ module: "actions", consecutiveFailures: 0, lastError: null })]);
    await executor.stop();
  });

  it("推迟不算失败：返回稍后再试，不加次数，按时间再试", async () => {
    const action = sendAction();
    const handler = vi
      .fn<(a: AnyActionRow) => ActionResult>()
      .mockReturnValueOnce({ kind: "later", delayMs: 2_000, reason: "busy" })
      .mockReturnValueOnce({ kind: "done" });
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", handler);
    executor.start();
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getAction(db, action.id)).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: T0 + 2_000 });
    expect(deps.reportHealth).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(getAction(db, action.id)).toMatchObject({ status: "done", attempts: 0 });
    await executor.stop();
  });

  it("重启接着做：留一个执行中的动作，重新打开存储和执行器，改回待执行并执行一次", async () => {
    const paths = resolveHubPaths({ AGENT_HUB_HOME: home }, "/nonexistent");
    const first = openStore(paths);
    const left = enqueueAction(first.db, { type: "session.start", params: { sessionId: 1, generation: 1 } }, Date.now()).row;
    setActionStatus(first.db, left.id, { status: "running", attempts: 1 }, Date.now());
    first.db.close();

    const second = openStore(paths);
    try {
      const secondLedger = createLedger(second.db);
      const executor = createActionExecutor(second.db, {
        reportHealth: (m, e) => secondLedger.reportHealth(m, e),
        onActionFailed: (a, e) => secondLedger.onActionFailed(a, e),
      });
      const handler = vi.fn((): ActionResult => ({ kind: "done" }));
      executor.register("session.start", handler);
      executor.start();
      expect(getAction(second.db, left.id)).toMatchObject({ status: "pending", attempts: 1 });
      await flush();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(getAction(second.db, left.id)?.status).toBe("done");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(handler).toHaveBeenCalledTimes(1);
      await executor.stop();
    } finally {
      second.db.close();
    }
  });

  it("wake：启动后新登记的动作马上执行，不等轮询", async () => {
    const executor = createActionExecutor(db, deps, { pollIntervalMs: 60_000 });
    const handler = vi.fn((): ActionResult => ({ kind: "done" }));
    executor.register("session.send", handler);
    executor.start();
    await flush();
    sendAction();
    await flush();
    expect(handler).not.toHaveBeenCalled();
    executor.wake();
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    await executor.stop();
  });

  it("没有 wake 也会靠轮询取到", async () => {
    const executor = createActionExecutor(db, deps, { pollIntervalMs: 1_000 });
    const handler = vi.fn((): ActionResult => ({ kind: "done" }));
    executor.register("session.send", handler);
    executor.start();
    await flush();
    sendAction();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(1);
    await executor.stop();
  });

  it("没注册处理函数的类型：标放弃，记 health；发消息动作调 onActionFailed，消息标失败", async () => {
    const { conversation } = ledger.createPm({ name: "项目经理", mode: "manage_only", persona: "" });
    const { messageId } = ledger.postUserMessage({ conversationId: conversation.id, clientId: "c1", text: "hi" });
    const [action] = db.all<{ id: number }>("SELECT id FROM actions");
    const executor = createActionExecutor(db, deps);
    executor.start();
    await flush();
    expect(getAction(db, action!.id)).toMatchObject({ status: "abandoned", lastError: "no handler registered for session.send" });
    expect(deps.reportHealth).toHaveBeenCalledWith("actions", "no handler registered for session.send");
    expect(deps.onActionFailed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.onActionFailed).mock.calls[0]?.[0]).toMatchObject({ id: action!.id, status: "abandoned" });
    expect(ledger.getMessage(messageId)).toMatchObject({ status: "failed", failureReason: "放弃：no handler registered for session.send" });
    await executor.stop();
  });

  it("start 之后再注册、重复注册都报错", () => {
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", () => ({ kind: "done" }));
    expect(() => executor.register("session.send", () => ({ kind: "done" }))).toThrow(/already/);
    executor.start();
    expect(() => executor.register("session.start", () => ({ kind: "done" }))).toThrow(/before start/);
    return executor.stop();
  });

  it("异步处理函数 reject 和同步抛错一样按失败处理", async () => {
    const action = sendAction();
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", async () => {
      throw new Error("async boom");
    });
    executor.start();
    await flush();
    expect(getAction(db, action.id)).toMatchObject({ status: "pending", attempts: 1, lastError: "async boom" });
    await executor.stop();
  });

  it("同一个会话一次只跑一个动作，同时到点时启动排在发消息前面；不同会话可以并行", async () => {
    sendAction(10, 1);
    enqueueAction(db, { type: "session.start", params: { sessionId: 1, generation: 1 } }, Date.now());
    sendAction(20, 2);
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const run = (label: string) =>
      new Promise<ActionResult>((resolve) => {
        log.push(`begin ${label}`);
        gates.set(label, () => {
          log.push(`end ${label}`);
          resolve({ kind: "done" });
        });
      });
    const executor = createActionExecutor(db, deps);
    executor.register("session.start", (a) => run(`start s${a.params.sessionId}`));
    executor.register("session.send", (a) => run(`send m${a.params.messageId}`));
    executor.start();
    await flush();
    expect(log).toEqual(["begin start s1", "begin send m20"]);
    gates.get("start s1")!();
    await flush();
    expect(log).toEqual(["begin start s1", "begin send m20", "end start s1", "begin send m10"]);
    gates.get("send m20")!();
    gates.get("send m10")!();
    await executor.stop();
  });

  it("到点时间不同也是启动排在发消息前面：先按类型，再按到点时间、编号", async () => {
    enqueueAction(db, { type: "session.send", params: { sessionId: 1, messageId: 10, source: "user" } }, T0 - 3_000);
    enqueueAction(db, { type: "session.send", params: { sessionId: 1, messageId: 11, source: "user" } }, T0 - 2_000);
    enqueueAction(db, { type: "session.start", params: { sessionId: 1, generation: 1, recovery: true } }, T0 - 1_000);
    const log: string[] = [];
    const executor = createActionExecutor(db, deps);
    executor.register("session.start", (a) => {
      log.push(`start s${a.params.sessionId}`);
      return { kind: "done" };
    });
    executor.register("session.send", (a) => {
      log.push(`send m${a.params.messageId}`);
      return { kind: "done" };
    });
    executor.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(log).toEqual(["start s1", "send m10", "send m11"]);
    await executor.stop();
  });

  it("结果写库失败：记 store 的 health，动作不会卡在执行中，下一轮改回待执行再做", async () => {
    const action = sendAction();
    db.exec("CREATE TRIGGER fail_done BEFORE UPDATE ON actions WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", () => {
      calls += 1;
      if (calls === 2) db.exec("DROP TRIGGER fail_done");
      return { kind: "done" };
    });
    executor.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(deps.reportHealth).toHaveBeenCalledWith("store", expect.stringContaining("disk full"));
    expect(calls).toBe(2);
    expect(getAction(db, action.id)?.status).toBe("done");
    await executor.stop();
    spy.mockRestore();
  });

  it("推迟时间不合法：小数向上取整，NaN、Infinity 不会让动作卡住", async () => {
    const action = sendAction();
    const handler = vi
      .fn<(a: AnyActionRow) => ActionResult>()
      .mockReturnValueOnce({ kind: "later", delayMs: 1.5 })
      .mockReturnValueOnce({ kind: "later", delayMs: Number.NaN })
      .mockReturnValueOnce({ kind: "later", delayMs: Number.POSITIVE_INFINITY })
      .mockReturnValue({ kind: "done" });
    const executor = createActionExecutor(db, deps, { pollIntervalMs: 1_000 });
    executor.register("session.send", handler);
    executor.start();
    await flush();
    expect(getAction(db, action.id)).toMatchObject({ status: "pending", nextAttemptAt: T0 + 2 });
    await vi.advanceTimersByTimeAsync(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(getAction(db, action.id)?.status).toBe("pending");
    // NaN、Infinity 按轮询间隔（1 秒）再试
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(getAction(db, action.id)).toMatchObject({ status: "pending", nextAttemptAt: T0 + 2 + 2_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(4);
    expect(getAction(db, action.id)?.status).toBe("done");
    await executor.stop();
  });

  it("health 清零不靠内存：库里留着 driver（来自 driver.error）和 actions 的错误，任何一个动作成功都清掉", async () => {
    const { sessionId } = ledger.createPm({ name: "项目经理", mode: "manage_only", persona: "" });
    ledger.applyDriverEvent(sessionId, { type: "driver.error", at: 1, code: "bad_output_line", message: "bad_output_line: x" });
    ledger.reportHealth("actions", "old");
    sendAction();
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", () => ({ kind: "done" }));
    executor.start();
    await flush();
    expect(ledger.snapshot().health).toEqual([
      expect.objectContaining({ module: "actions", consecutiveFailures: 0, lastError: null }),
      expect.objectContaining({ module: "driver", consecutiveFailures: 0, lastError: null }),
    ]);
    await executor.stop();
  });

  it("启动动作次数用完：actions 的 health 只按每次失败记，不再多记一次", async () => {
    enqueueAction(db, { type: "session.start", params: { sessionId: 1, generation: 1 } }, T0);
    const executor = createActionExecutor(db, deps, { retry: { "session.start": { maxAttempts: 1, baseMs: 1, maxMs: 1 }, "session.send": { maxAttempts: 1, baseMs: 1, maxMs: 1 }, "session.end": { maxAttempts: 1, baseMs: 1, maxMs: 1 } } });
    executor.register("session.start", () => {
      throw new Error("boom");
    });
    executor.start();
    await flush();
    expect(deps.onActionFailed).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().health).toEqual([expect.objectContaining({ module: "actions", consecutiveFailures: 1, lastError: "boom" })]);
    await executor.stop();
  });

  it("处理函数里调 wake：不会被这一轮末尾的定时盖掉", async () => {
    sendAction(1, 1);
    const executor = createActionExecutor(db, deps, { pollIntervalMs: 60_000 });
    let release!: () => void;
    const handler = vi.fn((a: AnyActionRow): ActionResult | Promise<ActionResult> => {
      if (a.type === "session.send" && a.params.messageId === 1) {
        sendAction(2, 2);
        executor.wake();
        // 第一个动作一直没做完，靠不上它结束时的那次 schedule
        return new Promise((resolve) => {
          release = () => resolve({ kind: "done" });
        });
      }
      return { kind: "done" };
    });
    executor.register("session.send", handler);
    executor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(handler).toHaveBeenCalledTimes(2);
    release();
    await executor.stop();
  });

  it("stop：不再取新动作，等正在执行的做完并记下结果", async () => {
    const first = sendAction(1, 1);
    let release!: () => void;
    const handler = vi.fn(
      (a: AnyActionRow) =>
        new Promise<ActionResult>((resolve) => {
          if (a.id === first.id) release = () => resolve({ kind: "done" });
          else resolve({ kind: "done" });
        }),
    );
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", handler);
    executor.start();
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = executor.stop().then(() => {
      stopped = true;
    });
    const later = sendAction(2, 2);
    executor.wake();
    await flush();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(getAction(db, first.id)?.status).toBe("done");
    expect(getAction(db, later.id)?.status).toBe("pending");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("参数坏了（不是 JSON）的动作标放弃", async () => {
    db.run(
      "INSERT INTO actions (type, dedupe_key, params, next_attempt_at, created_at, updated_at) VALUES ('session.send', 'x', 'not json', ?, ?, ?)",
      T0,
      T0,
      T0,
    );
    const executor = createActionExecutor(db, deps);
    executor.register("session.send", () => ({ kind: "done" }));
    executor.start();
    await flush();
    expect(db.get<{ status: string }>("SELECT status FROM actions WHERE dedupe_key = 'x'")?.status).toBe("abandoned");
    // 参数解析不出来：认不出是哪条消息，不调 onActionFailed
    expect(deps.onActionFailed).not.toHaveBeenCalled();
    await executor.stop();
  });
});
