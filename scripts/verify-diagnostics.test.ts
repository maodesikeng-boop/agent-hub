import { describe, expect, it } from "vitest";
import {
  VERIFY_SMOKE_BUDGET_MS,
  VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS,
  VERIFY_SMOKE_MAX_NOTES,
  VERIFY_SMOKE_STEP_TIMEOUT_MS,
} from "../src/shared/limits.ts";
import {
  createVerifyStepTracker,
  formatVerifyError,
  formatVerifyRunReport,
  type VerifyFailure,
} from "./verify-diagnostics.ts";

class FakeProtocolError extends Error {
  type: "closed" | "crashed" | "error";
  method?: string;
  logs?: string;

  constructor(type: "closed" | "crashed" | "error", method?: string, logs?: string) {
    super();
    this.type = type;
    this.method = method;
    this.logs = logs;
  }
}

describe("verify-diagnostics unchanged limits regression", () => {
  it("keeps the existing verify smoke budget and step timeout constants intact", () => {
    expect(VERIFY_SMOKE_BUDGET_MS).toBe(20_000);
    expect(VERIFY_SMOKE_STEP_TIMEOUT_MS).toBe(15_000);
    expect(VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS).toBeGreaterThan(0);
    expect(VERIFY_SMOKE_MAX_NOTES).toBeGreaterThan(0);
  });
});

describe("formatVerifyError", () => {
  it("synthesizes non-empty summary and detail for an empty-message Playwright ProtocolError", () => {
    const err = new FakeProtocolError("closed", "Timeline.start", "WPEWebProcess exited with signal SIGSEGV");
    const failure = formatVerifyError(err, {
      phasePath: ["WebKit composer layout", "recordKeys", "Timeline.start"],
      phaseDurationMs: 20_160,
      notes: ["page crashed before Timeline.stop"],
    });

    expect(failure.phasePath).toEqual(["WebKit composer layout", "recordKeys", "Timeline.start"]);
    expect(failure.phaseDurationMs).toBe(20_160);
    expect(failure.errorType).toBe("FakeProtocolError");
    expect(failure.summary.trim().length).toBeGreaterThan(0);
    expect(failure.summary).toContain("WebKit composer layout > recordKeys > Timeline.start");
    expect(failure.summary).toContain("FakeProtocolError");
    expect(failure.summary).toContain("closed");
    expect(failure.summary).toContain("Timeline.start");
    expect(failure.detail).toContain("WPEWebProcess exited with signal SIGSEGV");
    expect(failure.detail).toContain("page crashed before Timeline.stop");
    expect(failure.detail).toContain("FakeProtocolError");
  });

  it("handles bare empty-message Error, AggregateError, and nested cause chains without returning blank output", () => {
    const blank = formatVerifyError(new Error(""), { phasePath: ["WebKit composer layout"] });
    expect(blank.summary.trim().length).toBeGreaterThan(0);
    expect(blank.summary).toContain("Error");
    expect(blank.summary).toContain("WebKit composer layout");
    expect(blank.detail).toContain("Error");

    const agg = new AggregateError([new Error("first connection refused"), new TypeError("second failed")], "");
    const aggFailure = formatVerifyError(agg, { phasePath: ["登录、健康检查、/api/state"] });
    expect(aggFailure.errorType).toBe("AggregateError");
    expect(aggFailure.summary).toContain("AggregateError");
    expect(aggFailure.summary).toContain("first connection refused");
    expect(aggFailure.detail).toContain("second failed");

    const root = new Error("socket closed");
    const outer = new Error("request failed", { cause: root });
    const chained = formatVerifyError(outer, { daemonStderr: "daemon fatal: boom" });
    expect(chained.summary).toContain("request failed");
    expect(chained.detail).toContain("socket closed");
    expect(chained.detail).toContain("daemon fatal: boom");
  });

  it("safely formats non-Error primitives, plain objects, circular objects, and throwing getters", () => {
    const circular: Record<string, unknown> = { code: "EPIPE" };
    circular.self = circular;

    const hostile = {
      get message(): string {
        throw new Error("getter exploded");
      },
      toString(): string {
        throw new Error("toString exploded");
      },
    };

    for (const value of [null, undefined, "", 42, Symbol("boom"), { code: "ECONNRESET" }, circular, hostile]) {
      const failure = formatVerifyError(value, { phasePath: ["step"] });
      expect(failure.summary.trim().length).toBeGreaterThan(0);
      expect(failure.summary).toContain("step");
    }

    const circularFailure = formatVerifyError(circular);
    expect(circularFailure.summary).toContain("EPIPE");
  });

  it("keeps aggregate child stacks, nested causes, and the enclosing stack", () => {
    const cause = new Error("deep cause");
    cause.stack = "Error: deep cause\n    at deepCauseOrigin (daemon.ts:3:1)";
    const child = new TypeError("child failed", { cause });
    child.stack = "TypeError: child failed\n    at childOrigin (daemon.ts:2:1)";
    const aggregate = new AggregateError([child], "outer");
    aggregate.stack = "AggregateError: outer\n    at aggregateOrigin (daemon.ts:1:1)";

    expect(formatVerifyError(aggregate).detail).toMatch(/aggregateOrigin/);
    expect(formatVerifyError(aggregate).detail).toMatch(/childOrigin/);
    expect(formatVerifyError(aggregate).detail).toMatch(/deepCauseOrigin/);
  });

  it("does not execute a thrown object's aggregate iterator or propagate proxy traps", () => {
    const entries = [new Error("readable child")];
    Object.defineProperty(entries, "entries", { value: () => { throw new Error("iterator trap"); } });
    const hostile = { name: "BrokenAggregate", errors: entries };
    expect(formatVerifyError(hostile).summary).toContain("BrokenAggregate");
    expect(formatVerifyError(hostile).detail).toContain("readable child");

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(formatVerifyError({ name: "RevokedAggregate", errors: revoked.proxy }).summary).toContain("RevokedAggregate");
    expect(formatVerifyError(revoked.proxy).summary).toBeTruthy();
    const trapped = new Proxy({}, { getPrototypeOf: () => { throw new Error("prototype trap"); } });
    expect(formatVerifyError(trapped).summary).toBeTruthy();
  });

  it("bounds oversized diagnostic logs and daemon stderr to VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS", () => {
    const hugeLogs = "L".repeat(120_000);
    const hugeStderr = "D".repeat(120_000);
    const err = new FakeProtocolError("crashed", "Timeline.enable", hugeLogs);
    const failure = formatVerifyError(err, {
      phasePath: ["WebKit composer layout"],
      daemonStderr: hugeStderr,
    });

    expect(failure.detail.length).toBeLessThanOrEqual(VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS);
    expect(failure.summary.trim().length).toBeGreaterThan(0);
  });
});

describe("createVerifyStepTracker", () => {
  it("records completed phases and preserves the deepest failing sub-step path and elapsed duration", async () => {
    let clock = 1_000;
    const tracker = createVerifyStepTracker(() => clock);

    await tracker.runPhase("构建网页", async () => {
      clock += 2_500;
    });

    await expect(
      tracker.runPhase("WebKit composer layout", async (ctx) => {
        clock += 500;
        await ctx.step("openComposerPage", async () => {
          clock += 1_000;
        });
        await ctx.step("recordKeys", async () => {
          clock += 250;
          await ctx.step("Timeline.start", async () => {
            ctx.note("WebKit page crashed");
            clock += 750;
            throw new FakeProtocolError("crashed", "Timeline.start");
          });
        });
      }),
    ).rejects.toBeInstanceOf(FakeProtocolError);

    const snap = tracker.snapshot();
    expect(snap.phases).toEqual([{ name: "构建网页", durationMs: 2_500 }]);
    expect(snap.activePath).toEqual(["WebKit composer layout", "recordKeys", "Timeline.start"]);
    expect(snap.activeDurationMs).toBe(2_500);
    expect(snap.notes).toContain("WebKit page crashed");
  });

  it("caps recorded lifecycle notes at VERIFY_SMOKE_MAX_NOTES", () => {
    const tracker = createVerifyStepTracker(() => 0);
    for (let i = 0; i < 100; i++) tracker.note(`note-${i}`);
    const snap = tracker.snapshot();
    expect(snap.notes.length).toBeLessThanOrEqual(VERIFY_SMOKE_MAX_NOTES);
    expect(snap.notes.length).toBeGreaterThan(0);
  });
});

describe("formatVerifyRunReport", () => {
  it("never renders a blank failure status and prints failed phase info plus diagnostic detail", () => {
    const failure: VerifyFailure = {
      phasePath: ["WebKit composer layout", "recordKeys", "Timeline.start"],
      phaseDurationMs: 20_160,
      errorType: "ProtocolError",
      summary: "[WebKit composer layout > recordKeys > Timeline.start] ProtocolError: session closed (method=Timeline.start)",
      detail: "type: closed\nmethod: Timeline.start\nstack: Error\n  at WKSession.send",
    };

    const output = formatVerifyRunReport(1, {
      ok: false,
      totalMs: 40_580,
      budgetMs: VERIFY_SMOKE_BUDGET_MS,
      phases: [
        { name: "构建网页", durationMs: 2_590 },
        { name: "起守护进程", durationMs: 1_790 },
      ],
      failure,
    });

    expect(output).toContain("失败：[WebKit composer layout > recordKeys > Timeline.start] ProtocolError");
    expect(output).not.toMatch(/失败：\s*$/m);
    expect(output).toContain("构建网页 2.59s");
    expect(output).toContain("type: closed");
    expect(output).toContain("WKSession.send");
  });

  it("renders a passing run with completed phases", () => {
    const output = formatVerifyRunReport(1, {
      ok: true,
      totalMs: 12_340,
      budgetMs: VERIFY_SMOKE_BUDGET_MS,
      phases: [{ name: "构建网页", durationMs: 2_500 }],
    });

    expect(output).toContain("第 1 次：12.34s，通过");
    expect(output).toContain("构建网页 2.50s");
  });
});
