import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it } from "vitest";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { deepseekSkillFilesystemConfig, filterDeepSeekMcpServers } from "./capabilities.ts";

describe("deepseekSkillFilesystemConfig", () => {
  it("没有技能被关时返回 null", () => {
    const caps: SessionCapabilities = {
      deny: { skills: [], mcp: ["codegraph"], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
      allow: { skills: [{ name: "a", dir: "/s/a" }], mcp: [] },
    };
    expect(deepseekSkillFilesystemConfig(caps, "/launch/1/skills")).toBeNull();
  });

  it("有技能被关时关掉默认目录，只给允许的技能目录和产品技能目录", () => {
    const caps: SessionCapabilities = {
      deny: { skills: ["aws-auth"], mcp: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
      allow: {
        skills: [
          { name: "docx", dir: "/s/docx" },
          { name: "pdf", dir: "/s/pdf" },
        ],
        mcp: [],
      },
    };
    expect(deepseekSkillFilesystemConfig(caps, "/launch/1/skills")).toEqual({
      includeDefaultRoots: false,
      customSkillDirs: ["/s/docx", "/s/pdf", "/launch/1/skills"],
    });
    expect(deepseekSkillFilesystemConfig(caps, undefined)).toEqual({
      includeDefaultRoots: false,
      customSkillDirs: ["/s/docx", "/s/pdf"],
    });
  });
});

describe("filterDeepSeekMcpServers", () => {
  it("去掉被关的服务器，其余顺序不变", () => {
    const servers: McpServer[] = [
      { name: "alpha", command: "node", args: ["a.js"], env: [] },
      { name: "codegraph", command: "codegraph", args: ["mcp"], env: [] },
      { name: "zeta", type: "http", url: "https://example.com/mcp", headers: [] },
    ];
    const caps: SessionCapabilities = {
      deny: { skills: [], mcp: ["codegraph"], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
      allow: { skills: [], mcp: ["alpha", "zeta"] },
    };
    expect(filterDeepSeekMcpServers(servers, caps)).toEqual([servers[0], servers[2]]);
  });
});
