import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  AGENT_VENDORS,
  PM_CAPABILITY_PATCH_MAX_KEYS,
  applyCapabilitiesPatch,
  capabilityEnabled,
  vendorLabel,
  type AgentVendor,
  type CapabilitiesPatch,
  type CapabilitiesView,
  type CapabilityGroup,
  type CapabilityInventory,
  type CapabilityIsolation,
  type CapabilityItem,
  type CapabilityKey,
  type CapabilityKind,
  type CapabilityPolicy,
  type CapabilityScope,
  type CapabilitySource,
  type Pm,
  type PmId,
} from "../shared/index.ts";
import { resolvePmLook, type SlimeLook } from "../shared/slimes.ts";
import { localClient } from "./client.ts";
import { errorText, type ErrorInfo } from "./format.ts";
import { useHubQueryClient } from "./query-client.ts";

export type CapabilityScopeKey = "router" | `pm:${PmId}`;

export interface CapabilityScopeOption {
  key: CapabilityScopeKey;
  scope: CapabilityScope;
  label: string;
  look: SlimeLook | null;
}

export const ROUTER_SCOPE_OPTION: CapabilityScopeOption = { key: "router", scope: { kind: "router" }, label: "Router", look: null };

function capabilityScopeKey(scope: CapabilityScope): CapabilityScopeKey {
  return scope.kind === "router" ? "router" : `pm:${scope.pmId}`;
}

const scopeOptionsCache = new WeakMap<readonly Pm[], readonly CapabilityScopeOption[]>();

export function capabilityScopeOptions(pms: readonly Pm[]): readonly CapabilityScopeOption[] {
  const hit = scopeOptionsCache.get(pms);
  if (hit !== undefined) return hit;
  const options: CapabilityScopeOption[] = [ROUTER_SCOPE_OPTION];
  for (const pm of pms) {
    if (pm.archivedAt == null) options.push({ key: `pm:${pm.id}`, scope: { kind: "pm", pmId: pm.id }, label: pm.name, look: resolvePmLook(pm) });
  }
  scopeOptionsCache.set(pms, options);
  return options;
}

export const CAPABILITY_KIND_ORDER: readonly CapabilityKind[] = ["mcp", "skill", "connector"];

export const CAPABILITY_KIND_LABELS: Readonly<Record<CapabilityKind, string>> = { mcp: "MCP servers", skill: "Skills", connector: "Connectors" };

export interface CapabilityRow {
  key: CapabilityKey;
  name: string;
  description: string | null;
  enabled: boolean;
}

export interface CapabilitySourceGroup {
  id: string;
  label: string;
  detail: string | null;
  rows: readonly CapabilityRow[];
  enabled: number;
}

export interface CapabilityKindSection {
  kind: CapabilityKind;
  groups: readonly CapabilitySourceGroup[];
  total: number;
  enabled: number;
}

const SOURCE_ORDER: Readonly<Record<CapabilitySource["kind"], number>> = { project: 0, global: 1, plugin: 2, vendor_bundled: 3, account: 4 };

function sourceDetail(source: CapabilitySource): string | null {
  if (source.kind === "project") return "Project";
  if (source.kind === "plugin") return `${vendorLabel(source.vendor)} plugin`;
  return null;
}

// Claude namespaces plugin MCP servers as plugin:<plugin>:<server>; the group row already names the plugin.
function rowName(item: CapabilityItem, source: CapabilitySource): string {
  return source.kind === "plugin" && item.kind === "mcp" ? item.name.replace(/^plugin:[^:]+:/, "") : item.name;
}

function sourceGroup(group: CapabilityGroup, items: ReadonlyMap<CapabilityKey, CapabilityItem>, policy: CapabilityPolicy): CapabilitySourceGroup {
  const rows = group.itemKeys.flatMap((key): CapabilityRow[] => {
    const item = items.get(key);
    return item === undefined ? [] : [{ key, name: rowName(item, group.source), description: item.description, enabled: capabilityEnabled(policy, key) }];
  });
  return { id: group.id, label: group.label, detail: sourceDetail(group.source), rows, enabled: rows.filter((r) => r.enabled).length };
}

function compareGroups(a: CapabilityGroup, b: CapabilityGroup): number {
  return SOURCE_ORDER[a.source.kind] - SOURCE_ORDER[b.source.kind] || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function computeSections(inventory: CapabilityInventory, policy: CapabilityPolicy): readonly CapabilityKindSection[] {
  const items = new Map(inventory.items.map((item) => [item.key, item]));
  return CAPABILITY_KIND_ORDER.map((kind) => {
    const groups = inventory.groups
      .filter((g) => g.kind === kind)
      .toSorted(compareGroups)
      .map((g) => sourceGroup(g, items, policy))
      .filter((g) => g.rows.length > 0);
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    return { kind, groups, total, enabled: groups.reduce((n, g) => n + g.enabled, 0) };
  });
}

const sectionsCache = new WeakMap<CapabilityInventory, WeakMap<CapabilityPolicy, readonly CapabilityKindSection[]>>();

export function capabilitySections(inventory: CapabilityInventory, policy: CapabilityPolicy): readonly CapabilityKindSection[] {
  let byPolicy = sectionsCache.get(inventory);
  if (byPolicy === undefined) {
    byPolicy = new WeakMap();
    sectionsCache.set(inventory, byPolicy);
  }
  const hit = byPolicy.get(policy);
  if (hit !== undefined) return hit;
  const sections = computeSections(inventory, policy);
  byPolicy.set(policy, sections);
  return sections;
}

const rowMatches = (row: CapabilityRow, needle: string) =>
  row.name.toLowerCase().includes(needle) || row.key.toLowerCase().includes(needle) || (row.description?.toLowerCase().includes(needle) ?? false);

export function filterCapabilitySections(sections: readonly CapabilityKindSection[], query: string): readonly CapabilityKindSection[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return sections;
  return sections.flatMap((section) => {
    const groups = section.groups.flatMap((group): CapabilitySourceGroup[] => {
      const rows = group.label.toLowerCase().includes(needle) ? group.rows : group.rows.filter((row) => rowMatches(row, needle));
      return rows.length === 0 ? [] : [{ ...group, rows, enabled: rows.filter((r) => r.enabled).length }];
    });
    if (groups.length === 0) return [];
    return [{ ...section, groups, total: groups.reduce((n, g) => n + g.rows.length, 0), enabled: groups.reduce((n, g) => n + g.enabled, 0) }];
  });
}

export function capabilityTotals(sections: readonly CapabilityKindSection[]): { enabled: number; total: number } {
  return { enabled: sections.reduce((n, s) => n + s.enabled, 0), total: sections.reduce((n, s) => n + s.total, 0) };
}

function chunkedSet(keys: readonly CapabilityKey[], value: boolean | null): CapabilitiesPatch[] {
  const patches: CapabilitiesPatch[] = [];
  for (let i = 0; i < keys.length; i += PM_CAPABILITY_PATCH_MAX_KEYS) {
    patches.push({ set: Object.fromEntries(keys.slice(i, i + PM_CAPABILITY_PATCH_MAX_KEYS).map((key) => [key, value])) });
  }
  return patches;
}

export function kindPatches(policy: CapabilityPolicy, kind: CapabilityKind, on: boolean): CapabilitiesPatch[] {
  const overridden = Object.keys(policy.overrides).filter((key) => key.startsWith(`${kind}:`));
  const [first, ...rest] = chunkedSet(overridden, null);
  return [{ base: { [kind]: on ? "all" : "none" }, ...first }, ...rest];
}

export function rowsPatches(rows: readonly CapabilityRow[], on: boolean): CapabilitiesPatch[] {
  return chunkedSet(rows.filter((row) => row.enabled !== on).map((row) => row.key), on);
}

export const ISOLATION_LABELS: Readonly<Record<CapabilityIsolation, string>> = { session: "Per session", tool_deny: "Tools denied", shared: "Shared" };

export interface EnforcementCell {
  isolation: CapabilityIsolation;
  plugin: CapabilityIsolation | null;
}

export interface EnforcementRow {
  vendor: AgentVendor;
  label: string;
  cells: Readonly<Record<CapabilityKind, EnforcementCell>>;
}

const enforcementCache = new WeakMap<CapabilitiesView["isolation"], readonly EnforcementRow[]>();

export function enforcementRows(view: Pick<CapabilitiesView, "isolation" | "pluginIsolation">): readonly EnforcementRow[] {
  const hit = enforcementCache.get(view.isolation);
  if (hit !== undefined) return hit;
  const rows = AGENT_VENDORS.flatMap((vendor): EnforcementRow[] => {
    const isolation = view.isolation[vendor];
    if (isolation === undefined) return [];
    const plugin = view.pluginIsolation[vendor] ?? {};
    const cell = (kind: CapabilityKind): EnforcementCell => {
      const override = plugin[kind];
      return { isolation: isolation[kind], plugin: override !== undefined && override !== isolation[kind] ? override : null };
    };
    return [{ vendor, label: vendorLabel(vendor), cells: { mcp: cell("mcp"), skill: cell("skill"), connector: cell("connector") } }];
  });
  enforcementCache.set(view.isolation, rows);
  return rows;
}

export const capabilitiesQueryKey = (scope: CapabilityScope) => ["capabilities", capabilityScopeKey(scope)] as const;

export function useCapabilitiesView(scope: CapabilityScope) {
  const qc = useHubQueryClient();
  return useQuery({ queryKey: capabilitiesQueryKey(scope), queryFn: () => localClient.fetchCapabilities(scope) }, qc);
}

export function useCapabilityEditor(scope: CapabilityScope) {
  const qc = useHubQueryClient();
  const queryKey = capabilitiesQueryKey(scope);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { mutate } = useMutation(
    {
      mutationKey: queryKey,
      // One queue per scope keeps PATCHes ordered, so the last response carries every toggle.
      scope: { id: queryKey.join(":") },
      mutationFn: (patch: CapabilitiesPatch) => localClient.patchCapabilities(scope, patch),
      onMutate: async (patch: CapabilitiesPatch) => {
        setError(null);
        await qc.cancelQueries({ queryKey });
        qc.setQueryData<CapabilitiesView>(queryKey, (view) => view && { ...view, policy: applyCapabilitiesPatch(view.policy, patch) });
      },
      onSuccess: (view: CapabilitiesView) => {
        if (qc.isMutating({ mutationKey: queryKey }) <= 1) qc.setQueryData(queryKey, view);
      },
      onError: (err: unknown) => {
        setError(errorText(err));
        void qc.invalidateQueries({ queryKey });
      },
    },
    qc,
  );
  const apply = useCallback((patches: readonly CapabilitiesPatch[]) => patches.forEach((patch) => mutate(patch)), [mutate]);
  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      qc.setQueryData(queryKey, await localClient.fetchCapabilities(scope, { refresh: true }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRefreshing(false);
    }
  };
  return { apply, error, refreshing, refresh };
}
