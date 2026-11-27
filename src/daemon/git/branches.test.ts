import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBranchSquashMergedToMain } from "./index.ts";

let root: string;
let emptyGitConfig: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_SYSTEM: emptyGitConfig },
  }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "squash 检测 "));
  emptyGitConfig = join(root, ".empty-gitconfig");
  writeFileSync(emptyGitConfig, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

function readme(edits: Record<number, string>): string {
  return `${LINES.map((l, i) => edits[i + 1] ?? l).join("\n")}\n`;
}

function makeRepo(): { repo: string; base: string } {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), readme({}));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

function commitFiles(repo: string, files: Record<string, string>, message: string): string {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function squashInto(repo: string, branch: string, message: string): string {
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--squash", branch);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full).map((f) => `${entry}/${f}`));
    else out.push(entry);
  }
  return out.sort();
}

/** Every object file and ref in the repository, so a check that writes anything shows up as a difference. */
function repoSnapshot(repo: string): { objects: string[]; refs: string } {
  return { objects: listFiles(join(repo, ".git", "objects")), refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)") };
}

describe("isBranchSquashMergedToMain judges by content", () => {
  it("recognizes a squash merge after main changed the same file before and after the merge", async () => {
    const { repo, base } = makeRepo();
    git(repo, "checkout", "-q", "-b", "hub/1-feat");
    commitFiles(repo, { "README.md": readme({ 5: "feature" }) }, "feat");
    git(repo, "checkout", "-q", "main");
    // Another PR edits a nearby line first, so the squash commit's context lines differ from the branch's diff.
    commitFiles(repo, { "README.md": readme({ 3: "other PR" }) }, "other PR");
    squashInto(repo, "hub/1-feat", "feat (#1)");
    // A later PR rewrites the same line, so merging the branch into today's main would conflict.
    commitFiles(repo, { "README.md": readme({ 3: "other PR", 5: "feature v2" }) }, "later PR");

    const before = repoSnapshot(repo);
    expect(await isBranchSquashMergedToMain(repo, "hub/1-feat", base)).toBe(true);
    expect(repoSnapshot(repo)).toEqual(before);
  });

  it("recognizes earlier relay branches of one squash-merged PR through the PR head ref that contains them", async () => {
    const { repo, base } = makeRepo();
    git(repo, "checkout", "-q", "-b", "hub/2-impl");
    commitFiles(repo, { "README.md": readme({ 9: "impl" }), "g.txt": "v1\n" }, "impl");
    git(repo, "checkout", "-q", "-b", "hub/3-review");
    git(repo, "checkout", "-q", "-b", "hub/4-fix");
    commitFiles(repo, { "g.txt": "v2\n", "h.txt": "fix\n" }, "fix review findings");
    const prHead = git(repo, "rev-parse", "HEAD");
    // Each relay Worker pushed to the PR branch named after the first Worker; the fix Worker's local branch is already gone.
    git(repo, "update-ref", "refs/remotes/origin/hub/2-impl", prHead);
    squashInto(repo, "hub/4-fix", "impl (#2)");
    git(repo, "branch", "-q", "-D", "hub/4-fix");

    const before = repoSnapshot(repo);
    expect(await isBranchSquashMergedToMain(repo, "hub/2-impl", base)).toBe(true);
    expect(await isBranchSquashMergedToMain(repo, "hub/3-review", base)).toBe(true);
    expect(repoSnapshot(repo)).toEqual(before);
  });

  it("never reports a branch with changes missing from main as merged", async () => {
    const { repo, base } = makeRepo();

    git(repo, "checkout", "-q", "-b", "hub/10-wip");
    commitFiles(repo, { "wip.txt": "wip\n" }, "wip");
    git(repo, "checkout", "-q", "main");
    expect(await isBranchSquashMergedToMain(repo, "hub/10-wip", base)).toBe(false);

    // Part 1 was squash-merged, then the branch kept going with a commit that never reached main.
    git(repo, "checkout", "-q", "-b", "hub/11-more", base);
    commitFiles(repo, { "p.txt": "1\n" }, "part 1");
    squashInto(repo, "hub/11-more", "part 1 (#11)");
    git(repo, "checkout", "-q", "hub/11-more");
    commitFiles(repo, { "p.txt": "1\n2\n" }, "part 2");
    git(repo, "checkout", "-q", "main");
    expect(await isBranchSquashMergedToMain(repo, "hub/11-more", base)).toBe(false);

    // Main holds a different version of the same line.
    git(repo, "checkout", "-q", "-b", "hub/12-conflict", base);
    commitFiles(repo, { "README.md": readme({ 1: "branch" }) }, "branch edit");
    git(repo, "checkout", "-q", "main");
    commitFiles(repo, { "README.md": readme({ 1: "main" }) }, "main edit");
    expect(await isBranchSquashMergedToMain(repo, "hub/12-conflict", base)).toBe(false);

    // A ref containing the branch does not vouch for it unless that ref itself reached main.
    git(repo, "checkout", "-q", "-b", "hub/13-relay", base);
    commitFiles(repo, { "r.txt": "r1\n" }, "relay 1");
    git(repo, "checkout", "-q", "-b", "hub/14-relay-next");
    commitFiles(repo, { "r.txt": "r2\n" }, "relay 2");
    git(repo, "update-ref", "refs/remotes/origin/hub/13-relay", git(repo, "rev-parse", "HEAD"));
    git(repo, "checkout", "-q", "main");
    expect(await isBranchSquashMergedToMain(repo, "hub/13-relay", base)).toBe(false);

    // The branch deleted a file that main still has.
    git(repo, "checkout", "-q", "-b", "hub/15-delete", base);
    git(repo, "rm", "-q", "README.md");
    git(repo, "commit", "-q", "-m", "delete readme");
    git(repo, "checkout", "-q", "main");
    expect(await isBranchSquashMergedToMain(repo, "hub/15-delete", base)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("falls back to the patch-id check when git has no merge-tree --write-tree", async () => {
    const { repo, base } = makeRepo();
    git(repo, "checkout", "-q", "-b", "hub/20-simple");
    commitFiles(repo, { "s.txt": "s\n" }, "simple");
    squashInto(repo, "hub/20-simple", "simple (#20)");
    git(repo, "checkout", "-q", "-b", "hub/21-wip", base);
    commitFiles(repo, { "w.txt": "w\n" }, "wip");
    git(repo, "checkout", "-q", "main");

    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(root, "old-git-bin");
    const refused = join(root, "refused.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--write-tree" ] && { echo x >> "${refused}"; echo "usage: git merge-tree <base-tree> <branch1> <branch2>" >&2; exit 129; }; done\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);

    expect(await isBranchSquashMergedToMain(repo, "hub/20-simple", base)).toBe(true);
    expect(await isBranchSquashMergedToMain(repo, "hub/21-wip", base)).toBe(false);
    expect(readFileSync(refused, "utf8")).not.toBe("");
  });
});
