import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";
import {
  COMPOSER_CHAT_TEXTAREA_SELECTOR,
  openComposerPage,
  runWithWebKitTimeline,
  type TimelineRecord,
  type WebKitTimelineSession,
} from "./verify-composer-layout.ts";
import type { VerifyStepContext } from "./verify-diagnostics.ts";

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

function createFakeTimelineSession(options?: {
  onSend?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}) {
  const listeners = new Set<(event: { record: TimelineRecord }) => void>();
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let disposed = false;

  const session: WebKitTimelineSession = {
    on(_event, listener) {
      listeners.add(listener);
    },
    off(_event, listener) {
      listeners.delete(listener);
    },
    isDisposed() {
      return disposed;
    },
    async send(method, params) {
      calls.push({ method, params });
      if (options?.onSend) return options.onSend(method, params);
      if (disposed) throw new FakeProtocolError("closed", undefined, "browser disconnected");
      return {};
    },
  };

  return {
    session,
    calls,
    listenerCount: () => listeners.size,
    emitRecord: (record: TimelineRecord) => {
      for (const listener of listeners) listener({ record });
    },
    markDisposed: () => {
      disposed = true;
    },
  };
}

function createRecordingSteps(): { steps: VerifyStepContext; entered: string[]; notes: string[] } {
  const entered: string[] = [];
  const notes: string[] = [];
  const steps: VerifyStepContext = {
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      entered.push(name);
      return fn();
    },
    note(message: string): void {
      notes.push(message);
    },
  };
  return { steps, entered, notes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("verify-composer-layout unchanged budget assertions regression", () => {
  it("retains WebKit layout count, root height, soft-wrap, paste, IME, and touch font-floor checks", () => {
    const layoutSource = readFileSync(join(import.meta.dirname, "verify-composer-layout.ts"), "utf8");
    const interactionsSource = readFileSync(join(import.meta.dirname, "verify-composer-interactions.ts"), "utf8");

    expect(layoutSource).toContain("count <= 1");
    expect(layoutSource).toContain("height <= singleHeight");
    expect(layoutSource).toContain("WebKit composer exceeded its layout budget");
    expect(layoutSource).toContain("verifyTouchSoftWrap");

    expect(interactionsSource).toContain("COMPOSER_MAX_HEIGHT_PX");
    expect(interactionsSource).toContain("assert.equal(fontSize, 16");
    expect(interactionsSource).toContain("compositionstart");
    expect(interactionsSource).toContain("compositionend");
    expect(interactionsSource).toContain("Typing never crossed the soft wrap boundary");
  });
});

describe("runWithWebKitTimeline", () => {
  it("enables Timeline, starts with maxCallStackDepth 0, collects records, detaches listener, and stops and disables on success", async () => {
    const fake = createFakeTimelineSession();
    const { steps, entered } = createRecordingSteps();

    const { result, records } = await runWithWebKitTimeline(
      fake.session,
      async () => {
        fake.emitRecord({ type: "Layout", startTime: 1, data: { root: [0, 0, 100, 0, 100, 40, 0, 40] } });
        return "done";
      },
      { timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS, steps },
    );

    expect(result).toBe("done");
    expect(records).toHaveLength(1);
    expect(fake.calls).toEqual([
      { method: "Timeline.enable", params: undefined },
      { method: "Timeline.start", params: { maxCallStackDepth: 0 } },
      { method: "Timeline.stop", params: undefined },
      { method: "Timeline.disable", params: undefined },
    ]);
    expect(fake.listenerCount()).toBe(0);
    expect(entered).toContain("Timeline.enable");
    expect(entered).toContain("Timeline.start");
  });

  it("never masks the primary error when the session disposes or Timeline.stop throws an empty ProtocolError", async () => {
    const fake = createFakeTimelineSession({
      async onSend(method) {
        if (method === "Timeline.stop") throw new FakeProtocolError("closed", "Timeline.stop");
        return {};
      },
    });
    const { steps, notes } = createRecordingSteps();
    const primary = new Error("Target page, context or browser has been closed");

    await expect(
      runWithWebKitTimeline(
        fake.session,
        async () => {
          throw primary;
        },
        { timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS, steps },
      ),
    ).rejects.toBe(primary);

    expect(fake.listenerCount()).toBe(0);
    expect(notes.some((n) => n.includes("Timeline.stop"))).toBe(true);

    const disposedFake = createFakeTimelineSession();
    await expect(
      runWithWebKitTimeline(
        disposedFake.session,
        async () => {
          disposedFake.markDisposed();
          throw primary;
        },
        { timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS },
      ),
    ).rejects.toBe(primary);

    expect(disposedFake.calls.map((c) => c.method)).toEqual(["Timeline.enable", "Timeline.start"]);
    expect(disposedFake.listenerCount()).toBe(0);
  });

  it("rewrites an empty-message ProtocolError during Timeline.start into a descriptive error with method, type, logs, and state", async () => {
    const fake = createFakeTimelineSession({
      async onSend(method) {
        if (method === "Timeline.start") {
          throw new FakeProtocolError("crashed", "Timeline.start", "WebKitWebProcess crashed");
        }
        return {};
      },
    });

    await expect(
      runWithWebKitTimeline(fake.session, async () => "unreachable", {
        timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS,
        describeState: () => "pageCrashed=true",
      }),
    ).rejects.toThrow(/Timeline\.start[\s\S]*crashed[\s\S]*WebKitWebProcess crashed|Timeline\.start[\s\S]*crashed/);

    expect(fake.listenerCount()).toBe(0);
  });

  it("rejects with a clear timeout error when a Timeline command hangs", async () => {
    vi.useFakeTimers();
    const fake = createFakeTimelineSession({
      onSend(method) {
        if (method === "Timeline.start") return new Promise(() => {});
        return Promise.resolve({});
      },
    });

    const pending = runWithWebKitTimeline(fake.session, async () => "unreachable", { timeoutMs: 2_500 });
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_600);
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Timeline.start");
    expect((error as Error).message).toMatch(/2\.5|timeout|timed out|没完成/i);
    expect(fake.listenerCount()).toBe(0);
  });
});

describe("openComposerPage", () => {
  it("waits for auth redirect, #chat composer selector, networkidle, fonts, and frame settle with step timeouts and crash notes", async () => {
    const events: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const waitOptions: Array<{ selector: string; timeout?: number }> = [];

    const fakePage = {
      on(event: string, listener: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(listener);
        handlers.set(event, list);
      },
      async goto(url: string, opts?: { timeout?: number }) {
        events.push(`goto:${url}:timeout=${opts?.timeout}`);
      },
      async waitForURL(matcher: unknown, opts?: { timeout?: number }) {
        events.push(`waitForURL:${typeof matcher}:timeout=${opts?.timeout}`);
      },
      locator(selector: string) {
        return {
          async waitFor(opts?: { state?: string; timeout?: number }) {
            waitOptions.push({ selector, timeout: opts?.timeout });
            events.push(`waitFor:${selector}:timeout=${opts?.timeout}`);
          },
        };
      },
      async waitForLoadState(state: string, opts?: { timeout?: number }) {
        events.push(`loadState:${state}:timeout=${opts?.timeout}`);
      },
      async evaluate() {
        events.push("evaluate");
      },
    } as unknown as Page;

    const errors: string[] = [];
    const { steps, notes } = createRecordingSteps();

    await openComposerPage(fakePage, "http://127.0.0.1:4317/auth?token=abc", 7, errors, {
      timeoutMs: VERIFY_SMOKE_STEP_TIMEOUT_MS,
      steps,
    });

    expect(events[0]).toBe(`goto:http://127.0.0.1:4317/auth?token=abc:timeout=${VERIFY_SMOKE_STEP_TIMEOUT_MS}`);
    expect(events.some((e) => e.startsWith("waitForURL:") && e.includes(`timeout=${VERIFY_SMOKE_STEP_TIMEOUT_MS}`))).toBe(true);
    expect(events).toContain(`goto:http://127.0.0.1:4317/#/c/7:timeout=${VERIFY_SMOKE_STEP_TIMEOUT_MS}`);
    expect(waitOptions).toEqual([{ selector: COMPOSER_CHAT_TEXTAREA_SELECTOR, timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS }]);
    expect(events).toContain(`loadState:networkidle:timeout=${VERIFY_SMOKE_STEP_TIMEOUT_MS}`);
    expect(events.filter((e) => e === "evaluate").length).toBeGreaterThanOrEqual(1);

    for (const listener of handlers.get("console") ?? []) {
      listener({ type: () => "error", text: () => 'Viewport argument key "interactive-widget" not recognized and ignored.' });
      listener({ type: () => "error", text: () => "real error" });
    }
    expect(errors).toEqual(["real error"]);

    for (const listener of handlers.get("crash") ?? []) listener();
    expect(notes.some((n) => /crash/i.test(n))).toBe(true);
  });
});
