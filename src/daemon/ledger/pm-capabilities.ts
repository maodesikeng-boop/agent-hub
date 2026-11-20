import type { PmId } from "../../shared/domain.ts";
import { PM_CAPABILITY_OVERRIDES_MAX, PM_CAPABILITY_PATCH_MAX_KEYS } from "../../shared/limits.ts";
import {
  CAPABILITY_KINDS,
  EMPTY_CAPABILITY_LAYER,
  applyCapabilitiesPatch,
  applyCapabilityLayerPatch,
  defaultCapabilityPolicy,
  isValidCapabilityKey,
  layerCapabilityPolicy,
  type CapabilitiesPatch,
  type CapabilityBase,
  type CapabilityInheritance,
  type CapabilityKind,
  type CapabilityLayer,
  type CapabilityPolicy,
  type PmCapabilitiesStart,
  type ScopeCapabilities,
} from "../../shared/pm-capabilities.ts";
import type { Ledger } from "../../shared/ledger.ts";
import { fail, type LedgerContext } from "./context.ts";
import { PM_SELECT, toPm, type PmDbRow } from "./rows.ts";

export interface LedgerPmCapabilities
  extends Pick<Ledger, "getCapabilities" | "patchCapabilities" | "resetPmCapabilities" | "customizedCapabilityPms" | "getPmCapabilityPolicy" | "getRouterCapabilityPolicy"> {
  assertStart(start: PmCapabilitiesStart): void;
  init(pmId: PmId, start: PmCapabilitiesStart): void;
}

type Db = LedgerContext["db"];

interface PolicyDbRow {
  kind: CapabilityKind;
  base: CapabilityBase;
}

interface OverrideDbRow {
  item_key: string;
  enabled: number;
}

interface PolicyTables {
  policies: string;
  overrides: string;
  where: string;
  owner: readonly number[];
  ownerColumn: readonly string[];
}

const pmTables = (pmId: PmId): PolicyTables => ({
  policies: "pm_capability_policies",
  overrides: "pm_capability_overrides",
  where: "pm_id = ?",
  owner: [pmId],
  ownerColumn: ["pm_id"],
});

const DEFAULT_TABLES: PolicyTables = {
  policies: "default_capability_policies",
  overrides: "default_capability_overrides",
  where: "1 = 1",
  owner: [],
  ownerColumn: [],
};

const ROUTER_TABLES: PolicyTables = {
  policies: "router_capability_policies",
  overrides: "router_capability_overrides",
  where: "1 = 1",
  owner: [],
  ownerColumn: [],
};

const SCOPE_TABLES = { default: DEFAULT_TABLES, router: ROUTER_TABLES } as const;

function isCapabilityKind(value: string): value is CapabilityKind {
  return value === "skill" || value === "mcp" || value === "connector";
}

function validatePatch(patch: CapabilitiesPatch): void {
  const keys = Object.keys(patch.set);
  if (keys.length > PM_CAPABILITY_PATCH_MAX_KEYS) throw fail("invalid", `一次最多修改 ${PM_CAPABILITY_PATCH_MAX_KEYS} 项`);
  for (const k of keys) {
    if (!isValidCapabilityKey(k)) throw fail("invalid", `不合法的能力键：${k}`);
  }
}

function assertOverridesFit(overrides: Readonly<Record<string, boolean>>): void {
  if (Object.keys(overrides).length > PM_CAPABILITY_OVERRIDES_MAX) throw fail("invalid", `单独设置最多 ${PM_CAPABILITY_OVERRIDES_MAX} 项`);
}

function readLayer(db: Db, t: PolicyTables): CapabilityLayer {
  const base: Partial<Record<CapabilityKind, CapabilityBase>> = {};
  for (const r of db.all<PolicyDbRow>(`SELECT kind, base FROM ${t.policies} WHERE ${t.where}`, ...t.owner)) {
    if (isCapabilityKind(r.kind)) base[r.kind] = r.base;
  }
  const overrides: Record<string, boolean> = {};
  for (const r of db.all<OverrideDbRow>(`SELECT item_key, enabled FROM ${t.overrides} WHERE ${t.where} ORDER BY item_key ASC`, ...t.owner)) {
    overrides[r.item_key] = r.enabled === 1;
  }
  return { base, overrides };
}

function persistLayer(db: Db, t: PolicyTables, layer: CapabilityLayer, updatedAt: number): void {
  const cols = [...t.ownerColumn, ""].join(", ");
  const marks = t.owner.map(() => "?, ").join("");
  db.run(`DELETE FROM ${t.policies} WHERE ${t.where}`, ...t.owner);
  for (const kind of CAPABILITY_KINDS) {
    const base = layer.base[kind];
    if (base !== undefined) db.run(`INSERT INTO ${t.policies} (${cols}kind, base, updated_at) VALUES (${marks}?, ?, ?)`, ...t.owner, kind, base, updatedAt);
  }
  db.run(`DELETE FROM ${t.overrides} WHERE ${t.where}`, ...t.owner);
  for (const [key, enabled] of Object.entries(layer.overrides)) {
    db.run(`INSERT INTO ${t.overrides} (${cols}item_key, enabled, updated_at) VALUES (${marks}?, ?, ?)`, ...t.owner, key, enabled ? 1 : 0, updatedAt);
  }
}

// Default and Router rows store only what differs from the scope's built-in policy.
function readScopePolicy(db: Db, scope: "default" | "router"): CapabilityPolicy {
  const fallback = defaultCapabilityPolicy(scope);
  const stored = readLayer(db, SCOPE_TABLES[scope]);
  return { base: { ...fallback.base, ...stored.base }, overrides: stored.overrides };
}

function persistScopePolicy(db: Db, scope: "default" | "router", policy: CapabilityPolicy, updatedAt: number): void {
  const fallback = defaultCapabilityPolicy(scope).base;
  const base = Object.fromEntries(CAPABILITY_KINDS.filter((kind) => policy.base[kind] !== fallback[kind]).map((kind) => [kind, policy.base[kind]]));
  persistLayer(db, SCOPE_TABLES[scope], { base, overrides: policy.overrides }, updatedAt);
}

function readPmInheritance(db: Db, pmId: PmId): CapabilityInheritance {
  return { defaults: readScopePolicy(db, "default"), layer: readLayer(db, pmTables(pmId)) };
}

export function readPmCapabilityPolicy(db: Db, pmId: PmId): CapabilityPolicy {
  const { defaults, layer } = readPmInheritance(db, pmId);
  return layerCapabilityPolicy(defaults, layer);
}

function pmCapabilities(db: Db, pmId: PmId): ScopeCapabilities {
  const inheritance = readPmInheritance(db, pmId);
  return { policy: layerCapabilityPolicy(inheritance.defaults, inheritance.layer), inheritance };
}

export function createLedgerPmCapabilities(ctx: LedgerContext): LedgerPmCapabilities {
  const { db, now, write } = ctx;

  const requirePm = (pmId: PmId): PmDbRow => {
    const row = db.get<PmDbRow>(`${PM_SELECT} WHERE p.id = ?`, pmId) ?? null;
    if (row === null) throw fail("not_found", `没有编号 ${pmId} 的项目经理`);
    return row;
  };

  const writePmLayer = (pmId: PmId, next: (inheritance: CapabilityInheritance) => CapabilityLayer): ScopeCapabilities =>
    write((p) => {
      const pm = requirePm(pmId);
      const layer = next(readPmInheritance(db, pmId));
      assertOverridesFit(layer.overrides);
      persistLayer(db, pmTables(pmId), layer, now());
      p.changes.push({ type: "pm.updated", data: { pm: toPm(pm) } });
      return pmCapabilities(db, pmId);
    });

  return {
    getCapabilities(scope) {
      if (scope.kind !== "pm") return { policy: readScopePolicy(db, scope.kind), inheritance: null };
      requirePm(scope.pmId);
      return pmCapabilities(db, scope.pmId);
    },

    patchCapabilities(scope, patch) {
      validatePatch(patch);
      if (scope.kind === "pm") return writePmLayer(scope.pmId, ({ defaults, layer }) => applyCapabilityLayerPatch(defaults, layer, patch));
      return db.transaction(() => {
        const policy = applyCapabilitiesPatch(readScopePolicy(db, scope.kind), patch);
        assertOverridesFit(policy.overrides);
        persistScopePolicy(db, scope.kind, policy, now());
        return { policy, inheritance: null };
      });
    },

    resetPmCapabilities(pmId) {
      return writePmLayer(pmId, () => EMPTY_CAPABILITY_LAYER);
    },

    customizedCapabilityPms() {
      return db
        .all<{ pm_id: number }>("SELECT pm_id FROM pm_capability_policies UNION SELECT pm_id FROM pm_capability_overrides ORDER BY pm_id ASC")
        .map((r) => r.pm_id);
    },

    getPmCapabilityPolicy(pmId) {
      requirePm(pmId);
      return readPmCapabilityPolicy(db, pmId);
    },

    getRouterCapabilityPolicy() {
      return readScopePolicy(db, "router");
    },

    assertStart(start) {
      if (start.from === "pm") requirePm(start.pmId);
      else if (start.from !== "default") throw fail("invalid", "不合法的能力初始来源");
    },

    init(pmId, start) {
      db.transaction(() => {
        requirePm(pmId);
        if (start.from === "default") {
          persistLayer(db, pmTables(pmId), EMPTY_CAPABILITY_LAYER, now());
          return;
        }
        requirePm(start.pmId);
        persistLayer(db, pmTables(pmId), readLayer(db, pmTables(start.pmId)), now());
      });
    },
  };
}
