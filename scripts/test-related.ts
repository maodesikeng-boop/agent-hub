// Runs every test affected by this branch's changes using a symbol-aware static impact graph and bounded local concurrency.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GIT_MAX_BUFFER_BYTES, KILL_WAIT_MS, TEST_RELATED_LOCAL_MAX_WORKERS } from "../src/shared/limits.ts";
import { SANDBOX_SKIP_LOG_ENV } from "../test/sandbox-probes.ts";
import {
  findReferencingFiles,
  loadVitestProjectSpecs,
  parseTestRelatedArgs,
  referenceNeedles,
  resolveAffectedTests,
  resolveLocalConcurrency,
  type AffectedTestsResult,
} from "./related-graph.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

export { findReferencingFiles, referenceNeedles };

/** Guards that scan the whole tree instead of importing what they check, so no import graph reaches them. */
export const ALWAYS_RUN_TESTS = [
  "scripts/ci-friction.test.ts",
  "scripts/ci-workflows.test.ts",
  "src/code-hygiene.test.ts",
  "src/daemon/platform/executable-write-guard.test.ts",
  "src/daemon/resources/registry.test.ts",
  "src/direct-dependencies.test.ts",
  "src/docs-guard.test.ts",
  "src/hub-limits-guard.test.ts",
  "src/hub/registry.test.ts",
  "src/prompt-portability.test.ts",
  "src/shared/errors-guard.test.ts",
  "src/shared/vendor-guard.test.ts",
  "src/user-docs-consistency.test.ts",
  "src/user-docs-followups.test.ts",
  "src/vendors/contract.test.ts",
  "src/wall-clock-guard.test.ts",
  "src/web/query-write-guard.test.ts",
  "src/web/web-guard.test.ts",
  "test/sandbox-probes.test.ts",
  "test/smoke/ledger-access.test.ts",
] as const;

const MODULE_FILE = /\.[cm]?[jt]sx?$/;
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

function resolveMergeBase(cwd: string, base: string): string {
  try {
    return execFileSync("git", ["merge-base", base, "HEAD"], { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER_BYTES }).trim() || base;
  } catch {
    return base;
  }
}

function createBaseFileReader(cwd: string, baseRef: string): (repoRelativePath: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (repoRelativePath: string): string | undefined => {
    if (cache.has(repoRelativePath)) return cache.get(repoRelativePath);
    const out = spawnSync("git", ["show", `${baseRef}:${repoRelativePath}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    });
    const content = out.status === 0 && !out.error ? out.stdout : undefined;
    cache.set(repoRelativePath, content);
    return content;
  };
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

/** Formats per-test causal paths for `--explain`. */
export function formatExplainLines(result: AffectedTestsResult, alwaysRun: readonly string[] = ALWAYS_RUN_TESTS): string[] {
  const guardSet = new Set(alwaysRun);
  const lines: string[] = [];
  for (const testFile of result.testFiles) {
    const reasons = result.reasons.get(testFile);
    if (!reasons || reasons.length === 0) {
      lines.push(`  ${testFile}  [${guardSet.has(testFile) ? "always-run guard" : "selected"}]`);
      continue;
    }
    const formatted = reasons
      .slice(0, 3)
      .map((r) => `${r.changedFile}#${r.symbol} (${r.path.join(" -> ")})`)
      .join("; ");
    const suffix = reasons.length > 3 ? ` (+${reasons.length - 3} more)` : "";
    lines.push(`  ${testFile}  <- ${formatted}${suffix}`);
  }
  return lines;
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

const PROCESS_POLL_MS = 25;

function isProcessGroupAlive(pgid: number): boolean {
  if (process.platform === "win32" || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // Process group already exited.
  }
}

async function waitForProcessGroupExit(pgid: number, graceMs: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === "win32" || pgid <= 1 || !isProcessGroupAlive(pgid)) return;
  // Re-signal once in case a Vitest worker forked just before the CLI process exited.
  signalProcessGroup(pgid, signal);
  const deadline = performance.now() + graceMs;
  while (isProcessGroupAlive(pgid)) {
    if (performance.now() >= deadline) {
      signalProcessGroup(pgid, "SIGKILL");
      const killDeadline = performance.now() + graceMs;
      while (isProcessGroupAlive(pgid) && performance.now() < killDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, PROCESS_POLL_MS));
      }
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, PROCESS_POLL_MS));
  }
}

function killWindowsProcessTree(pid: number): Promise<void> {
  if (pid <= 1) return Promise.resolve();
  return new Promise((resolveKill) => {
    const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const taskkill = join(sysRoot, "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => {
      try {
        process.kill(pid);
      } catch {
        // Already exited.
      }
      resolveKill();
    });
    killer.once("close", () => resolveKill());
  });
}

export async function runVitest(
  args: readonly string[],
  options?: { readonly scriptPath?: string; readonly cwd?: string; readonly tmpRoot?: string },
): Promise<number> {
  const vitest = options?.scriptPath ?? join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  const cwd = options?.cwd ?? REPO_ROOT;
  const dir = mkdtempSync(join(options?.tmpRoot ?? tmpdir(), "test-related-"));
  const log = join(dir, "sandbox-skips.txt");
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, [vitest, ...args], {
    cwd,
    stdio: "inherit",
    detached: useProcessGroup,
    env: { ...process.env, [SANDBOX_SKIP_LOG_ENV]: log },
  });
  let receivedSignal: NodeJS.Signals | null = null;
  let escalateTimer: ReturnType<typeof setTimeout> | undefined;
  let win32KillPromise: Promise<void> | undefined;
  const forwardSignal = (sig: NodeJS.Signals): void => {
    receivedSignal = sig;
    const pid = child.pid;
    if (pid === undefined) return;
    if (useProcessGroup) {
      signalProcessGroup(pid, sig);
      if (escalateTimer === undefined) {
        escalateTimer = setTimeout(() => signalProcessGroup(pid, "SIGKILL"), KILL_WAIT_MS);
        escalateTimer.unref();
      }
    } else {
      win32KillPromise ??= killWindowsProcessTree(pid);
    }
  };
  const onSigInt = (): void => forwardSignal("SIGINT");
  const onSigTerm = (): void => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    if (escalateTimer !== undefined) {
      clearTimeout(escalateTimer);
      escalateTimer = undefined;
    }
    const pid = child.pid;
    if (pid !== undefined && (receivedSignal !== null || exit.signal !== null)) {
      if (useProcessGroup) {
        await waitForProcessGroupExit(pid, KILL_WAIT_MS, receivedSignal ?? exit.signal ?? "SIGTERM");
      } else {
        await (win32KillPromise ?? killWindowsProcessTree(pid));
      }
    }
    const report = sandboxSkipReport(existsSync(log) ? readFileSync(log, "utf8") : "");
    if (report) console.log(report);
    if (receivedSignal === "SIGINT") return 130;
    if (receivedSignal === "SIGTERM") return 143;
    if (exit.code !== null) return exit.code;
    if (exit.signal === "SIGINT") return 130;
    if (exit.signal === "SIGTERM") return 143;
    return 1;
  } finally {
    if (escalateTimer !== undefined) clearTimeout(escalateTimer);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const { base, dryRun, explain, vitestArgs } = parseTestRelatedArgs(argv);
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

  const projects = await loadVitestProjectSpecs(REPO_ROOT);
  const sources = readCodeSources(REPO_ROOT);
  const mergeBase = resolveMergeBase(REPO_ROOT, base);
  const result = resolveAffectedTests({
    repoRoot: REPO_ROOT,
    baseRef: base,
    changedFiles: changed,
    projects,
    alwaysRunTests: ALWAYS_RUN_TESTS,
    sources,
    readBaseFile: createBaseFileReader(REPO_ROOT, mergeBase),
  });

  const concurrency = resolveLocalConcurrency({
    vitestArgs,
    env: process.env,
    cpuCount: availableParallelism(),
    testFileCount: result.testFiles.length,
    maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
  });

  const workerNote =
    concurrency.maxWorkers !== undefined
      ? `maxWorkers=${concurrency.maxWorkers} (${concurrency.source})`
      : `workers=${concurrency.source}`;

  if (result.fullSuite) {
    console.log(
      `test:related: ${changed.length} changed since ${base}, full suite (${result.fullSuiteReason}), ${result.testFiles.length}/${result.totalTestFiles} test files, ${workerNote}`,
    );
  } else {
    console.log(
      `test:related: ${changed.length} changed since ${base}, ${result.linkedByPath.length} linked by path, ${ALWAYS_RUN_TESTS.length} guards -> ${result.testFiles.length}/${result.totalTestFiles} test files, ${workerNote}`,
    );
  }

  if (explain) {
    for (const line of formatExplainLines(result)) console.log(line);
  } else if (dryRun) {
    for (const file of result.testFiles) console.log(`  ${file}`);
  }

  if (dryRun) return 0;
  if (result.testFiles.length === 0) return 0;

  const targetArgs = result.fullSuite ? [] : result.testFiles;
  return await runVitest(["run", "--passWithNoTests", ...concurrency.extraArgs, ...vitestArgs, ...targetArgs]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
