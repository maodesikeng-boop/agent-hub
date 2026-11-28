import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hunksCoverOwnDiff,
  parseRawTreeDiff,
  parseUnifiedZeroHunks,
  verifyRelayCarriesChanges,
  type ParsedFileDiff,
} from "./relay-carry.ts";

describe("relay-carry pure diff contracts", () => {
  it("parses NUL-delimited git diff-tree --raw output including spaces and non-ASCII paths", () => {
    const raw =
      ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\0docs/测试 file.md\0" +
      ":000000 100644 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 A\0added.txt\0";
    const parsed = parseRawTreeDiff(raw);
    expect(parsed.get("docs/测试 file.md")).toEqual({
      path: "docs/测试 file.md",
      oldMode: "100644",
      newMode: "100644",
      oldOid: "1111111111111111111111111111111111111111",
      newOid: "2222222222222222222222222222222222222222",
      status: "M",
    });
    expect(parsed.get("added.txt")?.status).toBe("A");
  });

  it("parses zero-context unified diff hunks and flags binary diffs", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -5 +5 @@",
      "-line 5",
      "+feature A",
      "@@ -10,0 +11,2 @@",
      "+added 1",
      "+added 2",
      "diff --git a/asset.bin b/asset.bin",
      "Binary files a/asset.bin and b/asset.bin differ",
      "",
    ].join("\n");
    const parsed = parseUnifiedZeroHunks(diff);
    expect(parsed.get("README.md")).toEqual({
      path: "README.md",
      binary: false,
      hunks: [
        { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["feature A"] },
        { oldStart: 10, oldCount: 0, newStart: 11, newCount: 2, addedLines: ["added 1", "added 2"] },
      ],
    });
    expect(parsed.get("asset.bin")?.binary).toBe(true);
  });

  it("rejects disjoint, adjacent-line, partial-revert, binary, and main-identical conflict hunks", () => {
    const file = (hunks: ParsedFileDiff["hunks"], binary = false): ParsedFileDiff => ({
      path: "README.md",
      binary,
      hunks,
    });
    const ownLine5 = file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["feat A"] }]);

    expect(hunksCoverOwnDiff(ownLine5, file([{ oldStart: 9, oldCount: 1, newStart: 9, newCount: 1, addedLines: ["other"] }]))).toBe(false);
    expect(hunksCoverOwnDiff(ownLine5, file([{ oldStart: 6, oldCount: 1, newStart: 6, newCount: 1, addedLines: ["adjacent"] }]))).toBe(false);
    expect(hunksCoverOwnDiff(ownLine5, file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["feat A v2"] }]))).toBe(true);

    const ownTwo = file([
      { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["feat A"] },
      { oldStart: 9, oldCount: 1, newStart: 9, newCount: 1, addedLines: ["feat B"] },
    ]);
    expect(hunksCoverOwnDiff(ownTwo, file([{ oldStart: 9, oldCount: 1, newStart: 9, newCount: 1, addedLines: ["feat B v2"] }]))).toBe(false);

    const mainLine5 = file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["main edit"] }]);
    expect(hunksCoverOwnDiff(ownLine5, mainLine5, mainLine5)).toBe(false);
    expect(hunksCoverOwnDiff(file([], true), file([], true))).toBe(false);
  });

  it("verifies relay content preservation across a 50-file branch without invoking external diff drivers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-hub-relay-carry-"));
    try {
      const emptyCfg = join(dir, ".empty-gitconfig");
      writeFileSync(emptyCfg, "");
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_SYSTEM: emptyCfg },
        }).trim();
      git("init", "-q", "-b", "main");
      for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), "a\nb\nc\nd\ne\n");
      git("add", "-A");
      git("commit", "-q", "-m", "init");
      const base = git("rev-parse", "HEAD");

      git("checkout", "-q", "-b", "hub/1-many");
      for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), "a\nb-edit\nc\nd\ne\n");
      git("add", "-A");
      git("commit", "-q", "-m", "edit 50 files");
      const branchCommit = git("rev-parse", "HEAD");

      git("checkout", "-q", "-b", "hub/2-many");
      writeFileSync(join(dir, "f49.txt"), "a\nb-refined\nc\nd\ne\n");
      git("add", "-A");
      git("commit", "-q", "-m", "refine file 49");
      const containingCommit = git("rev-parse", "HEAD");

      expect(
        await verifyRelayCarriesChanges({
          repoFolder: dir,
          timeoutMs: 10_000,
          ownMergeBase: base,
          branchCommit,
          containingMergeBase: base,
          containingCommit,
        }),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
