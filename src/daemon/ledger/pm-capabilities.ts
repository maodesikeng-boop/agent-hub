import type { PmId } from "../../shared/domain.ts";
import { PM_CAPABILITY_OVERRIDES_MAX, PM_CAPABILITY_PATCH_MAX_KEYS } from "../../shared/limits.ts";
import {
  CAPABILITY_KINDS,
  applyCapabilitiesPatch,
  defaultCapabilityPolicy,
  isValidCapabilityKey,
  type CapabilitiesPatch,
  type CapabilityBase,
  type CapabilityKind,
  type CapabilityPolicy,
  type PmCapabilitiesStart,
} from "../../shared/pm-capabilities.ts";
import { fail, type LedgerContext } from "./context.ts";
import { PM_SELECT, toPm, type PmDbRow } from "./rows.ts";

export interface LedgerPmCapabilities {
  get(pmId: PmId): CapabilityPolicy;
  patch(pmId: PmId, patch: CapabilitiesPatch): CapabilityPolicy;
  assertStart(start: PmCapabilitiesStart): void;
  init(pmId: PmId, start: PmCapabilitiesStart): void;
  getRouter(): CapabilityPolicy;
  patchRouter(patch: CapabilitiesPatch): CapabilityPolicy;
}

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
  defaults: CapabilityPolicy;
}

const pmTables = (pmId: PmId): PolicyTables => ({
  policies: "pm_capability_policies",
  overrides: "pm_capability_overrides",
  where: "pm_id = ?",
  owner: [pmId],
  ownerColumn: ["pm_id"],
  defaults: defaultCapabilityPolicy("pm"),
});

const ROUTER_TABLES: PolicyTables = {
  policies: "router_capability_policies",
  overrides: "router_capability_overrides",
  where: "1 = 1",
  owner: [],
  ownerColumn: [],
  defaults: defaultCapabilityPolicy("router"),
};

function isCapabilityKind(value: string): value is CapabilityKind {
  return value === "skill" || value === "mcp" || value === "connector";
}

function validatePatch(patch: CapabilitiesPatch): void {
  if (patch.set !== undefined) {
    const keys = Object.keys(patch.set);
    if (keys.length > PM_CAPABILITY_PATCH_MAX_KEYS) throw fail("invalid", `一次最多修改 ${PM_CAPABILITY_PATCH_MAX_KEYS} 项`);
    for (const k of keys) {
      if (!isValidCapabilityKey(k)) throw fail("invalid", `不合法的能力键：${k}`);
    }
  }
  if (patch.base !== undefined) {
    for (const [k, v] of Object.entries(patch.base)) {
      if (!isCapabilityKind(k) || (v !== "all" && v !== "none")) throw fail("invalid", `不合法的默认开关：${k}`);
    }
  }
}

function readPolicy(db: LedgerContext["db"], t: PolicyTables): CapabilityPolicy {
  const base: Record<CapabilityKind, CapabilityBase> = { ...t.defaults.base };
  for (const r of db.all<PolicyDbRow>(`SELECT kind, base FROM ${t.policies} WHERE ${t.where}`, ...t.owner)) {
    if (isCapabilityKind(r.kind)) base[r.kind] = r.base;
  }
  const overrides: Record<string, boolean> = {};
  for (const r of db.all<OverrideDbRow>(`SELECT item_key, enabled FROM ${t.overrides} WHERE ${t.where} ORDER BY item_key ASC`, ...t.owner)) {
    overrides[r.item_key] = r.enabled === 1;
  }
  return { base, overrides };
}

function persistPolicy(db: LedgerContext["db"], t: PolicyTables, policy: CapabilityPolicy, updatedAt: number): void {
  const cols = [...t.ownerColumn, ""].join(", ");
  const marks = t.owner.map(() => "?, ").join("");
  const conflict = [...t.ownerColumn, "kind"].join(", ");
  for (const kind of CAPABILITY_KINDS) {
    if (policy.base[kind] === t.defaults.base[kind]) {
      db.run(`DELETE FROM ${t.policies} WHERE ${t.where} AND kind = ?`, ...t.owner, kind);
    } else {
      db.run(
        `INSERT INTO ${t.policies} (${cols}kind, base, updated_at) VALUES (${marks}?, ?, ?)
         ON CONFLICT (${conflict}) DO UPDATE SET base = excluded.base, updated_at = excluded.updated_at`,
        ...t.owner,
        kind,
        policy.base[kind],
        updatedAt,
      );
    }
  }
  db.run(`DELETE FROM ${t.overrides} WHERE ${t.where}`, ...t.owner);
  for (const [key, enabled] of Object.entries(policy.overrides)) {
    db.run(
      `INSERT INTO ${t.overrides} (${cols}item_key, enabled, updated_at) VALUES (${marks}?, ?, ?)`,
      ...t.owner,
      key,
      enabled ? 1 : 0,
      updatedAt,
    );
  }
}

function nextPolicy(db: LedgerContext["db"], t: PolicyTables, patch: CapabilitiesPatch): CapabilityPolicy {
  const next = applyCapabilitiesPatch(readPolicy(db, t), patch);
  if (Object.keys(next.overrides).length > PM_CAPABILITY_OVERRIDES_MAX) {
    throw fail("invalid", `单独设置最多 ${PM_CAPABILITY_OVERRIDES_MAX} 项`);
  }
  return next;
}

export function readPmCapabilityPolicy(db: LedgerContext["db"], pmId: PmId): CapabilityPolicy {
  return readPolicy(db, pmTables(pmId));
}

export function createLedgerPmCapabilities(ctx: LedgerContext): LedgerPmCapabilities {
  const { db, now, write } = ctx;

  const requirePm = (pmId: PmId): PmDbRow => {
    const row = db.get<PmDbRow>(`${PM_SELECT} WHERE p.id = ?`, pmId) ?? null;
    if (row === null) throw fail("not_found", `没有编号 ${pmId} 的项目经理`);
    return row;
  };

  return {
    get(pmId) {
      requirePm(pmId);
      return readPolicy(db, pmTables(pmId));
    },

    patch(pmId, patch) {
      validatePatch(patch);
      return write((p) => {
        const pm = requirePm(pmId);
        const tables = pmTables(pmId);
        const next = nextPolicy(db, tables, patch);
        persistPolicy(db, tables, next, now());
        p.changes.push({ type: "pm.updated", data: { pm: toPm(pm) } });
        return next;
      });
    },

    assertStart(start) {
      if (start.from === "pm") requirePm(start.pmId);
      else if (start.from !== "all") throw fail("invalid", "不合法的能力初始来源");
    },

    init(pmId, start) {
      db.transaction(() => {
        requirePm(pmId);
        if (start.from === "all") {
          persistPolicy(db, pmTables(pmId), defaultCapabilityPolicy("pm"), now());
          return;
        }
        requirePm(start.pmId);
        persistPolicy(db, pmTables(pmId), readPolicy(db, pmTables(start.pmId)), now());
      });
    },

    getRouter() {
      return readPolicy(db, ROUTER_TABLES);
    },

    patchRouter(patch) {
      validatePatch(patch);
      return db.transaction(() => {
        const next = nextPolicy(db, ROUTER_TABLES, patch);
        persistPolicy(db, ROUTER_TABLES, next, now());
        return next;
      });
    },
  };
}
