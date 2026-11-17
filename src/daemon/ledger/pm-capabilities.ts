// 项目经理的技能、MCP、云端连接器选择（pm_capability_policies、pm_capability_overrides，迁移 0033；docs/pm-capabilities-design.md）。
// 没有行的项目经理等于三类都是 all、没有单独设置；删项目经理时外键级联删掉。
// 改了选择发 pm.updated，驱动层在下一条消息前按 fingerprint 重启这个项目经理和它的 Worker。
import type { PmId } from "../../shared/domain.ts";
import { PM_CAPABILITY_OVERRIDES_MAX, PM_CAPABILITY_PATCH_MAX_KEYS } from "../../shared/limits.ts";
import {
  CAPABILITY_KINDS,
  applyCapabilitiesPatch,
  defaultPmCapabilityPolicy,
  isValidCapabilityKey,
  type CapabilityBase,
  type CapabilityKind,
  type PmCapabilitiesPatch,
  type PmCapabilitiesStart,
  type PmCapabilityPolicy,
} from "../../shared/pm-capabilities.ts";
import { fail, type LedgerContext } from "./context.ts";
import { toPm, type PmDbRow } from "./rows.ts";

export interface LedgerPmCapabilities {
  /** 后置：没存过返回 defaultPmCapabilityPolicy。项目经理不存在抛 not_found。 */
  get(pmId: PmId): PmCapabilityPolicy;
  /**
   * 后置：在一个事务里应用 patch（applyCapabilitiesPatch），返回改完的 policy。
   * set 超过 PM_CAPABILITY_PATCH_MAX_KEYS 项、改完 overrides 超过 PM_CAPABILITY_OVERRIDES_MAX 项时拒绝（invalid_input），什么都不改。
   */
  patch(pmId: PmId, patch: PmCapabilitiesPatch): PmCapabilityPolicy;
  /** 后置：新建项目经理时调。from 为 all 不写行；from 为 pm 时复制那个项目经理的 base 和 overrides，源项目经理不存在抛 not_found。 */
  init(pmId: PmId, start: PmCapabilitiesStart): void;
}

interface PolicyDbRow {
  kind: CapabilityKind;
  base: CapabilityBase;
}

interface OverrideDbRow {
  item_key: string;
  enabled: number;
}

function isCapabilityKind(value: string): value is CapabilityKind {
  return value === "skill" || value === "mcp" || value === "connector";
}

export function createLedgerPmCapabilities(ctx: LedgerContext): LedgerPmCapabilities {
  const { db, now, write } = ctx;

  const requirePm = (pmId: PmId): PmDbRow => {
    const row =
      db.get<PmDbRow>(
        "SELECT p.*, a.archived_at FROM pms p LEFT JOIN pm_archives a ON a.pm_id = p.id WHERE p.id = ?",
        pmId,
      ) ?? null;
    if (row === null) throw fail("not_found", `没有编号 ${pmId} 的项目经理`);
    return row;
  };

  const readPolicy = (pmId: PmId): PmCapabilityPolicy => {
    const base: Record<CapabilityKind, CapabilityBase> = { skill: "all", mcp: "all", connector: "all" };
    const policyRows = db.all<PolicyDbRow>(
      "SELECT kind, base FROM pm_capability_policies WHERE pm_id = ?",
      pmId,
    );
    for (const r of policyRows) {
      if (r.kind === "skill" || r.kind === "mcp" || r.kind === "connector") {
        base[r.kind] = r.base;
      }
    }
    const overrides: Record<string, boolean> = {};
    const overrideRows = db.all<OverrideDbRow>(
      "SELECT item_key, enabled FROM pm_capability_overrides WHERE pm_id = ? ORDER BY item_key ASC",
      pmId,
    );
    for (const r of overrideRows) {
      overrides[r.item_key] = r.enabled === 1;
    }
    return { pmId, base, overrides };
  };

  const persistPolicy = (pmId: PmId, policy: PmCapabilityPolicy, updatedAt: number): void => {
    for (const kind of CAPABILITY_KINDS) {
      const b = policy.base[kind];
      if (b === "all") {
        db.run("DELETE FROM pm_capability_policies WHERE pm_id = ? AND kind = ?", pmId, kind);
      } else {
        db.run(
          `INSERT INTO pm_capability_policies (pm_id, kind, base, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (pm_id, kind) DO UPDATE SET base = excluded.base, updated_at = excluded.updated_at`,
          pmId,
          kind,
          b,
          updatedAt,
        );
      }
    }
    db.run("DELETE FROM pm_capability_overrides WHERE pm_id = ?", pmId);
    for (const [key, enabled] of Object.entries(policy.overrides)) {
      db.run(
        "INSERT INTO pm_capability_overrides (pm_id, item_key, enabled, updated_at) VALUES (?, ?, ?, ?)",
        pmId,
        key,
        enabled ? 1 : 0,
        updatedAt,
      );
    }
  };

  return {
    get(pmId) {
      requirePm(pmId);
      const hasPolicy =
        db.get("SELECT 1 AS x FROM pm_capability_policies WHERE pm_id = ? LIMIT 1", pmId) !== undefined ||
        db.get("SELECT 1 AS x FROM pm_capability_overrides WHERE pm_id = ? LIMIT 1", pmId) !== undefined;
      if (!hasPolicy) return defaultPmCapabilityPolicy(pmId);
      return readPolicy(pmId);
    },

    patch(pmId, patch) {
      if (patch.set !== undefined) {
        const keys = Object.keys(patch.set);
        if (keys.length > PM_CAPABILITY_PATCH_MAX_KEYS) {
          throw fail("invalid", `一次最多修改 ${PM_CAPABILITY_PATCH_MAX_KEYS} 项`);
        }
        for (const k of keys) {
          if (!isValidCapabilityKey(k)) {
            throw fail("invalid", `不合法的能力键：${k}`);
          }
        }
      }
      if (patch.base !== undefined) {
        for (const [k, v] of Object.entries(patch.base)) {
          if (!isCapabilityKind(k) || (v !== "all" && v !== "none")) {
            throw fail("invalid", `不合法的默认开关：${k}`);
          }
        }
      }

      return write((p) => {
        const pm = requirePm(pmId);
        const current = readPolicy(pmId);
        const next = applyCapabilitiesPatch(current, patch);
        if (Object.keys(next.overrides).length > PM_CAPABILITY_OVERRIDES_MAX) {
          throw fail("invalid", `单独设置最多 ${PM_CAPABILITY_OVERRIDES_MAX} 项`);
        }
        persistPolicy(pmId, next, now());
        p.changes.push({ type: "pm.updated", data: { pm: toPm(pm) } });
        return next;
      });
    },

    init(pmId, start) {
      db.transaction(() => {
        requirePm(pmId);
        if (start.from === "all") {
          db.run("DELETE FROM pm_capability_policies WHERE pm_id = ?", pmId);
          db.run("DELETE FROM pm_capability_overrides WHERE pm_id = ?", pmId);
          return;
        }
        requirePm(start.pmId);
        const src = readPolicy(start.pmId);
        persistPolicy(pmId, { pmId, base: src.base, overrides: src.overrides }, now());
      });
    },
  };
}
