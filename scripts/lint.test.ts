import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINT_BASELINE,
  LINT_CONFIG,
  LINT_TARGETS,
  baselineKeyOf,
  buildBaseline,
  evaluateLintDiagnostics,
  formatLintFailure,
  main,
  normalizeDiagnosticPath,
  readBaseline,
  type LintDiagnostic,
  type LintRunners,
} from "./lint.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

describe("scripts/lint.ts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes absolute, relative, and Windows backslash paths to repo-relative POSIX paths", () => {
    expect(normalizeDiagnosticPath("./src/web/App.tsx", REPO_ROOT)).toBe("src/web/App.tsx");
    expect(normalizeDiagnosticPath("src\\daemon\\entry.ts", REPO_ROOT)).toBe("src/daemon/entry.ts");
    expect(normalizeDiagnosticPath(join(REPO_ROOT, "scripts", "lint.ts"), REPO_ROOT)).toBe("scripts/lint.ts");
  });

  it("blocks new violations on clean files, allows <= baseline on legacy files, and blocks +1 on legacy files", () => {
    const baseline = { [baselineKeyOf("src/legacy.ts", "eslint(no-unused-vars)")]: 1 };
    const cleanDiag: LintDiagnostic = {
      filename: "src/fresh.ts",
      code: "typescript(no-floating-promises)",
      severity: "error",
      message: "Promises must be awaited",
      labels: [{ span: { line: 4, column: 3 } }],
    };
    const legacyDiag: LintDiagnostic = {
      filename: "src/legacy.ts",
      code: "eslint(no-unused-vars)",
      severity: "error",
      message: "Unused var",
      labels: [{ span: { line: 2, column: 7 } }],
    };

    expect(evaluateLintDiagnostics([legacyDiag], baseline, REPO_ROOT).violations).toEqual([]);
    expect(evaluateLintDiagnostics([], baseline, REPO_ROOT).violations).toEqual([]);

    const addedClean = evaluateLintDiagnostics([cleanDiag], baseline, REPO_ROOT);
    expect(addedClean.violations.map((v) => v.key)).toEqual(["src/fresh.ts#typescript(no-floating-promises)"]);
    expect(formatLintFailure(addedClean, REPO_ROOT)).toContain("src/fresh.ts:4:3 [typescript(no-floating-promises)]");

    const grewLegacy = evaluateLintDiagnostics([legacyDiag, legacyDiag], baseline, REPO_ROOT);
    expect(grewLegacy.violations.map((v) => [v.found, v.allowed])).toEqual([[2, 1]]);
  });

  it("never lets tsconfig or parse errors pass via baseline", () => {
    const tsconfigErr: LintDiagnostic = {
      filename: "tsconfig.json",
      code: "typescript(tsconfig-error)",
      severity: "error",
      message: "Invalid tsconfig",
    };
    const evaluation = evaluateLintDiagnostics([tsconfigErr], { "tsconfig.json#typescript(tsconfig-error)": 5 }, REPO_ROOT);
    expect(evaluation.unbaselinable).toHaveLength(1);
    expect(() => buildBaseline([tsconfigErr], REPO_ROOT)).toThrow(/unbaselinable/);
  });

  it("stores a well-formed sorted baseline referencing .oxlintrc.json and valid targets", () => {
    expect(existsSync(join(REPO_ROOT, LINT_CONFIG))).toBe(true);
    for (const target of LINT_TARGETS) expect(existsSync(join(REPO_ROOT, target)), target).toBe(true);
    const baseline = readBaseline(join(REPO_ROOT, LINT_BASELINE));
    const keys = Object.keys(baseline);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const [key, count] of Object.entries(baseline)) {
      expect(key).toMatch(/^[^#]+#[^#]+$/);
      expect(key.startsWith("scripts/lint."), key).toBe(false);
      expect(Number.isInteger(count) && count > 0, key).toBe(true);
    }
  });

  it("loads .oxlintrc.json and catches real violations on a temporary file", () => {
    const oxlintBin = join(REPO_ROOT, "node_modules", "oxlint", "bin", "oxlint");
    expect(existsSync(oxlintBin), "oxlint binary must be installed").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "lint-smoke-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const badFile = join(dir, "bad.ts");
    const goodFile = join(dir, "good.ts");
    writeFileSync(badFile, "export function f(x: number): boolean { return x == 1; }\n", "utf8");
    writeFileSync(goodFile, "export function f(x: number): boolean { return x === 1; }\n", "utf8");

    const bad = spawnSync(process.execPath, [oxlintBin, "-c", join(REPO_ROOT, LINT_CONFIG), "-f", "json", badFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(bad.error).toBeUndefined();
    const badReport = JSON.parse(bad.stdout) as { diagnostics: LintDiagnostic[] };
    expect(badReport.diagnostics.some((d) => d.code === "eslint(eqeqeq)")).toBe(true);

    const good = spawnSync(process.execPath, [oxlintBin, "-c", join(REPO_ROOT, LINT_CONFIG), "-f", "json", goodFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(good.status).toBe(0);
    const goodReport = JSON.parse(good.stdout) as { diagnostics: LintDiagnostic[] };
    expect(goodReport.diagnostics).toEqual([]);
  });

  it("fails a full lint when knip fails even with clean oxlint output, and skips knip for explicit targets", () => {
    const root = mkdtempSync(join(tmpdir(), "lint-knip-"));
    dirs.push(root);
    const knipRuns: string[] = [];
    const runners = (knipStatus: number): LintRunners => ({
      oxlint: () => ({ report: { diagnostics: [] }, stderr: "" }),
      knip: (repoRoot) => {
        knipRuns.push(repoRoot);
        return knipStatus;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(main([], root, runners(1))).toBe(1);
      expect(knipRuns).toEqual([root]);
      expect(main([], root, runners(0))).toBe(0);
      expect(knipRuns).toHaveLength(2);
      expect(main(["src/web"], root, runners(1))).toBe(0);
      expect(knipRuns).toHaveLength(2);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });
});
