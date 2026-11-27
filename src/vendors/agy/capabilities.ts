// agy has no per-session MCP switch; deny rules feed launch fingerprinting and .agents/hooks.json.
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function agyCapabilityDenyRules(caps: SessionCapabilities): string[] {
  return [...new Set(caps.deny.mcp)].sort(cmpStr).map((server) => `mcp(${server}/*)`);
}
