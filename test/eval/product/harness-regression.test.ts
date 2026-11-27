import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  FAKE_CLAUDE,
  ROUTER,
  buildCompareSandboxInput,
  pmSandboxProfile,
  readDenyProbes,
} from "../isolation.ts";
import { extractScaleSafeFacts } from "./catalog.ts";
import { runTier1Harness } from "./harness.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "bellwood-harness-reg-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("Tier 1 harness real src/ paths, scale window ordering, and sandbox holdout denial", () => {
  it("runs Tier 1 harness through real Router Track A, resident prompt/persona, and first_message ACP driver paths without cloned baseTrials", { timeout: 60_000 }, async () => {
    const result = await runTier1Harness({ probeRealClis: false, runId: "reg-tier1" });

    expect(result.scorecard.verdict).toBe("pass");
    expect(result.scorecard.releaseGatePass).toBe(true);
    expect(result.scorecard.baseRef).toBe("absolute-gate");
    expect(result.scorecard.scenarioAggregates.every((a) => a.base === null && a.head?.status === "pass")).toBe(true);

    const byId = new Map(result.trials.map((t) => [t.scenarioId, t]));
    const rt = byId.get("route-track-a-mention")!;
    expect(rt.checks.find((c) => c.id === "RT1")?.reason).toContain("track=A");
    expect(rt.checks.find((c) => c.id === "RT1")?.reason).toContain("driverCalls=0/0");
    expect(rt.checks.find((c) => c.id === "RT2")?.reason).toContain("receiptStatus=dispatched");

    const efRes = byId.get("eff-prefix-stability-resident")!;
    expect(efRes.checks.find((c) => c.id === "EF1")?.reason).toContain("personaInjected=true");
    expect(efRes.checks.find((c) => c.id === "EF1")?.reason).toContain("rebakeCaughtTurn=1");

    const efFirst = byId.get("eff-prefix-stability-first-message")!;
    expect(efFirst.checks.find((c) => c.id === "EF3")?.reason).toContain("acpTurns=2");
    expect(efFirst.checks.find((c) => c.id === "EF3")?.reason).toContain("t1HasSystem=true");
    expect(efFirst.checks.find((c) => c.id === "EF3")?.reason).toContain("t2NoReinject=true");
    expect(efFirst.checks.find((c) => c.id === "EF3")?.reason).toContain("t2HasPersona=true");

    expect(result.scaleBenchmark.runs).toBe(5);
    expect(result.scaleBenchmark.scanMinMs).toBeLessThanOrEqual(result.scaleBenchmark.scanDurationMs);
    expect(result.scaleBenchmark.scanDurationMs).toBeLessThanOrEqual(result.scaleBenchmark.scanMaxMs);
  });

  it("scans the latest messages window (ORDER BY id DESC LIMIT ?) in extractScaleSafeFacts", () => {
    const dbFile = join(tempRoot, "latest-window.sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, meta TEXT);");
      const ins = db.prepare("INSERT INTO messages (meta) VALUES (?)");
      // Older corrupt row outside latest-3 window, followed by valid rows, followed by 2 latest corrupt rows.
      ins.run("{old-corrupt");
      ins.run('{"ok":true}');
      ins.run('{"ok":true}');
      ins.run("{latest-corrupt-1");
      ins.run("{latest-corrupt-2");
    } finally {
      db.close();
    }

    const facts = extractScaleSafeFacts({ dbFile, maxRows: 3 });
    expect(facts.messageCount).toBe(5);
    expect(facts.truncated).toBe(true);
    expect(facts.malformedMetaCount).toBe(2);
  });

  it("resolves isolation.ts module paths via fileURLToPath and denies --holdout-dir inside the real PM sandbox profile", () => {
    expect(isAbsolute(ROUTER)).toBe(true);
    expect(isAbsolute(FAKE_CLAUDE)).toBe(true);
    expect(existsSync(ROUTER)).toBe(true);
    expect(existsSync(FAKE_CLAUDE)).toBe(true);
    expect(ROUTER).not.toMatch(/^\/[A-Za-z]:/);
    expect(FAKE_CLAUDE).not.toMatch(/^\/[A-Za-z]:/);

    const holdoutDir = join(tempRoot, "secret-holdout");
    const runsDir = join(tempRoot, "eval-runs");
    mkdirSync(holdoutDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });

    const input = buildCompareSandboxInput(process.cwd(), process.env, { runsDir, holdoutDir });
    expect(input.readDenied).toContain(holdoutDir);
    const probes = readDenyProbes(input);
    expect(probes.some((p) => p.path === holdoutDir && !p.skip)).toBe(true);

    const profile = pmSandboxProfile(input);
    expect(profile).toContain(holdoutDir);
  });
});
