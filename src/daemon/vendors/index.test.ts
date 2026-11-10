// 按名单装配的守护进程侧登记表（index.ts，从 src/vendors/daemon-registry.ts 推出来）。
import { describe, expect, it } from "vitest";
import { AGENT_VENDORS, type AgentVendor } from "../../shared/index.ts";
import { DAEMON_VENDORS, composerBaseOf, createVendorComposers } from "./index.ts";

describe("厂商接口的完整性", () => {
  it("写进 agent 的内容经厂商接口拿；createVendorComposers 给每家都建出完整实现", () => {
    const composers = createVendorComposers(Object.fromEntries(AGENT_VENDORS.map((v) => [v, { executablePath: v }])) as Record<AgentVendor, { executablePath: string }>);
    expect(composers.claude.vendor).toBe("claude");
    expect(composers.agy.vendor).toBe("agy");
    expect(composers.codex.vendor).toBe("codex");
    expect(typeof composers.claude.queryCommands).toBe("function");
    expect(typeof composers.agy.queryCommands).toBe("function");
    expect(typeof composers.codex.queryCommands).toBe("function");
    expect(composers.claude.buildUserContent(["x"], "/y")).toEqual(composerBaseOf("claude")!.buildUserContent(["x"], "/y"));
  });

  it("DAEMON_VENDORS 汇总全部 AGENT_VENDORS 的 base、createComposer、probe、catalog、createDriver", () => {
    for (const vendor of AGENT_VENDORS) {
      const mod = DAEMON_VENDORS[vendor];
      expect(mod.base.vendor).toBe(vendor);
      expect(typeof mod.createComposer).toBe("function");
      expect(typeof mod.probe.parse).toBe("function");
      expect(mod.catalog).not.toBeNull();
      expect(typeof mod.createDriver).toBe("function");
      const composer = mod.createComposer({ executablePath: vendor });
      expect(composer.vendor).toBe(vendor);
    }
  });
});

describe("按厂商找实现", () => {
  it("认识的厂商有，不认识的 null", () => {
    expect(composerBaseOf("claude")?.vendor).toBe("claude");
    expect(composerBaseOf("agy")?.vendor).toBe("agy");
    expect(composerBaseOf("codex")?.vendor).toBe("codex");
    expect(composerBaseOf("unknown")).toBeNull();
    expect(composerBaseOf("constructor")).toBeNull();
  });
});
