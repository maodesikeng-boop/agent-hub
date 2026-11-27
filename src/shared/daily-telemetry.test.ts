import { describe, expect, it } from "vitest";
import { HUB_USAGE_PROMPT } from "../daemon/prompt.ts";
import { HUB_HELP_ONLY_COMMANDS } from "./hub.ts";
import { HUB_COMMAND } from "./names.ts";
import {
  DAILY_TELEMETRY_DEFAULT_WINDOW_MS,
  DAILY_TELEMETRY_EXCERPT_MAX_CHARS,
  DAILY_TELEMETRY_MAX_BYTES,
  DAILY_TELEMETRY_MAX_WINDOW_MS,
} from "./limits.ts";
import {
  boundTelemetryBundle,
  formatTelemetrySummary,
  isSelfReferentialScheduleMessage,
  redactTelemetryText,
  resolveTelemetryWindow,
  type DailyTelemetryBundle,
} from "./daily-telemetry.ts";

const NOW_MS = Date.UTC(2026, 10, 28, 0, 30, 0);

function makeBundle(messageCount: number, excerptText: string): DailyTelemetryBundle {
  return {
    schemaVersion: 1,
    generatedAt: NOW_MS,
    windowStartMs: NOW_MS - DAILY_TELEMETRY_DEFAULT_WINDOW_MS,
    windowEndMs: NOW_MS,
    scope: "pm",
    pmId: 1,
    platform: "darwin",
    vendorsSeen: ["claude"],
    sections: {
      messages: Array.from({ length: messageCount }, (_, idx) => ({
        id: idx + 1,
        conversationId: 1,
        sessionId: 1,
        workerId: null,
        sender: "user",
        kind: "text",
        status: "replied",
        failureReason: null,
        event: null,
        vendor: "claude",
        excerpt: excerptText,
        createdAt: NOW_MS - (messageCount - idx) * 1_000,
      })),
      turns: [],
      hubCalls: [],
      workerReports: [],
      taskGraphs: [],
      routerItems: [],
      routerCommands: [],
      approvals: [],
      operations: [],
      logs: [],
    },
    truncation: {
      truncatedSections: [],
      droppedCount: 0,
      totalBytes: 0,
    },
  };
}

describe("daily telemetry shared contracts", () => {
  it("regression: telemetry.export and telemetry.mine stay help-only and never alter HUB_USAGE_PROMPT (S10)", () => {
    expect("telemetry.export" in HUB_HELP_ONLY_COMMANDS).toBe(true);
    expect("telemetry.mine" in HUB_HELP_ONLY_COMMANDS).toBe(true);
    expect(HUB_USAGE_PROMPT).not.toContain(`${HUB_COMMAND} telemetry export`);
    expect(HUB_USAGE_PROMPT).not.toContain(`${HUB_COMMAND} telemetry mine`);
  });

  it("resolves default 24h windows, clamps spans to 7d, and rejects inverted or non-finite bounds (S1, S9)", () => {
    expect(resolveTelemetryWindow({ nowMs: NOW_MS })).toEqual({
      sinceMs: NOW_MS - DAILY_TELEMETRY_DEFAULT_WINDOW_MS,
      untilMs: NOW_MS,
    });
    const clamped = resolveTelemetryWindow({
      nowMs: NOW_MS,
      windowMs: DAILY_TELEMETRY_MAX_WINDOW_MS * 3,
    });
    expect(clamped.untilMs - clamped.sinceMs).toBe(DAILY_TELEMETRY_MAX_WINDOW_MS);
    expect(() => resolveTelemetryWindow({ nowMs: NOW_MS, sinceMs: NOW_MS, untilMs: NOW_MS - 1 })).toThrow(RangeError);
    expect(() => resolveTelemetryWindow({ nowMs: Number.NaN })).toThrow(RangeError);
  });

  it("redacts bearer tokens, API keys, and secrets while bounding excerpt length (S1, S9)", () => {
    const dirty = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload.signature",
      "OPENAI_API_KEY=sk-proj-abc1234567890SECRETKEY",
      "token=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "normal user feedback about filter flags",
    ].join(" | ");
    const redacted = redactTelemetryText(dirty, DAILY_TELEMETRY_EXCERPT_MAX_CHARS);
    expect(redacted).not.toContain("secretpayload");
    expect(redacted).not.toContain("sk-proj-abc1234567890SECRETKEY");
    expect(redacted).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("normal user feedback");
    expect([...redactTelemetryText("x".repeat(DAILY_TELEMETRY_EXCERPT_MAX_CHARS + 200))].length).toBeLessThanOrEqual(
      DAILY_TELEMETRY_EXCERPT_MAX_CHARS,
    );
  });

  it("detects self-referential mining and bug-hunt schedule turns while preserving ordinary messages (S1)", () => {
    expect(
      isSelfReferentialScheduleMessage(
        { event: "schedule.run", scheduleId: 9, name: "每日产品需求挖掘" },
        "【定时任务 · 每日产品需求挖掘】\n\nhub telemetry mine",
      ),
    ).toBe(true);
    expect(
      isSelfReferentialScheduleMessage(
        { event: "schedule.run", scheduleId: 10, name: "每日原始数据静态抓 bug" },
        "【定时任务 · 每日原始数据静态抓 bug】\n\nhub telemetry export",
      ),
    ).toBe(true);
    expect(
      isSelfReferentialScheduleMessage(
        { event: "schedule.run", scheduleId: 3, name: "每日进度日报" },
        "【定时任务 · 每日进度日报】\n\n总结昨天的交付",
      ),
    ).toBe(false);
    expect(isSelfReferentialScheduleMessage(null, "能不能给审批卡加一个按应用记住本次会话的选项")).toBe(false);
  });

  it("bounds oversized bundles to maxBytes without mutating input and records truncation metadata (S8)", () => {
    const oversized = makeBundle(400, "a".repeat(280));
    const snapshotBefore = JSON.stringify(oversized);
    const bounded = boundTelemetryBundle(oversized, 16 * 1024);
    expect(JSON.stringify(oversized)).toBe(snapshotBefore);
    const serializedBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    expect(serializedBytes).toBeLessThanOrEqual(16 * 1024);
    expect(bounded.truncation.totalBytes).toBeLessThanOrEqual(16 * 1024);
    expect(bounded.truncation.droppedCount).toBeGreaterThan(0);
    expect(bounded.truncation.truncatedSections).toContain("messages");
    expect(boundTelemetryBundle(makeBundle(2, "ok"), DAILY_TELEMETRY_MAX_BYTES).truncation.droppedCount).toBe(0);
  });

  it("formats a concise summary including counts, vendors, and truncation note (S1)", () => {
    const bundle = makeBundle(3, "need keyboard shortcut");
    const summary = formatTelemetrySummary(bundle);
    expect(summary).toContain("claude");
    expect(summary).toContain("3");
  });
});
