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

describe("createLedgerPmCapabilities", () => {
  it("没存过的项目经理三类都是 all，没有单独设置", () => {
    const pmId = insertPm("小林");
    expect(caps.get(pmId)).toEqual({
      base: { skill: "all", mcp: "all", connector: "all" },
      overrides: {},
    });
    expect(() => caps.get(999_999)).toThrowError(LedgerRequestError);
  });

  it("patch 后再 get 得到同样的 policy", () => {
    const pmId = insertPm("小林");
    const patched = caps.patch(pmId, {
      base: { mcp: "none" },
      set: { "skill:aws-auth": false, "mcp:codegraph": true },
    });
    expect(patched).toEqual({
      base: { skill: "all", mcp: "none", connector: "all" },
      overrides: { "skill:aws-auth": false, "mcp:codegraph": true },
    });
    expect(caps.get(pmId)).toEqual(patched);
  });

  it("开关点开再点回来，库里不留这一项", () => {
    const pmId = insertPm("小林");
    caps.patch(pmId, { set: { "skill:aws-auth": false } });
    expect(
      db.get<{ c: number }>("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", pmId)?.c,
    ).toBe(1);

    const back = caps.patch(pmId, { set: { "skill:aws-auth": true } });
    expect(back.overrides).toEqual({});
    expect(
      db.get<{ c: number }>("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", pmId)?.c,
    ).toBe(0);
  });

  it("改 base 时去掉和新 base 相同的单独设置", () => {
    const pmId = insertPm("小林");
    caps.patch(pmId, { set: { "skill:a": false, "skill:b": false, "mcp:codegraph": false } });
    const next = caps.patch(pmId, { base: { skill: "none" } });
    expect(next.base.skill).toBe("none");
    expect(next.overrides).toEqual({ "mcp:codegraph": false });
    expect(
      db.get<{ c: number }>("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", pmId)?.c,
    ).toBe(1);
  });

  it("set 超过 PM_CAPABILITY_PATCH_MAX_KEYS 项时拒绝且不改", () => {
    const pmId = insertPm("小林");
    caps.patch(pmId, { set: { "skill:keep": false } });
    const tooMany = Object.fromEntries(
      Array.from({ length: PM_CAPABILITY_PATCH_MAX_KEYS + 1 }, (_, i) => [`skill:k-${i}`, false]),
    );
    expect(() => caps.patch(pmId, { set: tooMany })).toThrowError(LedgerRequestError);
    expect(caps.get(pmId).overrides).toEqual({ "skill:keep": false });
  });

  it("单独设置超过 PM_CAPABILITY_OVERRIDES_MAX 项时拒绝且不改", () => {
    const pmId = insertPm("小林");
    const batchCount = Math.floor(PM_CAPABILITY_OVERRIDES_MAX / PM_CAPABILITY_PATCH_MAX_KEYS);
    for (let b = 0; b < batchCount; b++) {
      const set = Object.fromEntries(
        Array.from({ length: PM_CAPABILITY_PATCH_MAX_KEYS }, (_, i) => [
          `skill:item-${b * PM_CAPABILITY_PATCH_MAX_KEYS + i}`,
          false,
        ]),
      );
      caps.patch(pmId, { set });
    }
    expect(Object.keys(caps.get(pmId).overrides)).toHaveLength(PM_CAPABILITY_OVERRIDES_MAX);

    expect(() => caps.patch(pmId, { set: { "skill:overflow-item": false } })).toThrowError(LedgerRequestError);
    expect(Object.keys(caps.get(pmId).overrides)).toHaveLength(PM_CAPABILITY_OVERRIDES_MAX);
  });

  it("init 从别的项目经理复制 base 和单独设置", () => {
    const srcId = insertPm("源PM");
    caps.patch(srcId, {
      base: { connector: "none" },
      set: { "skill:aws-auth": false, "connector:claude:claude.ai Gmail": true },
    });

    const dstAll = insertPm("默认全开PM");
    caps.init(dstAll, { from: "all" });
    expect(caps.get(dstAll).overrides).toEqual({});

    const dstCopy = insertPm("复制PM");
    caps.init(dstCopy, { from: "pm", pmId: srcId });
    expect(caps.get(dstCopy)).toEqual({
      base: { skill: "all", mcp: "all", connector: "none" },
      overrides: { "skill:aws-auth": false, "connector:claude:claude.ai Gmail": true },
    });

    const dstBad = insertPm("坏源PM");
    expect(() => caps.init(dstBad, { from: "pm", pmId: 888_888 })).toThrowError(LedgerRequestError);
  });

  it("删除项目经理时它的选择一起删掉", () => {
    const pmId = insertPm("小林");
    caps.patch(pmId, { base: { mcp: "none" }, set: { "skill:aws-auth": false } });
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pm_capability_policies WHERE pm_id = ?", pmId)?.c).toBe(1);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", pmId)?.c).toBe(1);

    db.run("DELETE FROM pms WHERE id = ?", pmId);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pm_capability_policies WHERE pm_id = ?", pmId)?.c).toBe(0);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pm_capability_overrides WHERE pm_id = ?", pmId)?.c).toBe(0);
  });

  it("patch 发 pm.updated", () => {
    const pmId = insertPm("小林");
    changes.length = 0;
    caps.patch(pmId, { set: { "mcp:codegraph": false } });
    expect(changes).toEqual([
      {
        seq: expect.any(Number),
        type: "pm.updated",
        data: {
          pm: expect.objectContaining({ id: pmId, name: "小林" }),
        },
      },
    ]);
  });
});

describe("createLedger 集成：createPm 复制、getPmCapabilityPolicy、patchPmCapabilities、pmProjectMainFolder", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ledger-pmcap-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("createPm 默认全开，支持从已有 PM 复制选择；源 PM 不存在时抛 not_found 且不留目录", () => {
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

      ledger.patchPmCapabilities(src.pm.id, {
        base: { mcp: "none" },
        set: { "skill:aws-auth": false, "mcp:codegraph": true },
      });

      const copied = ledger.createPm({
        name: "复制经理",
        mode: "hands_on",
        persona: "",
        capabilities: { from: "pm", pmId: src.pm.id },
      });
      expect(ledger.pmProjectMainFolder(copied.pm.id)).toBeNull();
      expect(ledger.getPmCapabilityPolicy(copied.pm.id)).toEqual({
        base: { skill: "all", mcp: "none", connector: "all" },
        overrides: { "skill:aws-auth": false, "mcp:codegraph": true },
      });

      const allOpen = ledger.createPm({
        name: "全开经理",
        mode: "manage_only",
        persona: "",
        capabilities: { from: "all" },
      });
      expect(ledger.getPmCapabilityPolicy(allOpen.pm.id).overrides).toEqual({});

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
