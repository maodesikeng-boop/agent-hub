import { useMutation, useQuery, type Query, type QueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import {
  AGENT_VENDORS,
  EMPTY_CAPABILITY_LAYER,
  PM_CAPABILITY_PATCH_MAX_KEYS,
  applyCapabilitiesPatch,
  applyCapabilityLayerPatch,
  capabilityEnabled,
  capabilityLayerEmpty,
  capabilityPinned,
  layerCapabilityPolicy,
  vendorLabel,
  type AgentVendor,
  type CapabilitiesPatch,
  type CapabilitiesView,
  type CapabilityGroup,
  type CapabilityInventory,
  type CapabilityItem,
  type CapabilityKey,
  type CapabilityKind,
  type CapabilityScope,
  type Pm,
  type PmId,
} from "../shared/index.ts";
import { resolvePmLook, type SlimeLook } from "../shared/slimes.ts";
import { localClient } from "./client.ts";
import { errorText, type ErrorInfo } from "./format.ts";
import { useHubQueryClient } from "./query-client.ts";

export type CapabilityScopeKey = "default" | "router" | `pm:${PmId}`;

export function capabilityScopeKey(scope: CapabilityScope): CapabilityScopeKey {
  return scope.kind === "pm" ? `pm:${scope.pmId}` : scope.kind;
}

export interface CapabilityProjectOption {
  pmId: PmId;
  label: string;
  look: SlimeLook;
  vendor: AgentVendor;
}

const projectOptionsCache = new WeakMap<readonly Pm[], readonly CapabilityProjectOption[]>();

export function capabilityProjectOptions(pms: readonly Pm[]): readonly CapabilityProjectOption[] {
  const hit = projectOptionsCache.get(pms);
  if (hit !== undefined) return hit;
  const options = pms.filter((pm) => pm.archivedAt == null).map((pm) => ({ pmId: pm.id, label: pm.name, look: resolvePmLook(pm), vendor: pm.vendor }));
  projectOptionsCache.set(pms, options);
  return options;
}

export const CAPABILITY_KIND_TAGS: Readonly<Record<CapabilityKind, string>> = { mcp: "MCP", skill: "Skill", connector: "App" };

const LIST_LABELS: Readonly<Record<CapabilityKind, string>> = { mcp: "MCP servers", skill: "Skills", connector: "Apps" };

const KIND_ORDER: Readonly<Record<CapabilityKind, number>> = { mcp: 0, skill: 1, connector: 2 };

export interface CapabilityRow {
  key: CapabilityKey;
  kind: CapabilityKind;
  name: string;
  description: string | null;
  enabled: boolean;
  pinned: boolean;
  audience: readonly AgentVendor[] | null;
}

export interface CapabilityUnit {
  id: string;
  label: string;
  single: boolean;
  audience: readonly AgentVendor[] | null;
  rows: readonly CapabilityRow[];
  enabled: number;
  pinned: number;
}

type CapabilitySectionId = "project" | "shared" | `vendor:${AgentVendor}`;

export interface CapabilitySection {
  id: CapabilitySectionId;
  label: string;
  secondary: boolean;
  units: readonly CapabilityUnit[];
  total: number;
  enabled: number;
  pinned: number;
}

interface RowShape {
  item: CapabilityItem;
  name: string;
  audience: readonly AgentVendor[] | null;
}

interface UnitShape {
  id: string;
  label: string;
  single: boolean;
  order: number;
  audience: readonly AgentVendor[] | null;
  rows: RowShape[];
}

interface SectionShape {
  id: CapabilitySectionId;
  label: string;
  secondary: boolean;
  units: UnitShape[];
}

const sameVendors = (a: readonly AgentVendor[], b: readonly AgentVendor[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function sectionOf(item: CapabilityItem, group: CapabilityGroup): CapabilitySectionId {
  if (group.source.kind === "project") return "project";
  return item.vendors.length === 1 ? `vendor:${item.vendors[0]!}` : "shared";
}

// A plugin's MCP servers and skills share one row; standalone MCP servers stay visible as their own rows.
function unitOf(item: CapabilityItem, group: CapabilityGroup): Pick<UnitShape, "id" | "label" | "single" | "order"> {
  const { source } = group;
  if (source.kind === "plugin") return { id: `plugin:${source.vendor}:${source.plugin}`, label: group.label, single: false, order: 2 };
  if (source.kind === "vendor_bundled") return { id: `bundled:${source.vendor}`, label: "Built-in", single: false, order: 3 };
  if (source.kind === "account") return { id: `account:${source.vendor}`, label: LIST_LABELS.connector, single: false, order: 4 };
  if (item.kind === "mcp") return { id: `item:${item.key}`, label: item.name, single: true, order: 0 };
  return { id: `${source.kind}:${item.kind}`, label: LIST_LABELS[item.kind], single: false, order: 1 };
}

// Claude namespaces plugin MCP servers as plugin:<plugin>:<server> and plugin skills as <plugin>:<skill>; the unit row names the plugin.
function rowName(item: CapabilityItem, group: CapabilityGroup): string {
  if (group.source.kind !== "plugin") return item.name;
  if (item.kind === "mcp") return item.name.replace(/^plugin:[^:]+:/, "");
  const prefix = `${group.label}:`;
  return item.name.length > prefix.length && item.name.startsWith(prefix) ? item.name.slice(prefix.length) : item.name;
}

function unionVendors(rows: readonly RowShape[]): readonly AgentVendor[] {
  const seen = new Set(rows.flatMap((r) => r.item.vendors));
  return AGENT_VENDORS.filter((v) => seen.has(v));
}

function finishUnit(unit: UnitShape, showsAudience: boolean): void {
  unit.rows.sort((a, b) => KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.name.localeCompare(b.name) || a.item.key.localeCompare(b.item.key));
  if (!showsAudience) return;
  const union = unionVendors(unit.rows);
  unit.audience = union.length < AGENT_VENDORS.length ? union : null;
  for (const row of unit.rows) row.audience = sameVendors(row.item.vendors, union) ? null : row.item.vendors;
}

function sectionRank(id: CapabilitySectionId, lead: AgentVendor | null): number {
  if (id === "project") return 0;
  if (id === "shared") return 1;
  const vendor = id.slice("vendor:".length) as AgentVendor;
  return vendor === lead ? 2 : 3 + AGENT_VENDORS.indexOf(vendor);
}

function sectionLabel(id: CapabilitySectionId): string {
  if (id === "project") return "This project";
  if (id === "shared") return "Shared";
  return vendorLabel(id.slice("vendor:".length));
}

function computeLayout(inventory: CapabilityInventory, lead: AgentVendor | null): readonly SectionShape[] {
  const items = new Map(inventory.items.map((item) => [item.key, item]));
  const sections = new Map<CapabilitySectionId, Map<string, UnitShape>>();
  for (const group of inventory.groups) {
    for (const key of group.itemKeys) {
      const item = items.get(key);
      if (item === undefined || item.vendors.length === 0) continue;
      const sectionId = sectionOf(item, group);
      const units = sections.get(sectionId) ?? new Map<string, UnitShape>();
      sections.set(sectionId, units);
      const shape = unitOf(item, group);
      const unit = units.get(shape.id) ?? { ...shape, audience: null, rows: [] };
      units.set(shape.id, unit);
      unit.rows.push({ item, name: rowName(item, group), audience: null });
    }
  }
  return [...sections]
    .sort(([a], [b]) => sectionRank(a, lead) - sectionRank(b, lead))
    .map(([id, units]) => {
      const list = [...units.values()];
      for (const unit of list) finishUnit(unit, id === "shared" || id === "project");
      list.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
      return { id, label: sectionLabel(id), secondary: lead !== null && sectionRank(id, lead) > 2, units: list };
    });
}

const layoutCache = new WeakMap<CapabilityInventory, Map<string, readonly SectionShape[]>>();

function capabilityLayout(inventory: CapabilityInventory, lead: AgentVendor | null): readonly SectionShape[] {
  let byLead = layoutCache.get(inventory);
  if (byLead === undefined) {
    byLead = new Map();
    layoutCache.set(inventory, byLead);
  }
  const hit = byLead.get(lead ?? "");
  if (hit !== undefined) return hit;
  const layout = computeLayout(inventory, lead);
  byLead.set(lead ?? "", layout);
  return layout;
}

type ViewState = Pick<CapabilitiesView, "inventory" | "policy" | "inheritance">;

function computeSections(view: ViewState, lead: AgentVendor | null): readonly CapabilitySection[] {
  const layer = view.inheritance?.layer ?? null;
  return capabilityLayout(view.inventory, lead).map((section) => {
    const units = section.units.map((unit): CapabilityUnit => {
      const rows = unit.rows.map(({ item, name, audience }): CapabilityRow => ({
        key: item.key,
        kind: item.kind,
        name,
        description: item.description,
        enabled: capabilityEnabled(view.policy, item.key),
        pinned: layer !== null && capabilityPinned(layer, item.key),
        audience,
      }));
      return { id: unit.id, label: unit.label, single: unit.single, audience: unit.audience, rows, ...countRows(rows) };
    });
    return { id: section.id, label: section.label, secondary: section.secondary, units, ...sumUnits(units) };
  });
}

function countRows(rows: readonly CapabilityRow[]): { enabled: number; pinned: number } {
  let enabled = 0;
  let pinned = 0;
  for (const row of rows) {
    if (row.enabled) enabled++;
    if (row.pinned) pinned++;
  }
  return { enabled, pinned };
}

function sumUnits(units: readonly CapabilityUnit[]): { total: number; enabled: number; pinned: number } {
  return units.reduce((sum, u) => ({ total: sum.total + u.rows.length, enabled: sum.enabled + u.enabled, pinned: sum.pinned + u.pinned }), { total: 0, enabled: 0, pinned: 0 });
}

const sectionsCache = new WeakMap<ViewState, Map<string, readonly CapabilitySection[]>>();

export function capabilitySections(view: ViewState, lead: AgentVendor | null = null): readonly CapabilitySection[] {
  let byLead = sectionsCache.get(view);
  if (byLead === undefined) {
    byLead = new Map();
    sectionsCache.set(view, byLead);
  }
  const hit = byLead.get(lead ?? "");
  if (hit !== undefined) return hit;
  const sections = computeSections(view, lead);
  byLead.set(lead ?? "", sections);
  return sections;
}

const rowMatches = (row: CapabilityRow, needle: string) =>
  row.name.toLowerCase().includes(needle) || row.key.toLowerCase().includes(needle) || (row.description?.toLowerCase().includes(needle) ?? false);

export function filterCapabilitySections(sections: readonly CapabilitySection[], query: string): readonly CapabilitySection[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return sections;
  return sections.flatMap((section) => {
    const units = section.units.flatMap((unit): CapabilityUnit[] => {
      const rows = unit.label.toLowerCase().includes(needle) ? unit.rows : unit.rows.filter((row) => rowMatches(row, needle));
      return rows.length === 0 ? [] : [rows === unit.rows ? unit : { ...unit, rows, ...countRows(rows) }];
    });
    return units.length === 0 ? [] : [{ ...section, units, ...sumUnits(units) }];
  });
}

export function capabilityTotals(sections: readonly CapabilitySection[]): { enabled: number; total: number; pinned: number } {
  return sumUnits(sections.flatMap((s) => s.units));
}

export function rowsPatches(rows: readonly CapabilityRow[], on: boolean): CapabilitiesPatch[] {
  const keys = rows.filter((row) => row.enabled !== on).map((row) => row.key);
  const patches: CapabilitiesPatch[] = [];
  for (let i = 0; i < keys.length; i += PM_CAPABILITY_PATCH_MAX_KEYS) {
    patches.push({ set: Object.fromEntries(keys.slice(i, i + PM_CAPABILITY_PATCH_MAX_KEYS).map((key) => [key, on])) });
  }
  return patches;
}

export function patchedView(view: CapabilitiesView, patch: CapabilitiesPatch): CapabilitiesView {
  if (view.inheritance === null) return { ...view, policy: applyCapabilitiesPatch(view.policy, patch) };
  const { defaults } = view.inheritance;
  const layer = applyCapabilityLayerPatch(defaults, view.inheritance.layer, patch);
  return { ...view, policy: layerCapabilityPolicy(defaults, layer), inheritance: { defaults, layer } };
}

export function resetView(view: CapabilitiesView): CapabilitiesView {
  if (view.inheritance === null) return view;
  const { defaults } = view.inheritance;
  return { ...view, policy: layerCapabilityPolicy(defaults, EMPTY_CAPABILITY_LAYER), inheritance: { defaults, layer: EMPTY_CAPABILITY_LAYER } };
}

export const capabilityCustomized = (view: Pick<CapabilitiesView, "inheritance">): boolean =>
  view.inheritance !== null && !capabilityLayerEmpty(view.inheritance.layer);

export const capabilitiesQueryKey = (scope: CapabilityScope) => ["capabilities", capabilityScopeKey(scope)] as const;

const CUSTOMIZED_CAPABILITIES_QUERY_KEY = ["capabilities", "customized"] as const;

const isScopeView = (query: Query, except: CapabilityScopeKey | null, onlyProjects: boolean) => {
  const [root, key] = query.queryKey;
  if (root !== "capabilities" || typeof key !== "string" || key === "customized" || key === except) return false;
  return !onlyProjects || key.startsWith("pm:");
};

function invalidateOtherViews(qc: QueryClient, except: CapabilityScopeKey, onlyProjects: boolean): void {
  void qc.invalidateQueries({ predicate: (query) => isScopeView(query, except, onlyProjects) });
}

export function useCapabilitiesView(scope: CapabilityScope) {
  const qc = useHubQueryClient();
  return useQuery({ queryKey: capabilitiesQueryKey(scope), queryFn: () => localClient.fetchCapabilities(scope) }, qc);
}

export function useCustomizedCapabilityPms(): readonly PmId[] | undefined {
  const qc = useHubQueryClient();
  return useQuery({ queryKey: CUSTOMIZED_CAPABILITIES_QUERY_KEY, queryFn: () => localClient.fetchCustomizedCapabilities(), select: (r) => r.pmIds }, qc).data;
}

type CapabilityEdit = { kind: "patch"; patch: CapabilitiesPatch } | { kind: "reset" };

function sendEdit(scope: CapabilityScope, edit: CapabilityEdit): Promise<CapabilitiesView> {
  if (edit.kind === "patch") return localClient.patchCapabilities(scope, edit.patch);
  if (scope.kind !== "pm") throw new RangeError("only a project can reset to Project defaults");
  return localClient.resetPmCapabilities(scope.pmId);
}

export function useCapabilityEditor(scope: CapabilityScope) {
  const qc = useHubQueryClient();
  const queryKey = capabilitiesQueryKey(scope);
  const scopeKey = capabilityScopeKey(scope);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const { mutate } = useMutation(
    {
      mutationKey: queryKey,
      // One queue per scope keeps edits ordered, so the last response carries every toggle.
      scope: { id: queryKey.join(":") },
      mutationFn: (edit: CapabilityEdit) => sendEdit(scope, edit),
      onMutate: async (edit: CapabilityEdit) => {
        generation.current++;
        setError(null);
        await qc.cancelQueries({ queryKey });
        qc.setQueryData<CapabilitiesView>(queryKey, (view) => view && (edit.kind === "patch" ? patchedView(view, edit.patch) : resetView(view)));
      },
      onSuccess: (view: CapabilitiesView) => {
        if (qc.isMutating({ mutationKey: queryKey }) <= 1) qc.setQueryData(queryKey, view);
        if (scope.kind === "default") invalidateOtherViews(qc, scopeKey, true);
        if (scope.kind === "pm") void qc.invalidateQueries({ queryKey: CUSTOMIZED_CAPABILITIES_QUERY_KEY });
      },
      onError: (err: unknown) => {
        setError(errorText(err));
        void qc.invalidateQueries({ queryKey });
      },
    },
    qc,
  );
  const apply = useCallback((patches: readonly CapabilitiesPatch[]) => patches.forEach((patch) => mutate({ kind: "patch", patch })), [mutate]);
  const reset = useCallback(() => mutate({ kind: "reset" }), [mutate]);
  const refresh = async () => {
    const startedAt = generation.current;
    setRefreshing(true);
    setError(null);
    try {
      const view = await localClient.fetchCapabilities(scope, { refresh: true });
      // A toggle made while the rescan ran is newer than this response, so refetch instead of writing it.
      if (generation.current === startedAt && qc.isMutating({ mutationKey: queryKey }) === 0) qc.setQueryData(queryKey, view);
      else void qc.invalidateQueries({ queryKey });
      invalidateOtherViews(qc, scopeKey, false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRefreshing(false);
    }
  };
  return { apply, reset, error, refreshing, refresh };
}
