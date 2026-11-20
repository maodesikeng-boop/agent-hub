import type { PmId } from "./domain.ts";
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

export interface PmCapabilityPolicy {
  pmId: PmId;
  base: Readonly<Record<CapabilityKind, CapabilityBase>>;
  overrides: Readonly<Record<CapabilityKey, boolean>>;
}

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

export interface PmCapabilitiesView {
  pmId: PmId;
  inventory: CapabilityInventory;
  policy: PmCapabilityPolicy;
  isolation: Readonly<Partial<Record<AgentVendor, CapabilityIsolationMap>>>;
  pluginIsolation: Readonly<Partial<Record<AgentVendor, Partial<CapabilityIsolationMap>>>>;
}

export interface PmCapabilitiesPatch {
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

export function defaultPmCapabilityPolicy(pmId: PmId): PmCapabilityPolicy {
  return {
    pmId,
    base: { skill: "all", mcp: "all", connector: "all" },
    overrides: {},
  };
}

export function capabilityEnabled(policy: PmCapabilityPolicy, key: CapabilityKey): boolean {
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

export function applyCapabilitiesPatch(policy: PmCapabilityPolicy, patch: PmCapabilitiesPatch): PmCapabilityPolicy {
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
  return {
    pmId: policy.pmId,
    base: nextBase,
    overrides: nextOverrides,
  };
}

export function resolveSessionCapabilities(
  policy: PmCapabilityPolicy,
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
