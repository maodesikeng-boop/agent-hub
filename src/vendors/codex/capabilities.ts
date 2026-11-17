// codex 按会话关技能、MCP、云端连接器（codex-cli 0.169.0 实测）：每个会话一个 app-server 进程，
// 用 `-c` 覆盖只对这个进程生效，不写 ~/.codex/config.toml（skills/config/write 会写全局，不用）。
// - 技能：skills.config=[{name,enabled=false}]；
// - MCP：mcp_servers.<名字>.enabled=false（实测 mcpServerStatus/list 里该服务器工具数变 0）；
// - 云端连接器（ChatGPT apps）：apps.<编号>.enabled=false；
// - 插件：plugins."<编号>".enabled=false。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function configKeySegment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/**
 * 后置：返回接在 `codex app-server` 后面的 `-c key=value` 参数，值是 TOML 字面量；deny 全空返回 []。
 * 名字里有点、空格的键段加引号。同样的输入返回逐字相同的数组。
 */
export function codexCapabilityArgs(caps: SessionCapabilities): string[] {
  const args: string[] = [];

  const skills = [...new Set(caps.deny.skills)].sort(cmpStr);
  if (skills.length > 0) {
    const entries = skills.map((name) => `{name=${JSON.stringify(name)},enabled=false}`).join(",");
    args.push("-c", `skills.config=[${entries}]`);
  }

  const mcp = [...new Set(caps.deny.mcp)].sort(cmpStr);
  for (const server of mcp) {
    args.push("-c", `mcp_servers.${configKeySegment(server)}.enabled=false`);
  }

  const connectors = [...new Set(caps.deny.connectors)].sort(cmpStr);
  for (const id of connectors) {
    args.push("-c", `apps.${configKeySegment(id)}.enabled=false`);
  }

  const plugins = [...new Set(caps.deny.plugins)].sort(cmpStr);
  for (const id of plugins) {
    args.push("-c", `plugins.${configKeySegment(id)}.enabled=false`);
  }

  return args;
}
