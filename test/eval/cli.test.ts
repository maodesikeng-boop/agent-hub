// End-to-end self-test for unified pnpm eval commands (harness, compare, scorecard).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { osSandboxAvailable } from "../../src/daemon/driver/write-scope.ts";
import { shortTmp } from "../e2e/harness.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";
import { CAPABILITY_DIMENSIONS, type CapabilityScorecard } from "./product/types.ts";
import type { Summary } from "./report.ts";
import { scenarioById } from "./scenarios.ts";

const canSpawnWorkers = process.platform === "darwin" ? sandboxAllowsNestedSandbox() : osSandboxAvailable();

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const root = mkdtempSync(join(shortTmp(), "ah-evalcli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("pnpm eval unified CLI", { timeout: 180_000 }, () => {
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
});
