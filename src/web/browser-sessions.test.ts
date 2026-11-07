// 设置里“已登录的浏览器”的文字：User-Agent 显示成“iPhone Safari”这样的名字，最后活动显示成“3 分钟前”，登录链接剩余时间显示成“4:32”。
import { describe, expect, it } from "vitest";
import { describeUserAgent, formatAgo, formatCountdown } from "./browser-sessions.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WIN_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("describeUserAgent", () => {
  it.each([
    [IPHONE, "iPhone Safari"],
    [IPHONE_CHROME, "iPhone Chrome"],
    [IPAD, "iPad Safari"],
    [MAC_CHROME, "Mac Chrome"],
    [MAC_SAFARI, "Mac Safari"],
    [WIN_EDGE, "Windows Edge"],
    [ANDROID_CHROME, "Android Chrome"],
    [LINUX_FIREFOX, "Linux Firefox"],
  ])("%s → %s", (ua, name) => {
    expect(describeUserAgent(ua)).toBe(name);
  });

  it("认不出（空、curl、乱码）：只给认得出的那一半；都认不出是“未知浏览器”", () => {
    expect(describeUserAgent("")).toBe("未知浏览器");
    expect(describeUserAgent("curl/8.4.0")).toBe("未知浏览器");
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(describeUserAgent("Mozilla/5.0 Firefox/132.0")).toBe("Firefox");
  });
});

describe("formatAgo", () => {
  const now = 10 * 24 * 3600_000;
  it.each([
    [0, "刚刚"],
    [59_000, "刚刚"],
    [60_000, "1 分钟前"],
    [59 * 60_000, "59 分钟前"],
    [3600_000, "1 小时前"],
    [23 * 3600_000, "23 小时前"],
    [24 * 3600_000, "1 天前"],
    [9 * 24 * 3600_000, "9 天前"],
    [-5000, "刚刚"],
  ])("%d 毫秒前 → %s", (ago, text) => {
    expect(formatAgo(now - ago, now)).toBe(text);
  });
});

describe("formatCountdown", () => {
  it.each([
    [300_000, "5:00"],
    [272_400, "4:33"],
    [59_001, "1:00"],
    [9_000, "0:09"],
    [1, "0:01"],
    [0, "0:00"],
    [-10, "0:00"],
  ])("剩 %d 毫秒 → %s", (left, text) => {
    expect(formatCountdown(left)).toBe(text);
  });
});
