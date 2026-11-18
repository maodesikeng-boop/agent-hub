import { describe, expect, it } from "vitest";
import type { FeishuStatusView } from "../shared/feishu.ts";
import { AdminUnavailableError } from "../tunnel/cli.ts";
import { runFeishuCli, type FeishuCliIo } from "./cli.ts";

const base: FeishuStatusView = {
  state: "unconfigured",
  brand: null,
  appId: null,
  botName: null,
  ownerOpenId: null,
  ownerName: null,
  registration: null,
  missing: [],
  lastError: null,
  chats: [],
};

function harness(handler: (method: string, path: string, body?: unknown) => unknown, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const io = (argv: string[]): FeishuCliIo => ({
    argv,
    stdin: async () => stdin,
    stdout: { write: (t: string) => out.push(t) },
    stderr: { write: (t: string) => err.push(t) },
    admin: async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return handler(method, path, body);
    },
    renderQr: (url) => `[QR ${url}]`,
    sleep: async () => {},
  });
  return { io, out: () => out.join(""), err: () => err.join(""), calls };
}

describe("runFeishuCli", () => {
  it("connect 打出二维码，轮询到 connected 后打印应用和机器人名，退出码 0；被拒绝或过期退出码 1", async () => {
    let polls = 0;
    const ok = harness((method, path) => {
      if (method === "POST" && path === "/feishu/registration") return { ...base, state: "registering", registration: { url: "https://qr/1", expiresAt: Date.now() + 600_000 } };
      polls++;
      return polls < 2 ? { ...base, state: "registering", registration: { url: "https://qr/1", expiresAt: 0 } } : { ...base, state: "connected", appId: "cli_a", botName: "Fusa 机器人" };
    });
    expect(await runFeishuCli(ok.io(["connect"]))).toBe(0);
    expect(ok.out()).toContain("[QR https://qr/1]");
    expect(ok.out()).toContain("cli_a");
    expect(ok.out()).toContain("Fusa 机器人");
    const denied = harness((method) =>
      method === "POST" ? { ...base, state: "registering", registration: { url: "https://qr/2", expiresAt: Date.now() } } : { ...base, lastError: "扫码后点了拒绝" },
    );
    expect(await runFeishuCli(denied.io(["connect"]))).toBe(1);
    expect(denied.err()).toContain("拒绝");
  });

  it("connect --manual 从标准输入读 App ID 和 App Secret，App Secret 不出现在任何输出里", async () => {
    const h = harness(() => ({ ...base, state: "awaiting_owner", appId: "cli_m" }), "cli_m\nTOP-SECRET-123\n");
    expect(await runFeishuCli(h.io(["connect", "--manual", "--lark"]))).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: "/feishu/credentials", body: { brand: "lark", appId: "cli_m", appSecret: "TOP-SECRET-123" } }]);
    expect(h.out() + h.err()).not.toContain("TOP-SECRET-123");
    expect(h.out()).toContain("bind");
  });

  it("policy 把唤醒方式和访客档位交给守护进程，参数值不对时打印用法、退出码 2", async () => {
    const h = harness((_m, _p, body) => ({ chatId: "oc_1", target: { kind: "pm", pmId: 3 }, name: "小林", mode: "solo", triggerMode: "mention_only", guestTier: "observer", guestCount: 0, archived: false, ...(body as object) }));
    expect(await runFeishuCli(h.io(["policy", "3", "--trigger", "mention_only", "--guest", "observer"]))).toBe(0);
    expect(h.calls.at(-1)).toEqual({ method: "PUT", path: "/feishu/policy", body: { pmId: 3, triggerMode: "mention_only", guestTier: "observer" } });
    expect(h.out()).toContain("只读");
    for (const argv of [["policy", "3", "--guest", "boss"], ["policy", "x", "--guest", "observer"], ["policy", "3"], ["policy", "3", "--what"]]) {
      expect(await runFeishuCli(h.io(argv))).toBe(2);
    }
    expect(h.err()).toContain("用法");
  });

  it("守护进程连不上时退出码 1，错误信息写清楚", async () => {
    const h = harness(() => {
      throw new AdminUnavailableError("/x/run/admin.sock");
    });
    expect(await runFeishuCli(h.io(["status"]))).toBe(1);
    expect(h.err()).toContain("连不上本机守护进程");
  });

  it("不认识的子命令打印用法，退出码 2", async () => {
    const h = harness(() => base);
    expect(await runFeishuCli(h.io(["fly"]))).toBe(2);
    expect(await runFeishuCli(h.io([]))).toBe(2);
    expect(h.err()).toContain("用法");
  });
});
