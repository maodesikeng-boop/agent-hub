// claude 按会话关技能、MCP、云端连接器（docs/pm-capabilities-design.md 的现状表，claude 2.1.326 实测）：
// 都写进这次会话的 --settings 文件（settings.ts 的 buildSessionSettings 合并），不写 ~/.claude 和 ~/.claude.json。
// - 技能：skillOverrides { <名字>: "off" }，列表里也看不到；
// - 插件里的技能：skillOverrides 对它不生效（只认 claude.ai 同步来的技能），改用 permissions.deny 的 Skill(<名字>)，
//   列表里还在、调用被拒；
// - MCP（含插件带的 `plugin:<插件>:<服务器>`）和 claude.ai 云端连接器：deniedMcpServers [{ serverName }]；
// - 整个插件：enabledPlugins { <插件编号>: false }，插件带的技能和 MCP 一起不见。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

export interface ClaudeCapabilitySettings {
  skillOverrides?: Record<string, "off">;
  deniedMcpServers?: Array<{ serverName: string }>;
  enabledPlugins?: Record<string, false>;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 后置：只含 caps.deny 里有东西的键；deny 全空返回 {}。同样的 caps 返回逐字相同的对象（键按名字排序），进 fingerprint 不抖。
 * 插件里的技能不进 skillOverrides（见 claudeCapabilityDenyRules）。allow 不用（claude 支持禁用清单）。
 */
export function claudeCapabilitySettings(caps: SessionCapabilities): ClaudeCapabilitySettings {
  const out: ClaudeCapabilitySettings = {};

  const skills = [...new Set(caps.deny.skills)]
    .filter((name) => !Object.hasOwn(caps.deny.pluginOf.skills, name))
    .sort(cmpStr);
  if (skills.length > 0) {
    out.skillOverrides = Object.fromEntries(skills.map((name) => [name, "off" as const]));
  }

  const deniedServers = [...new Set([...caps.deny.mcp, ...caps.deny.connectors])].sort(cmpStr);
  if (deniedServers.length > 0) {
    out.deniedMcpServers = deniedServers.map((serverName) => ({ serverName }));
  }

  const plugins = [...new Set(caps.deny.plugins)].sort(cmpStr);
  if (plugins.length > 0) {
    out.enabledPlugins = Object.fromEntries(plugins.map((id) => [id, false as const]));
  }

  return out;
}

/**
 * 后置：插件里关掉的技能每个一条 `Skill(<名字>)`，按名字排序；所属插件整个关了的不再写（enabledPlugins 已经让它不见）。
 * 调用方并进 --settings 的 permissions.deny，不覆盖已有规则。
 */
export function claudeCapabilityDenyRules(caps: SessionCapabilities): string[] {
  const pluginsOff = new Set(caps.deny.plugins);
  return Object.entries(caps.deny.pluginOf.skills)
    .filter(([, pluginId]) => !pluginsOff.has(pluginId))
    .map(([name]) => name)
    .sort(cmpStr)
    .map((name) => `Skill(${name})`);
}
