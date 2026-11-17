// claude 按会话关技能、MCP、云端连接器（docs/pm-capabilities-design.md 的现状表，claude 2.1.326 实测）：
// 都写进这次会话的 --settings 文件（settings.ts 的 buildSessionSettings 合并），不写 ~/.claude 和 ~/.claude.json。
// - 技能：skillOverrides { <名字>: "off" }；
// - MCP 和 claude.ai 云端连接器：deniedMcpServers [{ serverName }]，云端连接器的服务器名是 `claude.ai <名字>`；
// - 整个插件：enabledPlugins { <插件编号>: false }，插件带的技能和 MCP 一起不见。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

export interface ClaudeCapabilitySettings {
  skillOverrides?: Record<string, "off">;
  deniedMcpServers?: Array<{ serverName: string }>;
  enabledPlugins?: Record<string, false>;
}

/**
 * 后置：只含 caps.deny 里有东西的键；deny 全空返回 {}。同样的 caps 返回逐字相同的对象（键按名字排序），进 fingerprint 不抖。
 * allow 不用（claude 支持禁用清单）。
 */
export function claudeCapabilitySettings(caps: SessionCapabilities): ClaudeCapabilitySettings {
  throw new Error("未实现");
}
