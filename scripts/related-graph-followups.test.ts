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
      const scansRepoSources =
        /execFileSync\s*\(\s*["']git["']\s*,\s*\[[^\]]*ls-files[^\]]*(?:src|scripts|test)/.test(text) ||
        /readdir(?:Sync)?\s*\(\s*(?:["']src\b|["']scripts\b|["']test\b|join\s*\(\s*REPO_ROOT\s*,\s*["']src["']|srcDir)/.test(text);
      if (scansRepoSources) uncovered.push(file);
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
});
