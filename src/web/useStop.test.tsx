import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../shared/index.ts";
import { makeSession } from "./test-utils.ts";
import { useStop } from "./useStop.ts";

describe("useStop lifecycle closure (S2, S5, S6, S12)", () => {
  it("resets local stopping phase when switching to a different busy conversation or session", async () => {
    const requestStop = vi.fn(() => Promise.resolve());
    const sessionA = makeSession({ sessionId: 1, conversationId: 10, status: "running", activity: "working", activeTurnId: 101 });
    const sessionB = makeSession({ sessionId: 2, conversationId: 20, status: "running", activity: "working", activeTurnId: 201 });

    const { result, rerender } = renderHook(
      ({ session }: { session: SessionState | null }) => useStop(session, requestStop, false),
      { initialProps: { session: sessionA } },
    );

    await act(async () => {
      result.current.onStop();
      await Promise.resolve();
    });
    expect(result.current.stopping).toBe(true);
    expect(result.current.canStop).toBe(false);

    rerender({ session: sessionB });
    expect(result.current.stopping).toBe(false);
    expect(result.current.canStop).toBe(true);
  });

  it("resets local requested phase when a new turn starts on the same session after a coalesced idle-working burst", async () => {
    const requestStop = vi.fn(() => Promise.resolve());
    const turn1 = makeSession({ sessionId: 1, conversationId: 10, status: "running", activity: "working", activeTurnId: 101 });
    const turn2 = makeSession({ sessionId: 1, conversationId: 10, status: "running", activity: "working", activeTurnId: 102 });

    const { result, rerender } = renderHook(
      ({ session }: { session: SessionState | null }) => useStop(session, requestStop, false),
      { initialProps: { session: turn1 } },
    );

    await act(async () => {
      result.current.onStop();
      await Promise.resolve();
    });
    expect(result.current.stopping).toBe(true);

    // Coalesced WS update: never rendered intermediate idle, jumped straight to turn 2 working.
    rerender({ session: turn2 });
    expect(result.current.stopping).toBe(false);
    expect(result.current.canStop).toBe(true);
  });

  it("resets local requested phase when server activity exits stopping back to working (stale cache resync)", async () => {
    const requestStop = vi.fn(() => Promise.resolve());
    const working = makeSession({ sessionId: 1, conversationId: 10, status: "running", activity: "working" });
    const stopping = makeSession({ sessionId: 1, conversationId: 10, status: "running", activity: "stopping" });

    const { result, rerender } = renderHook(
      ({ session }: { session: SessionState | null }) => useStop(session, requestStop, false),
      { initialProps: { session: working } },
    );

    await act(async () => {
      result.current.onStop();
      await Promise.resolve();
    });
    rerender({ session: stopping });
    expect(result.current.stopping).toBe(true);

    rerender({ session: working });
    expect(result.current.stopping).toBe(false);
    expect(result.current.canStop).toBe(true);
  });

  it("regression: transitions idle -> sending -> requested -> idle cleanly and reports failed stop", async () => {
    let resolveStop!: () => void;
    const requestStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const working = makeSession({ sessionId: 1, conversationId: 10, status: "running", activity: "working" });
    const idle = makeSession({ sessionId: 1, conversationId: 10, status: "running", activity: "idle" });

    const { result, rerender } = renderHook(
      ({ session }: { session: SessionState | null }) => useStop(session, requestStop, false),
      { initialProps: { session: working } },
    );

    expect(result.current.canStop).toBe(true);
    const firstRef = result.current;
    rerender({ session: working });
    expect(result.current).toBe(firstRef);

    act(() => {
      result.current.onStop();
    });
    expect(result.current.stopping).toBe(true);
    expect(result.current.canStop).toBe(false);

    await act(async () => {
      resolveStop();
      await Promise.resolve();
    });
    expect(result.current.stopping).toBe(true);

    rerender({ session: idle });
    expect(result.current.stopping).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.canStop).toBe(false);
  });
});

describe("useStop shared stopId ordering and in-flight turn progression regressions", () => {
  it("keeps the next turn stop button enabled when WS settledStopId arrives before the POST /stop 202 reply", async () => {
    let resolveStop!: (value: { stopId: number | null }) => void;
    const requestStop = vi.fn(
      () =>
        new Promise<{ stopId: number | null }>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const preparing = makeSession({
      sessionId: 1,
      conversationId: 10,
      status: "running",
      activity: "preparing",
      activeTurnId: null,
      settledStopId: 6,
    });
    const nextTurnWorking = makeSession({
      sessionId: 1,
      conversationId: 10,
      status: "running",
      activity: "working",
      activeTurnId: null,
      settledStopId: 7,
    });

    const { result, rerender } = renderHook(
      ({ session }: { session: SessionState | null }) => useStop(session, requestStop, false),
      { initialProps: { session: preparing } },
    );

    act(() => {
      result.current.onStop();
    });
    expect(result.current.stopping).toBe(true);

    // WS pushes the settled stopId=7 and the immediately-started next turn before HTTP 202 resolves.
    rerender({ session: nextTurnWorking });
    await act(async () => {
      resolveStop({ stopId: 7 });
      await Promise.resolve();
    });

    expect(result.current.stopping).toBe(false);
    expect(result.current.canStop).toBe(true);
  });

  it("clears requested phase when WS settledStopId arrives after HTTP 202 without intermediate stopping/idle frames and across unchanged resync snapshots", async () => {
    let resolveStop!: (value: { stopId: number | null }) => void;
    const requestStop = vi.fn(
      () =>
        new Promise<{ stopId: number | null }>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const workingBefore = makeSession({
      sessionId: 1,
      conversationId: 10,
      status: "running",
      activity: "working",
      activeTurnId: null,
      settledStopId: 6,
    });
    const coalescedNextTurn = makeSession({
      sessionId: 1,
      conversationId: 10,
      status: "running",
      activity: "working",
      activeTurnId: null,
      settledStopId: 7,
    });

    const { result, rerender } = renderHook(
      ({ session }: { session: SessionState | null }) => useStop(session, requestStop, false),
      { initialProps: { session: workingBefore } },
    );

    act(() => {
      result.current.onStop();
    });
    await act(async () => {
      resolveStop({ stopId: 7 });
      await Promise.resolve();
    });
    expect(result.current.stopping).toBe(true);
    expect(result.current.canStop).toBe(false);

    // Unchanged resync while stopId=7 has not yet settled keeps stopping active.
    rerender({ session: { ...workingBefore } });
    expect(result.current.stopping).toBe(true);

    // Coalesced WS or resync carrying settledStopId=7 clears stopping even with no intermediate stopping or idle frame.
    rerender({ session: coalescedNextTurn });
    expect(result.current.stopping).toBe(false);
    expect(result.current.canStop).toBe(true);
  });

  it("preserves sending state and reports failed=true when activeTurnId transitions null -> turnId while POST /stop is in flight", async () => {
    let rejectStop!: (err: Error) => void;
    const requestStop = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStop = reject;
        }),
    );
    const queuedIdle = makeSession({
      sessionId: 1,
      conversationId: 10,
      status: "running",
      activity: "idle",
      activeTurnId: null,
    });
    const processingTurn = makeSession({
      sessionId: 1,
      conversationId: 10,
      status: "running",
      activity: "working",
      activeTurnId: 101,
    });

    const { result, rerender } = renderHook(
      ({ session, queued }: { session: SessionState | null; queued: boolean }) => useStop(session, requestStop, queued),
      { initialProps: { session: queuedIdle, queued: true } },
    );

    act(() => {
      result.current.onStop();
    });
    expect(result.current.stopping).toBe(true);
    expect(result.current.canStop).toBe(false);

    // Same message progresses from queued -> processing (activeTurnId: null -> 101) while POST /stop is still in flight.
    rerender({ session: processingTurn, queued: false });
    expect(result.current.stopping).toBe(true);
    expect(result.current.canStop).toBe(false);

    await act(async () => {
      rejectStop(new Error("network offline"));
      await Promise.resolve();
    });
    expect(result.current.failed).toBe(true);
    expect(result.current.stopping).toBe(false);
    expect(result.current.canStop).toBe(true);
  });

  it("clears local stopping immediately when POST /stop returns stopId=null", async () => {
    const requestStop = vi.fn(() => Promise.resolve({ stopId: null }));
    const working = makeSession({
      sessionId: 1,
      conversationId: 10,
      status: "running",
      activity: "working",
      activeTurnId: null,
    });

    const { result } = renderHook(() => useStop(working, requestStop, false));
    await act(async () => {
      result.current.onStop();
      await Promise.resolve();
    });

    expect(result.current.stopping).toBe(false);
    expect(result.current.canStop).toBe(true);
  });
});
