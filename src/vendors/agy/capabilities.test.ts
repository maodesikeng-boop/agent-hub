import { describe, expect, it } from "vitest";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { buildAgyWorkspaceHooks } from "./acp-config.ts";
import { agyCapabilityDenyRules } from "./capabilities.ts";

function emptyCaps(): SessionCapabilities {
  return {
    deny: { skills: [], mcp: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
    allow: { skills: [], mcp: [] },
  };
}

describe("agyCapabilityDenyRules", () => {
  it("produces sorted mcp(<server>/*) rules for each denied MCP server", () => {
    const rules = agyCapabilityDenyRules({
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, mcp: ["z-server", "codegraph"] },
    });
    expect(rules).toEqual(["mcp(codegraph/*)", "mcp(z-server/*)"]);
  });

  it("ignores denied skills, connectors, and plugins", () => {
    const rules = agyCapabilityDenyRules({
      ...emptyCaps(),
      deny: {
        skills: ["aws-auth"],
        mcp: [],
        connectors: ["claude.ai Gmail"],
        plugins: ["sales@synced"],
        pluginOf: { skills: {}, mcp: {} },
      },
    });
    expect(rules).toEqual([]);
  });

  it("returns an empty array when deny.mcp is empty", () => {
    expect(agyCapabilityDenyRules(emptyCaps())).toEqual([]);
  });

  it("wires denied MCP servers into buildAgyWorkspaceHooks alongside schedule and readonly rules", () => {
    const caps: SessionCapabilities = {
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, mcp: ["codegraph"] },
    };
    const hooks = buildAgyWorkspaceHooks({ readonly: true, capabilities: caps, platform: "darwin" });
    expect(hooks["bellwood-schedule"]).toBeDefined();
    expect(hooks["bellwood-readonly"]).toBeDefined();
    expect(hooks["bellwood-mcp-deny"]).toBeDefined();
    expect(JSON.stringify(hooks["bellwood-mcp-deny"])).toContain("codegraph");
    expect(JSON.stringify(hooks["bellwood-mcp-deny"])).toContain("call_mcp_tool");
  });
});
