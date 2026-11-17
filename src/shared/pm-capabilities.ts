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

/** 没存过选择的项目经理：三类都是 all，没有 overrides。 */
export function defaultPmCapabilityPolicy(pmId: PmId): PmCapabilityPolicy {
  throw new Error("未实现");
}

/**
 * 后置：overrides 里有这一项就用它，没有就看 base（key 前缀认种类）。
 * 前置：key 是 capabilityKey 拼出来的。
 */
export function capabilityEnabled(policy: PmCapabilityPolicy, key: CapabilityKey): boolean {
  throw new Error("未实现");
}

/** 拼稳定键。connector 必须给 vendor，别的种类给了也不用。 */
export function capabilityKey(kind: CapabilityKind, name: string, vendor?: AgentVendor): CapabilityKey {
  throw new Error("未实现");
}

/**
 * 后置：返回新的 policy，不改入参。set 里值和 base 相同的项从 overrides 去掉，所以同一个开关点开再点回来，存下来的和原来一样。
 * 改了 base 时，已有 overrides 里和新 base 相同的项也去掉。
 */
export function applyCapabilitiesPatch(policy: PmCapabilityPolicy, patch: PmCapabilitiesPatch): PmCapabilityPolicy {
  throw new Error("未实现");
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
  throw new Error("未实现");
}
