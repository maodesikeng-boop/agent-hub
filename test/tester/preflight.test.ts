import { afterEach, describe, expect, it, vi } from "vitest";
import { VENDOR_LIST } from "../../src/shared/index.ts";
import type { BenchConfig } from "./bench.ts";
import { fakeBench, fakeComputer, providersAll } from "./fake-bench.ts";
import type { FeishuDriver } from "./feishu-driver.ts";
import { createApiClient, createInstanceClient } from "./instance-client.ts";
import { TESTER_FEISHU_REAUTHORIZE_WINDOW_MS } from "./limits.ts";
import { preflight } from "./preflight.ts";
import type { BenchCapability } from "./types.ts";

afterEach(() => vi.unstubAllGlobals());

const config: BenchConfig = {
  version: 1,
  root: "/bench",
  instances: [
    { name: "mac", role: "local", dataDir: "/bench/local/home", userHome: "/bench/local/user-home", uiPort: 4417, meshPort: 4421, env: {} },
    { name: "tokyo", role: "remote", deviceId: "dev_tokyo", sshAlias: "bellwood-tester" },
  ],
  testAccount: { githubLogin: "bench-bot" },
  feishu: { botAppId: "cli_test", driverAppId: "cli_driver" },
  sandboxProject: "/bench/projects/sandbox",
  guards: { dataDirs: ["/prod"], uiPorts: [4317], meshPorts: [4320], feishuAppIds: [], githubLogins: [] },
};

const WANTED: BenchCapability[] = ["local_instance", "remote_instance", "remote_control", "feishu_bot", "feishu_driver", "vendor:claude"];

function driver(over: Partial<FeishuDriver> = {}): FeishuDriver & { sent: number } {
  const d = {
    sent: 0,
    testChats: async () => [],
    sendAsUser: async () => {
      d.sent++;
      return "om";
    },
    listMessages: async () => [],
    waitForBotMessage: async () => {
      throw new Error("unused");
    },
    ensureUserToken: async () => Number.POSITIVE_INFINITY,
    ...over,
  };
  return d;
}

describe("preflight", () => {
  it("lists each wanted capability that answered", async () => {
    const { bench } = fakeBench(config, { remote: fakeComputer({ health: [new Error("device_offline")] }) });
    const result = await preflight(bench, driver({ ensureUserToken: async () => Promise.reject(new Error("20037")) }), WANTED);
    expect(result.available.sort()).toEqual(["feishu_bot", "local_instance", "remote_control"]);
    expect(result.coverage).toHaveLength(VENDOR_LIST.length * 2);
    expect(result.coverage.filter((c) => c.instance === "remote").every((c) => c.status === "unknown")).toBe(true);
  });

  it("checks the remote instance through the local mesh proxy", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (urls.push(url), Response.json({ generatedAt: 1, pms: [] })));
    const remote = createInstanceClient("tokyo", createApiClient({ origin: "http://127.0.0.1:4417", cookie: "c=1" }).forDevice("dev_tokyo"));
    expect(await remote.health()).toEqual({ ok: true });
    expect(urls).toEqual(["http://127.0.0.1:4417/d/dev_tokyo/api/router/digest"]);
  });

  it("warns within two days of the saved refresh expiry without blocking Feishu", async () => {
    const { bench } = fakeBench(config);
    const now = Date.parse("2026-11-26T12:00:00Z");
    const threshold = now + TESTER_FEISHU_REAUTHORIZE_WINDOW_MS;
    const result = await preflight(bench, driver({ ensureUserToken: async () => threshold - 1 }), WANTED, () => now);
    expect(result.available).toContain("feishu_driver");
    expect(result.warnings).toEqual([expect.stringMatching(/2026-11-28T11:59:59\.999Z.*authorize-feishu/)]);
    expect((await preflight(bench, driver({ ensureUserToken: async () => threshold }), WANTED, () => now)).warnings).toEqual([]);
  });

  it("retries a capability once before reporting it", async () => {
    const flaky = fakeBench(config, { local: fakeComputer({ health: [new Error("blip"), true], providers: providersAll("available", "darwin") }) });
    expect((await preflight(flaky.bench, null, WANTED)).available).toContain("local_instance");
    expect(flaky.local.requests.filter((r) => r === "GET /api/health")).toHaveLength(2);
    const down = fakeBench(config, { local: fakeComputer({ health: [new Error("a"), new Error("b"), true] }) });
    expect((await preflight(down.bench, null, WANTED)).available).not.toContain("local_instance");
  });

  it("names the failing service in problems", async () => {
    const { bench } = fakeBench(config, { remote: fakeComputer({ health: [new Error("device_offline")] }), status: async () => Promise.reject(new Error("ssh refused")) });
    const result = await preflight(bench, driver({ testChats: async () => Promise.reject(new Error("HTTP 503")) }), WANTED);
    expect(result.problems).toEqual(expect.arrayContaining([
      { service: "relay", detail: "remote_instance: device_offline" },
      { service: "bench", detail: "remote_control: ssh refused" },
      { service: "feishu", detail: "feishu_bot: HTTP 503" },
    ]));
    expect(result.problems).toHaveLength(3);
  });

  it("sends no Feishu message and starts no model turn", async () => {
    const handles = fakeBench(config);
    const d = driver();
    await preflight(handles.bench, d, WANTED);
    expect(d.sent).toBe(0);
    for (const computer of [handles.local, handles.remote!]) expect(computer.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("lists every vendor on a remote computer the bench does not have yet", async () => {
    const { bench } = fakeBench(config, { remote: null });
    const result = await preflight(bench, null, WANTED);
    const remote = result.coverage.filter((c) => c.instance === "remote");
    expect(remote.map((c) => c.vendor)).toEqual(VENDOR_LIST.map((v) => v.id));
    expect(remote.every((c) => c.status === "unknown" && c.fix.includes("bench-setup.md"))).toBe(true);
  });
});
