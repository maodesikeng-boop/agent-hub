// Invariant: hub caps output is read-only, bounded by HUB_CAPS_LIST_MAX, and reflects the PM's effective capability policy.

import type { CapabilityInventory, CapabilityKey, CapabilityKind, CapabilityPolicy } from "./pm-capabilities.ts";
import type { AgentVendor } from "./vendors.ts";

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

/**
 * Precondition: policy is the PM's effective capability policy and inventory is the current CapabilityInventory snapshot.
 * Postcondition: filters items by optional args.kind and args.vendor, marks each item's effective enabled status and
 * `--no-outer-sandbox` eligibility, bounds returned items and rendered text to HUB_CAPS_LIST_MAX, and appends a filter hint on overflow.
 */
export function formatHubCapabilities(
  _policy: CapabilityPolicy,
  _inventory: CapabilityInventory,
  _args: HubCapsArgs,
  _platform?: string,
): { text: string; data: HubCapsData } {
  throw new Error("Not implemented");
}
