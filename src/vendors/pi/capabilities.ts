// pi-mcp replaces chars outside [A-Za-z0-9_] with _ in tool names.
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sanitizePiServerName(server: string): string {
  return server.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface PiCapabilityArgs {
  noSkills: boolean;
  skillDirs: string[];
  excludeTools: string[];
}

export function piCapabilityArgs(caps: SessionCapabilities): PiCapabilityArgs {
  const noSkills = caps.deny.skills.length > 0;
  const skillDirs = noSkills ? caps.allow.skills.map((s) => s.dir) : [];
  const excludeTools = [...new Set(caps.deny.mcp.map((s) => `mcp__${sanitizePiServerName(s)}__*`))].sort(cmpStr);
  return { noSkills, skillDirs, excludeTools };
}
