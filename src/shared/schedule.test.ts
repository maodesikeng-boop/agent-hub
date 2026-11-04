// 定时任务的频率解析、下一次、标题（src/shared/schedule.ts）。时间都按本机本地时间，用 new Date(年, 月, 日, 时, 分) 造，和时区无关。
import { describe, expect, it } from "vitest";
import {
  checkEveryMinutes,
  nextDailyRun,
  nextRunAfter,
  parseDailyTime,
  parseEvery,
  scheduleLabel,
  scheduledTimeText,
  scheduleRunTitle,
} from "./schedule.ts";

const local = (day: number, h: number, m = 0, month = 10) => new Date(2026, month, day, h, m).getTime();

describe("parseDailyTime", () => {
  it.each(["00:00", "09:00", "23:59"])("%s 合法", (raw) => expect(parseDailyTime(raw)).toBe(raw));
  it.each(["9:00", "24:00", "09:60", "09:0", "0900", "09:00:00", " 09:00", "", "ab:cd"])("%j 不合法", (raw) => expect(parseDailyTime(raw)).toBeNull());
});

describe("parseEvery / checkEveryMinutes", () => {
  it("30m、2h 换成分钟数；别的写法 null", () => {
    expect(parseEvery("30m")).toBe(30);
    expect(parseEvery("2h")).toBe(120);
    for (const raw of ["", "0m", "m", "2", "2d", "1.5h", "-5m", "05m", "2 h", "2H"]) expect(parseEvery(raw)).toBeNull();
  });

  it("最短 15 分钟、最长 7 天、要整数", () => {
    expect(checkEveryMinutes(15)).toBeNull();
    expect(checkEveryMinutes(7 * 24 * 60)).toBeNull();
    expect(checkEveryMinutes(14)).toMatch(/最短 15 分钟/);
    expect(checkEveryMinutes(7 * 24 * 60 + 1)).toMatch(/最长 7 天/);
    expect(checkEveryMinutes(20.5)).toMatch(/整数/);
    expect(checkEveryMinutes("30")).toMatch(/整数/);
  });
});

describe("下一次", () => {
  it("每天：今天还没到就是今天，到了或过了就是明天（严格晚于现在）", () => {
    expect(nextDailyRun(local(4, 8), "09:00")).toBe(local(4, 9));
    expect(nextDailyRun(local(4, 9), "09:00")).toBe(local(5, 9));
    expect(nextDailyRun(local(4, 9, 1), "09:00")).toBe(local(5, 9));
  });

  it("每天：跨月", () => {
    expect(nextDailyRun(local(30, 10), "09:00")).toBe(local(1, 9, 0, 11));
  });

  it("间隔：现在 + 间隔，不管原定时间", () => {
    expect(nextRunAfter({ kind: "interval", atTime: null, everyMinutes: 120 }, local(4, 8))).toBe(local(4, 10));
    expect(nextRunAfter({ kind: "daily", atTime: "09:00", everyMinutes: null }, local(4, 8))).toBe(local(4, 9));
  });
});

describe("给人看的文字", () => {
  it("频率", () => {
    expect(scheduleLabel({ kind: "daily", atTime: "09:00", everyMinutes: null })).toBe("每天 09:00");
    expect(scheduleLabel({ kind: "interval", atTime: null, everyMinutes: 120 })).toBe("每隔 2 小时");
    expect(scheduleLabel({ kind: "interval", atTime: null, everyMinutes: 90 })).toBe("每隔 90 分钟");
    expect(scheduleLabel({ kind: "interval", atTime: null, everyMinutes: 15 })).toBe("每隔 15 分钟");
  });

  it("原定时间：当天只写时间，不是当天带日期", () => {
    expect(scheduledTimeText(local(4, 9), local(4, 9, 0))).toBe("09:00");
    expect(scheduledTimeText(local(3, 9, 5), local(4, 9))).toBe("11-03 09:05");
  });

  it("标题：定时任务：名字（原定 09:00），补跑的注明补跑", () => {
    expect(scheduleRunTitle("日报", local(4, 9), local(4, 9), false)).toBe("定时任务：日报（原定 09:00）");
    expect(scheduleRunTitle("日报", local(3, 9), local(4, 10), true)).toBe("定时任务：日报（补跑，原定 11-03 09:00）");
  });
});
