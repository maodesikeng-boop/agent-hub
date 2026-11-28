import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffChangedExports,
  loadVitestProjectSpecs,
  resolveAffectedTests,
  SCOPED_SOURCE_GUARDS,
  type VitestProjectSpec,
} from "./related-graph.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";
import { ALWAYS_RUN_TESTS } from "./test-related.ts";

const SYNTHETIC_PROJECTS: readonly VitestProjectSpec[] = [
  {
    name: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["src/web/**", "src/relay/cloudflare/**"],
    setupFiles: ["test/clean-env.ts", "test/spawn-guard.ts"],
  },
  {
    name: "cloudflare",
    include: ["src/relay/cloudflare/**/*.test.ts"],
    setupFiles: ["test/clean-env.ts"],
  },
  {
    name: "web",
    include: ["src/web/**/*.test.{ts,tsx}"],
    setupFiles: ["src/web/test-setup.ts"],
  },
];

let cachedRepoSources: Map<string, string> | undefined;
function loadRepoSources(): Map<string, string> {
  if (!cachedRepoSources) {
    const repoFiles = execFileSync("git", ["ls-files", "-z", "--", "src", "scripts", "test"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && existsSync(resolve(REPO_ROOT, f)));
    cachedRepoSources = new Map(repoFiles.map((f) => [f, readFileSync(resolve(REPO_ROOT, f), "utf8")]));
  }
  return cachedRepoSources;
}

function makeBaseReader(baseSources: ReadonlyMap<string, string>): (path: string) => string | undefined {
  return (path) => baseSources.get(path);
}

function scansRepoSourceTree(text: string): boolean {
  const hasRecursiveReaddirSourceRoot =
    /\breaddir(?:Sync)?\s*\(/.test(text) &&
    (/\b(?:resolve|join)\s*\(\s*(?:(?:REPO_ROOT|ROOT|process\.cwd\s*\(\s*\))\s*,\s*)?["'`](?:src|scripts|test)(?:\/|["'`])/.test(text) ||
      /\b(?:resolve|join)\s*\(\s*(?:import\.meta\.dirname|__dirname)\b/.test(text) ||
      /\bnew\s+URL\s*\(\s*["'`][^"'`]*(?:src|scripts|test)(?:\/|["'`])/.test(text));
  return (
    /execFileSync\s*\(\s*["']git["']\s*,\s*\[[^\]]*ls-files[^\]]*(?:src|scripts|test)/.test(text) ||
    /\bglob(?:Sync)?\s*\([^)]*(?:src|scripts|test)/.test(text) ||
    /readdir(?:Sync)?\s*\(\s*(?:["']src\b|["']scripts\b|["']test\b|join\s*\(\s*REPO_ROOT\s*,\s*["'](?:src|scripts|test)["']|srcDir)/.test(text) ||
    hasRecursiveReaddirSourceRoot
  );
}

describe("scripts/related-graph.ts review follow-up regressions", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("1) detects runtime optional-chaining edits on MemberExpression and CallExpression while ignoring TS-only optional markers", () => {
    const known = new Set(["src/read.ts", "src/consumer.test.ts", "test/clean-env.ts", "test/spawn-guard.ts", "src/web/test-setup.ts", "src/guard.test.ts"]);

    const oldMember = "export function read(x?: { child?: { value: number } }) { return x?.child?.value; }\n";
    const newMember = "export function read(x?: { child?: { value: number } }) { return x?.child.value; }\n";
    expect(diffChangedExports("src/read.ts", oldMember, newMember, known)).toEqual({
      kind: "symbols",
      symbols: ["read"],
    });

    const baseSources = new Map<string, string>([
      ["src/read.ts", oldMember],
      ["src/consumer.test.ts", 'import { read } from "./read.ts";\nvoid read;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/read.ts", newMember);
    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/read.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(result.testFiles).toContain("src/consumer.test.ts");

    const oldCall = "export function invoke(fn?: () => number) { return fn?.(); }\n";
    const newCall = "export function invoke(fn?: () => number) { return fn(); }\n";
    expect(diffChangedExports("src/read.ts", oldCall, newCall, known)).toEqual({
      kind: "symbols",
      symbols: ["invoke"],
    });

    const oldTsOptional = "export class Box { value?: number; }\nexport function keep(x?: number, { a = 1 }?: { a?: number }) { return [x, a]; }\n";
    const newTsOptional = "export class Box { value: number; }\nexport function keep(x: number, { a = 1 }: { a: number }) { return [x, a]; }\n";
    expect(diffChangedExports("src/read.ts", oldTsOptional, newTsOptional, known)).toEqual({ kind: "none" });
  });

  it("2a) treats effectful module-load initializers as module-evaluation side effects without bouncing pure limits fan-out", { timeout: 45_000 }, async () => {
    const projects = await loadVitestProjectSpecs(REPO_ROOT);
    const baseSources = loadRepoSources();
    const oldQueryClient = baseSources.get("src/web/query-client.ts")!;
    const brokenQueryClient = oldQueryClient.replace(
      'export const ACCOUNT_QUERY_KEY = ["account"] as const;',
      'export const ACCOUNT_QUERY_KEY = JSON.parse("{") as readonly ["account"];',
    );
    expect(brokenQueryClient).not.toBe(oldQueryClient);

    const diff = diffChangedExports("src/web/query-client.ts", oldQueryClient, brokenQueryClient, new Set(baseSources.keys()));
    expect(diff.kind).toBe("all");

    const brokenSources = new Map(baseSources);
    brokenSources.set("src/web/query-client.ts", brokenQueryClient);
    const brokenResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/web/query-client.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: brokenSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(brokenResult.testFiles).toContain("src/web/notify.test.ts");

    // Pure literal edits stay symbol-scoped and do not trigger the web setupFile sweep.
    const pureQueryClient = oldQueryClient.replace(
      'export const ACCOUNT_QUERY_KEY = ["account"] as const;',
      'export const ACCOUNT_QUERY_KEY = ["account-v2"] as const;',
    );
    const pureDiff = diffChangedExports("src/web/query-client.ts", oldQueryClient, pureQueryClient, new Set(baseSources.keys()));
    expect(pureDiff).toEqual({
      kind: "symbols",
      symbols: ["ACCOUNT_QUERY_KEY", "accountQueryFn", "commitAccountStatus", "invalidateAccount"],
    });
    const pureSources = new Map(baseSources);
    pureSources.set("src/web/query-client.ts", pureQueryClient);
    const pureResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/web/query-client.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: pureSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(pureResult.testFiles).not.toContain("src/web/notify.test.ts");

    // Single pure constant edit in src/shared/limits.ts stays well under 100 files.
    const oldLimits = baseSources.get("src/shared/limits.ts")!;
    const newLimits = oldLimits.replace("FEISHU_CARD_MAX_BYTES = 30_000", "FEISHU_CARD_MAX_BYTES = 31_000");
    const limitsSources = new Map(baseSources);
    limitsSources.set("src/shared/limits.ts", newLimits);
    const limitsResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/shared/limits.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: limitsSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(limitsResult.testFiles.length).toBeLessThan(100);
  });

  it("2b & S3) propagates module-evaluation side effects conservatively through named re-exports and static imports", () => {
    const oldSetup = "(globalThis as Record<string, unknown>).enabled = true;\nexport const config = 1;\n";
    const newSetup = "(globalThis as Record<string, unknown>).enabled = false;\nexport const config = 1;\n";

    const baseSources = new Map<string, string>([
      ["src/setup.ts", oldSetup],
      ["src/runner.ts", "export const run = () => (globalThis as Record<string, unknown>).enabled;\n"],
      ["src/index.ts", 'export { config } from "./setup.ts";\nexport { run } from "./runner.ts";\n'],
      ["src/mid.ts", 'import { config } from "./setup.ts";\nexport const readConfig = () => config;\nexport const unrelated = () => 42;\n'],
      ["src/config.test.ts", 'import { config } from "./index.ts";\nvoid config;\n'],
      ["src/run.test.ts", 'import { run } from "./index.ts";\nvoid run;\n'],
      ["src/unrelated-via-mid.test.ts", 'import { unrelated } from "./mid.ts";\nvoid unrelated;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/setup.ts", newSetup);

    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/setup.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });

    expect(result.testFiles).toContain("src/config.test.ts");
    expect(result.testFiles).toContain("src/run.test.ts");
    expect(result.testFiles).toContain("src/unrelated-via-mid.test.ts");
  });

  it("3) selects scoped source-scanning guards, new URL file reads, and import(URL_VAR) consumers even on newly added exports", { timeout: 45_000 }, async () => {
    const projects = await loadVitestProjectSpecs(REPO_ROOT);
    const baseSources = loadRepoSources();

    // New unimported export in src/web/components/NewPmDialog.tsx must still hit web source-scanning guards and src/ shell:true guard.
    const webSources = new Map(baseSources);
    webSources.set(
      "src/web/components/NewPmDialog.tsx",
      `${baseSources.get("src/web/components/NewPmDialog.tsx")!}\nexport function NewPmNotes() { return <Textarea className="focus-visible:outline-none" />; }\n`,
    );
    const webResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/web/components/NewPmDialog.tsx"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: webSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(webResult.testFiles).toContain("src/web/card-corners.test.tsx");
    expect(webResult.testFiles).toContain("src/web/info-style.test.tsx");
    expect(webResult.testFiles).toContain("src/web/lib/palette.test.ts");
    expect(webResult.testFiles).toContain("src/web/ui/icons.test.ts");
    expect(webResult.testFiles).toContain("src/web/ui-scale.test.tsx");
    expect(webResult.testFiles).toContain("src/web/ui/ui-standard.test.tsx");
    expect(webResult.testFiles).toContain("src/daemon/platform/win32.test.ts");

    // Direct new URL("../daemon.ts", import.meta.url) read in src/daemon/mesh/listen-port.test.ts.
    const daemonSources = new Map(baseSources);
    daemonSources.set("src/daemon/daemon.ts", `${baseSources.get("src/daemon/daemon.ts")!}\nexport const _unusedProbe = 1;\n`);
    const daemonResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/daemon/daemon.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: daemonSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(daemonResult.testFiles).toContain("src/daemon/mesh/listen-port.test.ts");

    // Indirect import(WORKER_URL) where WORKER_URL = new URL("./cloudflare/worker.ts", import.meta.url).href.
    const workerSources = new Map(baseSources);
    workerSources.set(
      "src/relay/cloudflare/worker.ts",
      `${baseSources.get("src/relay/cloudflare/worker.ts")!}\nexport const _unusedWorkerProbe = 1;\n`,
    );
    const workerResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/relay/cloudflare/worker.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: workerSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(workerResult.testFiles).toContain("src/relay/lease-checkpoint.test.ts");
    expect(workerResult.testFiles).toContain("src/relay/cloudflare/worker.test.ts");

    // Direct readFileSync("src/...") and join(import.meta.dirname, ...) reads.
    const composerSources = new Map(baseSources);
    composerSources.set(
      "src/vendors/claude/composer.ts",
      `${baseSources.get("src/vendors/claude/composer.ts")!}\nexport const _unusedComposerProbe = 1;\n`,
    );
    const composerResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/vendors/claude/composer.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: composerSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(composerResult.testFiles).toContain("src/vendors/claude/composer.test.ts");

    // Direct file-path fixture spawn (fake-acp-agent.ts) links ACP vendor tests.
    const acpSources = new Map(baseSources);
    acpSources.set(
      "src/vendors/_common/acp/fixtures/fake-acp-agent.ts",
      `${baseSources.get("src/vendors/_common/acp/fixtures/fake-acp-agent.ts")!}\nexport const _unusedAcpProbe = 1;\n`,
    );
    const acpResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/vendors/_common/acp/fixtures/fake-acp-agent.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: acpSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(acpResult.testFiles).toContain("src/vendors/_common/acp/driver.test.ts");
    expect(acpResult.testFiles).toContain("src/vendors/kimi/kimi.test.ts");
    expect(acpResult.testFiles).toContain("src/vendors/opencode/opencode.test.ts");
  });

  it("3b) registers every repo directory-scanning source guard in ALWAYS_RUN_TESTS or SCOPED_SOURCE_GUARDS", () => {
    const covered = new Set<string>([
      ...ALWAYS_RUN_TESTS,
      ...SCOPED_SOURCE_GUARDS.map((g) => g.testFile),
      // Non-source scans: migrations/, REVIEW.md stamp glob sanity check, and the planning suite itself.
      "scripts/related-graph.test.ts",
      "scripts/review-stamp-gate.test.ts",
      "src/daemon/store/store.test.ts",
      "test/migration.test.ts",
    ]);

    for (const guard of SCOPED_SOURCE_GUARDS) {
      expect(existsSync(resolve(REPO_ROOT, guard.testFile)), guard.testFile).toBe(true);
    }

    const uncovered: string[] = [];
    for (const [file, text] of loadRepoSources()) {
      if (!/\.test\.tsx?$/.test(file) || covered.has(file)) continue;
      if (scansRepoSourceTree(text)) uncovered.push(file);
    }
    expect(uncovered).toEqual([]);
  });

  it("4a & S5) covers synthetic vendor paths.ts and spec.ts propagation in addition to daemon.ts", () => {
    const oldPaths = "export const parentSessionEnv = ['ACME_PID'];\n";
    const newPaths = "export const parentSessionEnv = ['ACME_PID', 'ACME_TOKEN'];\n";
    const oldSpec = "export default { id: 'acme', label: 'Acme' };\n";
    const newSpec = "export default { id: 'acme', label: 'Acme v2' };\n";

    const baseSources = new Map<string, string>([
      ["src/vendors/acme/daemon.ts", "export default { createDriver: () => 1 };\n"],
      ["src/vendors/acme/paths.ts", oldPaths],
      ["src/vendors/acme/spec.ts", oldSpec],
      ["src/vendors/load.ts", "export function importVendorFile(id: string, file: string) { return import(`./${id}/${file}`); }\n"],
      ["src/vendors/daemon-registry.ts", 'import { importVendorFile } from "./load.ts";\nexport const VENDOR_DAEMONS = importVendorFile;\n'],
      ["src/vendors/paths-registry.ts", 'import { importVendorFile } from "./load.ts";\nexport const VENDOR_PATHS = importVendorFile;\n'],
      ["src/vendors/registry.ts", 'import acme from "./acme/spec.ts";\nexport const VENDOR_LIST = [acme] as const;\n'],
      ["src/daemon/multi-vendor.test.ts", 'import { VENDOR_DAEMONS } from "../vendors/daemon-registry.ts";\nvoid VENDOR_DAEMONS;\n'],
      ["src/daemon/paths.test.ts", 'import { VENDOR_PATHS } from "../vendors/paths-registry.ts";\nvoid VENDOR_PATHS;\n'],
      ["src/vendors/registry.test.ts", 'import { VENDOR_LIST } from "./registry.ts";\nvoid VENDOR_LIST;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);

    const pathsSources = new Map(baseSources);
    pathsSources.set("src/vendors/acme/paths.ts", newPaths);
    const pathsResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/vendors/acme/paths.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: pathsSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(pathsResult.testFiles).toContain("src/daemon/paths.test.ts");
    expect(pathsResult.testFiles).not.toContain("src/daemon/multi-vendor.test.ts");

    const specSources = new Map(baseSources);
    specSources.set("src/vendors/acme/spec.ts", newSpec);
    const specResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/vendors/acme/spec.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: specSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(specResult.testFiles).toContain("src/vendors/registry.test.ts");
    expect(specResult.testFiles).not.toContain("src/daemon/multi-vendor.test.ts");
  });

  it("4b & S8) cleans up its temporary directory on mid-run interruption and reruns cleanly with zero stale cache", { timeout: 45_000 }, async () => {
    const scratchTmp = mkdtempSync(join(tmpdir(), "related-s8-"));
    tempDirs.push(scratchTmp);
    const fakeVitest = join(scratchTmp, "fake-vitest.mjs");
    if (process.platform === "win32") {
      writeFileSync(fakeVitest, 'process.stdout.write("READY\\n"); process.exit(1);\n');
    } else {
      writeFileSync(
        fakeVitest,
        'process.stdout.write("READY\\n"); process.on("SIGTERM", () => process.exit(143)); setInterval(() => {}, 60_000);\n',
      );
    }
    const driver = join(scratchTmp, "run-driver.mjs");
    writeFileSync(
      driver,
      `import { runVitest } from ${JSON.stringify(resolve(REPO_ROOT, "scripts/test-related.ts"))};
const code = await runVitest([], { scriptPath: ${JSON.stringify(fakeVitest)}, tmpRoot: ${JSON.stringify(scratchTmp)} });
process.exit(code);
`,
    );

    const child = spawn(process.execPath, [driver], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let sawReady = false;
    let sawTempDir = false;
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.on("error", rejectExit);
      child.stdout.on("data", (chunk: Buffer) => {
        if (!sawReady && chunk.toString("utf8").includes("READY")) {
          sawReady = true;
          sawTempDir = readdirSync(scratchTmp).some((name) => name.startsWith("test-related-"));
          if (process.platform !== "win32") child.kill("SIGTERM");
        }
      });
      child.on("close", (code) => resolveExit(code));
    });

    expect(sawReady).toBe(true);
    if (process.platform !== "win32") {
      expect(sawTempDir).toBe(true);
      expect(exitCode).toBe(143);
    } else {
      expect(exitCode).toBe(1);
    }
    expect(readdirSync(scratchTmp).filter((name) => name.startsWith("test-related-"))).toEqual([]);

    const rerun = execFileSync(process.execPath, ["scripts/test-related.ts", "--base", "HEAD", "--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratchTmp, TEMP: scratchTmp, TMP: scratchTmp },
    });
    expect(rerun).toContain("test:related:");
    expect(readdirSync(scratchTmp).filter((name) => name.startsWith("test-related-"))).toEqual([]);
  });

  it("4c & S10) loads real vitest.config.ts across win32, darwin, and linux and enforces all four Windows eval exclusions", async () => {
    const winExcluded = [
      "test/eval/isolation.test.ts",
      "test/eval/cli.test.ts",
      "test/eval/selftest.test.ts",
      "test/eval/fakes.test.ts",
    ];
    const baseSources = new Map<string, string>([
      ["test/eval/shared.ts", "export const v = 1;\n"],
      ...winExcluded.map((file): [string, string] => [file, 'import { v } from "./shared.ts";\nvoid v;\n']),
      ["test/eval/other.test.ts", 'import { v } from "./shared.ts";\nvoid v;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("test/eval/shared.ts", "export const v = 2;\n");

    const loadForPlatform = loadVitestProjectSpecs as (repoRoot: string, platform?: NodeJS.Platform) => Promise<VitestProjectSpec[]>;

    const winProjects = await loadForPlatform(REPO_ROOT, "win32");
    const winResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["test\\eval\\shared.ts"],
      projects: winProjects,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
      platform: "win32",
    });
    expect(winResult.testFiles).toContain("test/eval/other.test.ts");
    for (const file of winExcluded) expect(winResult.testFiles).not.toContain(file);

    for (const posixPlatform of ["darwin", "linux"] as const) {
      const posixProjects = await loadForPlatform(REPO_ROOT, posixPlatform);
      const posixResult = resolveAffectedTests({
        repoRoot: REPO_ROOT,
        baseRef: "origin/main",
        changedFiles: ["test/eval/shared.ts"],
        projects: posixProjects,
        alwaysRunTests: ["src/guard.test.ts"],
        sources: currentSources,
        readBaseFile: makeBaseReader(baseSources),
        platform: posixPlatform,
      });
      for (const file of winExcluded) expect(posixResult.testFiles, posixPlatform).toContain(file);
    }
  });

  it("5) treats throwing BigInt binary/unary expressions and retargeted barrel re-exports as module-evaluation side effects while preserving low fan-out", { timeout: 45_000 }, async () => {
    const known = new Set(["src/mod.ts", "src/setup.ts", "src/other.ts", "src/runner.ts", "src/index.ts"]);

    const baseMod = "export const value = 10;\nexport const other = 20;\n";
    for (const riskyInit of [
      "export const value = 1n / 0n;\nexport const other = 20;\n",
      "export const value = 100n / 0n;\nexport const other = 20;\n",
      "export const value = 1n % 0n;\nexport const other = 20;\n",
      "export const value = 2n ** -1n;\nexport const other = 20;\n",
      "export const value = +1n;\nexport const other = 20;\n",
      "export const value = 1n + 1;\nexport const other = 20;\n",
      "const ZERO = 0n;\nexport const value = 1n / ZERO;\nexport const other = 20;\n",
      "const obj = { toString() { throw new Error('boom'); } };\nexport const value = `${obj}`;\nexport const other = 20;\n",
      "export const value = typeof later;\nconst later = 1;\nexport const other = 20;\n",
      "const Base = 123 as never;\nexport class Bad extends Base {}\nexport const value = 10;\nexport const other = 20;\n",
    ]) {
      expect(diffChangedExports("src/mod.ts", baseMod, riskyInit, known).kind, riskyInit).toBe("all");
    }

    // Normal pure number and string arithmetic stays symbol-scoped.
    expect(
      diffChangedExports("src/mod.ts", baseMod, "export const value = 5 * 60_000;\nexport const other = 20;\n", known),
    ).toEqual({ kind: "symbols", symbols: ["value"] });
    expect(
      diffChangedExports("src/mod.ts", baseMod, 'export const value = "a" + "b";\nexport const other = 20;\n', known),
    ).toEqual({ kind: "symbols", symbols: ["value"] });

    // Real repo: throwing BigInt initializer in src/web/query-client.ts must trigger all web tests.
    const projects = await loadVitestProjectSpecs(REPO_ROOT);
    const repoBase = loadRepoSources();
    const oldQueryClient = repoBase.get("src/web/query-client.ts")!;
    const literalBigIntQueryClient = oldQueryClient.replace(
      'export const ACCOUNT_QUERY_KEY = ["account"] as const;',
      'export const ACCOUNT_QUERY_KEY = [100n / 0n] as const;',
    );
    expect(literalBigIntQueryClient).not.toBe(oldQueryClient);
    const bigIntSources = new Map(repoBase);
    bigIntSources.set("src/web/query-client.ts", literalBigIntQueryClient);
    const bigIntResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/web/query-client.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: bigIntSources,
      readBaseFile: makeBaseReader(repoBase),
    });
    expect(bigIntResult.testFiles).toContain("src/web/notify.test.ts");

    // Retargeting a barrel re-export to another module (whose top-level evaluation may throw) must propagate to all barrel consumers.
    const oldBarrel = 'export { config } from "./setup.ts";\nexport { run } from "./runner.ts";\n';
    const newBarrel = 'export { config } from "./other.ts";\nexport { run } from "./runner.ts";\n';
    expect(diffChangedExports("src/index.ts", oldBarrel, newBarrel, known).kind).toBe("all");

    const barrelBase = new Map<string, string>([
      ["src/setup.ts", "export const config = 1;\n"],
      ["src/other.ts", 'throw new Error("boom");\nexport const config = 2;\n'],
      ["src/runner.ts", "export const run = () => 1;\n"],
      ["src/index.ts", oldBarrel],
      ["src/config.test.ts", 'import { config } from "./index.ts";\nvoid config;\n'],
      ["src/run.test.ts", 'import { run } from "./index.ts";\nvoid run;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const barrelCurrent = new Map(barrelBase);
    barrelCurrent.set("src/index.ts", newBarrel);
    const barrelResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/index.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: barrelCurrent,
      readBaseFile: makeBaseReader(barrelBase),
    });
    expect(barrelResult.testFiles).toContain("src/config.test.ts");
    expect(barrelResult.testFiles).toContain("src/run.test.ts");
  });

  it("6) resolves template URL source reads in test/skeleton.test.ts and falls back conservatively for dynamic template URLs", { timeout: 45_000 }, async () => {
    const projects = await loadVitestProjectSpecs(REPO_ROOT);
    const repoBase = loadRepoSources();

    const setupSources = new Map(repoBase);
    setupSources.set("src/web/test-setup.ts", `${repoBase.get("src/web/test-setup.ts")!}\n// comment edit\n`);
    const setupResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/web/test-setup.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: setupSources,
      readBaseFile: makeBaseReader(repoBase),
    });
    expect(setupResult.testFiles).toContain("test/skeleton.test.ts");

    const mainSources = new Map(repoBase);
    mainSources.set("src/daemon/main.ts", `${repoBase.get("src/daemon/main.ts")!}\nexport const _probe = 1;\n`);
    const mainResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/daemon/main.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: mainSources,
      readBaseFile: makeBaseReader(repoBase),
    });
    expect(mainResult.testFiles).toContain("test/skeleton.test.ts");

    // Dynamic template URL falls back conservatively to the resolved directory scope without leaking into sibling directories.
    const synthBase = new Map<string, string>([
      ["src/fixtures/alpha.ts", "export const a = 1;\n"],
      ["src/other/beta.ts", "export const b = 1;\n"],
      [
        "test/dynamic-url.test.ts",
        'import { readFileSync } from "node:fs";\nfunction pick() { return "alpha"; }\nexport const raw = () => readFileSync(new URL(`../src/fixtures/${pick()}.ts`, import.meta.url), "utf8");\n',
      ],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const synthAlpha = new Map(synthBase);
    synthAlpha.set("src/fixtures/alpha.ts", "export const a = 2;\n");
    const alphaResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/fixtures/alpha.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: synthAlpha,
      readBaseFile: makeBaseReader(synthBase),
    });
    expect(alphaResult.testFiles).toContain("test/dynamic-url.test.ts");

    const synthBeta = new Map(synthBase);
    synthBeta.set("src/other/beta.ts", "export const b = 2;\n");
    const betaResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/other/beta.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: synthBeta,
      readBaseFile: makeBaseReader(synthBase),
    });
    expect(betaResult.testFiles).not.toContain("test/dynamic-url.test.ts");
  });

  it("7 & S8) waits for real Vitest forks worker processes to terminate on SIGTERM so workers stop responding to file events", { timeout: 45_000 }, async () => {
    if (process.platform === "win32") return;
    const scratchTmp = mkdtempSync(join(tmpdir(), "related-s8-forks-"));
    tempDirs.push(scratchTmp);

    const readyFile = join(scratchTmp, "worker-ready.txt");
    const triggerFile = join(scratchTmp, "trigger.txt");
    const respondedFile = join(scratchTmp, "worker-responded.txt");
    const probeTest = join(scratchTmp, "forks-probe.test.mjs");
    const vitestConfig = join(scratchTmp, "vitest.probe.config.mjs");
    const driver = join(scratchTmp, "run-forks-driver.mjs");

    writeFileSync(
      vitestConfig,
      `export default { test: { pool: "forks", include: ["forks-probe.test.mjs"], testTimeout: 30000 } };\n`,
    );
    writeFileSync(
      probeTest,
      `import { existsSync, watch, writeFileSync } from "node:fs";
import { it } from "vitest";
it("waits on file event", () => new Promise((resolveTest) => {
  const watcher = watch(${JSON.stringify(scratchTmp)}, (_event, name) => {
    if (name === "trigger.txt" || existsSync(${JSON.stringify(triggerFile)})) {
      writeFileSync(${JSON.stringify(respondedFile)}, String(process.pid));
      watcher.close();
      resolveTest();
    }
  });
  writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
}));
`,
    );
    writeFileSync(
      driver,
      `import { runVitest } from ${JSON.stringify(resolve(REPO_ROOT, "scripts/test-related.ts"))};
const code = await runVitest(
  ["run", "--pool=forks", "--config", ${JSON.stringify(vitestConfig)}, ${JSON.stringify(probeTest)}],
  { cwd: ${JSON.stringify(scratchTmp)}, tmpRoot: ${JSON.stringify(scratchTmp)} },
);
process.exit(code);
`,
    );

    const child = spawn(process.execPath, [driver], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let workerPid: number | null = null;
    try {
      const readyDeadline = performance.now() + 20_000;
      while (!existsSync(readyFile) && performance.now() < readyDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(readyFile)).toBe(true);
      workerPid = Number.parseInt(readFileSync(readyFile, "utf8").trim(), 10);
      expect(Number.isInteger(workerPid) && workerPid > 1).toBe(true);
      expect(readdirSync(scratchTmp).some((name) => name.startsWith("test-related-"))).toBe(true);

      const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code) => resolveExit(code));
      });
      child.kill("SIGTERM");
      const exitCode = await exitPromise;

      expect(exitCode).toBe(143);
      expect(readdirSync(scratchTmp).filter((name) => name.startsWith("test-related-"))).toEqual([]);

      let workerStillAlive = false;
      try {
        process.kill(workerPid, 0);
        workerStillAlive = true;
      } catch {
        workerStillAlive = false;
      }
      expect(workerStillAlive).toBe(false);

      writeFileSync(triggerFile, "ping");
      await new Promise((r) => setTimeout(r, 250));
      expect(existsSync(respondedFile)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }
      if (workerPid !== null && workerPid > 1) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  });

  it("8) traverses non-callback arguments (thisArg, .each title/extra args, default params) in static array iteration calls", () => {
    const baseSources = new Map<string, string>([
      ["src/review-fixture-data.ts", 'export const mode = "allowed";\n'],
      ["src/title-fixture.ts", 'export const label = "case";\n'],
      ["src/default-arg.ts", 'export const fallback = "ok";\n'],
      ["src/items/alpha.ts", "export const a = 1;\n"],
      ["src/items/beta.ts", "export const b = 1;\n"],
      [
        "test/this-arg.test.ts",
        [
          'import { readFileSync } from "node:fs";',
          'const matches = ["allowed"].map(',
          "  function (this: string, expected) { return this.includes(expected); },",
          '  readFileSync(new URL("../src/review-fixture-data.ts", import.meta.url), "utf8"),',
          ");",
          "export { matches };",
        ].join("\n"),
      ],
      [
        "test/each-extra.test.ts",
        [
          'import { readFileSync } from "node:fs";',
          'import { it } from "vitest";',
          'it.each(["alpha"])(',
          '  readFileSync(new URL("../src/title-fixture.ts", import.meta.url), "utf8"),',
          '  (item, extra = readFileSync(new URL("../src/default-arg.ts", import.meta.url), "utf8")) => {',
          '    void [extra, readFileSync(new URL(`../src/items/${item}.ts`, import.meta.url), "utf8")];',
          "  },",
          ");",
        ].join("\n"),
      ],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);

    const runEdit = (file: string, nextContent: string) => {
      const currentSources = new Map(baseSources);
      currentSources.set(file, nextContent);
      return resolveAffectedTests({
        repoRoot: REPO_ROOT,
        baseRef: "origin/main",
        changedFiles: [file],
        projects: SYNTHETIC_PROJECTS,
        alwaysRunTests: ["src/guard.test.ts"],
        sources: currentSources,
        readBaseFile: makeBaseReader(baseSources),
      });
    };

    expect(runEdit("src/review-fixture-data.ts", 'export const mode = "denied";\n').testFiles).toContain("test/this-arg.test.ts");
    expect(runEdit("src/title-fixture.ts", 'export const label = "changed";\n').testFiles).toContain("test/each-extra.test.ts");
    expect(runEdit("src/default-arg.ts", 'export const fallback = "changed";\n').testFiles).toContain("test/each-extra.test.ts");
    expect(runEdit("src/items/alpha.ts", "export const a = 2;\n").testFiles).toContain("test/each-extra.test.ts");
    expect(runEdit("src/items/beta.ts", "export const b = 2;\n").testFiles).not.toContain("test/each-extra.test.ts");
  });

  it("9) waits for the Vitest process group to exit before deleting the temp dir when SIGTERM hits Vitest directly", { timeout: 45_000 }, async () => {
    if (process.platform === "win32") return;
    const scratchTmp = mkdtempSync(join(tmpdir(), "related-direct-sigterm-"));
    tempDirs.push(scratchTmp);

    const readyFile = join(scratchTmp, "ready.json");
    const beforeRemoveFile = join(scratchTmp, "before-remove.json");
    const probeTest = join(scratchTmp, "direct-sigterm-probe.test.mjs");
    const vitestConfig = join(scratchTmp, "vitest.direct.config.mjs");
    const observer = join(scratchTmp, "observer.mjs");
    const driver = join(scratchTmp, "run-direct-driver.mjs");

    writeFileSync(
      vitestConfig,
      'export default { test: { pool: "forks", include: ["direct-sigterm-probe.test.mjs"], testTimeout: 30000 } };\n',
    );
    writeFileSync(
      probeTest,
      `import { writeFileSync } from "node:fs";
import { it } from "vitest";
it("holds briefly on SIGTERM", () => new Promise(() => {
  let exiting = false;
  process.on("SIGTERM", () => {
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(0), 180);
  });
  writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ vitestPid: process.ppid, workerPid: process.pid }));
}));
`,
    );
    writeFileSync(
      observer,
      `import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === "EPERM"; }
};
const origRmSync = fs.rmSync;
fs.rmSync = (targetPath, options) => {
  if (typeof targetPath === "string" && targetPath.startsWith(${JSON.stringify(join(scratchTmp, "test-related-"))})) {
    const info = existsSync(${JSON.stringify(readyFile)}) ? JSON.parse(readFileSync(${JSON.stringify(readyFile)}, "utf8")) : null;
    writeFileSync(
      ${JSON.stringify(beforeRemoveFile)},
      JSON.stringify({
        targetPath,
        groupAliveBeforeRemove: info ? alive(-info.vitestPid) : null,
        workerAliveBeforeRemove: info ? alive(info.workerPid) : null,
      }),
    );
  }
  return origRmSync(targetPath, options);
};
syncBuiltinESMExports();
`,
    );
    writeFileSync(
      driver,
      `import { runVitest } from ${JSON.stringify(resolve(REPO_ROOT, "scripts/test-related.ts"))};
const code = await runVitest(
  ["run", "--pool=forks", "--config", ${JSON.stringify(vitestConfig)}, ${JSON.stringify(probeTest)}],
  { cwd: ${JSON.stringify(scratchTmp)}, tmpRoot: ${JSON.stringify(scratchTmp)} },
);
process.exit(code);
`,
    );

    const child = spawn(process.execPath, ["--import", observer, driver], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let vitestPid: number | null = null;
    let workerPid: number | null = null;
    try {
      const deadline = performance.now() + 20_000;
      while (!existsSync(readyFile) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(readyFile)).toBe(true);
      const info = JSON.parse(readFileSync(readyFile, "utf8")) as { vitestPid: number; workerPid: number };
      vitestPid = info.vitestPid;
      workerPid = info.workerPid;
      expect(vitestPid).toBeGreaterThan(1);
      expect(workerPid).toBeGreaterThan(1);
      expect(readdirSync(scratchTmp).some((name) => name.startsWith("test-related-"))).toBe(true);

      const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code) => resolveExit(code));
      });
      // Signal Vitest directly rather than runVitest so Vitest handles SIGTERM and closes with { code: 143, signal: null }.
      process.kill(vitestPid, "SIGTERM");
      const exitCode = await exitPromise;

      expect(exitCode).toBe(143);
      expect(readdirSync(scratchTmp).filter((name) => name.startsWith("test-related-"))).toEqual([]);
      expect(existsSync(beforeRemoveFile)).toBe(true);
      const snapshot = JSON.parse(readFileSync(beforeRemoveFile, "utf8")) as {
        groupAliveBeforeRemove: boolean | null;
        workerAliveBeforeRemove: boolean | null;
      };
      expect(snapshot.groupAliveBeforeRemove).toBe(false);
      expect(snapshot.workerAliveBeforeRemove).toBe(false);
    } finally {
      for (const pid of [vitestPid, workerPid]) {
        if (pid !== null && pid > 1) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  });

  it("10) detects recursive readdir source scans rooted at resolve(import.meta.dirname, ...) or __dirname combined paths", () => {
    for (const sourceGuardText of [
      'const dir = resolve(import.meta.dirname, "..", "src");\nreaddirSync(dir, { recursive: true });\n',
      'const dir = resolve(import.meta.dirname, "../src/web");\nreaddirSync(dir);\n',
      'const dir = join(__dirname, "..", "..", "scripts");\nreaddirSync(dir);\n',
      'const dir = resolve(__dirname, "../test");\nreaddirSync(dir);\n',
      'const dir = resolve(import.meta.dirname);\nreaddirSync(dir, { withFileTypes: true });\n',
      'const dir = join(import.meta.dirname, "..", "components");\nreaddirSync(dir);\n',
    ]) {
      expect(scansRepoSourceTree(sourceGuardText), sourceGuardText).toBe(true);
    }
    for (const benignTestText of [
      'const dir = mkdtempSync(join(tmpdir(), "guard-"));\nreaddirSync(dir);\n',
      'const file = resolve(import.meta.dirname, "..", "src/foo.ts");\nreadFileSync(file, "utf8");\n',
    ]) {
      expect(scansRepoSourceTree(benignTestText), benignTestText).toBe(false);
    }
  });

  it("11) treats retargeted named re-exports whose source module changes as module-level changes even when staticModuleDeps stays identical", () => {
    const known = new Set(["src/setup.ts", "src/other.ts", "src/runner.ts", "src/index.ts"]);

    // Both ./setup.ts and ./runner.ts remain in staticModuleDeps, while `extra` moves from ./setup.ts to ./runner.ts.
    const oldSharedDepsBarrel = 'export { config, extra } from "./setup.ts";\nexport { run } from "./runner.ts";\n';
    const newSharedDepsBarrel = 'export { config } from "./setup.ts";\nexport { extra, run } from "./runner.ts";\n';
    expect(diffChangedExports("src/index.ts", oldSharedDepsBarrel, newSharedDepsBarrel, known).kind).toBe("all");

    const baseSources = new Map<string, string>([
      ["src/setup.ts", "export const config = 1;\nexport const extra = 2;\n"],
      ["src/runner.ts", "export const run = () => 1;\n"],
      ["src/index.ts", oldSharedDepsBarrel],
      ["src/config.test.ts", 'import { config } from "./index.ts";\nvoid config;\n'],
      ["src/run.test.ts", 'import { run } from "./index.ts";\nvoid run;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/index.ts", newSharedDepsBarrel);
    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/index.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(result.testFiles).toContain("src/config.test.ts");
    expect(result.testFiles).toContain("src/run.test.ts");

    // Re-export retargeted to an already-imported module still triggers module-level invalidation.
    const oldWithImports =
      'import { a } from "./setup.ts";\nimport { b } from "./other.ts";\nexport const both = [a, b];\nexport { config } from "./setup.ts";\n';
    const newWithImports =
      'import { a } from "./setup.ts";\nimport { b } from "./other.ts";\nexport const both = [a, b];\nexport { config } from "./other.ts";\n';
    expect(diffChangedExports("src/index.ts", oldWithImports, newWithImports, known).kind).toBe("all");

    // Adding a new re-export from the same already-loaded module remains symbol-scoped (preserving S2).
    const oldSameSource = 'export { config } from "./setup.ts";\nexport { run } from "./runner.ts";\n';
    const newSameSource = 'export { config, extra } from "./setup.ts";\nexport { run } from "./runner.ts";\n';
    expect(diffChangedExports("src/index.ts", oldSameSource, newSameSource, known)).toEqual({
      kind: "symbols",
      symbols: ["extra"],
    });
  });
});
