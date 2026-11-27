import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledModelCatalog, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../shared/vendors.ts";
import { ensureFirstRunPm } from "./first-run-pm.ts";
import { createResolveFolder } from "./ledger/files.ts";
import { createLedger } from "./ledger/index.ts";
import { openTestDb } from "./store/test-helpers.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createFreshFixture(opts: {
  availability: (vendor: AgentVendor) => VendorAvailability;
  current?: (vendor: AgentVendor) => ModelCatalog | null;
}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "bellwood-first-run-pm-")));
  const dataHome = join(root, "state");
  mkdirSync(dataHome, { recursive: true });
  const db = openTestDb();
  const models = {
    list: async (): Promise<ModelCatalog[]> => [],
    availability: opts.availability,
    current: opts.current ?? (() => null),
  };
  const ledger = createLedger(db, {
    now: () => Date.parse("2026-11-28T00:00:00Z"),
    dataHome,
    pmHomeRoot: join(dataHome, "pm-home"),
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    osSandboxed: () => true,
    models,
  });
  cleanups.push(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const lines: string[] = [];
  return {
    ledger,
    models,
    lines,
    hasAnyPm: () => db.get("SELECT 1 AS x FROM pms LIMIT 1") !== undefined,
    log: (line: string) => lines.push(line),
  };
}

const agyOnly = (vendor: AgentVendor): VendorAvailability => (vendor === "agy" ? "available" : "not_installed");

describe("ensureFirstRunPm agent setting validation", () => {
  it("drops an unsupported agy effort suffix instead of throwing LedgerRequestError on first start", async () => {
    const f = createFreshFixture({ availability: agyOnly });
    const pm = await ensureFirstRunPm({
      ledger: f.ledger,
      models: f.models,
      hasAnyPm: f.hasAnyPm,
      defaultModel: "gpt-oss-120b-high",
      probeBudgetMs: 50,
      log: f.log,
    });
    expect(pm).not.toBeNull();
    expect(pm!.vendor).toBe("agy");
    expect(pm!.defaultModel).toBeNull();
    expect(pm!.effort).toBeNull();
    expect(f.lines.join("\n")).toContain("gpt-oss-120b-high");
    expect(f.lines.join("\n")).toContain("不能用");
  });

  it("validates AGENT_HUB_DEFAULT_MODEL against models.current(vendor) probed catalog", async () => {
    const probedAgy: ModelCatalog = {
      ...bundledModelCatalog("agy"),
      source: "vendor",
      availability: "available",
      models: [
        ...bundledModelCatalog("agy").models,
        { id: "dynamic-model", label: "Dynamic Model", description: null, efforts: ["low"] },
      ],
    };
    const f = createFreshFixture({
      availability: agyOnly,
      current: (vendor) => (vendor === "agy" ? probedAgy : null),
    });
    const pm = await ensureFirstRunPm({
      ledger: f.ledger,
      models: f.models,
      hasAnyPm: f.hasAnyPm,
      defaultModel: "dynamic-model-high",
      probeBudgetMs: 50,
      log: f.log,
    });
    expect(pm).not.toBeNull();
    expect(pm!.vendor).toBe("agy");
    expect(pm!.defaultModel).toBeNull();
    expect(pm!.effort).toBeNull();
    expect(f.lines.join("\n")).toContain("dynamic-model-high");
    expect(f.lines.join("\n")).toContain("不能用");
  });

  it("keeps a valid agy model with a supported effort suffix", async () => {
    const f = createFreshFixture({ availability: agyOnly });
    const pm = await ensureFirstRunPm({
      ledger: f.ledger,
      models: f.models,
      hasAnyPm: f.hasAnyPm,
      defaultModel: "gpt-oss-120b-medium",
      probeBudgetMs: 50,
      log: f.log,
    });
    expect(pm).not.toBeNull();
    expect(pm!.vendor).toBe("agy");
    expect(pm!.defaultModel).toBe("gpt-oss-120b");
    expect(pm!.effort).toBe("medium");
    expect(f.lines.join("\n")).not.toContain("不能用");
  });
});
