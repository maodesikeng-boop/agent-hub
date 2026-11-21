// Runs every test affected by this branch's changes. Vitest's import graph covers code; a path search links
// files loaded at runtime (SQL migrations, workflow YAML, fixtures) to the tests and modules that read them.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GIT_MAX_BUFFER_BYTES } from "../src/shared/limits.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

/** Guards that scan the whole tree instead of importing what they check, so no import graph reaches them. */
export const ALWAYS_RUN_TESTS = [
  "scripts/ci-workflows.test.ts",
  "src/code-hygiene.test.ts",
  "src/daemon/resources/registry.test.ts",
  "src/shared/errors-guard.test.ts",
  "src/shared/vendor-guard.test.ts",
  "src/vendors/contract.test.ts",
  "src/web/query-write-guard.test.ts",
  "src/web/web-guard.test.ts",
  "test/smoke/ledger-access.test.ts",
] as const;

const DEFAULT_BASE = "origin/main";
const MODULE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const SEARCH_ROOTS = ["src", "scripts", "test"];

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

/** Code files whose source mentions a needle. Markdown changes match test files only. */
export function findReferencingFiles(changed: readonly string[], sources: ReadonlyMap<string, string>): string[] {
  const hits = new Set<string>();
  for (const file of changed) {
    const needles = referenceNeedles(file);
    if (needles.length === 0) continue;
    const testsOnly = file.endsWith(".md");
    for (const [path, text] of sources) {
      if (path === file || (testsOnly && !TEST_FILE.test(path))) continue;
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
  const linked = changed.some((file) => referenceNeedles(file).length > 0) ? findReferencingFiles(changed, readCodeSources(REPO_ROOT)) : [];
  const targets = [...new Set([...changed, ...linked, ...ALWAYS_RUN_TESTS])];
  console.log(`test:related: ${changed.length} changed since ${base}, ${linked.length} linked by path, ${ALWAYS_RUN_TESTS.length} guards`);
  const vitest = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  const run = spawnSync(process.execPath, [vitest, "related", "--run", "--passWithNoTests", ...vitestArgs, ...targets], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
