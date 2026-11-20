import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { PmId } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { PM_CAPABILITY_OVERRIDES_MAX, PM_CAPABILITY_PATCH_MAX_KEYS } from "../../shared/limits.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedgerContext, type LedgerContext } from "./context.ts";
import { createLedger } from "./ledger.ts";
import { createLedgerPmCapabilities, type LedgerPmCapabilities } from "./pm-capabilities.ts";

let db: Db;
let now: number;
let ctx: LedgerContext;
let caps: LedgerPmCapabilities;
let changes: Change[];

function insertPm(name: string): PmId {
  const res = db.run(
    "INSERT INTO pms (name, mode, vendor, persona, created_at) VALUES (?, 'manage_only', 'claude', '', ?)",
    name,
    now,
  );
  return res.lastInsertRowid;
}

beforeEach(() => {
  db = openTestDb();
  now = 50_000;
  ctx = createLedgerContext(db, { now: () => now, initialSeq: 1 });
  changes = [];
  ctx.subscribe(ctx.changeListeners, (change) => changes.push(change));
  caps = createLedgerPmCapabilities(ctx);
});

afterEach(() => {
  db.close();
});

const pm = (pmId: PmId) => ({ kind: "pm", pmId }) as const;
const DEFAULTS = { kind: "default" } as const;
const ALL_ON = { base: { skill: "all", mcp: "all", connector: "all" }, overrides: {} };
const count = (sql: string, ...args: number[]) => db.get<{ c: number }>(sql, ...args)?.c;

describe("createLedgerPmCapabilities", () => {
  it("没存过的项目经理继承 Project defaults（出厂全开），特例层是空的", () => {
    const pmId = insertPm("小林");
    expect(caps.getCapabilities(pm(pmId))).toEqual({ policy: ALL_ON, inheritance: { defaults: ALL_ON, layer: { base: {}, overrides: {} } } });
    expect(caps.getPmCapabilityPolicy(pmId)).toEqual(ALL_ON);
    expect(caps.getCapabilities(DEFAULTS)).toEqual({ policy: ALL_ON, inheritance: null });
    expect(() => caps.getCapabilities(pm(999_999))).toThrowError(LedgerRequestError);
    expect(() => caps.getPmCapabilityPolicy(999_999)).toThrowError(LedgerRequestError);
  });

  it("改 Project defaults：没钉住的项目跟着变，项目自己的特例照旧", () => {
    const follower = insertPm("跟默认");
    const pinned = insertPm("钉住");
    caps.patchCapabilities(pm(pinned), { set: { "mcp:codegraph": false } });
    changes.length = 0;
    const next = caps.patchCapabilities(DEFAULTS, { set: { "mcp:codegraph": false, "skill:aws-auth": false } });
    expect(next).toEqual({ policy: { ...ALL_ON, overrides: { "mcp:codegraph": false, "skill:aws-auth": false } }, inheritance: null });
    expect(count("SELECT count(*) AS c FROM default_capability_overrides")).toBe(2);
    expect(changes).toEqual([]);
    expect(caps.getPmCapabilityPolicy(follower).overrides).toEqual({ "mcp:codegraph": false, "skill:aws-auth": false });

    caps.patchCapabilities(DEFAULTS, { set: { "mcp:codegraph": true } });
    expect(caps.getPmCapabilityPolicy(follower).overrides).toEqual({ "skill:aws-auth": false });
    expect(caps.getPmCapabilityPolicy(pinned).overrides).toEqual({ "mcp:codegraph": false, "skill:aws-auth": false });
  });

  it("项目只存和继承值不同的特例；拨回继承值就删掉这一行", () => {
    const pmId = insertPm("小林");
    caps.patchCapabilities(DEFAULTS, { set: { "mcp:linear": false } });
    const patched = caps.patchCapabilities(pm(pmId), { set: { "skill:aws-auth": false, "mcp:linear": false, "mcp:codegraph": true } });
    expect(patched.inheritance?.layer).toEqual({ base: {}, overrides: { "skill:aws-auth": false } });
    expect(patched.policy.overrides).toEqual({ "mcp:linear": false, "skill:aws-auth": false });
    expect(count("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", pmId)).toBe(1);

    const back = caps.patchCapabilities(pm(pmId), { set: { "skill:aws-auth": true, "mcp:linear": true } });
    expect(back.inheritance?.layer).toEqual({ base: {}, overrides: { "mcp:linear": true } });
    expect(back.policy).toEqual(ALL_ON);
  });

  it("老版本存下的整类开关和单项照旧生效，读出来算项目自己的特例", () => {
    const pmId = insertPm("老项目");
    db.run("INSERT INTO pm_capability_policies (pm_id, kind, base, updated_at) VALUES (?, 'mcp', 'none', 1)", pmId);
    db.run("INSERT INTO pm_capability_overrides (pm_id, item_key, enabled, updated_at) VALUES (?, 'mcp:codegraph', 1, 1)", pmId);
    db.run("INSERT INTO pm_capability_overrides (pm_id, item_key, enabled, updated_at) VALUES (?, 'skill:aws-auth', 0, 1)", pmId);
    caps.patchCapabilities(DEFAULTS, { set: { "mcp:linear": true, "skill:verify": false } });
    expect(caps.getPmCapabilityPolicy(pmId)).toEqual({
      base: { skill: "all", mcp: "none", connector: "all" },
      overrides: { "mcp:codegraph": true, "skill:aws-auth": false, "skill:verify": false },
    });
    expect(caps.customizedCapabilityPms()).toEqual([pmId]);
  });

  it("Reset 清空项目的特例回到继承，发 pm.updated；有特例的项目列表跟着变", () => {
    const a = insertPm("甲");
    const b = insertPm("乙");
    caps.patchCapabilities(pm(b), { set: { "skill:x": false } });
    caps.patchCapabilities(pm(a), { set: { "mcp:y": false } });
    expect(caps.customizedCapabilityPms()).toEqual([a, b]);
    changes.length = 0;
    expect(caps.resetPmCapabilities(a)).toEqual({ policy: ALL_ON, inheritance: { defaults: ALL_ON, layer: { base: {}, overrides: {} } } });
    expect(count("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", a)).toBe(0);
    expect(changes.map((c) => c.type)).toEqual(["pm.updated"]);
    expect(caps.customizedCapabilityPms()).toEqual([b]);
    expect(() => caps.resetPmCapabilities(999_999)).toThrowError(LedgerRequestError);
  });

  it("set 超过 PM_CAPABILITY_PATCH_MAX_KEYS 项时拒绝且不改", () => {
    const pmId = insertPm("小林");
    caps.patchCapabilities(pm(pmId), { set: { "skill:keep": false } });
    const tooMany = Object.fromEntries(Array.from({ length: PM_CAPABILITY_PATCH_MAX_KEYS + 1 }, (_, i) => [`skill:k-${i}`, false]));
    expect(() => caps.patchCapabilities(pm(pmId), { set: tooMany })).toThrowError(LedgerRequestError);
    expect(() => caps.patchCapabilities(DEFAULTS, { set: tooMany })).toThrowError(LedgerRequestError);
    expect(() => caps.patchCapabilities(DEFAULTS, { set: { "bad key": false } })).toThrowError(LedgerRequestError);
    expect(caps.getCapabilities(pm(pmId)).inheritance?.layer.overrides).toEqual({ "skill:keep": false });
  });

  it.each([
    ["项目", (pmId: PmId) => pm(pmId)],
    ["Project defaults", () => DEFAULTS],
  ] as const)("%s 的单独设置超过 PM_CAPABILITY_OVERRIDES_MAX 项时拒绝且不改", (_, scopeOf) => {
    const scope = scopeOf(insertPm("小林"));
    const stored = () => Object.keys(scope.kind === "pm" ? caps.getCapabilities(scope).inheritance!.layer.overrides : caps.getCapabilities(scope).policy.overrides);
    for (let b = 0; b < PM_CAPABILITY_OVERRIDES_MAX / PM_CAPABILITY_PATCH_MAX_KEYS; b++) {
      const keys = Array.from({ length: PM_CAPABILITY_PATCH_MAX_KEYS }, (_, i) => `skill:item-${b * PM_CAPABILITY_PATCH_MAX_KEYS + i}`);
      caps.patchCapabilities(scope, { set: Object.fromEntries(keys.map((key) => [key, false])) });
    }
    expect(stored()).toHaveLength(PM_CAPABILITY_OVERRIDES_MAX);
    expect(() => caps.patchCapabilities(scope, { set: { "skill:overflow-item": false } })).toThrowError(LedgerRequestError);
    expect(stored()).toHaveLength(PM_CAPABILITY_OVERRIDES_MAX);
  });

  it("init 新项目默认继承 Project defaults，也能从别的项目复制它的特例", () => {
    const srcId = insertPm("源PM");
    caps.patchCapabilities(pm(srcId), { set: { "skill:aws-auth": false, "connector:claude:claude.ai Gmail": false } });
    db.run("INSERT INTO pm_capability_policies (pm_id, kind, base, updated_at) VALUES (?, 'mcp', 'none', 1)", srcId);

    const inherit = insertPm("继承PM");
    caps.init(inherit, { from: "default" });
    expect(caps.customizedCapabilityPms()).toEqual([srcId]);

    const dstCopy = insertPm("复制PM");
    caps.init(dstCopy, { from: "pm", pmId: srcId });
    expect(caps.getCapabilities(pm(dstCopy)).inheritance?.layer).toEqual({
      base: { mcp: "none" },
      overrides: { "connector:claude:claude.ai Gmail": false, "skill:aws-auth": false },
    });

    const dstBad = insertPm("坏源PM");
    expect(() => caps.init(dstBad, { from: "pm", pmId: 888_888 })).toThrowError(LedgerRequestError);
  });

  it("删除项目经理时它的特例一起删掉", () => {
    const pmId = insertPm("小林");
    caps.patchCapabilities(pm(pmId), { set: { "skill:aws-auth": false } });
    db.run("INSERT INTO pm_capability_policies (pm_id, kind, base, updated_at) VALUES (?, 'mcp', 'none', 1)", pmId);
    db.run("DELETE FROM pms WHERE id = ?", pmId);
    expect(count("SELECT count(*) AS c FROM pm_capability_policies WHERE pm_id = ?", pmId)).toBe(0);
    expect(count("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", pmId)).toBe(0);
  });

  it("项目 patch 发 pm.updated", () => {
    const pmId = insertPm("小林");
    changes.length = 0;
    caps.patchCapabilities(pm(pmId), { set: { "mcp:codegraph": false } });
    expect(changes).toEqual([{ seq: expect.any(Number), type: "pm.updated", data: { pm: expect.objectContaining({ id: pmId, name: "小林" }) } }]);
  });
});

describe("createLedger 集成：createPm 继承或复制、getPmCapabilityPolicy、patchCapabilities、pmProjectMainFolder", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ledger-pmcap-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("createPm 默认继承 Project defaults，支持从已有 PM 复制特例；源 PM 不存在时抛 not_found 且不留目录", () => {
    const projDir = join(workDir, "repo");
    mkdirSync(projDir, { recursive: true });
    const realProjDir = realpathSync.native(projDir);
    const dataHome = join(workDir, "data");
    const pmHomeRoot = join(dataHome, "pm-home");
    const ledger = createLedger(db, { now: () => now, pmHomeRoot });
    try {
      const src = ledger.createPm({ name: "源经理", mode: "manage_only", persona: "", folder: projDir });
      expect(ledger.pmProjectMainFolder(src.pm.id)).toBe(realProjDir);
      expect(ledger.getPmCapabilityPolicy(src.pm.id)).toEqual({
        base: { skill: "all", mcp: "all", connector: "all" },
        overrides: {},
      });

      ledger.patchCapabilities({ kind: "default" }, { set: { "mcp:codegraph": false } });
      ledger.patchCapabilities({ kind: "pm", pmId: src.pm.id }, { set: { "skill:aws-auth": false, "mcp:codegraph": true } });

      const copied = ledger.createPm({
        name: "复制经理",
        mode: "hands_on",
        persona: "",
        capabilities: { from: "pm", pmId: src.pm.id },
      });
      expect(ledger.pmProjectMainFolder(copied.pm.id)).toBeNull();
      expect(ledger.getPmCapabilityPolicy(copied.pm.id)).toEqual({
        base: { skill: "all", mcp: "all", connector: "all" },
        overrides: { "skill:aws-auth": false },
      });

      const inherit = ledger.createPm({
        name: "继承经理",
        mode: "manage_only",
        persona: "",
        capabilities: { from: "default" },
      });
      expect(ledger.getPmCapabilityPolicy(inherit.pm.id).overrides).toEqual({ "mcp:codegraph": false });
      expect(ledger.customizedCapabilityPms()).toEqual([src.pm.id, copied.pm.id]);

      const countBefore = db.get<{ c: number }>("SELECT count(*) AS c FROM pms")!.c;
      expect(() =>
        ledger.createPm({
          name: "坏复制",
          mode: "manage_only",
          persona: "",
          capabilities: { from: "pm", pmId: 999_999 },
        }),
      ).toThrowError(LedgerRequestError);
      expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pms")!.c).toBe(countBefore);
      expect(existsSync(join(pmHomeRoot, String(countBefore + 1)))).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
