// pi 按会话管技能和 MCP（pi 1.5.2 的 --help）：
// - 技能：--no-skills 关掉自动发现，再逐个 --skill <目录> 只开允许的（允许清单）；
// - MCP：--exclude-tools mcp__<服务器>__* 拒掉该服务器的工具（服务器照起）。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

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
  throw new Error("未实现");
}
