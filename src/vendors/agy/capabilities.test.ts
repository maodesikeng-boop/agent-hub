import { describe, expect, it } from "vitest";
import { EMPTY_TOKEN_USAGE, type AgentSessionRow } from "../../shared/domain.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { buildReadonlyPolicy } from "../../shared/readonly-policy.ts";
import { vendorSpec } from "../../shared/vendors.ts";
import { agyCapabilityDenyRules } from "./capabilities.ts";
import { buildAgyArgs } from "./protocol.ts";

function emptyCaps(): SessionCapabilities {
  return {
    deny: { skills: [], mcp: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
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
        pluginOf: { skills: {}, mcp: {} },
      },
    });
    expect(rules).toEqual([]);
  });

  it("和只读 Worker 的规则合并后两边的规则都在", () => {
    const session = agySession();
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

describe("buildAgyArgs 能力路径的 --settings（agy 只认最后一个 --settings）", () => {
  const caps: SessionCapabilities = { ...emptyCaps(), deny: { ...emptyCaps().deny, mcp: ["codegraph"] } };
  const lastSettings = (argv: readonly string[]) =>
    JSON.parse(argv[argv.lastIndexOf("--settings") + 1]!) as { enableTerminalSandbox?: boolean; permissions: { deny: string[] } };

  it("包进 OS 沙箱的 Worker：包装层前置的关终端沙箱设置并进最后一条，deny 也在", () => {
    const files: LaunchFiles = {
      promptFile: "/launch/1/prompt.md",
      env: {},
      fingerprint: "fp",
      writeScope: { dataDir: "/Users/test/.agent-hub", writableDirs: ["/repo"] },
      capabilities: caps,
    };
    const argv = [...(vendorSpec("agy").capabilities.ownSandboxOffArgs ?? []), ...buildAgyArgs(agySession(), files, false)];
    const settings = lastSettings(argv);
    expect(settings.enableTerminalSandbox).toBe(false);
    expect(settings.permissions.deny).toEqual(["mcp(codegraph/*)"]);
  });

  it("项目经理（不包沙箱）：不动 agy 自己的终端沙箱", () => {
    const files: LaunchFiles = { promptFile: "/launch/1/prompt.md", env: {}, fingerprint: "fp", capabilities: caps };
    const settings = lastSettings(buildAgyArgs({ ...agySession(), role: "pm", workerId: null, pmId: 1 }, files, false));
    expect(settings).toEqual({ permissions: { deny: ["mcp(codegraph/*)"] } });
  });
});

function agySession(): AgentSessionRow {
  return {
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
}
