import { describe, expect, it } from "vitest";
import { parseCodexRateLimits } from "./codex-protocol.ts";

// 真实数据（2026-11-07，codex-cli 0.162 的 account/rateLimits/updated）：这个账号只有一个 30 天窗口（windowDurationMins 43200），放在 primary 里。
describe("parseCodexRateLimits：窗口按 windowDurationMins 归类，不按 primary / secondary 的位置", () => {
  it("primary 是 30 天窗口：不能当成 5 小时（用户看到 5 小时“12/2 14:39 重置”就是它）", () => {
    const info = parseCodexRateLimits({ primary: { usedPercent: 19, windowDurationMins: 43200, resetsAt: 1796193545 }, secondary: null });
    expect(info).toEqual({
      status: "allowed",
      resetsAt: 1796193545,
      windows: { thirty_day: { utilization: 0.19, resetsAt: 1796193545, status: "allowed" } },
    });
  });

  it("300 分钟是 5 小时、10080 分钟是 7 天，和 primary / secondary 谁在哪无关", () => {
    const info = parseCodexRateLimits({
      primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1793646000 },
      secondary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1793619600 },
    });
    expect(info?.windows).toEqual({
      seven_day: { utilization: 0.6, resetsAt: 1793646000, status: "allowed" },
      five_hour: { utilization: 0.35, resetsAt: 1793619600, status: "allowed" },
    });
  });

  it("不知道窗口多长（windowDurationMins 是 null 或不认识）的窗口不显示，不猜", () => {
    expect(parseCodexRateLimits({ primary: { usedPercent: 10, windowDurationMins: null, resetsAt: 1793646000 }, secondary: null })).toBeNull();
    expect(parseCodexRateLimits({ primary: { usedPercent: 10, windowDurationMins: 77, resetsAt: 1793646000 }, secondary: null })).toBeNull();
  });
});
