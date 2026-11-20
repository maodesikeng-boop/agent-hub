import type { ReadonlyPolicy } from "../../shared/readonly-policy.ts";

// dontAsk denies everything that needs approval (even /tmp reads); plan does not stop Bash writes.
export const CLAUDE_READONLY_PERMISSION_MODE = "default";
export const CLAUDE_READONLY_ALLOW_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] as const;
export const CLAUDE_READONLY_DENY_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

function absoluteRulePath(path: string): string {
  return `/${path.replace(/\/+$/, "").replace(/[\\[\]*?]/g, "\\$&")}`;
}

function connectorDenyRule(rule: string): string | null {
  const slash = rule.indexOf("/");
  const server = slash < 0 ? rule : rule.slice(0, slash);
  const tool = slash < 0 ? "*" : rule.slice(slash + 1);
  if (server === "*") return null;
  return tool === "*" ? `mcp__${server}` : `mcp__${server}__${tool}`;
}

export function claudeReadonlyPermissions(policy: ReadonlyPolicy): { allow: string[]; deny: string[] } {
  const deny: string[] = [...CLAUDE_READONLY_DENY_TOOLS];
  for (const path of [...policy.secretPaths, ...(policy.dataDirDenied ?? [])]) deny.push(`Read(${absoluteRulePath(path)})`, `Read(${absoluteRulePath(path)}/**)`);
  for (const glob of policy.secretGlobs) deny.push(`Read(//${glob})`);
  for (const rule of policy.connectors.deny) {
    const denyRule = connectorDenyRule(rule);
    if (denyRule !== null) deny.push(denyRule);
  }
  return { allow: [...CLAUDE_READONLY_ALLOW_TOOLS], deny };
}

export interface ClaudeReadonlySandboxInput {
  denyWrite: string[];
  hubSock?: string;
}

export interface ClaudeReadonlySandbox {
  enabled: true;
  failIfUnavailable: true;
  allowUnsandboxedCommands: false;
  autoAllowBashIfSandboxed: true;
  enableWeakerNetworkIsolation: true;
  filesystem: { denyWrite: string[]; denyRead: string[] };
  network: { allowedDomains: string[]; allowUnixSockets: string[] };
}

// Use denyRead only: allowRead overrides it. Rooted /**/ globs match; bare **/ ones do not.
export function claudeReadonlySandbox(policy: ReadonlyPolicy, input: ClaudeReadonlySandboxInput): ClaudeReadonlySandbox {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    enableWeakerNetworkIsolation: true,
    filesystem: {
      denyWrite: [...input.denyWrite],
      denyRead: [...policy.secretPaths, ...(policy.dataDirDenied ?? []), ...policy.secretGlobs.map((glob) => (glob.startsWith("**/") ? `/${glob}` : glob))],
    },
    network: { allowedDomains: ["*"], allowUnixSockets: input.hubSock === undefined ? [] : [input.hubSock] },
  };
}
