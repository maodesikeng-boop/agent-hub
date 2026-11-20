import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

export interface ClaudeCapabilitySettings {
  skillOverrides?: Record<string, "off">;
  deniedMcpServers?: Array<{ serverName: string }>;
  enabledPlugins?: Record<string, false>;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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

// skillOverrides does not apply to plugin skills, so deny Skill(<name>) instead (claude 2.1.326).
export function claudeCapabilityDenyRules(caps: SessionCapabilities): string[] {
  const pluginsOff = new Set(caps.deny.plugins);
  return Object.entries(caps.deny.pluginOf.skills)
    .filter(([, pluginId]) => !pluginsOff.has(pluginId))
    .map(([name]) => name)
    .sort(cmpStr)
    .map((name) => `Skill(${name})`);
}
