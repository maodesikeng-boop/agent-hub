import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

export function deepseekSkillFilesystemConfig(
  caps: SessionCapabilities,
  productSkillsDir: string | undefined,
): { includeDefaultRoots: false; customSkillDirs: string[] } | null {
  if (caps.deny.skills.length === 0) return null;
  const dirs = caps.allow.skills.map((s) => s.dir);
  if (productSkillsDir) dirs.push(productSkillsDir);
  return {
    includeDefaultRoots: false,
    customSkillDirs: [...new Set(dirs)],
  };
}

export function filterDeepSeekMcpServers(servers: readonly McpServer[], caps: SessionCapabilities): McpServer[] {
  if (caps.deny.mcp.length === 0) return [...servers];
  const denied = new Set(caps.deny.mcp);
  return servers.filter((server) => !denied.has(server.name));
}
