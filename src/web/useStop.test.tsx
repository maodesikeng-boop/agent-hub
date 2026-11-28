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
