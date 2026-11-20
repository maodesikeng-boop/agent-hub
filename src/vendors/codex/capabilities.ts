// `-c` splits keys on . and ignores quotes, so use top-level tables with inline-table values.
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DISABLED = "{enabled=false}";

function inlineTable(entries: ReadonlyArray<readonly [string, string]>): string {
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}=${value}`).join(",")}}`;
}

function disabledTable(names: Iterable<string>): string {
  return inlineTable([...new Set(names)].sort(cmpStr).map((name) => [name, DISABLED] as const));
}

export function codexCapabilityArgs(caps: SessionCapabilities): string[] {
  const args: string[] = [];

  const skills = [...new Set(caps.deny.skills)].sort(cmpStr);
  if (skills.length > 0) {
    const entries = skills.map((name) => `{name=${JSON.stringify(name)},enabled=false}`).join(",");
    args.push("-c", `skills.config=[${entries}]`);
  }

  const pluginMcp = caps.deny.pluginOf.mcp;
  const configMcp = caps.deny.mcp.filter((name) => !Object.hasOwn(pluginMcp, name));
  if (configMcp.length > 0) args.push("-c", `mcp_servers=${disabledTable(configMcp)}`);

  const byPlugin = new Map<string, string[]>();
  for (const [name, pluginId] of Object.entries(pluginMcp)) {
    const names = byPlugin.get(pluginId);
    if (names) names.push(name);
    else byPlugin.set(pluginId, [name]);
  }
  if (byPlugin.size > 0) {
    const plugins = [...byPlugin.keys()].sort(cmpStr).map((id) => [id, `{mcp_servers=${disabledTable(byPlugin.get(id)!)}}`] as const);
    args.push("-c", `plugins=${inlineTable(plugins)}`);
  }

  if (caps.deny.connectors.length > 0) args.push("-c", `apps=${disabledTable(caps.deny.connectors)}`);

  return args;
}
