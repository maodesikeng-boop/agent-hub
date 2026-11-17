// pi 按会话管技能和 MCP（pi 1.5.2 实测）：
// - 技能：--no-skills 关掉自动发现，再逐个 --skill <目录> 只开允许的（允许清单）；
// - MCP：--exclude-tools mcp__<服务器>__* 拒掉该服务器的工具（pi-mcp 将非 [A-Za-z0-9_] 替换为 _）。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sanitizePiServerName(server: string): string {
  return server.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface PiCapabilityArgs {
  /** true 时调用方加 --no-skills，并且不再加默认的 `--skill <cwd>/.agents/skills`。 */
  noSkills: boolean;
  skillDirs: string[];
  /** 并进 --exclude-tools（只读 Worker 的 edit,write 也在那里）。 */
  excludeTools: string[];
}

/**
 * 后置：deny.skills 非空时 noSkills 为 true，skillDirs 是 allow.skills 的目录；否则 noSkills 为 false、skillDirs 为空。
 * excludeTools 每个关掉的 MCP 一条 `mcp__<服务器>__*`。
 */
export function piCapabilityArgs(caps: SessionCapabilities): PiCapabilityArgs {
  const noSkills = caps.deny.skills.length > 0;
  const skillDirs = noSkills ? caps.allow.skills.map((s) => s.dir) : [];
  const excludeTools = [...new Set(caps.deny.mcp.map((s) => `mcp__${sanitizePiServerName(s)}__*`))].sort(cmpStr);
  return { noSkills, skillDirs, excludeTools };
}
