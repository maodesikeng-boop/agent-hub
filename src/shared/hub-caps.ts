// Invariant: hub caps output is read-only, bounded by HUB_CAPS_LIST_MAX, and reflects the PM's effective capability policy.

import { HUB_CAPS_LIST_MAX } from "./limits.ts";
import {
  CAPABILITY_KINDS,
  capabilityEnabled,
  type CapabilityInventory,
  type CapabilityKey,
  type CapabilityKind,
  type CapabilityPolicy,
} from "./pm-capabilities.ts";
import { NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS, eligibleComputerUseCapabilities } from "./sandbox-approval.ts";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "./vendors.ts";

export interface HubCapsArgs {
  kind?: CapabilityKind;
  vendor?: AgentVendor;
}

export interface HubCapabilityEntry {
  key: CapabilityKey;
  kind: CapabilityKind;
  name: string;
  enabled: boolean;
  vendors: readonly AgentVendor[];
  computerUseEligible: boolean;
}

export interface HubCapsData {
  policy: CapabilityPolicy;
  items: readonly HubCapabilityEntry[];
  totalMatched: number;
  truncated: boolean;
}

const KIND_ORDER: Readonly<Record<CapabilityKind, number>> = { mcp: 0, skill: 1, connector: 2 };

function computerUseEligibleKeys(inventory: CapabilityInventory, vendor: AgentVendor | undefined, platform: string): ReadonlySet<CapabilityKey> {
  if (!NO_OUTER_SANDBOX_SUPPORTED_PLATFORMS.some((entry) => entry === platform)) return new Set();
  const vendors = vendor !== undefined ? [vendor] : AGENT_VENDORS;
  const keys = new Set<CapabilityKey>();
  for (const v of vendors) {
    if (vendorSpec(v).capabilities.builtInSandbox?.platforms.some((entry) => entry === platform) !== true) continue;
    for (const key of eligibleComputerUseCapabilities(v, inventory)) keys.add(key);
  }
  return keys;
}

export function formatHubCapabilities(
  policy: CapabilityPolicy,
  inventory: CapabilityInventory,
  args: HubCapsArgs,
  platform: string = process.platform,
): { text: string; data: HubCapsData } {
  const cuKeys = computerUseEligibleKeys(inventory, args.vendor, platform);
  const matched: HubCapabilityEntry[] = inventory.items
    .filter((item) => (args.kind === undefined || item.kind === args.kind) && (args.vendor === undefined || item.vendors.includes(args.vendor)))
    .map((item) => ({
      key: item.key,
      kind: item.kind,
      name: item.name,
      enabled: capabilityEnabled(policy, item.key),
      vendors: item.vendors,
      computerUseEligible: cuKeys.has(item.key),
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const totalMatched = matched.length;
  const truncated = totalMatched > HUB_CAPS_LIST_MAX;
  const items = truncated ? matched.slice(0, HUB_CAPS_LIST_MAX) : matched;

  const baseSummary = CAPABILITY_KINDS.map((kind) => `${kind} ${policy.base[kind] === "all" ? "全开" : "全关"}`).join(" · ");
  const filters: string[] = [];
  if (args.kind !== undefined) filters.push(`类别=${args.kind}`);
  if (args.vendor !== undefined) filters.push(`厂商=${args.vendor}`);
  const filterNote = filters.length === 0 ? "" : `（筛选：${filters.join("，")}）`;
  const lines = [`项目外接能力策略：${baseSummary}${filterNote}`];

  if (items.length === 0) {
    lines.push("当前没有匹配的外接能力。");
  } else {
    for (const item of items) {
      const state = item.enabled ? "开启" : "关闭";
      const cuNote = item.computerUseEligible ? " [支持 --no-outer-sandbox]" : "";
      lines.push(`  - ${item.key} [${state}] · 厂商 ${item.vendors.join("/")}${cuNote}`);
    }
  }
  if (truncated) {
    lines.push(`另有 ${totalMatched - items.length} 项未列出，请用 --kind skill|mcp|connector 或 --vendor <厂商> 过滤。`);
  }
  if (inventory.truncated) {
    lines.push("注：本机发现的能力数量达到扫描上限，部分条目未纳入列表。");
  }
  return {
    text: lines.join("\n"),
    data: { policy, items, totalMatched, truncated },
  };
}
