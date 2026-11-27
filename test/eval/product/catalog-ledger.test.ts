import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { SCENARIOS } from "../scenarios.ts";
import {
  extractScaleSafeFacts,
  listProductEvalScenarios,
  loadHoldoutScenarios,
  selectEvalScenarios,
} from "./catalog.ts";
import {
  appendBaselineEntry,
  readBaselineLedger,
  renderCapabilityReport,
} from "./ledger.ts";
import {
  PRODUCT_EVAL_HISTORY_MAX_RUNS,
  PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS,
  PRODUCT_EVAL_MAX_EVIDENCE_BYTES,
} from "./limits.ts";
import {
  CAPABILITY_DIMENSIONS,
  type BaselineEntry,
  type BaselineReadResult,
  type CapabilityScorecard,
  type EvalDimensionFacts,
  type EvalEntryPoint,
  type EvalScenarioSpec,
  type EvalSelectionFilter,
  type EvalTargetRole,
  type ScaleSafeFactsInput,
} from "./types.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "bellwood-product-eval-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

function makeScorecard(runId: string): CapabilityScorecard {
  return {
    schemaVersion: 1,
    runId,
    baseRef: "main",
    baseCommit: "11111111",
    headRef: "head",
    headCommit: "22222222",
    graderSha256Base: "sha-1",
    graderSha256Head: "sha-1",
    graderMatched: true,
    envErrorRate: 0,
    publicDelta: 0.05,
    holdoutDelta: 0.03,
    overfitGap: 0.02,
    dimensions: CAPABILITY_DIMENSIONS.map((dimension) => ({
      dimension,
      suite: "regression",
      basePassPowK: 1,
      headPassPowK: 1,
      basePassAtK: 1,
      headPassAtK: 1,
      cacheReadDelta: 0.01,
      turnDelta: 0,
      prefixRegressed: false,
      status: "pass",
      reasons: [],
    })),
    scenarioAggregates: [],
    verdict: "pass",
    releaseGatePass: true,
    reasons: [],
  };
}

describe("unified five-dimension scenario catalog and holdout loader", () => {
  it("covers all five dimensions, wraps every legacy orchestration scenario, and selects by changed paths", () => {
    const catalog: readonly EvalScenarioSpec[] = listProductEvalScenarios();
    for (const dimension of CAPABILITY_DIMENSIONS) {
      expect(catalog.some((s) => s.dimension === dimension)).toBe(true);
    }

    const wrappedLegacyIds = new Set(catalog.map((s) => s.legacyScenarioId).filter(Boolean));
    for (const legacy of SCENARIOS) {
      expect(wrappedLegacyIds.has(legacy.id)).toBe(true);
    }

    const entryPoints = new Set<EvalEntryPoint>(catalog.flatMap((s) => [...s.entryPoints]));
    expect(entryPoints.has("hub_cli")).toBe(true);
    expect(entryPoints.has("daemon")).toBe(true);

    const roles = new Set<EvalTargetRole>(catalog.map((s) => s.targetRole));
    expect(roles.has("router")).toBe(true);
    expect(roles.has("pm")).toBe(true);
    expect(roles.has("worker")).toBe(true);

    const filter: EvalSelectionFilter = { changedPaths: ["src/daemon/router/prompt.ts"] };
    const matched = selectEvalScenarios(filter, catalog);
    expect(matched.some((s) => s.dimension === "routing")).toBe(true);

    expect(() => selectEvalScenarios({ ids: ["does-not-exist"] }, catalog)).toThrow(/unknown scenario/i);
  });

  it("loads validated holdout scenarios from an external directory and rejects public or malformed specs", () => {
    const holdoutDir = join(tempRoot, "holdout-valid");
    const badDir = join(tempRoot, "holdout-bad");
    const validSpec: EvalScenarioSpec = {
      id: "holdout-routing-1",
      title: "Holdout cross-project routing",
      dimension: "routing",
      tier: "replay",
      suite: "regression",
      split: "holdout",
      gateLevel: "rc_blocking",
      targetRole: "router",
      entryPoints: ["web", "feishu", "mesh"],
      minimumTrials: 3,
      triggers: ["src/daemon/router/**"],
      checkIds: ["H1"],
    };
    mkdirSync(holdoutDir, { recursive: true });
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(holdoutDir, "h1.json"), JSON.stringify(validSpec));
    writeFileSync(join(badDir, "bad.json"), JSON.stringify({ ...validSpec, split: "public" }));

    const loaded = loadHoldoutScenarios(holdoutDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("holdout-routing-1");

    expect(() => loadHoldoutScenarios(badDir)).toThrow(/holdout/i);
  });
});

describe("scale-safe one-month fact extraction", () => {
  it("extracts bounded facts for 300 workers, 30,000 messages, and 50,000 step logs while tolerating malformed meta", () => {
    const dbFile = join(tempRoot, "one-month.sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(`
        CREATE TABLE workers (id INTEGER PRIMARY KEY, status TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, meta TEXT);
        CREATE TABLE session_steps (id INTEGER PRIMARY KEY, kind TEXT);
      `);
      db.exec("BEGIN");
      const insWorker = db.prepare("INSERT INTO workers (status) VALUES (?)");
      for (let i = 0; i < 300; i += 1) insWorker.run("done");
      const insMsg = db.prepare("INSERT INTO messages (meta) VALUES (?)");
      for (let i = 0; i < 29_998; i += 1) insMsg.run('{"ok":true}');
      insMsg.run("{corrupt-json");
      insMsg.run("not-json");
      const insStep = db.prepare("INSERT INTO session_steps (kind) VALUES (?)");
      for (let i = 0; i < 50_000; i += 1) insStep.run("turn_started");
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const input: ScaleSafeFactsInput = { dbFile, maxRows: PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS };
    const facts: EvalDimensionFacts = extractScaleSafeFacts(input);
    expect(facts.workerCount).toBe(300);
    expect(facts.messageCount).toBe(30_000);
    expect(facts.stepLogCount).toBe(50_000);
    expect(facts.malformedMetaCount).toBe(2);
    expect(facts.truncated).toBe(false);
  });
});

describe("baseline history ledger, restart recovery, and non-collapsed report rendering", () => {
  it("recovers from a torn trailing JSONL line, upgrades v0 entries, prunes to maxRuns, and renders five dimensions", () => {
    const ledgerFile = join(tempRoot, "baseline.jsonl");
    const e1: BaselineEntry = {
      schemaVersion: 1,
      recordedAt: "2026-11-26T00:00:00.000Z",
      scorecard: makeScorecard("20261126-000000"),
    };
    const e2: BaselineEntry = {
      schemaVersion: 1,
      recordedAt: "2026-11-27T00:00:00.000Z",
      scorecard: makeScorecard("20261127-000000"),
    };

    const legacyV0 = JSON.stringify({
      recordedAt: "2026-11-25T00:00:00.000Z",
      scorecard: { ...makeScorecard("20261125-000000"), schemaVersion: undefined },
    });
    // Simulate a crash leaving a half-written JSON line at EOF.
    writeFileSync(ledgerFile, `${legacyV0}\n${JSON.stringify(e1)}\n{"schemaVersion":1,"truncated":`);

    const recovered: BaselineReadResult = readBaselineLedger(ledgerFile);
    expect(recovered.entries).toHaveLength(2);
    expect(recovered.skippedMalformedLines).toBe(1);
    expect(recovered.upgradedLegacyLines).toBe(1);

    appendBaselineEntry(ledgerFile, e2, 2);
    const afterPrune = readBaselineLedger(ledgerFile);
    expect(afterPrune.entries).toHaveLength(2);
    expect(afterPrune.entries[1]?.scorecard.runId).toBe("20261127-000000");

    // Verify default retention cap constant is respected when pruning over 180 runs.
    const capFile = join(tempRoot, "baseline-cap.jsonl");
    for (let i = 0; i < PRODUCT_EVAL_HISTORY_MAX_RUNS + 5; i += 1) {
      appendBaselineEntry(capFile, {
        schemaVersion: 1,
        recordedAt: `2026-11-28T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        scorecard: makeScorecard(`run-${String(i).padStart(4, "0")}`),
      });
    }
    expect(readBaselineLedger(capFile).entries).toHaveLength(PRODUCT_EVAL_HISTORY_MAX_RUNS);

    const md = renderCapabilityReport(e2.scorecard, { format: "markdown" });
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(PRODUCT_EVAL_MAX_EVIDENCE_BYTES);
    for (const dimension of CAPABILITY_DIMENSIONS) {
      expect(md).toContain(dimension);
    }
    expect(md).not.toMatch(/total score/i);
  });
});
