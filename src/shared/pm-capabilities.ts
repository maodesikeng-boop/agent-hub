// 按项目经理管理 Skill、MCP 与 Connector（docs/pm-capabilities-design.md）。
// 不变量：
// - 库存（CapabilityInventory）是本机各厂商现在能看到的全部能力，只读扫描得来，不写任何用户配置；
// - 项目经理的选择只存“和默认不同的那几项”（PmCapabilityPolicy.overrides），默认按种类各自是 all 或 none；
//   没有存过的项目经理等于三类都是 all、没有 overrides，启动参数和现在完全一样；
// - Worker 用所属项目经理的选择；总助不受项目经理的选择影响；
// - 一家厂商做不到按会话隔离的那一类（VendorCapabilities.isolation 为 "shared"）照旧用全局配置，界面标出来。
import type { PmId } from "./domain.ts";
import type { AgentVendor } from "../vendors/registry.ts";

export const CAPABILITY_KINDS = ["skill", "mcp", "connector"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** 新出现、没单独设过的能力默认开还是关。 */
export type CapabilityBase = "all" | "none";

/**
 * 一项能力的稳定键：`skill:<技能名>`、`mcp:<服务器名>`、`connector:<厂商>:<连接器编号>`。
 * 技能和 MCP 按名字跨厂商算同一项（vendor-sync 也按名字对齐）；云端连接器挂在厂商账号上，各家分开算。
 */
export type CapabilityKey = string;

/** 一组能力从哪来：分组、批量开关都按它。 */
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
  /** 技能是 SKILL.md 的 description，MCP 和连接器没有；截到 PM_CAPABILITY_DESCRIPTION_MAX_CHARS。 */
  description: string | null;
  groupId: string;
  /** 本机哪几家能看到它。 */
  vendors: readonly AgentVendor[];
  /** 技能在磁盘上的目录（MCP 和连接器没有）；不同厂商指向不同目录时按 skillDirs 区分。 */
  dir?: string;
  skillDirs?: Readonly<Partial<Record<AgentVendor, string>>>;
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
  /** 超过 PM_CAPABILITY_INVENTORY_MAX_ITEMS 被截掉了。 */
  truncated: boolean;
}

export interface PmCapabilityPolicy {
  pmId: PmId;
  base: Readonly<Record<CapabilityKind, CapabilityBase>>;
  /** 和 base 不同的那几项。 */
  overrides: Readonly<Record<CapabilityKey, boolean>>;
}

/** 技能在磁盘上的位置：只认允许清单的厂商（pi 的 --skill、deepseek 的 customSkillDirs）要路径。 */
export interface SkillRef {
  name: string;
  dir: string;
}

/**
 * 一次启动要关掉、或者只开哪些（LaunchFiles.capabilities）。各家在自己的 capabilities.ts 里翻译成参数，
 * 支持禁用清单的用 deny，只支持允许清单的用 allow。
 */
export interface SessionCapabilities {
  /** plugins：一整组都关掉的插件（claude enabledPlugins、codex plugins.<id>.enabled），比逐项关更干净。 */
  deny: { skills: readonly string[]; mcp: readonly string[]; connectors: readonly string[]; plugins: readonly string[] };
  allow: { skills: readonly SkillRef[]; mcp: readonly string[] };
}

/** 一家厂商对一类能力能做到什么：session = 按会话隔离；tool_deny = 服务器照起，工具调用被拒；shared = 只能用全局配置。 */
export type CapabilityIsolation = "session" | "tool_deny" | "shared";

export type CapabilityIsolationMap = Readonly<Record<CapabilityKind, CapabilityIsolation>>;

/** 新建项目经理时从哪开始。 */
export type PmCapabilitiesStart = { from: "all" } | { from: "pm"; pmId: PmId };

/** GET /api/pms/:id/capabilities。 */
export interface PmCapabilitiesView {
  pmId: PmId;
  inventory: CapabilityInventory;
  policy: PmCapabilityPolicy;
  /** 各家每类能做到什么，界面给 shared 的那几家打标。 */
  isolation: Readonly<Partial<Record<AgentVendor, CapabilityIsolationMap>>>;
}

/** PATCH /api/pms/:id/capabilities：set 里给 null 是去掉这一项的单独设置，回到 base。 */
export interface PmCapabilitiesPatch {
  base?: Partial<Record<CapabilityKind, CapabilityBase>>;
  set?: Readonly<Record<CapabilityKey, boolean | null>>;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/** 没存过选择的项目经理：三类都是 all，没有 overrides。 */
export function defaultPmCapabilityPolicy(pmId: PmId): PmCapabilityPolicy {
  return {
    pmId,
    base: { skill: "all", mcp: "all", connector: "all" },
    overrides: {},
  };
}

/**
 * 后置：overrides 里有这一项就用它，没有就看 base（key 前缀认种类）。
 * 前置：key 是 capabilityKey 拼出来的。
 */
export function capabilityEnabled(policy: PmCapabilityPolicy, key: CapabilityKey): boolean {
  if (Object.hasOwn(policy.overrides, key)) {
    return policy.overrides[key]!;
  }
  const kind = kindOfCapabilityKey(key);
  return policy.base[kind] === "all";
}

/** 拼稳定键。connector 必须给 vendor，别的种类给了也不用。 */
export function capabilityKey(kind: CapabilityKind, name: string, vendor?: AgentVendor): CapabilityKey {
  if (kind === "connector") {
    if (!vendor) throw new RangeError("connector capabilityKey requires vendor");
    return `connector:${vendor}:${name}`;
  }
  return `${kind}:${name}`;
}

/**
 * 后置：返回新的 policy，不改入参。set 里值和 base 相同的项从 overrides 去掉，所以同一个开关点开再点回来，存下来的和原来一样。
 * 改了 base 时，已有 overrides 里和新 base 相同的项也去掉。
 */
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

/**
 * 算这一次启动要关的、只开的：
 * - 三类 base 都是 all 且没有一项被关时返回 null，驱动不加任何参数，和现在一样；
 * - 只看 vendor 能看到的那些项；连接器只算 vendor 自己账号上的；
 * - deny 和 allow 都按名字排序，内容一样时结果逐字相同（进 fingerprint）。
 */
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
  const visibleByKey = new Map<CapabilityKey, CapabilityItem>();
  for (const item of visibleItems) visibleByKey.set(item.key, item);

  const pluginItemKeys = new Map<string, Set<CapabilityKey>>();
  for (const group of inventory.groups) {
    if (group.source.kind !== "plugin" || group.source.vendor !== vendor) continue;
    let set = pluginItemKeys.get(group.source.plugin);
    if (!set) {
      set = new Set();
      pluginItemKeys.set(group.source.plugin, set);
    }
    for (const key of group.itemKeys) {
      if (visibleByKey.has(key)) set.add(key);
    }
  }

  const denyPlugins: string[] = [];
  const coveredByPlugin = new Set<CapabilityKey>();
  for (const [pluginId, keys] of pluginItemKeys) {
    if (keys.size === 0) continue;
    const allDisabled = [...keys].every((key) => !capabilityEnabled(policy, key));
    if (allDisabled) {
      denyPlugins.push(pluginId);
      for (const key of keys) coveredByPlugin.add(key);
    }
  }

  const denySkills = new Set<string>();
  const denyMcp = new Set<string>();
  const denyConnectors = new Set<string>();
  const allowSkillsByName = new Map<string, SkillRef>();
  const allowMcp = new Set<string>();
  let anyDisabled = false;

  for (const item of visibleItems) {
    const enabled = capabilityEnabled(policy, item.key);
    if (!enabled) {
      anyDisabled = true;
      if (coveredByPlugin.has(item.key)) continue;
      if (item.kind === "skill") denySkills.add(item.name);
      else if (item.kind === "mcp") denyMcp.add(item.name);
      else if (item.kind === "connector") denyConnectors.add(item.key.slice(connectorPrefix.length));
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
      plugins: [...new Set(denyPlugins)].sort(cmpStr),
    },
    allow: {
      skills: [...allowSkillsByName.keys()].sort(cmpStr).map((name) => allowSkillsByName.get(name)!),
      mcp: [...allowMcp].sort(cmpStr),
    },
  };
}
