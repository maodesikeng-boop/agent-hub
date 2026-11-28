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

  it("rejects partial revert inside a single contiguous hunk while accepting full contiguous refinement", () => {
    const file = (hunks: ParsedFileDiff["hunks"]): ParsedFileDiff => ({ path: "content", binary: false, hunks });
    const ownLines5And6 = file([
      { oldStart: 5, oldCount: 2, newStart: 5, newCount: 2, addedLines: ["part1 line 5", "part1 line 6"] },
    ]);

    // Reverting line 5 while retaining line 6 leaves line 5 uncovered inside the original hunk.
    expect(
      hunksCoverOwnDiff(
        ownLines5And6,
        file([{ oldStart: 6, oldCount: 1, newStart: 6, newCount: 1, addedLines: ["part1 line 6"] }]),
      ),
    ).toBe(false);

    // Reverting line 6 while retaining line 5 also fails.
    expect(
      hunksCoverOwnDiff(
        ownLines5And6,
        file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["part1 line 5"] }]),
      ),
    ).toBe(false);

    // Reverting the middle line of a 3-line hunk fails even though both outer lines remain changed.
    const ownLines5To7 = file([
      { oldStart: 5, oldCount: 3, newStart: 5, newCount: 3, addedLines: ["p1 5", "p1 6", "p1 7"] },
    ]);
    expect(
      hunksCoverOwnDiff(
        ownLines5To7,
        file([
          { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["p1 5"] },
          { oldStart: 7, oldCount: 1, newStart: 7, newCount: 1, addedLines: ["p1 7"] },
        ]),
      ),
    ).toBe(false);

    // Legitimate refinement covering all lines (or a wider range) passes.
    expect(
      hunksCoverOwnDiff(
        ownLines5And6,
        file([{ oldStart: 5, oldCount: 2, newStart: 5, newCount: 2, addedLines: ["refined 5", "refined 6"] }]),
      ),
    ).toBe(true);
    expect(
      hunksCoverOwnDiff(
        ownLines5And6,
        file([{ oldStart: 4, oldCount: 4, newStart: 4, newCount: 4, addedLines: ["r4", "r5", "r6", "r7"] }]),
      ),
    ).toBe(true);

    // Dropping line 5 in favor of main's exact line 5 inside a merged 2-line hunk fails.
    expect(
      hunksCoverOwnDiff(
        ownLines5And6,
        file([{ oldStart: 5, oldCount: 2, newStart: 5, newCount: 2, addedLines: ["main line 5", "part1 line 6"] }]),
        file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["main line 5"] }]),
      ),
    ).toBe(false);

    // Non-conflicting main edit on adjacent line 4 merged into one hunk still covers own line 5.
    expect(
      hunksCoverOwnDiff(
        file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["part1 line 5"] }]),
        file([{ oldStart: 4, oldCount: 2, newStart: 4, newCount: 2, addedLines: ["main line 4", "part1 line 5"] }]),
        file([{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1, addedLines: ["main line 4"] }]),
      ),
    ).toBe(true);
  });

  it("excludes main-identical conflict lines in the interior of a contiguous hunk and splits remaining coverage", () => {
    const file = (hunks: ParsedFileDiff["hunks"]): ParsedFileDiff => ({ path: "target.txt", binary: false, hunks });
    const ownLine5 = file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["first edit 5"] }]);
    const mainLine5 = file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["main edit 5"] }]);

    // Dropping line 5 to main's exact line while editing surrounding lines 4 and 6 leaves line 5 uncovered.
    expect(
      hunksCoverOwnDiff(
        ownLine5,
        file([{ oldStart: 4, oldCount: 3, newStart: 4, newCount: 3, addedLines: ["other 4", "main edit 5", "other 6"] }]),
        mainLine5,
      ),
    ).toBe(false);

    // Same interior drop when surrounding line 4 also expands to two lines (non-1-to-1 containing hunk).
    expect(
      hunksCoverOwnDiff(
        ownLine5,
        file([
          {
            oldStart: 4,
            oldCount: 3,
            newStart: 4,
            newCount: 4,
            addedLines: ["other 4a", "other 4b", "main edit 5", "other 6"],
          },
        ]),
        mainLine5,
      ),
    ).toBe(false);

    // Same interior drop when main replaced line 5 with two lines and relay kept both verbatim inside [4..6].
    expect(
      hunksCoverOwnDiff(
        ownLine5,
        file([
          {
            oldStart: 4,
            oldCount: 3,
            newStart: 4,
            newCount: 4,
            addedLines: ["other 4", "main 5a", "main 5b", "other 6"],
          },
        ]),
        file([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 2, addedLines: ["main 5a", "main 5b"] }]),
      ),
    ).toBe(false);

    // Same interior drop when main touched [4..6] and relay refined 4 and 6 while keeping main's line 5 verbatim.
    expect(
      hunksCoverOwnDiff(
        ownLine5,
        file([{ oldStart: 4, oldCount: 3, newStart: 4, newCount: 3, addedLines: ["other 4", "main edit 5", "other 6"] }]),
        file([{ oldStart: 4, oldCount: 3, newStart: 4, newCount: 3, addedLines: ["main 4", "main edit 5", "main 6"] }]),
      ),
    ).toBe(false);

    // Same interior drop when main deleted line 5 and relay kept it deleted while editing lines 4 and 6.
    expect(
      hunksCoverOwnDiff(
        ownLine5,
        file([{ oldStart: 4, oldCount: 3, newStart: 4, newCount: 2, addedLines: ["other 4", "other 6"] }]),
        file([{ oldStart: 5, oldCount: 1, newStart: 4, newCount: 0, addedLines: [] }]),
      ),
    ).toBe(false);

    // Multiple interior main-identical lines inside one hunk leave only the genuinely edited segments covered.
    const containingMulti = file([
      { oldStart: 4, oldCount: 5, newStart: 4, newCount: 5, addedLines: ["r4", "main 5", "r6", "main 7", "r8"] },
    ]);
    const mainMulti = file([
      { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, addedLines: ["main 5"] },
      { oldStart: 7, oldCount: 1, newStart: 7, newCount: 1, addedLines: ["main 7"] },
    ]);
    expect(hunksCoverOwnDiff(ownLine5, containingMulti, mainMulti)).toBe(false);
    expect(
      hunksCoverOwnDiff(
        file([{ oldStart: 7, oldCount: 1, newStart: 7, newCount: 1, addedLines: ["first 7"] }]),
        containingMulti,
        mainMulti,
      ),
    ).toBe(false);
    expect(
      hunksCoverOwnDiff(
        file([{ oldStart: 6, oldCount: 1, newStart: 6, newCount: 1, addedLines: ["first 6"] }]),
        containingMulti,
        mainMulti,
      ),
    ).toBe(true);

    // Legitimate conflict resolution that combines/refines line 5 instead of keeping main's line still passes.
    expect(
      hunksCoverOwnDiff(
        ownLine5,
        file([{ oldStart: 4, oldCount: 3, newStart: 4, newCount: 3, addedLines: ["other 4", "combined 5", "other 6"] }]),
        mainLine5,
      ),
    ).toBe(true);
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
