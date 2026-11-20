import { isOneOf, type PmId } from "./domain.ts";
import { WORKER_CAPABILITY_ALLOW_MAX } from "./limits.ts";
import type { AgentVendor } from "../vendors/registry.ts";

export const CAPABILITY_KINDS = ["skill", "mcp", "connector"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export type CapabilityBase = "all" | "none";

export type CapabilityKey = string;

export type CapabilitySource =
  | { kind: "global" }
  | { kind: "project"; projectLabel: string }
  | { kind: "plugin"; vendor: AgentVendor; plugin: string }
  | { kind: "vendor_bundled"; vendor: AgentVendor }
  | { kind: "account"; vendor: AgentVendor };

export interface CapabilityItem {
  key: CapabilityKey;
  kind: CapabilityKind;
  name: string;
  description: string | null;
  groupId: string;
  vendors: readonly AgentVendor[];
  dir?: string;
  skillDirs?: Readonly<Partial<Record<AgentVendor, string>>>;
  plugins?: Readonly<Partial<Record<AgentVendor, string>>>;
}

export interface CapabilityGroup {
  id: string;
  kind: CapabilityKind;
  label: string;
  source: CapabilitySource;
  itemKeys: readonly CapabilityKey[];
}

export interface CapabilityInventory {
  scannedAt: number;
  items: readonly CapabilityItem[];
  groups: readonly CapabilityGroup[];
  truncated: boolean;
}

type CapabilityBaseMap = Readonly<Record<CapabilityKind, CapabilityBase>>;

const ALL_CAPABILITIES_BASE: CapabilityBaseMap = { skill: "all", mcp: "all", connector: "all" };
const NO_CAPABILITIES_BASE: CapabilityBaseMap = { skill: "none", mcp: "none", connector: "none" };

export interface CapabilityPolicy {
  base: CapabilityBaseMap;
  overrides: Readonly<Record<CapabilityKey, boolean>>;
}

export type CapabilityScope = { kind: "router" } | { kind: "pm"; pmId: PmId };

export const WORKER_CAPABILITY_MODES = ["inherit", "none", "custom"] as const;
export type WorkerCapabilityMode = (typeof WORKER_CAPABILITY_MODES)[number];

export type WorkerCapabilities =
  | { mode: "inherit" }
  | { mode: "none" }
  | { mode: "custom"; allow: readonly CapabilityKey[] };

export interface SkillRef {
  name: string;
  dir: string;
}

export interface SessionCapabilities {
  deny: {
    skills: readonly string[];
    mcp: readonly string[];
    connectors: readonly string[];
    plugins: readonly string[];
    pluginOf: { skills: Readonly<Record<string, string>>; mcp: Readonly<Record<string, string>> };
  };
  allow: { skills: readonly SkillRef[]; mcp: readonly string[] };
}

export type CapabilityIsolation = "session" | "tool_deny" | "shared";

export type CapabilityIsolationMap = Readonly<Record<CapabilityKind, CapabilityIsolation>>;

export type PmCapabilitiesStart = { from: "all" } | { from: "pm"; pmId: PmId };

export interface CapabilitiesView {
  scope: CapabilityScope;
  inventory: CapabilityInventory;
  policy: CapabilityPolicy;
  isolation: Readonly<Partial<Record<AgentVendor, CapabilityIsolationMap>>>;
  pluginIsolation: Readonly<Partial<Record<AgentVendor, Partial<CapabilityIsolationMap>>>>;
}

export interface CapabilitiesPatch {
  base?: Partial<Record<CapabilityKind, CapabilityBase>>;
  set?: Readonly<Record<CapabilityKey, boolean | null>>;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedRecord(map: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => cmpStr(a, b)));
}

function kindOfCapabilityKey(key: CapabilityKey): CapabilityKind {
  if (key.startsWith("skill:") && key.length > 6) return "skill";
  if (key.startsWith("mcp:") && key.length > 4) return "mcp";
  if (key.startsWith("connector:")) {
    const rest = key.slice("connector:".length);
    const sep = rest.indexOf(":");
    if (sep > 0 && sep + 1 < rest.length) return "connector";
  }
  throw new RangeError(`invalid capability key: ${key}`);
}

export function isValidCapabilityKey(key: string): boolean {
  if (key.length === 0 || key.length > 512 || /[\u0000-\u001f]/.test(key)) return false;
  try {
    kindOfCapabilityKey(key);
    return true;
  } catch {
    return false;
  }
}

// The Router starts with no external capabilities so single dispatch turns stay fast and cheap.
export function defaultCapabilityPolicy(scope: CapabilityScope["kind"]): CapabilityPolicy {
  return { base: scope === "router" ? NO_CAPABILITIES_BASE : ALL_CAPABILITIES_BASE, overrides: {} };
}

export function capabilityEnabled(policy: CapabilityPolicy, key: CapabilityKey): boolean {
  if (Object.hasOwn(policy.overrides, key)) {
    return policy.overrides[key]!;
  }
  const kind = kindOfCapabilityKey(key);
  return policy.base[kind] === "all";
}

export function capabilityKey(kind: CapabilityKind, name: string, vendor?: AgentVendor): CapabilityKey {
  if (kind === "connector") {
    if (!vendor) throw new RangeError("connector capabilityKey requires vendor");
    return `connector:${vendor}:${name}`;
  }
  return `${kind}:${name}`;
}

export function applyCapabilitiesPatch(policy: CapabilityPolicy, patch: CapabilitiesPatch): CapabilityPolicy {
  const nextBase: Record<CapabilityKind, CapabilityBase> = {
    skill: patch.base?.skill ?? policy.base.skill,
    mcp: patch.base?.mcp ?? policy.base.mcp,
    connector: patch.base?.connector ?? policy.base.connector,
  };
  const rawOverrides = new Map<CapabilityKey, boolean>(Object.entries(policy.overrides));
  if (patch.set !== undefined) {
    for (const [key, value] of Object.entries(patch.set)) {
      if (value === null) rawOverrides.delete(key);
      else if (typeof value === "boolean") rawOverrides.set(key, value);
    }
  }
  const sortedKeys = [...rawOverrides.keys()].sort(cmpStr);
  const nextOverrides: Record<CapabilityKey, boolean> = {};
  for (const key of sortedKeys) {
    const val = rawOverrides.get(key)!;
    const kind = kindOfCapabilityKey(key);
    const defaultEnabled = nextBase[kind] === "all";
    if (val !== defaultEnabled) {
      nextOverrides[key] = val;
    }
  }
  return { base: nextBase, overrides: nextOverrides };
}

export function resolveSessionCapabilities(
  policy: CapabilityPolicy,
  inventory: CapabilityInventory,
  vendor: AgentVendor,
): SessionCapabilities | null {
  const connectorPrefix = `connector:${vendor}:`;
  const visibleItems = inventory.items.filter((item) => {
    if (!item.vendors.includes(vendor)) return false;
    if (item.kind === "connector") return item.key.startsWith(connectorPrefix);
    return true;
  });
  const denySkills = new Set<string>();
  const denyMcp = new Set<string>();
  const denyConnectors = new Set<string>();
  const pluginSkills = new Map<string, string>();
  const pluginMcp = new Map<string, string>();
  const allowSkillsByName = new Map<string, SkillRef>();
  const allowMcp = new Set<string>();
  const pluginAllOff = new Map<string, boolean>();
  let anyDisabled = false;

  for (const item of visibleItems) {
    const enabled = capabilityEnabled(policy, item.key);
    const pluginId = item.plugins?.[vendor];
    if (pluginId !== undefined) pluginAllOff.set(pluginId, (pluginAllOff.get(pluginId) ?? true) && !enabled);
    if (!enabled) {
      anyDisabled = true;
      if (item.kind === "skill") {
        denySkills.add(item.name);
        if (pluginId !== undefined) pluginSkills.set(item.name, pluginId);
      } else if (item.kind === "mcp") {
        denyMcp.add(item.name);
        if (pluginId !== undefined) pluginMcp.set(item.name, pluginId);
      } else if (item.kind === "connector") denyConnectors.add(item.key.slice(connectorPrefix.length));
    } else {
      if (item.kind === "skill") {
        const dir = item.skillDirs?.[vendor] ?? item.dir;
        if (dir !== undefined && !allowSkillsByName.has(item.name)) {
          allowSkillsByName.set(item.name, { name: item.name, dir });
        }
      } else if (item.kind === "mcp") {
        allowMcp.add(item.name);
      }
    }
  }

  if (
    policy.base.skill === "all" &&
    policy.base.mcp === "all" &&
    policy.base.connector === "all" &&
    !anyDisabled
  ) {
    return null;
  }

  return {
    deny: {
      skills: [...denySkills].sort(cmpStr),
      mcp: [...denyMcp].sort(cmpStr),
      connectors: [...denyConnectors].sort(cmpStr),
      plugins: [...pluginAllOff].filter(([, allOff]) => allOff).map(([id]) => id).sort(cmpStr),
      pluginOf: { skills: sortedRecord(pluginSkills), mcp: sortedRecord(pluginMcp) },
    },
    allow: {
      skills: [...allowSkillsByName.keys()].sort(cmpStr).map((name) => allowSkillsByName.get(name)!),
      mcp: [...allowMcp].sort(cmpStr),
    },
  };
}

export const INHERIT_WORKER_CAPABILITIES: WorkerCapabilities = { mode: "inherit" };

const CAPABILITY_KEY_HINT = "写成 skill:<名>、mcp:<名> 或 connector:<厂商>:<编号>";

export function workerCapabilitiesOf(mode: unknown, allow: unknown): WorkerCapabilities | { error: string } {
  const allowGiven = allow !== undefined && allow !== null;
  if (mode === undefined || mode === null) {
    return allowGiven ? { error: "allow 要配合 caps custom 一起用" } : INHERIT_WORKER_CAPABILITIES;
  }
  if (!isOneOf(WORKER_CAPABILITY_MODES, mode)) return { error: `caps 只能是 ${WORKER_CAPABILITY_MODES.join("、")}` };
  if (mode !== "custom") return allowGiven ? { error: "只有 caps custom 才能用 allow 点名能力" } : { mode };
  if (!Array.isArray(allow) || allow.length === 0) {
    return { error: `caps custom 至少点名一项（${CAPABILITY_KEY_HINT}）；什么都不带用 caps none` };
  }
  const keys = [...new Set(allow)];
  if (keys.length > WORKER_CAPABILITY_ALLOW_MAX) return { error: `allow 最多点名 ${WORKER_CAPABILITY_ALLOW_MAX} 项` };
  for (const key of keys) {
    if (typeof key !== "string" || !isValidCapabilityKey(key)) return { error: `不认识的能力 ${String(key)}：${CAPABILITY_KEY_HINT}` };
  }
  return { mode: "custom", allow: (keys as string[]).sort(cmpStr) };
}

export function workerCapabilitiesJson(caps: WorkerCapabilities): string | null {
  return caps.mode === "inherit" ? null : JSON.stringify(caps);
}

export function parseWorkerCapabilitiesJson(raw: string | null): WorkerCapabilities {
  if (raw === null) return INHERIT_WORKER_CAPABILITIES;
  let obj: { mode?: unknown; allow?: unknown } | null;
  try {
    obj = JSON.parse(raw) as { mode?: unknown; allow?: unknown } | null;
  } catch {
    obj = null;
  }
  const caps = workerCapabilitiesOf(obj?.mode ?? "none", obj?.allow);
  // An unreadable row must never widen a Worker's reach, so it loads nothing external.
  return "error" in caps ? { mode: "none" } : caps;
}

export function workerCapabilityPolicy(project: CapabilityPolicy, worker: WorkerCapabilities): CapabilityPolicy {
  if (worker.mode === "inherit") return project;
  const allow = worker.mode === "custom" ? worker.allow.filter((key) => capabilityEnabled(project, key)) : [];
  return { base: NO_CAPABILITIES_BASE, overrides: Object.fromEntries(allow.map((key) => [key, true])) };
}

export function blockedWorkerCapabilities(project: CapabilityPolicy, worker: WorkerCapabilities): CapabilityKey[] {
  return worker.mode === "custom" ? worker.allow.filter((key) => !capabilityEnabled(project, key)) : [];
}
