import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_RELATED_LOCAL_MAX_WORKERS } from "../src/shared/limits.ts";
import {
  analyzeModuleSource,
  diffChangedExports,
  ENV_TEST_MAX_WORKERS,
  loadVitestProjectSpecs,
  parseTestRelatedArgs,
  resolveAffectedTests,
  resolveLocalConcurrency,
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

function makeBaseReader(baseSources: ReadonlyMap<string, string>): (path: string) => string | undefined {
  return (path) => baseSources.get(path);
}

describe("scripts/related-graph.ts acceptance scenarios", () => {
  it("S1: scopes a single-constant edit in src/shared/limits.ts to consumers of that constant plus guards", () => {
    const oldLimits = [
      "export const FEISHU_CARD_MAX_BYTES = 10_000;",
      "export const UNRELATED_TIMEOUT_MS = 30_000;",
      "export const TEST_CHILD_EXIT_WAIT_MS = 5_000;",
    ].join("\n");
    const newLimits = [
      "export const FEISHU_CARD_MAX_BYTES = 20_000;",
      "export const UNRELATED_TIMEOUT_MS = 30_000;",
      "export const TEST_CHILD_EXIT_WAIT_MS = 5_000;",
    ].join("\n");

    const baseSources = new Map<string, string>([
      ["src/shared/limits.ts", oldLimits],
      ["src/shared/index.ts", 'export * from "./limits.ts";\n'],
      ["src/daemon/feishu/cards.ts", 'import { FEISHU_CARD_MAX_BYTES } from "../../shared/index.ts";\nexport const cap = () => FEISHU_CARD_MAX_BYTES;\n'],
      ["src/daemon/feishu/cards.test.ts", 'import { cap } from "./cards.ts";\nvoid cap;\n'],
      ["src/daemon/other.ts", 'import { UNRELATED_TIMEOUT_MS } from "../shared/index.ts";\nexport const t = () => UNRELATED_TIMEOUT_MS;\n'],
      ["src/daemon/other.test.ts", 'import { t } from "./other.ts";\nvoid t;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", 'import { TEST_CHILD_EXIT_WAIT_MS } from "../src/shared/limits.ts";\nvoid TEST_CHILD_EXIT_WAIT_MS;\n'],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/shared/limits.ts", newLimits);

    const diff = diffChangedExports("src/shared/limits.ts", oldLimits, newLimits, new Set(currentSources.keys()));
    expect(diff).toEqual({ kind: "symbols", symbols: ["FEISHU_CARD_MAX_BYTES"] });

    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/shared/limits.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });

    expect(result.fullSuite).toBe(false);
    expect(result.testFiles).toEqual(["src/daemon/feishu/cards.test.ts", "src/guard.test.ts"]);
    expect(result.testFiles).not.toContain("src/daemon/other.test.ts");
  });

  it("S2: traverses export * and named re-export barrels by symbol without cross-contaminating unrelated modules", () => {
    const oldHandover = "export function buildHandover() { return 1; }\n";
    const newHandover = "export function buildHandover() { return 2; }\n";
    const oldPlatformBarrel = 'export { sleepFn } from "./sleep.ts";\nexport { fsFn } from "./fs.ts";\n';
    const newPlatformBarrel = 'export { sleepFn } from "./sleep.ts";\nexport { fsFn, newFsFn } from "./fs.ts";\n';

    const baseSources = new Map<string, string>([
      ["src/shared/handover.ts", oldHandover],
      ["src/shared/other.ts", "export function otherHelper() { return 1; }\n"],
      ["src/shared/index.ts", 'export * from "./handover.ts";\nexport * from "./other.ts";\n'],
      ["src/daemon/handover.test.ts", 'import { buildHandover } from "../shared/index.ts";\nvoid buildHandover;\n'],
      ["src/daemon/other.test.ts", 'import { otherHelper } from "../shared/index.ts";\nvoid otherHelper;\n'],
      ["src/daemon/namespace.test.ts", 'import * as shared from "../shared/index.ts";\nvoid shared;\n'],
      ["src/daemon/platform/sleep.ts", "export function sleepFn() { return 1; }\n"],
      ["src/daemon/platform/fs.ts", "export function fsFn() { return 1; }\nexport function newFsFn() { return 2; }\n"],
      ["src/daemon/platform/index.ts", oldPlatformBarrel],
      ["src/daemon/platform/sleep.test.ts", 'import { sleepFn } from "./index.ts";\nvoid sleepFn;\n'],
      ["src/daemon/platform/fs.test.ts", 'import { newFsFn } from "./index.ts";\nvoid newFsFn;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);

    const handoverCurrent = new Map(baseSources);
    handoverCurrent.set("src/shared/handover.ts", newHandover);
    const handoverResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/shared/handover.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: handoverCurrent,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(handoverResult.testFiles).toEqual(["src/daemon/handover.test.ts", "src/daemon/namespace.test.ts", "src/guard.test.ts"]);

    const barrelCurrent = new Map(baseSources);
    barrelCurrent.set("src/daemon/platform/index.ts", newPlatformBarrel);
    const barrelResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/daemon/platform/index.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: barrelCurrent,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(barrelResult.testFiles).toEqual(["src/daemon/platform/fs.test.ts", "src/guard.test.ts"]);
    expect(barrelResult.testFiles).not.toContain("src/daemon/platform/sleep.test.ts");
  });

  it("S3: propagates intra-file helpers and shared state, fails closed on top-level side effects, and ignores type-only edits", () => {
    const known = new Set(["src/mod.ts"]);

    const oldHelper = [
      "const helper = () => 1;",
      "export function foo() { return helper(); }",
      "export function baz() { return 9; }",
    ].join("\n");
    const newHelper = [
      "const helper = () => 2;",
      "export function foo() { return helper(); }",
      "export function baz() { return 9; }",
    ].join("\n");
    expect(diffChangedExports("src/mod.ts", oldHelper, newHelper, known)).toEqual({
      kind: "symbols",
      symbols: ["foo"],
    });

    const oldSharedState = [
      "const cache = new Map<string, number>();",
      "export function setVal(k: string, v: number) { cache.set(k, v); }",
      "export function getVal(k: string) { return cache.get(k); }",
      "export function pure() { return 1; }",
    ].join("\n");
    const newSharedState = [
      "const cache = new Map<string, number>([['a', 1]]);",
      "export function setVal(k: string, v: number) { cache.set(k, v); }",
      "export function getVal(k: string) { return cache.get(k); }",
      "export function pure() { return 1; }",
    ].join("\n");
    const stateDiff = diffChangedExports("src/mod.ts", oldSharedState, newSharedState, known);
    expect(stateDiff.kind).toBe("symbols");
    if (stateDiff.kind === "symbols") {
      expect([...stateDiff.symbols].sort()).toEqual(["getVal", "setVal"]);
    }

    const oldSideEffect = "console.log('a');\nexport const x = 1;\n";
    const newSideEffect = "console.log('b');\nexport const x = 1;\n";
    expect(diffChangedExports("src/mod.ts", oldSideEffect, newSideEffect, known).kind).toBe("all");

    const oldTypeOnly = "export interface Item { id: string; }\nexport function fn(x: Item): string { return x.id; }\n";
    const newTypeOnly = "// updated comment\nexport interface Item { id: string; label?: string; }\nexport function fn(x: Item): string { return x.id; }\n";
    expect(diffChangedExports("src/mod.ts", oldTypeOnly, newTypeOnly, known)).toEqual({ kind: "none" });
  });

  it("S4: keeps test/clean-env.ts and test/spawn-guard.ts free of mega-hubs and expands project tests only when a setupFile dependency changes", () => {
    const repoFiles = execFileSync("git", ["ls-files", "-z", "--", "src", "scripts", "test"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && existsSync(resolve(REPO_ROOT, f)));
    const known = new Set(repoFiles);

    const transitiveImportsOf = (entry: string): Set<string> => {
      const visited = new Set<string>([entry]);
      const queue = [entry];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        const summary = analyzeModuleSource(cur, readFileSync(resolve(REPO_ROOT, cur), "utf8"), known);
        for (const edge of summary.imports) {
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            queue.push(edge.target);
          }
        }
        for (const edge of summary.reexports) {
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            queue.push(edge.target);
          }
        }
      }
      return visited;
    };

    const cleanEnvClosure = transitiveImportsOf("test/clean-env.ts");
    expect(cleanEnvClosure.has("src/shared/index.ts")).toBe(false);
    expect(cleanEnvClosure.has("src/shared/limits.ts")).toBe(false);
    expect(cleanEnvClosure.has("src/daemon/driver/protocol.ts")).toBe(false);

    const spawnGuardClosure = transitiveImportsOf("test/spawn-guard.ts");
    expect(spawnGuardClosure.has("src/shared/limits.ts")).toBe(false);

    const oldQueryClient = "export function resetQueryClient() { return 1; }\nexport function claimAccountTicket() { return 1; }\n";
    const editClaimOnly = "export function resetQueryClient() { return 1; }\nexport function claimAccountTicket() { return 2; }\n";
    const editReset = "export function resetQueryClient() { return 9; }\nexport function claimAccountTicket() { return 1; }\n";

    const baseSources = new Map<string, string>([
      ["src/web/query-client.ts", oldQueryClient],
      ["src/web/test-setup.ts", 'import { resetQueryClient } from "./query-client.ts";\nvoid resetQueryClient;\n'],
      ["src/web/account.test.tsx", 'import { claimAccountTicket } from "./query-client.ts";\nvoid claimAccountTicket;\n'],
      ["src/web/unrelated.test.tsx", "export const ok = 1;\n"],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);

    const claimSources = new Map(baseSources);
    claimSources.set("src/web/query-client.ts", editClaimOnly);
    const claimResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/web/query-client.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: claimSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(claimResult.testFiles).toEqual(["src/guard.test.ts", "src/web/account.test.tsx"]);

    const resetSources = new Map(baseSources);
    resetSources.set("src/web/query-client.ts", editReset);
    const resetResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/web/query-client.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: resetSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(resetResult.testFiles).toEqual(["src/guard.test.ts", "src/web/account.test.tsx", "src/web/unrelated.test.tsx"]);
  });

  it("S5: bridges dynamic importVendorFile edges for any vendor daemon.ts and paths.ts without hardcoding vendor names", () => {
    const oldDaemon = "export default { createDriver: () => 1 };\n";
    const newDaemon = "export default { createDriver: () => 2 };\n";
    const baseSources = new Map<string, string>([
      ["src/vendors/acme/daemon.ts", oldDaemon],
      ["src/vendors/acme/paths.ts", "export const parentSessionEnv = ['ACME_PID'];\n"],
      ["src/vendors/load.ts", "export function importVendorFile(id: string, file: string) { return import(`./${id}/${file}`); }\n"],
      ["src/vendors/daemon-registry.ts", 'import { importVendorFile } from "./load.ts";\nexport const VENDOR_DAEMONS = importVendorFile;\n'],
      ["src/vendors/paths-registry.ts", 'import { importVendorFile } from "./load.ts";\nexport const VENDOR_PATHS = importVendorFile;\n'],
      ["src/daemon/multi-vendor.test.ts", 'import { VENDOR_DAEMONS } from "../vendors/daemon-registry.ts";\nvoid VENDOR_DAEMONS;\n'],
      ["src/daemon/paths.test.ts", 'import { VENDOR_PATHS } from "../vendors/paths-registry.ts";\nvoid VENDOR_PATHS;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/vendors/acme/daemon.ts", newDaemon);

    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/vendors/acme/daemon.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });

    expect(result.testFiles).toContain("src/daemon/multi-vendor.test.ts");
    expect(result.testFiles).not.toContain("src/daemon/paths.test.ts");
  });

  it("S6: fails closed to fullSuite on config edits while keeping package manifests scoped and linking migrations", () => {
    const baseSources = new Map<string, string>([
      ["src/daemon/store/migrate.ts", 'export const dir = "migrations/";\n'],
      ["src/daemon/store/migrate.test.ts", 'import { dir } from "./migrate.ts";\nvoid dir;\n'],
      ["scripts/staged-lockfile.ts", 'export const lock = "pnpm-lock.yaml";\n'],
      ["scripts/staged-lockfile.test.ts", 'import { lock } from "./staged-lockfile.ts";\nvoid lock;\n'],
      ["src/daemon/unrelated.ts", 'export const x = "package.json";\n'],
      ["src/daemon/unrelated.test.ts", 'import { x } from "./unrelated.ts";\nvoid x;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);

    const configResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["vitest.config.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: baseSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(configResult.fullSuite).toBe(true);

    const manifestResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["package.json", "pnpm-lock.yaml"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: baseSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(manifestResult.fullSuite).toBe(false);
    expect(manifestResult.testFiles).toEqual(["scripts/staged-lockfile.test.ts", "src/guard.test.ts"]);

    const migrationResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["migrations/0060_pm_watches.sql"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: baseSources,
      readBaseFile: makeBaseReader(baseSources),
    });
    expect(migrationResult.testFiles).toContain("src/daemon/store/migrate.test.ts");
  });

  it("S7: fails closed on syntax errors, added/deleted files, and rejects invalid concurrency env values", () => {
    const known = new Set(["src/broken.ts", "src/added.ts", "src/deleted.ts"]);

    const brokenSummary = analyzeModuleSource("src/broken.ts", "export function {{{", known);
    expect(brokenSummary.parseFailed).toBe(true);
    expect(diffChangedExports("src/broken.ts", "export const a = 1;", "export function {{{", known).kind).toBe("all");
    expect(diffChangedExports("src/added.ts", undefined, "export const a = 1;", known).kind).toBe("all");
    expect(diffChangedExports("src/deleted.ts", "export const a = 1;", undefined, known).kind).toBe("all");

    expect(() =>
      resolveLocalConcurrency({
        vitestArgs: [],
        env: { [ENV_TEST_MAX_WORKERS]: "0" },
        cpuCount: 10,
        testFileCount: 20,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveLocalConcurrency({
        vitestArgs: [],
        env: { [ENV_TEST_MAX_WORKERS]: "abc" },
        cpuCount: 10,
        testFileCount: 20,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toThrow(RangeError);
  });

  it("S8: bounds local concurrency by CPU and file count while honoring CLI, env, and CI precedence plus diagnostic flags", () => {
    expect(
      resolveLocalConcurrency({
        vitestArgs: [],
        env: {},
        cpuCount: 10,
        testFileCount: 20,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toEqual({
      maxWorkers: 4,
      source: "local-default",
      extraArgs: ["--maxWorkers", "4"],
    });

    expect(
      resolveLocalConcurrency({
        vitestArgs: [],
        env: {},
        cpuCount: 4,
        testFileCount: 20,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toEqual({
      maxWorkers: 2,
      source: "local-default",
      extraArgs: ["--maxWorkers", "2"],
    });

    expect(
      resolveLocalConcurrency({
        vitestArgs: [],
        env: {},
        cpuCount: 10,
        testFileCount: 2,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toEqual({
      maxWorkers: 2,
      source: "local-default",
      extraArgs: ["--maxWorkers", "2"],
    });

    expect(
      resolveLocalConcurrency({
        vitestArgs: ["--maxWorkers=6"],
        env: { [ENV_TEST_MAX_WORKERS]: "2" },
        cpuCount: 10,
        testFileCount: 20,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toEqual({
      maxWorkers: undefined,
      source: "cli",
      extraArgs: [],
    });

    expect(
      resolveLocalConcurrency({
        vitestArgs: [],
        env: { [ENV_TEST_MAX_WORKERS]: "3" },
        cpuCount: 10,
        testFileCount: 20,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toEqual({
      maxWorkers: 3,
      source: "env",
      extraArgs: ["--maxWorkers", "3"],
    });

    expect(
      resolveLocalConcurrency({
        vitestArgs: [],
        env: { CI: "true" },
        cpuCount: 4,
        testFileCount: 20,
        maxWorkersCap: TEST_RELATED_LOCAL_MAX_WORKERS,
      }),
    ).toEqual({
      maxWorkers: undefined,
      source: "ci",
      extraArgs: [],
    });

    expect(parseTestRelatedArgs(["--base", "main", "--dry-run", "--explain", "--reporter=dot"])).toEqual({
      base: "main",
      dryRun: true,
      explain: true,
      vitestArgs: ["--reporter=dot"],
    });
  });

  it("S9: resolves real repository fan-out for a single limits constant under 100 files and keeps every guard", async () => {
    const projects = await loadVitestProjectSpecs(REPO_ROOT);
    expect(projects.map((p) => p.name)).toEqual(["node", "cloudflare", "web"]);

    const repoFiles = execFileSync("git", ["ls-files", "-z", "--", "src", "scripts", "test"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && existsSync(resolve(REPO_ROOT, f)));
    const baseSources = new Map<string, string>(repoFiles.map((f) => [f, readFileSync(resolve(REPO_ROOT, f), "utf8")]));
    const currentSources = new Map(baseSources);
    const oldLimits = baseSources.get("src/shared/limits.ts")!;
    const newLimits = oldLimits.replace("FEISHU_CARD_MAX_BYTES = 30_000", "FEISHU_CARD_MAX_BYTES = 31_000");
    expect(newLimits).not.toBe(oldLimits);
    currentSources.set("src/shared/limits.ts", newLimits);

    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/shared/limits.ts"],
      projects,
      alwaysRunTests: ALWAYS_RUN_TESTS,
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });

    expect(result.fullSuite).toBe(false);
    expect(result.totalTestFiles).toBeGreaterThanOrEqual(590);
    expect(result.testFiles.length).toBeLessThan(100);
    for (const guard of ALWAYS_RUN_TESTS) expect(result.testFiles).toContain(guard);
    expect(result.reasons.size).toBeGreaterThan(0);
  });

  it("S10: normalizes Windows paths and honors win32 Vitest project exclusions", () => {
    const projects: readonly VitestProjectSpec[] = [
      {
        name: "node",
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        exclude: ["test/eval/isolation.test.ts", "test/eval/cli.test.ts"],
      },
    ];
    const baseSources = new Map<string, string>([
      ["test/eval/shared.ts", "export const v = 1;\n"],
      ["test/eval/isolation.test.ts", 'import { v } from "./shared.ts";\nvoid v;\n'],
      ["test/eval/other.test.ts", 'import { v } from "./shared.ts";\nvoid v;\n'],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("test/eval/shared.ts", "export const v = 2;\n");

    const winResult = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["test\\eval\\shared.ts"],
      projects,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
      platform: "win32",
    });

    expect(winResult.testFiles).toEqual(["src/guard.test.ts", "test/eval/other.test.ts"]);
    expect(winResult.testFiles).not.toContain("test/eval/isolation.test.ts");
  });

  it("S11: treats dynamic import() and vi.mock/doMock/unmock/importActual/importMock as fail-closed whole-file edges while ignoring TSImportType", () => {
    const oldTarget = "export const alpha = 1;\nexport const beta = 2;\nexport interface TargetShape { id: string; }\n";
    const newTarget = "export const alpha = 99;\nexport const beta = 2;\nexport interface TargetShape { id: string; }\n";

    const baseSources = new Map<string, string>([
      ["src/mod/target.ts", oldTarget],
      ["src/mod/mock-str.test.ts", 'import { vi } from "vitest";\nvi.mock("./target.ts", () => ({ beta: 2 }));\n'],
      ["src/mod/domock.test.ts", 'import { vi } from "vitest";\nvi.doMock("./target.ts", () => ({ beta: 2 }));\n'],
      ["src/mod/unmock.test.ts", 'import { vi } from "vitest";\nvi.unmock("./target.ts");\n'],
      ["src/mod/import-actual.test.ts", 'import { vi } from "vitest";\nexport const load = () => vi.importActual("./target.ts");\n'],
      ["src/mod/import-mock.test.ts", 'import { vi } from "vitest";\nexport const load = () => vi.importMock("./target.ts");\n'],
      ["src/mod/dynamic-import.test.ts", 'export const load = () => import("./target.ts");\n'],
      ["src/mod/mock-import.test.ts", 'import { vi } from "vitest";\nvi.mock(import("./target.ts"), () => ({ beta: 2 }));\n'],
      ["src/mod/type-only-import.ts", 'export function shape(): import("./target.ts").TargetShape { return { id: "1" }; }\n'],
      ["src/mod/type-only-import.test.ts", 'import { shape } from "./type-only-import.ts";\nvoid shape;\n'],
      ["test/clean-env.ts", "export {};\n"],
      ["test/spawn-guard.ts", "export {};\n"],
      ["src/web/test-setup.ts", "export {};\n"],
      ["src/guard.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/mod/target.ts", newTarget);
    const known = new Set(currentSources.keys());

    for (const file of [
      "src/mod/mock-str.test.ts",
      "src/mod/domock.test.ts",
      "src/mod/unmock.test.ts",
      "src/mod/import-actual.test.ts",
      "src/mod/import-mock.test.ts",
      "src/mod/dynamic-import.test.ts",
      "src/mod/mock-import.test.ts",
    ]) {
      const summary = analyzeModuleSource(file, currentSources.get(file)!, known);
      expect(summary.imports, file).toContainEqual({ target: "src/mod/target.ts", imported: "*", local: null });
    }
    const typeOnlySummary = analyzeModuleSource("src/mod/type-only-import.ts", currentSources.get("src/mod/type-only-import.ts")!, known);
    expect(typeOnlySummary.imports).toEqual([]);

    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["src/mod/target.ts"],
      projects: SYNTHETIC_PROJECTS,
      alwaysRunTests: ["src/guard.test.ts"],
      sources: currentSources,
      readBaseFile: makeBaseReader(baseSources),
    });

    expect(result.testFiles).toEqual([
      "src/guard.test.ts",
      "src/mod/domock.test.ts",
      "src/mod/dynamic-import.test.ts",
      "src/mod/import-actual.test.ts",
      "src/mod/import-mock.test.ts",
      "src/mod/mock-import.test.ts",
      "src/mod/mock-str.test.ts",
      "src/mod/unmock.test.ts",
    ]);
    expect(result.testFiles).not.toContain("src/mod/type-only-import.test.ts");
  });
});
