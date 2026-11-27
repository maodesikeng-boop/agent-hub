// End-to-end self-test for unified pnpm eval commands (harness, compare, scorecard).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { osSandboxAvailable } from "../../src/daemon/driver/write-scope.ts";
import { shortTmp } from "../e2e/harness.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";
import { buildInterleavedTrials, resolveCompareSelection } from "./cli.ts";
import { CAPABILITY_DIMENSIONS, type CapabilityScorecard, type EvalScenarioSpec } from "./product/types.ts";
import type { Summary } from "./report.ts";
import { SCENARIOS, scenarioById } from "./scenarios.ts";

const canSpawnWorkers = process.platform === "darwin" ? sandboxAllowsNestedSandbox() : osSandboxAvailable();

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const root = mkdtempSync(join(shortTmp(), "ah-evalcli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("pnpm eval unified CLI", { timeout: 180_000 }, () => {
  it("exits 0 for top-level --help and -h flags", () => {
    for (const flag of ["--help", "-h"]) {
      const r = spawnSync(process.execPath, [CLI, flag], { encoding: "utf8" });
      expect(r.status, `${flag}: ${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("pnpm eval harness");
      expect(r.stdout).toContain("--holdout-dir");
      expect(r.stdout).toContain("--require-gate");
    }
  });

  it("interleaves base and head trials per (scenario, trialIndex) and includes external holdout specs by default", () => {
    const holdoutDir = join(root, "holdout-unit");
    mkdirSync(holdoutDir, { recursive: true });
    const holdoutSpec: EvalScenarioSpec = {
      id: "holdout-orch-unit",
      title: "Holdout orchestration unit spec",
      dimension: "orchestration",
      tier: "replay",
      suite: "regression",
      split: "holdout",
      gateLevel: "rc_blocking",
      targetRole: "pm",
      entryPoints: ["daemon", "hub_cli"],
      minimumTrials: 3,
      triggers: ["src/daemon/prompt.ts"],
      checkIds: ["H1"],
    };
    writeFileSync(join(holdoutDir, "holdout-orch-unit.json"), JSON.stringify(holdoutSpec), "utf8");

    const defaultSelection = resolveCompareSelection({ holdoutDir });
    expect(defaultSelection.scenarios.map((s) => s.id)).toContain("holdout-orch-unit");
    expect(defaultSelection.scenarios.length).toBe(SCENARIOS.length + 1);
    expect(defaultSelection.evalSpecs.some((s) => s.id === "holdout-orch-unit" && s.split === "holdout")).toBe(true);

    const explicitSelection = resolveCompareSelection({ holdoutDir, requestedIds: ["holdout-orch-unit"] });
    expect(explicitSelection.scenarios.map((s) => s.id)).toEqual(["holdout-orch-unit"]);
    expect(explicitSelection.evalSpecs.map((s) => s.id)).toEqual(["holdout-orch-unit"]);

    const interleaved = buildInterleavedTrials({
      scenarios: [{ id: "s3a-tray" }, { id: "holdout-orch-unit" }],
      versions: [
        { label: "base", commit: "111", daemonMain: "/b" },
        { label: "head", commit: "222", daemonMain: "/h" },
      ],
      trialCount: 2,
      runDir: join(root, "plan-order"),
    });
    expect(interleaved.map((t) => `${t.scenario}:${t.version.label}:t${t.trialIndex}`)).toEqual([
      "s3a-tray:base:t0",
      "s3a-tray:head:t0",
      "s3a-tray:base:t1",
      "s3a-tray:head:t1",
      "holdout-orch-unit:base:t0",
      "holdout-orch-unit:head:t0",
      "holdout-orch-unit:base:t1",
      "holdout-orch-unit:head:t1",
    ]);
  });

  it("runs Tier 1 harness, writes baseline ledger, and renders scorecard", () => {
    const outFile = join(root, "tier1-report.md");
    const ledgerFile = join(root, "baseline.jsonl");
    const harness = spawnSync(
      process.execPath,
      [CLI, "harness", "--no-real-cli", "--out", outFile, "--ledger", ledgerFile],
      { encoding: "utf8" },
    );
    expect(harness.status, `${harness.stdout}\n${harness.stderr}`).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(existsSync(ledgerFile)).toBe(true);
    for (const dim of CAPABILITY_DIMENSIONS) {
      expect(harness.stdout).toContain(`| ${dim} |`);
    }
    expect(harness.stdout).toContain("Release Gate: `PASS`");

    const rendered = spawnSync(
      process.execPath,
      [CLI, "scorecard", "--ledger", ledgerFile, "--format", "terminal"],
      { encoding: "utf8" },
    );
    expect(rendered.status, `${rendered.stdout}\n${rendered.stderr}`).toBe(0);
    expect(rendered.stdout).toContain("Bellwood Product Capability Scorecard");
  });

  it("runs scripted compare across two refs and writes five-dimension scorecard.json and summary.md", () => {
    const kind = canSpawnWorkers ? "positive" : "nothing";
    const r = spawnSync(
      process.execPath,
      [CLI, "compare", "--base", "HEAD", "--head", "HEAD", "--scripted", kind, "--scenario", "s3a-tray", "--root", root],
      { encoding: "utf8" },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const [runId] = readdirSync(join(root, "runs"));
    const runDir = join(root, "runs", runId!);
    const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as Summary;
    const scorecard = JSON.parse(readFileSync(join(runDir, "scorecard.json"), "utf8")) as CapabilityScorecard;
    expect(summary.trials.map((t) => t.version).sort()).toEqual(["base", "head"]);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    expect(scorecard.dimensions).toHaveLength(5);
    // k=1 exploratory scripted run must not pass the multi-trial release gate.
    expect(scorecard.verdict).toBe("inconclusive");
    expect(scorecard.releaseGatePass).toBe(false);
    expect(r.stdout).toContain("Bellwood Product Capability Scorecard");
    if (kind === "positive") {
      const s3a = scenarioById("s3a-tray");
      const kindOf = (id: string) => s3a.checks.find((d) => d.id === id)?.kind;
      for (const t of summary.trials) {
        expect(t.checks.filter((c) => (kindOf(c.id) === undefined ? c.status !== "pass" : kindOf(c.id) === "guard" ? c.status === "fail" : false))).toEqual([]);
      }
    }
    expect(readdirSync(join(root, "v")).length).toBe(1);
  });

  it("runs compare with --holdout-dir and --scenario <holdout-id> without crashing and honors --require-gate", () => {
    const holdoutDir = join(root, "holdout-cli-e2e");
    const holdoutRoot = mkdtempSync(join(shortTmp(), "ah-eh-"));
    mkdirSync(holdoutDir, { recursive: true });
    try {
      const holdoutSpec: EvalScenarioSpec = {
        id: "holdout-orch-1",
        title: "Holdout PM orchestration check",
        dimension: "orchestration",
        tier: "replay",
        suite: "regression",
        split: "holdout",
        gateLevel: "rc_blocking",
        targetRole: "pm",
        entryPoints: ["daemon", "hub_cli"],
        minimumTrials: 3,
        triggers: ["src/daemon/prompt.ts"],
        checkIds: ["H1"],
      };
      writeFileSync(join(holdoutDir, "holdout-orch-1.json"), JSON.stringify(holdoutSpec), "utf8");

      const r = spawnSync(
        process.execPath,
        [
          CLI,
          "compare",
          "--base",
          "HEAD",
          "--head",
          "HEAD",
          "--scripted",
          "nothing",
          "--holdout-dir",
          holdoutDir,
          "--scenario",
          "holdout-orch-1",
          "--root",
          holdoutRoot,
          "--require-gate",
        ],
        { encoding: "utf8" },
      );
      // k=1 exploratory scripted run has releaseGatePass=false, so --require-gate exits 1 while producing a valid scorecard.
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      const [runId] = readdirSync(join(holdoutRoot, "runs"));
      const runDir = join(holdoutRoot, "runs", runId!);
      const scorecard = JSON.parse(readFileSync(join(runDir, "scorecard.json"), "utf8")) as CapabilityScorecard;
      expect(scorecard.scenarioAggregates.map((a) => a.scenarioId)).toEqual(["holdout-orch-1"]);
      expect(scorecard.scenarioAggregates[0]?.head?.split).toBe("holdout");
      expect(scorecard.verdict).toBe("inconclusive");
      expect(scorecard.releaseGatePass).toBe(false);
    } finally {
      rmSync(holdoutRoot, { recursive: true, force: true });
    }
  });
});
