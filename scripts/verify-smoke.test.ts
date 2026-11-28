import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VerifyStepContext, VerifyStepTracker } from "./verify-diagnostics.ts";
import { runBrowserVerifications, type SmokeBrowserDeps, type SmokeBrowserHandle } from "./verify-smoke.ts";

function createFakeTracker(): { tracker: VerifyStepTracker; phases: string[] } {
  const phases: string[] = [];
  const ctx: VerifyStepContext = {
    async step<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    note() {},
  };
  const tracker: VerifyStepTracker = {
    async runPhase<T>(name: string, fn: (c: VerifyStepContext) => Promise<T>): Promise<T> {
      const result = await fn(ctx);
      phases.push(name);
      return result;
    },
    note() {},
    snapshot() {
      return { phases: phases.map((name) => ({ name, durationMs: 1 })), activePath: [], activeDurationMs: 0, notes: [] };
    },
  };
  return { tracker, phases };
}

describe("verify-smoke unchanged safety boundaries regression", () => {
  it("preserves session owner tag passthrough and leftover child-process ledger verification", () => {
    const source = readFileSync(join(import.meta.dirname, "verify-smoke.ts"), "utf8");
    expect(source).toContain("ENV_SESSION_OWNER_TAG");
    expect(source).toContain("readLedgerFile");
    expect(source).toContain("VERIFY_SMOKE_STEP_TIMEOUT_MS");
  });
});

describe("runBrowserVerifications", () => {
  it("finishes WebKit composer verification before launching Chromium so peak active browsers never exceeds 1", async () => {
    const events: string[] = [];
    let activeBrowsers = 0;
    let peakBrowsers = 0;
    const { tracker } = createFakeTracker();

    const deps: SmokeBrowserDeps<SmokeBrowserHandle> = {
      async verifyWebKitComposer(conversationId) {
        activeBrowsers++;
        peakBrowsers = Math.max(peakBrowsers, activeBrowsers);
        events.push(`webkit:start:${conversationId}`);
        activeBrowsers--;
        events.push(`webkit:end:${conversationId}`);
      },
      async launchChromium() {
        activeBrowsers++;
        peakBrowsers = Math.max(peakBrowsers, activeBrowsers);
        events.push("chromium:launch");
        return {
          async close() {
            activeBrowsers--;
            events.push("chromium:close");
          },
        };
      },
      async runChromiumChecks(_browser, _t, checkComposer, conversationId) {
        events.push(`chromium:checks:composer=${checkComposer}:id=${conversationId}`);
        return { conversationId: conversationId ?? 1, userMessageId: 1, replyMessageId: 2, replyMs: 10 };
      },
    };

    const trip = await runBrowserVerifications(deps, { checkComposer: true, conversationId: 42, tracker });

    expect(trip.conversationId).toBe(42);
    expect(peakBrowsers).toBe(1);
    expect(activeBrowsers).toBe(0);
    expect(events).toEqual([
      "webkit:start:42",
      "webkit:end:42",
      "chromium:launch",
      "chromium:checks:composer=true:id=42",
      "chromium:close",
    ]);
  });

  it("closes Chromium in finally when a Chromium check throws and skips WebKit when checkComposer is false", async () => {
    const events: string[] = [];
    const { tracker } = createFakeTracker();

    const deps: SmokeBrowserDeps<SmokeBrowserHandle> = {
      async verifyWebKitComposer() {
        events.push("webkit:should-not-run");
      },
      async launchChromium() {
        events.push("chromium:launch");
        return {
          async close() {
            events.push("chromium:close");
          },
        };
      },
      async runChromiumChecks() {
        events.push("chromium:throw");
        throw new Error("boom");
      },
    };

    await expect(runBrowserVerifications(deps, { checkComposer: false, conversationId: undefined, tracker })).rejects.toThrow("boom");
    expect(events).toEqual(["chromium:launch", "chromium:throw", "chromium:close"]);
  });

  it("wires verify-smoke.ts through formatVerifyError, formatVerifyRunReport, and runBrowserVerifications without blank error formatting", () => {
    const source = readFileSync(join(import.meta.dirname, "verify-smoke.ts"), "utf8");
    expect(source).not.toContain("error instanceof Error ? error.message : String(error)");
    expect(source).toContain("formatVerifyError");
    expect(source).toContain("formatVerifyRunReport");
    expect(source).toMatch(/await runBrowserVerifications\(/);
  });
});
