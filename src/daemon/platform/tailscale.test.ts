// 联机 P1：tailscale 命令在哪、serve 转发到哪、本机 tailnet 名字和主人（docs/multi-device-design.md 第 3、5 节）。
import { describe, expect, it } from "vitest";
import {
  MACOS_TAILSCALE_APP_CLI,
  createTailnetProbe,
  parseTailscaleStatus,
  serveCommandLine,
  serveTargetKind,
  tailscaleCommand,
} from "./index.ts";

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "Mac-Mini.tail1234.ts.net.", UserID: 42, Tags: undefined },
  User: { "42": { ID: 42, LoginName: "Owner@Example.com" }, "7": { ID: 7, LoginName: "friend@example.com" } },
});

describe("tailscale 命令在哪", () => {
  it("macOS：有 App 就用 App 里的命令行，没有就用 PATH 里的 tailscale", () => {
    expect(tailscaleCommand({ platform: "darwin", env: {}, exists: (p) => p === MACOS_TAILSCALE_APP_CLI })).toBe(MACOS_TAILSCALE_APP_CLI);
    expect(tailscaleCommand({ platform: "darwin", env: {}, exists: () => false })).toBe("tailscale");
  });

  it("Linux：PATH 里的 tailscale，不去看 /Applications", () => {
    expect(tailscaleCommand({ platform: "linux", env: {}, exists: () => true })).toBe("tailscale");
  });

  it("环境变量 AGENT_HUB_TAILSCALE 优先", () => {
    expect(tailscaleCommand({ platform: "darwin", env: { AGENT_HUB_TAILSCALE: "/opt/ts" }, exists: () => true })).toBe("/opt/ts");
  });
});

describe("serve 转发目标", () => {
  it("Linux 走 Unix socket，macOS 走 127.0.0.1 端口（App 有沙箱）", () => {
    expect(serveTargetKind({ platform: "linux", env: {} })).toBe("unix");
    expect(serveTargetKind({ platform: "darwin", env: {} })).toBe("tcp");
  });

  it("AGENT_HUB_SERVE_TARGET 能改（老版本 tailscale 不支持 unix: 时用 tcp）；乱填不认", () => {
    expect(serveTargetKind({ platform: "linux", env: { AGENT_HUB_SERVE_TARGET: "tcp" } })).toBe("tcp");
    expect(serveTargetKind({ platform: "darwin", env: { AGENT_HUB_SERVE_TARGET: "unix" } })).toBe("unix");
    expect(serveTargetKind({ platform: "linux", env: { AGENT_HUB_SERVE_TARGET: "x" } })).toBe("unix");
  });

  it("给用户的 serve 命令", () => {
    expect(serveCommandLine("tailscale", { kind: "unix", path: "/home/u/.agent-hub/run/ui.sock" })).toBe(
      "tailscale serve --bg unix:/home/u/.agent-hub/run/ui.sock",
    );
    expect(serveCommandLine(MACOS_TAILSCALE_APP_CLI, { kind: "tcp", port: 4317 })).toBe(
      `${MACOS_TAILSCALE_APP_CLI} serve --bg http://127.0.0.1:4317`,
    );
  });
});

describe("tailscale status --json", () => {
  it("取本机名字（去掉末尾的点，小写）和主人登录名（小写）", () => {
    expect(parseTailscaleStatus(STATUS)).toEqual({ dnsName: "mac-mini.tail1234.ts.net", owner: "owner@example.com" });
  });

  it("没在跑、没有名字、不是 JSON → null", () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "a.b.ts.net." } }))).toBeNull();
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "" } }))).toBeNull();
    expect(parseTailscaleStatus("not json")).toBeNull();
  });

  it("打了 tag 的设备没有主人（owner null），要用 AGENT_HUB_TAILNET_OWNER 写明", () => {
    const tagged = JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: "tokyo.tail1234.ts.net.", UserID: 9, Tags: ["tag:server"] },
      User: { "9": { LoginName: "tagged-devices" } },
    });
    expect(parseTailscaleStatus(tagged)).toEqual({ dnsName: "tokyo.tail1234.ts.net", owner: null });
  });
});

describe("探测结果缓存", () => {
  function setup(outputs: Array<string | Error>, env: Record<string, string> = {}) {
    let t = 0;
    let calls = 0;
    const probe = createTailnetProbe({
      env,
      now: () => t,
      okTtlMs: 1000,
      failTtlMs: 100,
      run: async () => {
        const out = outputs[Math.min(calls, outputs.length - 1)];
        calls++;
        if (out instanceof Error) throw out;
        return out!;
      },
    });
    return { probe, calls: () => calls, advance: (ms: number) => (t += ms) };
  }

  it("同一段时间里不管问多少次只跑一次命令", async () => {
    const s = setup([STATUS]);
    expect(await s.probe.refresh()).toEqual({ dnsName: "mac-mini.tail1234.ts.net", owner: "owner@example.com" });
    for (let i = 0; i < 50; i++) s.probe.current();
    expect(s.calls()).toBe(1);
    expect(s.probe.current()?.dnsName).toBe("mac-mini.tail1234.ts.net");
  });

  it("current() 第一次就在后台去问，同时只有一个在跑；问完之后 current() 拿到结果", async () => {
    const s = setup([STATUS]);
    expect(s.probe.current()).toBeNull();
    expect(s.probe.current()).toBeNull();
    await s.probe.refresh();
    expect(s.calls()).toBe(1);
    expect(s.probe.current()?.owner).toBe("owner@example.com");
  });

  it("过期后下一次 current() 再问一次，期间先用旧的", async () => {
    const s = setup([STATUS, STATUS.replace("Mac-Mini", "Renamed")]);
    await s.probe.refresh();
    s.advance(1001);
    expect(s.probe.current()?.dnsName).toBe("mac-mini.tail1234.ts.net");
    await s.probe.refresh();
    expect(s.calls()).toBe(2);
    expect(s.probe.current()?.dnsName).toBe("renamed.tail1234.ts.net");
  });

  it("没装 / 没开 tailscale：null，隔 failTtl 才再问（Tailscale 后开也能认出来）", async () => {
    const s = setup([new Error("ENOENT"), STATUS]);
    expect(await s.probe.refresh()).toBeNull();
    s.probe.current();
    expect(s.calls()).toBe(1);
    s.advance(101);
    s.probe.current();
    await s.probe.refresh();
    expect(s.probe.current()?.dnsName).toBe("mac-mini.tail1234.ts.net");
  });

  it("环境变量写死名字和主人：不跑命令", async () => {
    const s = setup([new Error("should not run")], { AGENT_HUB_TAILNET_NAME: "Box.tail9.ts.net.", AGENT_HUB_TAILNET_OWNER: "Me@x.com" });
    expect(s.probe.current()).toEqual({ dnsName: "box.tail9.ts.net", owner: "me@x.com" });
    expect(await s.probe.refresh()).toEqual({ dnsName: "box.tail9.ts.net", owner: "me@x.com" });
    expect(s.calls()).toBe(0);
  });

  it("只写死主人（tag 设备）：名字照样问，主人用写死的", async () => {
    const s = setup([STATUS], { AGENT_HUB_TAILNET_OWNER: "me@x.com" });
    expect(await s.probe.refresh()).toEqual({ dnsName: "mac-mini.tail1234.ts.net", owner: "me@x.com" });
  });
});
