// codex 按会话关技能、MCP、云端连接器（codex-cli 0.169.0 实测）：每个会话一个 app-server 进程，
// 用 `-c` 覆盖只对这个进程生效，不写 ~/.codex/config.toml（skills/config/write 会写全局，不用）。
// - 技能：skills.config=[{name,enabled=false}]；
// - MCP：mcp_servers.<名字>.enabled=false（实测 mcpServerStatus/list 里该服务器工具数变 0）；
// - 云端连接器（ChatGPT apps）：apps.<编号>.enabled=false；
// - 插件：plugins."<编号>".enabled=false。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

/**
 * 后置：返回接在 `codex app-server` 后面的 `-c key=value` 参数，值是 TOML 字面量；deny 全空返回 []。
 * 名字里有点、空格的键段加引号。同样的输入返回逐字相同的数组。
 */
export function codexCapabilityArgs(caps: SessionCapabilities): string[] {
  throw new Error("未实现");
}
