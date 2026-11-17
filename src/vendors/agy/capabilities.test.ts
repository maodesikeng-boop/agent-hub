import { describe, expect, it } from "vitest";
import { EMPTY_TOKEN_USAGE, type AgentSessionRow } from "../../shared/domain.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { buildReadonlyPolicy } from "../../shared/readonly-policy.ts";
import { agyCapabilityDenyRules } from "./capabilities.ts";
import { buildAgyArgs } from "./protocol.ts";

function emptyCaps(): SessionCapabilities {
  return {
    deny: { skills: [], mcp: [], connectors: [], plugins: [] },
    allow: { skills: [], mcp: [] },
  };
}

describe("agyCapabilityDenyRules", () => {
  it("每个关掉的 MCP 一条 mcp(<服务器>/*) 规则", () => {
    const rules = agyCapabilityDenyRules({
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, mcp: ["z-server", "codegraph"] },
    });
    expect(rules).toEqual(["mcp(codegraph/*)", "mcp(z-server/*)"]);
  });

  it("技能和连接器的 deny 不产生规则", () => {
    const rules = agyCapabilityDenyRules({
      ...emptyCaps(),
      deny: {
        skills: ["aws-auth"],
        mcp: [],
        connectors: ["claude.ai Gmail"],
        plugins: ["sales@synced"],
      },
    });
    expect(rules).toEqual([]);
  });

  it("和只读 Worker 的规则合并后两边的规则都在", () => {
    const session: AgentSessionRow = {
      id: 1,
      role: "worker",
      conversationId: 10,
      pmId: null,
      workerId: 5,
      vendor: "agy",
      vendorSessionId: "conv-1",
      cwd: "/repo",
      addDirs: [],
      generation: 1,
      model: null,
      effort: null,
      pid: null,
      status: "idle",
      hasCompletedTurn: false,
      lastEventAt: null,
      rateLimit: null,
      usage: EMPTY_TOKEN_USAGE,
      createdAt: 1,
      updatedAt: 1,
    };
    const readonly = buildReadonlyPolicy({ homeDir: "/Users/test", stateDir: "/Users/test/.agent-hub/state" });
    const caps: SessionCapabilities = {
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, mcp: ["codegraph"] },
    };
    const files: LaunchFiles = {
      promptFile: "/launch/1/prompt.md",
      env: {},
      fingerprint: "fp",
      readonly,
      capabilities: caps,
    };
    const args = buildAgyArgs(session, files, false, { allow: ["mcp(other/read)"], deny: ["mcp(other/write)"] });
    const idx = args.indexOf("--settings");
    expect(idx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(args[idx + 1]!) as { permissions: { allow: string[]; deny: string[] } };
    expect(parsed.permissions.deny).toContain("write_file(*)");
    expect(parsed.permissions.deny).toContain("mcp(other/write)");
    expect(parsed.permissions.deny).toContain("mcp(codegraph/*)");
  });

  it("deny.mcp 为空返回空数组", () => {
    expect(agyCapabilityDenyRules(emptyCaps())).toEqual([]);
  });
});
