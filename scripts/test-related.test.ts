import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAffectedTests, type VitestProjectSpec } from "./related-graph.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";
import {
  ALWAYS_RUN_TESTS,
  findReferencingFiles,
  formatExplainLines,
  listChangedFiles,
  referenceNeedles,
  sandboxSkipReport,
} from "./test-related.ts";

const TEST_PROJECTS: readonly VitestProjectSpec[] = [
  {
    name: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["src/web/**"],
  },
  {
    name: "web",
    include: ["src/web/**/*.test.{ts,tsx}"],
  },
];

describe("scripts/test-related.ts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
  }

  it("lists branch commits, staged, unstaged, and untracked files but not changes already on the base", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-related-"));
    dirs.push(repo);
    git(repo, "init", "-q", "-b", "main");
    for (const name of ["base.ts", "edited.ts", "staged.ts"]) writeFileSync(join(repo, name), "export {};\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "feature");
    mkdirSync(join(repo, "migrations"));
    writeFileSync(join(repo, "migrations", "0001.sql"), "select 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "feature");
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "base.ts"), "export const later = 1;\n");
    git(repo, "commit", "-q", "-am", "main moved on");
    git(repo, "checkout", "-q", "feature");
    writeFileSync(join(repo, "staged.ts"), "export const s = 1;\n");
    git(repo, "add", "staged.ts");
    writeFileSync(join(repo, "edited.ts"), "export const e = 1;\n");
    writeFileSync(join(repo, "new.ts"), "export {};\n");

    expect(listChangedFiles(repo, "main")).toEqual(["edited.ts", "migrations/0001.sql", "new.ts", "staged.ts"]);
  });

  it("lists more untracked paths than the default 1 MB child output buffer holds", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-related-"));
    dirs.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    const bulk = join(repo, "bulk");
    mkdirSync(bulk);
    const count = 6_000;
    for (let i = 0; i < count; i++) writeFileSync(join(bulk, `${String(i).padStart(5, "0")}-${"x".repeat(200)}.ts`), "");

    expect(listChangedFiles(repo, "main")).toHaveLength(count);
  });

  it("keeps a pnpm store created inside the worktree out of the change list", () => {
    expect(() => execFileSync("git", ["check-ignore", "-q", ".pnpm-store/v10/index"], { cwd: REPO_ROOT })).not.toThrow();
  });

  it("links runtime-loaded files by path and leaves code to the import graph", () => {
    expect(referenceNeedles("src/daemon/store/migrate.ts")).toEqual([]);
    expect(referenceNeedles("migrations/0046_x.sql")).toEqual(["migrations/0046_x.sql", "migrations/"]);
    expect(referenceNeedles("pnpm-lock.yaml")).toEqual(["pnpm-lock.yaml"]);
    expect(referenceNeedles("docs/ui-polish/baseline/style-brief.md")).toEqual(["docs/ui-polish/baseline/style-brief.md"]);
    expect(referenceNeedles("AGENTS.md")).toEqual([]);
  });

  it("finds the tests and modules that load a changed non-code file", () => {
    const sources = new Map([
      ["src/daemon/store/migrate.ts", 'new URL("../../../migrations/", import.meta.url)'],
      ["test/migration.test.ts", 'new URL("../migrations/0001_init.sql", import.meta.url)'],
      ["src/daemon/prompt.ts", "按 `docs/ui-polish/baseline/style-brief.md` 写"],
      ["test/ui-polish/rubric.test.ts", 'new URL("../../docs/ui-polish/baseline/style-brief.md", import.meta.url)'],
      ["src/web/App.tsx", "export {}"],
    ]);
    expect(findReferencingFiles(["migrations/0046_x.sql", "src/web/App.tsx"], sources)).toEqual([
      "src/daemon/store/migrate.ts",
      "test/migration.test.ts",
    ]);
    expect(findReferencingFiles(["docs/ui-polish/baseline/style-brief.md"], sources)).toEqual(["test/ui-polish/rubric.test.ts"]);
  });

  it("keeps package manifests and lockfiles scoped to referencing tests, scripts/, other changes, and guards without triggering fullSuite", () => {
    const baseSources = new Map([
      ["scripts/staged-lockfile.ts", 'export const lock = "pnpm-lock.yaml";\n'],
      ["scripts/staged-lockfile.test.ts", 'import { lock } from "./staged-lockfile.ts";\nvoid lock;\n'],
      ["scripts/stage-runtime-common.ts", 'export const pkg = "package.json";\n'],
      ["scripts/stage-runtime-common.test.ts", 'import { pkg } from "./stage-runtime-common.ts";\nvoid pkg;\n'],
      ["src/daemon/self-reload.ts", 'export const p = "package.json";\n'],
      ["src/daemon/self-reload.test.ts", 'export const f = "package.json";\n'],
      ["src/vendors/deepseek/driver.ts", 'export const p = "package.json";\n'],
      ["src/vendors/deepseek/driver.test.ts", 'import { p } from "./driver.ts";\nvoid p;\n'],
      ["test/smoke/setup.ts", 'export const s = "pnpm-lock.yaml";\n'],
      ["src/web/App.tsx", "export const app = 1;\n"],
      ["src/web/App.test.tsx", 'import { app } from "./App.tsx";\nvoid app;\n'],
      ["src/direct-dependencies.test.ts", "export {};\n"],
    ]);
    const currentSources = new Map(baseSources);
    currentSources.set("src/web/App.tsx", "export const app = 2;\n");

    const result = resolveAffectedTests({
      repoRoot: REPO_ROOT,
      baseRef: "origin/main",
      changedFiles: ["package.json", "pnpm-lock.yaml", ".agents/skills/poteto-mode/scripts/package.json", "src/web/App.tsx"],
      projects: TEST_PROJECTS,
      alwaysRunTests: ["src/direct-dependencies.test.ts"],
      sources: currentSources,
      readBaseFile: (p) => baseSources.get(p),
    });

    expect(result.fullSuite).toBe(false);
    expect(result.linkedByPath).toEqual(["scripts/stage-runtime-common.ts", "scripts/staged-lockfile.ts", "src/daemon/self-reload.test.ts"]);
    expect(result.testFiles).toEqual([
      "scripts/stage-runtime-common.test.ts",
      "scripts/staged-lockfile.test.ts",
      "src/daemon/self-reload.test.ts",
      "src/direct-dependencies.test.ts",
      "src/web/App.test.tsx",
    ]);
    expect(result.testFiles).not.toContain("src/vendors/deepseek/driver.test.ts");
  });

  it("triggers fullSuite when vitest, vite, or tsconfig files change", () => {
    const sources = new Map([["src/a.test.ts", "export {};\n"]]);
    for (const cfg of ["vitest.config.ts", "vitest.eval.config.ts", "vite.config.ts", "tsconfig.json"]) {
      const result = resolveAffectedTests({
        repoRoot: REPO_ROOT,
        baseRef: "origin/main",
        changedFiles: [cfg],
        projects: TEST_PROJECTS,
        alwaysRunTests: [],
        sources,
        readBaseFile: () => undefined,
      });
      expect(result.fullSuite, cfg).toBe(true);
    }
  });

  it("formats causal explanation lines for --explain including always-run guards", () => {
    const lines = formatExplainLines(
      {
        fullSuite: false,
        linkedByPath: [],
        testFiles: ["src/a.test.ts", "src/guard.test.ts"],
        totalTestFiles: 2,
        reasons: new Map([["src/a.test.ts", [{ changedFile: "src/a.ts", symbol: "foo", path: ["src/a.ts", "src/a.test.ts"] }]]]),
      },
      ["src/guard.test.ts"],
    );
    expect(lines).toEqual([
      "  src/a.test.ts  <- src/a.ts#foo (src/a.ts -> src/a.test.ts)",
      "  src/guard.test.ts  [always-run guard]",
    ]);
  });

  it("always runs guard tests that exist", () => {
    for (const file of ALWAYS_RUN_TESTS) expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
  });

  it("lists each sandbox-skipped test file once and asks to wait for CI before handoff", () => {
    expect(sandboxSkipReport("")).toBeUndefined();
    const report = sandboxSkipReport("test/e2e/m3.test.ts\ntest/eval/selftest.test.ts\ntest/e2e/m3.test.ts\n");
    expect(report?.split("\n")).toEqual([
      "test:related: the sandbox refused ps or a nested sandbox, so 2 test file(s) skipped tests that CI still runs:",
      "  test/e2e/m3.test.ts",
      "  test/eval/selftest.test.ts",
      "test:related: after you push, wait for the cloud checks with `node scripts/wait-checks.ts` before you hand off.",
    ]);
  });
});
