import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./stage-runtime-common.ts";
import { ALWAYS_RUN_TESTS, findReferencingFiles, listChangedFiles, referenceNeedles } from "./test-related.ts";

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

  it("always runs guard tests that exist", () => {
    for (const file of ALWAYS_RUN_TESTS) expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
  });
});
