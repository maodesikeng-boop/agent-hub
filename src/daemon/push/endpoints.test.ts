// 联机 P4：推送订阅的 endpoint 只收已知推送服务的主机（防守护进程被订阅内容指去请求任意 https 地址）。
import { describe, expect, it } from "vitest";
import { isAllowedPushEndpoint, PUSH_ENDPOINT_HOSTS } from "./endpoints.ts";

describe("isAllowedPushEndpoint", () => {
  it("名单内：FCM、Mozilla、Apple、Windows（*.notify.windows.com 任意子域）", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QAbc",
      "https://db5p.notify.windows.com/?token=abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://FCM.googleapis.com/x",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(true);
    }
  });

  it("名单外、骗主机的写法、不是 https、带账号或端口：都不收", () => {
    for (const url of [
      "https://push.example.com/send/1",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "http://fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.com/x",
      "https://evilfcm.googleapis.com/x",
      "https://fcm.googleapis.com@evil.com/x",
      "https://evil.com/fcm.googleapis.com",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://notify.windows.com/x",
      "https://evilnotify.windows.com/x",
      "https://x.notify.windows.com.evil.com/x",
      "https://web.push.apple.com./x",
      "ftp://fcm.googleapis.com/x",
      "not a url",
      "",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(false);
    }
  });

  it("名单就是这四项", () => {
    expect([...PUSH_ENDPOINT_HOSTS]).toEqual(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "*.notify.windows.com"]);
  });
});
