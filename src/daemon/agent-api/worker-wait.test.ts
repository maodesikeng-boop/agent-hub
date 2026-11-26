import { afterEach, describe, expect, it, vi } from "vitest";
import type { Change } from "../../shared/api.ts";
import { WORKER_WAIT_CHUNK_MS } from "../../shared/limits.ts";
import type { WorkerWaitResult } from "../../shared/worker-wait.ts";
import { FakeHubLedger } from "./fake-ledger.ts";
import { createAgentApi } from "./server.ts";
import { createSessionTokens } from "./tokens.ts";
import { waitForWorkersStart } from "./worker-wait.ts";

describe("S6 (agent-api): event-driven bounded waitForWorkersStart", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeBus = () => {
    const listeners = new Set<(c: Change) => void>();
    return {
      onChange: (fn: (c: Change) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      emit: (c: Change) => {
        for (const fn of [...listeners]) fn(c);
      },
      count: () => listeners.size,
    };
  };

  it("returns immediately without subscribing when already settled", async () => {
    const bus = makeBus();
    const settled: WorkerWaitResult = {
      settled: true,
      timedOut: false,
      workers: [{ workerId: 12, phase: "started", elapsedMs: 5_000, detail: null }],
    };
    const snapshot = vi.fn(() => settled);
    const ac = new AbortController();

    const res = await waitForWorkersStart({ snapshot, onChange: bus.onChange }, { sessionId: 1, workerIds: [12], waitMs: WORKER_WAIT_CHUNK_MS }, ac.signal);
    expect(res).toEqual(settled);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(bus.count()).toBe(0);
  });

  it("resolves on ledger change without polling and cleans up its listener", async () => {
    vi.useFakeTimers();
    const bus = makeBus();
    let started = false;
    const snapshot = vi.fn((): WorkerWaitResult => ({
      settled: started,
      timedOut: false,
      workers: [{ workerId: 12, phase: started ? "started" : "running_setup", elapsedMs: 12_000, detail: null }],
    }));
    const ac = new AbortController();

    const pending = waitForWorkersStart(
      { snapshot, onChange: bus.onChange },
      { sessionId: 1, workerIds: [12], waitMs: WORKER_WAIT_CHUNK_MS },
      ac.signal,
    );
    pending.catch(() => undefined);
    expect(bus.count()).toBe(1);

    started = true;
    bus.emit({ type: "session.status", seq: 1, data: {} as never });

    const res = await pending;
    expect(res.settled).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.workers[0]!.phase).toBe("started");
    expect(bus.count()).toBe(0);
  });

  it("resolves with timedOut=true when waitMs elapses before settling", async () => {
    vi.useFakeTimers();
    const bus = makeBus();
    const snapshot = vi.fn((): WorkerWaitResult => ({
      settled: false,
      timedOut: false,
      workers: [{ workerId: 15, phase: "running_setup", elapsedMs: 25_000, detail: null }],
    }));
    const ac = new AbortController();

    const pending = waitForWorkersStart(
      { snapshot, onChange: bus.onChange },
      { sessionId: 1, workerIds: [15], waitMs: WORKER_WAIT_CHUNK_MS },
      ac.signal,
    );
    pending.catch(() => undefined);
    expect(bus.count()).toBe(1);

    await vi.advanceTimersByTimeAsync(WORKER_WAIT_CHUNK_MS);
    const res = await pending;
    expect(res.settled).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(bus.count()).toBe(0);
  });

  it("stops touching the ledger immediately once signal aborts (shutdown or client disconnect)", async () => {
    vi.useFakeTimers();
    const bus = makeBus();
    const snapshot = vi.fn((): WorkerWaitResult => ({
      settled: false,
      timedOut: false,
      workers: [{ workerId: 15, phase: "creating_worktree", elapsedMs: 1_000, detail: null }],
    }));
    const ac = new AbortController();

    const pending = waitForWorkersStart(
      { snapshot, onChange: bus.onChange },
      { sessionId: 1, workerIds: [15], waitMs: WORKER_WAIT_CHUNK_MS },
      ac.signal,
    );
    pending.catch(() => undefined);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(bus.count()).toBe(1);
    const callsBeforeAbort = snapshot.mock.calls.length;
    ac.abort();
    await pending.catch(() => undefined);

    expect(bus.count()).toBe(0);
    bus.emit({ type: "session.status", seq: 2, data: {} as never });
    await vi.advanceTimersByTimeAsync(WORKER_WAIT_CHUNK_MS * 2);
    expect(snapshot).toHaveBeenCalledTimes(callsBeforeAbort);
  });

  it("regression: /v1/worker.wait never triggers probePr (no gh pr view storm)", async () => {
    const ledger = new FakeHubLedger();
    ledger.prTarget = { cwd: "/repo", branch: "hub/12" };
    const tokens = createSessionTokens();
    const token = tokens.issue(11);
    const probePr = vi.fn(async () => null);
    const app = createAgentApi({ ledger, tokens, probePr });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/worker.wait",
        headers: { authorization: `Bearer ${token}` },
        payload: { workerIds: [12], waitMs: 5_000 },
      });
      expect(res.statusCode).toBe(200);
      expect(probePr).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
