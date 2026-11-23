import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./stage-runtime-common.ts";

export const LINT_CONFIG = ".oxlintrc.json";
export const LINT_BASELINE = ".oxlint-baseline.json";
export const LINT_TARGETS = ["src", "scripts", "test", "vite.config.ts", "vitest.config.ts", "vitest.eval.config.ts"] as const;

const OXLINT_BIN = ["node_modules", "oxlint", "bin", "oxlint"] as const;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const UNBASELINABLE_CODES = new Set(["typescript(tsconfig-error)", "parse"]);

export interface LintLabel {
  span?: { line?: number; column?: number };
}

export interface LintDiagnostic {
  message: string;
  code?: string;
  severity?: string;
  filename?: string;
  labels?: LintLabel[];
}

export interface LintReport {
  diagnostics: LintDiagnostic[];
  number_of_files?: number;
  number_of_rules?: number;
}

export type LintBaseline = Record<string, number>;

export interface LintViolation {
  key: string;
  file: string;
  code: string;
  found: number;
  allowed: number;
  diagnostics: LintDiagnostic[];
}

export interface LintEvaluation {
  violations: LintViolation[];
  unbaselinable: LintDiagnostic[];
}

export function normalizeDiagnosticPath(filename: string, repoRoot: string): string {
  const posix = isAbsolute(filename) ? relative(repoRoot, filename) : filename;
  return posix.split("\\").join("/").replace(/^\.\//, "");
}

export function baselineKeyOf(file: string, code: string): string {
  return `${file}#${code}`;
}

export function isUnbaselinable(diag: LintDiagnostic): boolean {
  return !diag.filename || !diag.code || UNBASELINABLE_CODES.has(diag.code);
}

export function countDiagnostics(
  diagnostics: readonly LintDiagnostic[],
  repoRoot: string,
): {
  counts: Map<string, { file: string; code: string; count: number; items: LintDiagnostic[] }>;
  unbaselinable: LintDiagnostic[];
} {
  const counts = new Map<string, { file: string; code: string; count: number; items: LintDiagnostic[] }>();
  const unbaselinable: LintDiagnostic[] = [];
  for (const diag of diagnostics) {
    if (isUnbaselinable(diag)) {
      unbaselinable.push(diag);
      continue;
    }
    const file = normalizeDiagnosticPath(diag.filename!, repoRoot);
    const code = diag.code!;
    const key = baselineKeyOf(file, code);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      existing.items.push(diag);
    } else {
      counts.set(key, { file, code, count: 1, items: [diag] });
    }
  }
  return { counts, unbaselinable };
}

export function buildBaseline(diagnostics: readonly LintDiagnostic[], repoRoot: string): LintBaseline {
  const { counts, unbaselinable } = countDiagnostics(diagnostics, repoRoot);
  if (unbaselinable.length > 0) {
    throw new Error(`Cannot record baseline with ${unbaselinable.length} unbaselinable error(s): ${unbaselinable[0]!.message}`);
  }
  const entries = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => [key, entry.count] as const);
  return Object.fromEntries(entries);
}

export function evaluateLintDiagnostics(
  diagnostics: readonly LintDiagnostic[],
  baseline: Readonly<LintBaseline>,
  repoRoot: string,
): LintEvaluation {
  const { counts, unbaselinable } = countDiagnostics(diagnostics, repoRoot);
  const violations: LintViolation[] = [];
  for (const [key, entry] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const allowed = baseline[key] ?? 0;
    if (entry.count > allowed) {
      violations.push({
        key,
        file: entry.file,
        code: entry.code,
        found: entry.count,
        allowed,
        diagnostics: entry.items,
      });
    }
  }
  return { violations, unbaselinable };
}

function formatDiagnosticLine(diag: LintDiagnostic, repoRoot: string): string {
  const file = diag.filename ? normalizeDiagnosticPath(diag.filename, repoRoot) : "<unknown>";
  const span = diag.labels?.[0]?.span;
  const loc = span?.line !== undefined ? `:${span.line}${span.column !== undefined ? `:${span.column}` : ""}` : "";
  const code = diag.code ? `[${diag.code}] ` : "";
  return `  ${file}${loc} ${code}${diag.message}`;
}

export function formatLintFailure(evaluation: LintEvaluation, repoRoot: string): string {
  const lines: string[] = [];
  for (const diag of evaluation.unbaselinable) {
    lines.push(formatDiagnosticLine(diag, repoRoot));
  }
  for (const v of evaluation.violations) {
    lines.push(`${v.key}: ${v.found} hit(s) exceed baseline ${v.allowed}`);
    for (const diag of v.diagnostics) {
      lines.push(formatDiagnosticLine(diag, repoRoot));
    }
  }
  return lines.join("\n");
}

export function runOxlint(
  repoRoot: string,
  targets: readonly string[] = LINT_TARGETS,
  extraArgs: readonly string[] = [],
): { report: LintReport; status: number; stderr: string } {
  const oxlintBin = join(repoRoot, ...OXLINT_BIN);
  if (!existsSync(oxlintBin)) {
    throw new Error(`Missing oxlint binary at ${oxlintBin} (run 'pnpm install' first)`);
  }
  const localBin = join(repoRoot, "node_modules", ".bin");
  const pathEnv = process.env.PATH ? `${localBin}${delimiter}${process.env.PATH}` : localBin;
  const args = [oxlintBin, "--type-aware", "-c", join(repoRoot, LINT_CONFIG), "-f", "json", ...extraArgs, ...targets];
  const run = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, PATH: pathEnv },
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (run.error) throw run.error;
  const raw = run.stdout.trim();
  if (!raw) {
    throw new Error(`oxlint exited with code ${run.status ?? 1} and no JSON output:\n${run.stderr.trim()}`);
  }
  const parsed = JSON.parse(raw) as Partial<LintReport>;
  if (!Array.isArray(parsed.diagnostics)) {
    throw new Error(`oxlint returned unexpected JSON without diagnostics array:\n${raw.slice(0, 500)}`);
  }
  return {
    report: {
      diagnostics: parsed.diagnostics,
      number_of_files: parsed.number_of_files,
      number_of_rules: parsed.number_of_rules,
    },
    status: run.status ?? 0,
    stderr: run.stderr.trim(),
  };
}

export function readBaseline(baselinePath: string): LintBaseline {
  if (!existsSync(baselinePath)) return {};
  return JSON.parse(readFileSync(baselinePath, "utf8")) as LintBaseline;
}

export function main(argv: readonly string[], repoRoot: string = REPO_ROOT): number {
  const updateBaseline = argv.includes("--update-baseline");
  const targets = argv.filter((arg) => !arg.startsWith("-"));
  if (updateBaseline && targets.length > 0) {
    console.error("lint: --update-baseline cannot be combined with explicit target paths");
    return 2;
  }
  const selectedTargets = targets.length > 0 ? targets : LINT_TARGETS;
  const { report, stderr } = runOxlint(repoRoot, selectedTargets);
  if (stderr) console.error(stderr);
  const baselinePath = join(repoRoot, LINT_BASELINE);

  if (updateBaseline) {
    const next = buildBaseline(report.diagnostics, repoRoot);
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`lint: updated ${LINT_BASELINE} (${Object.keys(next).length} entries across ${report.number_of_files ?? "?"} files)`);
    return 0;
  }

  const baseline = readBaseline(baselinePath);
  const evaluation = evaluateLintDiagnostics(report.diagnostics, baseline, repoRoot);
  if (evaluation.unbaselinable.length > 0 || evaluation.violations.length > 0) {
    console.error(formatLintFailure(evaluation, repoRoot));
    return 1;
  }
  console.log(
    `lint: passed (${report.number_of_files ?? "?"} files, ${report.number_of_rules ?? "?"} rules, ${report.diagnostics.length} baselined diagnostics)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
