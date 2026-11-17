// deepseek（dsh 0.2.2-rc.1）按会话管技能和 MCP：
// - 技能：--patch 给 skill-filesystem 设 includeDefaultRoots=false + customSkillDirs（允许清单），和产品技能的补丁合成一条；
// - MCP：驱动建会话时由 ACP session.mcpServers 注入（sync.ts），过滤掉关掉的那几项即可，本来就是按会话。
import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

/**
 * 后置：deny.skills 为空返回 null（不加补丁，照旧扫默认目录）；否则返回 skill-filesystem 的配置，
 * customSkillDirs = allow.skills 的目录加上 productSkillsDir（给了时）。
 */
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

/** 后置：去掉名字在 deny.mcp 里的服务器，其余原样、顺序不变。 */
export function filterDeepSeekMcpServers(servers: readonly McpServer[], caps: SessionCapabilities): McpServer[] {
  if (caps.deny.mcp.length === 0) return [...servers];
  const denied = new Set(caps.deny.mcp);
  return servers.filter((server) => !denied.has(server.name));
}
