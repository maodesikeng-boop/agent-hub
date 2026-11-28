import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, ConversationId, DriverEvent, SessionId, StopEvent, StopId } from "../../shared/index.ts";
import { wireSessionStopHandler } from "../stop-handler.ts";
import { createSessionStore, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger, type SqliteLedger } from "./index.ts";
import {
  createStopSettlement,
  shouldApplyLiveDelivery,
  shouldApplyLiveToolStart,
} from "./stop-settlement.ts";

describe("stop-settlement unit contracts (S3, S5, S7, S8)", () => {
  it("allocates strictly increasing StopId values and settles immediately when quiescent", () => {
    const settled: Array<{ sessionId: SessionId; stopId: StopId }> = [];
    const ctrl = createStopSettlement({
      hasPendingDriverEvents: () => false,
      hasPendingTurnCompletions: () => false,
      settleNow: (sessionId, stopId) => settled.push({ sessionId, stopId }),
    });

    const first = ctrl.nextStopId();
    const second = ctrl.nextStopId();
    expect(second).toBeGreaterThan(first);

    ctrl.settleStop(10, first, { driverBusy: false, setupActive: false });
    expect(settled).toEqual([{ sessionId: 10, stopId: first }]);
    expect(ctrl.pendingCount()).toBe(0);
  });

  it("defers settlement while driver events or turn completions are pending and settles on drain", () => {
    let pendingEvents = true;
    const settled: Array<{ sessionId: SessionId; stopId: StopId }> = [];
    const ctrl = createStopSettlement({
      hasPendingDriverEvents: () => pendingEvents,
      hasPendingTurnCompletions: () => false,
      settleNow: (sessionId, stopId) => settled.push({ sessionId, stopId }),
    });

    const stopId = ctrl.nextStopId();
    ctrl.settleStop(20, stopId, { driverBusy: false, setupActive: false });
    expect(settled).toEqual([]);
    expect(ctrl.pendingCount()).toBe(1);

    pendingEvents = false;
    ctrl.onSessionDrained(20);
    expect(settled).toEqual([{ sessionId: 20, stopId }]);
    expect(ctrl.pendingCount()).toBe(0);
  });

  it("does not settle when driverBusy or setupActive is true, and clears pending state on forget/close", () => {
    const settled: Array<{ sessionId: SessionId; stopId: StopId }> = [];
    const ctrl = createStopSettlement({
      hasPendingDriverEvents: () => true,
      hasPendingTurnCompletions: () => false,
      settleNow: (sessionId, stopId) => settled.push({ sessionId, stopId }),
    });

    const s1 = ctrl.nextStopId();
    ctrl.settleStop(1, s1, { driverBusy: true, setupActive: false });
    ctrl.settleStop(1, s1, { driverBusy: false, setupActive: true });
    expect(ctrl.pendingCount()).toBe(0);

    for (let i = 1; i <= 300; i++) {
      ctrl.settleStop(i, ctrl.nextStopId(), { driverBusy: false, setupActive: false });
      ctrl.forget(i);
    }
    expect(ctrl.pendingCount()).toBe(0);

    ctrl.settleStop(99, ctrl.nextStopId(), { driverBusy: false, setupActive: false });
    expect(ctrl.pendingCount()).toBe(1);
    ctrl.close();
    expect(ctrl.pendingCount()).toBe(0);
    expect(settled).toEqual([]);
  });

  it("rejects duplicate agent.tool on an idle session and all-cancelled message.delivered", () => {
    expect(shouldApplyLiveToolStart(false, "idle")).toBe(false);
    expect(shouldApplyLiveToolStart(true, "idle")).toBe(true);
    expect(shouldApplyLiveToolStart(false, "working")).toBe(true);

    expect(shouldApplyLiveDelivery(1, 0, false)).toBe(false);
    expect(shouldApplyLiveDelivery(1, 1, false)).toBe(true);
    expect(shouldApplyLiveDelivery(1, 0, true)).toBe(true);
    expect(shouldApplyLiveDelivery(0, 0, false)).toBe(true);
  });
});

describe("wireSessionStopHandler contracts (S3, S5)", () => {
  it("cancels setup, awaits driver.interrupt, and settles stop by stopId unless closing", async () => {
    let listener: ((event: StopEvent) => void) | null = null;
    let resolveInterrupt!: () => void;
    const settleStop = vi.fn();
    const cancel = vi.fn();
    const log = vi.fn();
    let closing = false;

    const unsub = wireSessionStopHandler({
      ledger: {
        onStopRequested: (fn) => {
          listener = fn;
          return () => {
            listener = null;
          };
        },
        settleStop,
      },
      driver: {
        interrupt: () =>
          new Promise<void>((resolve) => {
            resolveInterrupt = resolve;
          }),
        isBusy: () => false,
      },
      setup: {
        cancel,
        isRunning: () => false,
      },
      isClosing: () => closing,
      log,
    });

    listener!({ conversationId: 1, sessionId: 10, stopId: 7 });
    expect(cancel).toHaveBeenCalledWith(10);
    expect(settleStop).not.toHaveBeenCalled();

    resolveInterrupt();
    await Promise.resolve();
    await Promise.resolve();
    expect(settleStop).toHaveBeenCalledWith(10, 7, { driverBusy: false, setupActive: false });

    // After shutdown starts, async completion must never touch the ledger.
    closing = true;
    listener!({ conversationId: 1, sessionId: 10, stopId: 8 });
    resolveInterrupt();
    await Promise.resolve();
    await Promise.resolve();
    expect(settleStop).toHaveBeenCalledTimes(1);

    unsub();
  });
});

describe("ledger stop lifecycle integration (S1, S4, S5, S8, S12)", () => {
  let db: Db;
  let home: string;
  let ledger: SqliteLedger;
  let now: number;
  let changes: Change[];
  let conversationId: ConversationId;
  let sessionId: SessionId;

  beforeEach(() => {
    db = openTestDb();
    home = mkdtempSync(join(tmpdir(), "bellwood-stop-ledger-"));
    now = 10_000;
    const created = createLedger(db, { now: () => now, pmHomeRoot: home }).createPm({
      name: "PM",
      mode: "manage_only",
      persona: "",
    });
    ledger = createLedger(db, { now: () => now, pmHomeRoot: home });
    conversationId = created.conversation.id;
    sessionId = created.sessionId;
    createSessionStore(db, { now: () => now }).update(sessionId, { status: "running" });
    changes = [];
    ledger.onChange((c) => changes.push(c));
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const ev = (event: DriverEvent) => ledger.applyDriverEvent(sessionId, event);
  const activity = () => ledger.snapshot().sessions.find((s) => s.sessionId === sessionId)?.activity;

  it("emits a monotonic stopId and settles a no-op stop back to idle while ignoring stale stopIds", () => {
    const stops: StopEvent[] = [];
    ledger.onStopRequested((e) => stops.push(e));
    const msgId = ledger.postUserMessage({ conversationId, clientId: "m1", text: "work" }).messageId;
    ev({ type: "message.delivered", messageIds: [msgId], at: now });
    ev({ type: "message.processing", messageIds: [msgId], at: ++now });

    ledger.requestStop(conversationId);
    expect(activity()).toBe("stopping");
    expect(stops).toHaveLength(1);
    const firstStopId = stops[0]!.stopId;
    expect(typeof firstStopId).toBe("number");

    // Stale stopId must not clear the active stopping state.
    ledger.settleStop!(sessionId, (firstStopId as number) - 1, { driverBusy: false, setupActive: false });
    expect(activity()).toBe("stopping");

    // Matching stopId settles to idle when driver and setup are idle.
    ledger.settleStop!(sessionId, firstStopId!, { driverBusy: false, setupActive: false });
    expect(activity()).toBe("idle");
  });

  it("does not resurrect working state when a duplicate agent.tool arrives after turn.ended", () => {
    const msgId = ledger.postUserMessage({ conversationId, clientId: "m-dup", text: "run bg" }).messageId;
    ev({ type: "message.delivered", messageIds: [msgId], at: now });
    ev({ type: "message.processing", messageIds: [msgId], at: ++now });
    ev({
      type: "agent.tool",
      uuid: "acp:s1:p1:t1:tool:call_331",
      toolUseId: "acp:s1:p1:t1:tool:call_331",
      name: "run_command",
      input: { CommandLine: "sleep 60" },
      at: ++now,
    });
    ev({ type: "agent.tool_result", toolUseIds: ["acp:s1:p1:t1:tool:call_331"], at: ++now });
    ev({ type: "turn.ended", ok: false, interrupted: true, messageIds: [msgId], durationMs: 500, at: ++now });
    expect(activity()).toBe("idle");

    // Late duplicate agent.tool + agent.tool_result arriving after turn.ended.
    ev({
      type: "agent.tool",
      uuid: "acp:s1:p1:t1:tool:call_331",
      toolUseId: "acp:s1:p1:t1:tool:call_331",
      name: "run_command",
      input: { CommandLine: "sleep 60" },
      at: ++now,
    });
    ev({ type: "agent.tool_result", toolUseIds: ["acp:s1:p1:t1:tool:call_331"], at: ++now });
    expect(activity()).toBe("idle");
  });

  it("settles live activity to idle when turn.ended arrives with non-empty messageIds for an already-cancelled message", () => {
    const msgId = ledger.postUserMessage({ conversationId, clientId: "m-cancel-race", text: "race" }).messageId;
    // User clicks Stop while message is still queued, cancelling it before stdin write callback fires.
    ledger.requestStop(conversationId);
    expect(ledger.getMessage(msgId)?.status).toBe("cancelled");

    ev({ type: "message.delivered", messageIds: [msgId], at: ++now });
    expect(activity()).toBe("idle");

    // Even if live state had been stopping, turn.ended with non-empty messageIds and no running turn must still settle to idle.
    ev({ type: "agent.thinking", uuid: "th-late", at: ++now });
    ledger.requestStop(conversationId);
    expect(activity()).toBe("stopping");
    ev({ type: "turn.ended", ok: false, interrupted: true, messageIds: [msgId], durationMs: 10, at: ++now });
    expect(activity()).toBe("idle");
  });

  it("regression: requestStop still cancels queued user messages and keeps queued system notices", () => {
    const running = ledger.postUserMessage({ conversationId, clientId: "r1", text: "running" }).messageId;
    ev({ type: "message.delivered", messageIds: [running], at: now });
    ev({ type: "message.processing", messageIds: [running], at: ++now });
    const queuedUser = ledger.postUserMessage({ conversationId, clientId: "r2", text: "next" }).messageId;
    const queuedSys = ledger.postUserMessage({ conversationId, clientId: "r3", text: "sys" }).messageId;
    db.run("UPDATE messages SET sender = 'system' WHERE id = ?", queuedSys);

    ledger.requestStop(conversationId);
    expect(ledger.getMessage(queuedUser)?.status).toBe("cancelled");
    expect(ledger.getMessage(queuedSys)?.status).toBe("queued");
    expect(activity()).toBe("stopping");
  });

  it("does not resurrect working state when a duplicate agent.text arrives on an idle session", () => {
    const msgId = ledger.postUserMessage({ conversationId, clientId: "m-dup-text", text: "hello" }).messageId;
    ev({ type: "message.delivered", messageIds: [msgId], at: now });
    ev({ type: "message.processing", messageIds: [msgId], at: ++now });
    ev({ type: "agent.text", uuid: "text-dup-1", text: "done", at: ++now });
    ev({ type: "turn.ended", ok: true, interrupted: false, messageIds: [msgId], durationMs: 20, at: ++now });
    expect(activity()).toBe("idle");

    ev({ type: "agent.text", uuid: "text-dup-1", text: "done", at: ++now });
    expect(activity()).toBe("idle");
  });

  it("echoes stopId while stopping and settledStopId across idle and subsequent turns in SessionState", () => {
    expect(ledger.requestStop(conversationId)).toBeNull();

    const msgId = ledger.postUserMessage({ conversationId, clientId: "m-stop-id", text: "work" }).messageId;
    ev({ type: "message.delivered", messageIds: [msgId], at: now });
    ev({ type: "message.processing", messageIds: [msgId], at: ++now });

    const stopId = ledger.requestStop(conversationId);
    expect(typeof stopId).toBe("number");
    const stoppingSnap = ledger.snapshot().sessions.find((s) => s.sessionId === sessionId);
    expect(stoppingSnap?.activity).toBe("stopping");
    expect(stoppingSnap?.stopId).toBe(stopId);

    ledger.settleStop!(sessionId, stopId as number, { driverBusy: false, setupActive: false });
    const settledSnap = ledger.snapshot().sessions.find((s) => s.sessionId === sessionId);
    expect(settledSnap?.activity).toBe("idle");
    expect(settledSnap?.stopId).toBeUndefined();
    expect(settledSnap?.settledStopId).toBe(stopId);

    const msg2 = ledger.postUserMessage({ conversationId, clientId: "m-stop-id-2", text: "next" }).messageId;
    ev({ type: "message.delivered", messageIds: [msg2], at: ++now });
    const nextSnap = ledger.snapshot().sessions.find((s) => s.sessionId === sessionId);
    expect(nextSnap?.activity).toBe("working");
    expect(nextSnap?.settledStopId).toBe(stopId);
  });
});
