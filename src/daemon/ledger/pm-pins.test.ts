import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { PM_ARCHIVE_RETENTION_MS } from "../../shared/limits.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { PmId } from "../../shared/domain.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

let db: Db;
let home: string;
let ledger: SqliteLedger;
let now: number;
let pmId: PmId;
let changes: Change[];

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-pm-pins-"));
  now = 1_000;
  ledger = createLedger(db, { now: () => now, pmHomeRoot: home });
  pmId = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" }).pm.id;
  changes = [];
  ledger.onChange((c) => changes.push(c));
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("ledger.setPmPinned", () => {
  it("records pinnedAt on pin and returns the PM with it", () => {
    now = 5_000;
    const pm = ledger.setPmPinned(pmId, true);
    expect(pm.pinnedAt).toBe(5_000);
    expect(ledger.snapshot().pms.find((p) => p.id === pmId)?.pinnedAt).toBe(5_000);
  });

  it("keeps the first pinnedAt when an already pinned PM is pinned again, and emits nothing", () => {
    now = 2_500;
    expect(ledger.setPmPinned(pmId, true).pinnedAt).toBe(2_500);
    changes = [];
    now = 9_999;
    const again = ledger.setPmPinned(pmId, true);
    expect(again.pinnedAt).toBe(2_500);
    expect(changes).toEqual([]);
  });

  it("clears pinnedAt on unpin and emits nothing when the PM was not pinned", () => {
    expect(ledger.setPmPinned(pmId, false).pinnedAt).toBeNull();
    expect(changes).toEqual([]);

    now = 4_000;
    ledger.setPmPinned(pmId, true);
    changes = [];
    const unpinned = ledger.setPmPinned(pmId, false);
    expect(unpinned.pinnedAt).toBeNull();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "pm.updated", data: { pm: { id: pmId, pinnedAt: null } } });

    changes = [];
    expect(ledger.setPmPinned(pmId, false).pinnedAt).toBeNull();
    expect(changes).toEqual([]);
  });

  it("emits pm.updated with the new PM when the pin changes", () => {
    now = 7_777;
    const pinned = ledger.setPmPinned(pmId, true);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "pm.updated", data: { pm: { ...pinned, pinnedAt: 7_777 } } });
  });

  it("rejects an archived PM with conflict and an unknown PM with not_found", () => {
    expect(() => ledger.setPmPinned(999, true)).toThrowError(LedgerRequestError);
    try {
      ledger.setPmPinned(999, true);
    } catch (e) {
      expect((e as LedgerRequestError).code).toBe("not_found");
    }

    ledger.archivePm(pmId);
    changes = [];
    for (const pinned of [true, false]) {
      try {
        ledger.setPmPinned(pmId, pinned);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(LedgerRequestError);
        expect((e as LedgerRequestError).code).toBe("conflict");
      }
    }
    expect(changes.filter((c) => c.type === "pm.updated")).toEqual([]);
  });

  it("keeps the pin across archive and restore", () => {
    now = 3_000;
    ledger.setPmPinned(pmId, true);
    now = 4_000;
    const archived = ledger.archivePm(pmId);
    expect(archived.pinnedAt).toBe(3_000);
    now = 5_000;
    const restored = ledger.unarchivePm(pmId);
    expect(restored.pinnedAt).toBe(3_000);
    expect(ledger.snapshot().pms.find((p) => p.id === pmId)?.pinnedAt).toBe(3_000);
  });

  it("drops the pm_pins row when the archived PM is purged", () => {
    now = 3_000;
    ledger.setPmPinned(pmId, true);
    now = 4_000;
    ledger.archivePm(pmId);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pm_pins WHERE pm_id = ?", pmId)?.c).toBe(1);

    const purged = ledger.purgeExpiredArchivedPms(4_000 + PM_ARCHIVE_RETENTION_MS);
    expect(purged).toEqual([pmId]);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pm_pins WHERE pm_id = ?", pmId)?.c).toBe(0);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("returns pinnedAt null in the snapshot for PMs that were never pinned", () => {
    const pm = ledger.snapshot().pms.find((p) => p.id === pmId);
    expect(pm?.pinnedAt).toBeNull();
  });
});
