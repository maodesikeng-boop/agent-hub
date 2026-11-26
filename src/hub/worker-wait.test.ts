import { describe, expect, it, vi } from "vitest";
import { HUB_EXIT } from "../shared/hub.ts";
import { WORKER_WAIT_CHUNK_MS, WORKER_WAIT_DEFAULT_MS } from "../shared/limits.ts";
import { parseCommand } from "./parse.ts";
import { runWorkerWaitLoop, type WorkerWaitChunkResult } from "./worker-wait.ts";

describe("S6 (CLI): hub worker wait parser and chunked loop", () => {
  it("parses hub worker wait with multiple Worker IDs and optional --timeout", () => {
    expect(parseCommand(["worker", "wait", "12", "13"], {}, "/tmp")).toEqual({
      command: "worker.wait",
      body: { workerIds: [12, 13], waitMs: WORKER_WAIT_DEFAULT_MS },
      textSource: null,
    });
    expect(parseCommand(["worker", "wait", "12", "--timeout", "3m"], {}, "/tmp")).toEqual({
      command: "worker.wait",
      body: { workerIds: [12], waitMs: 180_000 },
      textSource: null,
    });
  });

  it("S6.2: loops in WORKER_WAIT_CHUNK_MS steps until settled and exits 0", async () => {
    let clock = 1_000_000;
    const requests: Array<{ workerIds: readonly number[]; waitMs: number }> = [];
    const requestChunk = vi.fn(async (body: { workerIds: readonly number[]; waitMs: number }): Promise<WorkerWaitChunkResult> => {
      requests.push(body);
      clock += body.waitMs;
      const done = requests.length >= 2;
      return {
        kind: "response",
        response: {
          ok: true,
          text: done ? "#12 已开工（准备用了 20 秒）" : "#12 还在跑准备命令",
          data: {
            settled: done,
            timedOut: !done,
            workers: [{ workerId: 12, phase: done ? "started" : "running_setup", elapsedMs: 20_000, detail: null }],
          },
        },
      };
    });

    const out = await runWorkerWaitLoop({ requestChunk, now: () => clock }, { workerIds: [12], timeoutMs: 25_000 });
    expect(out.exitCode).toBe(HUB_EXIT.ok);
    expect(requests.map((r) => r.waitMs)).toEqual([WORKER_WAIT_CHUNK_MS, WORKER_WAIT_CHUNK_MS]);
    expect(out.stdout).toContain("#12 已开工");
  });

  it("S6.4: exits 0 at total timeout and prints current phase and elapsed time", async () => {
    let clock = 2_000_000;
    const requestChunk = vi.fn(async (body: { workerIds: readonly number[]; waitMs: number }): Promise<WorkerWaitChunkResult> => {
      clock += body.waitMs;
      return {
        kind: "response",
        response: {
          ok: true,
          text: "#15 还在跑准备命令（已 15 秒），可以结束这一轮，开工失败会通知你",
          data: {
            settled: false,
            timedOut: true,
            workers: [{ workerId: 15, phase: "running_setup", elapsedMs: 15_000, detail: null }],
          },
        },
      };
    });

    const out = await runWorkerWaitLoop({ requestChunk, now: () => clock }, { workerIds: [15], timeoutMs: 15_000 });
    expect(out.exitCode).toBe(HUB_EXIT.ok);
    expect(requestChunk).toHaveBeenCalledTimes(2);
    expect(out.stdout).toContain("#15");
    expect(out.stdout).toContain("准备命令");
  });

  it("S6.6: daemon restart mid-wait exits with HUB_EXIT.unreachable and notes that rerunning is safe", async () => {
    let clock = 3_000_000;
    let calls = 0;
    const requestChunk = vi.fn(async (body: { workerIds: readonly number[]; waitMs: number }): Promise<WorkerWaitChunkResult> => {
      calls++;
      clock += body.waitMs;
      if (calls === 1) {
        return {
          kind: "response",
          response: {
            ok: true,
            text: "#12 准备中",
            data: {
              settled: false,
              timedOut: true,
              workers: [{ workerId: 12, phase: "creating_worktree", elapsedMs: 10_000, detail: null }],
            },
          },
        };
      }
      return { kind: "unreachable", reason: "ECONNREFUSED" };
    });

    const out = await runWorkerWaitLoop({ requestChunk, now: () => clock }, { workerIds: [12], timeoutMs: 30_000 });
    expect(out.exitCode).toBe(HUB_EXIT.unreachable);
    expect(out.stderr).toMatch(/连不上|重跑/);
  });
});
