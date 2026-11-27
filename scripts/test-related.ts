// Runs every test affected by this branch's changes. Vitest's import graph covers code; a path search links
// files loaded at runtime (SQL migrations, workflow YAML, fixtures) to the tests and modules that read them.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GIT_MAX_BUFFER_BYTES } from "../src/shared/limits.ts";
import { SANDBOX_SKIP_LOG_ENV } from "../test/sandbox-probes.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

/** Guards that scan the whole tree instead of importing what they check, so no import graph reaches them. */
export const ALWAYS_RUN_TESTS = [
  "scripts/ci-friction.test.ts",
  "scripts/ci-workflows.test.ts",
  "src/code-hygiene.test.ts",
  "src/daemon/resources/registry.test.ts",
  "src/direct-dependencies.test.ts",
  "src/docs-guard.test.ts",
  "src/hub-limits-guard.test.ts",
  "src/hub/registry.test.ts",
  "src/prompt-portability.test.ts",
  "src/shared/errors-guard.test.ts",
  "src/shared/vendor-guard.test.ts",
  "src/vendors/contract.test.ts",
  "src/wall-clock-guard.test.ts",
  "src/web/query-write-guard.test.ts",
  "src/web/web-guard.test.ts",
  "test/sandbox-probes.test.ts",
  "test/smoke/ledger-access.test.ts",
] as const;

const DEFAULT_BASE = "origin/main";
const MODULE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const SEARCH_ROOTS = ["src", "scripts", "test"];
const MANIFEST_OR_LOCKFILE_NAMES = new Set(["package.json", "pnpm-lock.yaml"]);

function gitLines(cwd: string, args: string[]): string[] {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER_BYTES }).split("\0").filter(Boolean);
}

/** Files changed since the merge base with `base`, plus staged, unstaged, and untracked files, as repo-relative POSIX paths. */
export function listChangedFiles(cwd: string, base: string): string[] {
  const files = [
    ...gitLines(cwd, ["diff", "--name-only", "-z", `${base}...HEAD`]),
    ...gitLines(cwd, ["diff", "--name-only", "-z", "HEAD"]),
    ...gitLines(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ];
  return [...new Set(files)].sort();
}

/** Strings a test or module that loads `file` at runtime would contain; empty for code that the import graph already covers. */
export function referenceNeedles(file: string): string[] {
  if (MODULE_FILE.test(file)) return [];
  const dir = posix.dirname(file);
  // Prompts and fixtures mention Markdown files as prose, so only an exact path below the root counts.
  if (file.endsWith(".md")) return dir === "." ? [] : [file];
  if (dir === ".") return [file];
  return [file, `${dir}/`];
}

function isManifestOrLockfile(file: string): boolean {
  return MANIFEST_OR_LOCKFILE_NAMES.has(posix.basename(file));
}

function matchesReferenceTarget(changedFile: string, candidatePath: string): boolean {
  if (changedFile.endsWith(".md")) return TEST_FILE.test(candidatePath);
  // Root manifests and lockfiles link only to tests and build scripts so literal "package.json" in src/ runtime code does not fan out across unrelated suites.
  if (isManifestOrLockfile(changedFile)) return TEST_FILE.test(candidatePath) || candidatePath.startsWith("scripts/");
  return true;
}

/** Code files whose source mentions a needle. Markdown matches tests only; manifests and lockfiles match tests and `scripts/` modules. */
export function findReferencingFiles(changed: readonly string[], sources: ReadonlyMap<string, string>): string[] {
  const hits = new Set<string>();
  for (const file of changed) {
    const needles = referenceNeedles(file);
    if (needles.length === 0) continue;
    for (const [path, text] of sources) {
      if (path === file || !matchesReferenceTarget(file, path)) continue;
      if (needles.some((needle) => text.includes(needle))) hits.add(path);
    }
  }
  return [...hits].sort();
}

function readCodeSources(cwd: string): Map<string, string> {
  const paths = [
    ...gitLines(cwd, ["ls-files", "-z", "--", ...SEARCH_ROOTS]),
    ...gitLines(cwd, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...SEARCH_ROOTS]),
  ];
  const sources = new Map<string, string>();
  for (const path of paths) {
    if (MODULE_FILE.test(path) && existsSync(join(cwd, path))) sources.set(path, readFileSync(join(cwd, path), "utf8"));
  }
  return sources;
}

function splitArgs(argv: string[]): { base: string; vitestArgs: string[] } {
  const at = argv.indexOf("--base");
  if (at === -1) return { base: DEFAULT_BASE, vitestArgs: argv };
  const base = argv[at + 1];
  if (!base) throw new Error("--base needs a git ref");
  return { base, vitestArgs: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/** Selects `vitest related` targets while omitting `package.json` and `pnpm-lock.yaml`, because Vitest's `forceRerunTriggers` expands `package.json` to the full suite and path linking plus `ALWAYS_RUN_TESTS` already cover manifest and lockfile consumers. */
export function selectRelatedTargets(
  changed: readonly string[],
  sources: ReadonlyMap<string, string>,
): { linked: string[]; targets: string[] } {
  const linked = changed.some((file) => referenceNeedles(file).length > 0) ? findReferencingFiles(changed, sources) : [];
  const direct = changed.filter((file) => !isManifestOrLockfile(file));
  const targets = [...new Set([...direct, ...linked, ...ALWAYS_RUN_TESTS])];
  return { linked, targets };
}

/** The closing note when the sandbox made tests skip: CI still runs them, so this run cannot vouch for them. */
export function sandboxSkipReport(logText: string): string | undefined {
  const files = [...new Set(logText.split("\n").filter(Boolean))].sort();
  if (files.length === 0) return undefined;
  return [
    `test:related: the sandbox refused ps or a nested sandbox, so ${files.length} test file(s) skipped tests that CI still runs:`,
    ...files.map((file) => `  ${file}`),
    "test:related: after you push, wait for the cloud checks with `node scripts/wait-checks.ts` before you hand off.",
  ].join("\n");
}

function runVitest(args: readonly string[]): number {
  const vitest = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  const dir = mkdtempSync(join(tmpdir(), "test-related-"));
  const log = join(dir, "sandbox-skips.txt");
  try {
    const run = spawnSync(process.execPath, [vitest, ...args], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, [SANDBOX_SKIP_LOG_ENV]: log },
    });
    if (run.error) throw run.error;
    const report = sandboxSkipReport(existsSync(log) ? readFileSync(log, "utf8") : "");
    if (report) console.log(report);
    return run.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const { base, vitestArgs } = splitArgs(argv);
  let changed: string[];
  try {
    changed = listChangedFiles(REPO_ROOT, base);
  } catch (error) {
    console.error(`test:related: cannot diff against ${base} (run 'git fetch origin main' or pass --base <ref>): ${String(error)}`);
    return 2;
  }
  if (changed.length === 0) {
    console.log(`test:related: no changes since ${base}`);
    return 0;
  }
  const sources = changed.some((file) => referenceNeedles(file).length > 0) ? readCodeSources(REPO_ROOT) : new Map<string, string>();
  const { linked, targets } = selectRelatedTargets(changed, sources);
  console.log(`test:related: ${changed.length} changed since ${base}, ${linked.length} linked by path, ${ALWAYS_RUN_TESTS.length} guards`);
  return runVitest(["related", "--run", "--passWithNoTests", ...vitestArgs, ...targets]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
