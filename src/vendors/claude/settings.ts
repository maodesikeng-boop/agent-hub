import type { SessionRole } from "../../shared/domain.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import type { ReadonlyPolicy } from "../../shared/readonly-policy.ts";
import { claudeCapabilityDenyRules, claudeCapabilitySettings, type ClaudeCapabilitySettings } from "./capabilities.ts";
import { CLAUDE_READONLY_PERMISSION_MODE, claudeReadonlyPermissions, claudeReadonlySandbox, type ClaudeReadonlySandbox } from "./readonly-settings.ts";

const HUB_ALLOW_RULE = `Bash(${HUB_COMMAND}:*)`;

export const DEFAULT_PERMISSION_MODE = "auto";
type PermissionMode = typeof DEFAULT_PERMISSION_MODE | typeof CLAUDE_READONLY_PERMISSION_MODE;

// Rules use gitignore syntax: absolute paths start with // and \ [ ] * ? are escaped.
export function stateDirDenyRule(stateDir: string): string {
  const escaped = stateDir.replace(/\/+$/, "").replace(/[\\[\]*?]/g, "\\$&");
  return `Edit(/${escaped}/**)`;
}

// All worktrees of a repo share one auto-memory dir, so Worker writes would reach the PM.
export const WORKER_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

interface SessionReadonlyInput {
  policy: ReadonlyPolicy;
  denyWrite: string[];
}

export interface SessionSettingsInput {
  role: SessionRole;
  readonly?: SessionReadonlyInput;
  // macOS /var is /private/var; an unresolved path breaks the sandbox allowlist.
  hubSock?: string;
  stateDir: string;
  // macOS sandboxes cannot nest; claude's own sandbox makes every Bash call exit 71.
  osSandboxed: boolean;
  // Native Windows claude has no built-in sandbox.
  platform?: string;
  capabilities?: SessionCapabilities;
}

export interface SessionSettings extends ClaudeCapabilitySettings {
  permissions: { defaultMode: PermissionMode; allow: string[]; deny?: string[] };
  sandbox: PlainSandbox | ClaudeReadonlySandbox;
  autoMemoryEnabled?: false;
}

interface PlainSandbox {
  enabled?: false;
  network: { allowUnixSockets: string[] };
}

export function buildSessionSettings(input: SessionSettingsInput): SessionSettings {
  const hubAllow = input.hubSock === undefined ? [] : [HUB_ALLOW_RULE];
  const capSettings = input.capabilities ? claudeCapabilitySettings(input.capabilities) : {};
  const capDeny = input.capabilities ? claudeCapabilityDenyRules(input.capabilities) : [];
  if (input.readonly) {
    const { allow, deny: readonlyDeny } = claudeReadonlyPermissions(input.readonly.policy);
    const deny = [...readonlyDeny, ...capDeny];
    const platform = input.platform ?? process.platform;
    if (platform === "win32") {
      return {
        permissions: { defaultMode: CLAUDE_READONLY_PERMISSION_MODE, allow: [...hubAllow, ...allow], deny },
        sandbox: { enabled: false, network: { allowUnixSockets: [] } },
        autoMemoryEnabled: false,
        ...capSettings,
      };
    }
    return {
      permissions: { defaultMode: CLAUDE_READONLY_PERMISSION_MODE, allow: [...hubAllow, ...allow], deny },
      sandbox: claudeReadonlySandbox(input.readonly.policy, { denyWrite: input.readonly.denyWrite, hubSock: input.hubSock }),
      autoMemoryEnabled: false,
      ...capSettings,
    };
  }
  const sandbox: PlainSandbox = { network: { allowUnixSockets: input.hubSock === undefined ? [] : [input.hubSock] } };
  const settings: SessionSettings = { permissions: { defaultMode: DEFAULT_PERMISSION_MODE, allow: hubAllow }, sandbox };
  if (input.role === "worker") {
    settings.permissions.deny = [...(settings.permissions.deny ?? []), stateDirDenyRule(input.stateDir)];
    settings.autoMemoryEnabled = false;
    if (input.osSandboxed) sandbox.enabled = false;
  }
  if (capDeny.length > 0) settings.permissions.deny = [...(settings.permissions.deny ?? []), ...capDeny];
  return { ...settings, ...capSettings };
}

export function sessionEnv(role: SessionRole): Readonly<Record<string, string>> {
  return role === "worker" ? WORKER_ENV : {};
}

// Verified on claude 2.1.314: without these layers the copy could Write, Edit, and write files via Bash.
export const FORK_PERMISSION_MODE = "dontAsk";
// A whole-tool deny removes the tool from the list and breaks the prompt cache.
export const FORK_DENY_RULES: readonly string[] = ["Edit(//**)"];
// PreToolUse exit code 2 blocks the call and shows stderr to the model.
export const FORK_DENY_ALL_HOOK = {
  matcher: "*",
  hooks: [{ type: "command", command: "echo '这是复制出来只写交接的一份：不能调用任何工具，直接把交接写成这一轮的回复。' >&2; exit 2" }],
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arrayOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function buildForkSettings(settings: object): Record<string, unknown> {
  const base = settings as Record<string, unknown>;
  const permissions = isRecord(base.permissions) ? base.permissions : {};
  const hooks = isRecord(base.hooks) ? base.hooks : {};
  return {
    ...base,
    permissions: { ...permissions, defaultMode: FORK_PERMISSION_MODE, deny: [...arrayOf(permissions.deny), ...FORK_DENY_RULES] },
    hooks: { ...hooks, PreToolUse: [...arrayOf(hooks.PreToolUse), FORK_DENY_ALL_HOOK] },
    disableAllHooks: false,
  };
}
