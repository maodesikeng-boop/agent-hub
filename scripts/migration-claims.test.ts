import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_MANIFEST } from "../src/daemon/store/migrate.ts";
import {
  checkMigrationClaims,
  formatClaimReport,
  latestManifestVersion,
  migrationClaimsOf,
  nextFreeVersion,
  type ClaimCheckInput,
} from "./migration-claims.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

const HASH = "0".repeat(64);
const MANIFEST_54 = Array.from({ length: 54 }, (_, i) => `${HASH}  ${String(i + 1).padStart(4, "0")}_m${i + 1}.sql`).join("\n") + "\n";

function input(overrides: Partial<ClaimCheckInput> = {}): ClaimCheckInput {
  return {
    pr: 20,
    files: ["migrations/0055_mine.sql", "migrations/manifest.sha256", "src/daemon/store/x.ts"],
    filesTruncated: false,
    mainManifest: MANIFEST_54,
    openPrs: [],
    openPrsTruncated: false,
    ...overrides,
  };
}

describe("migrationClaimsOf", () => {
  it("keeps numbered migration files in input order and ignores the manifest and other paths", () => {
    expect(migrationClaimsOf(7, ["src/a.ts", "migrations/0056_b.sql", "migrations/manifest.sha256", "migrations/0055_a.sql"])).toEqual([
      { pr: 7, version: 56, file: "migrations/0056_b.sql" },
      { pr: 7, version: 55, file: "migrations/0055_a.sql" },
    ]);
  });

  it("ignores migration-like names without a number or outside migrations/", () => {
    expect(migrationClaimsOf(7, ["migrations/notes.sql", "migrations/sub/0055_a.sql", "docs/0055_a.sql", "migrations/0055_a.sql.bak"])).toEqual([]);
  });
});

describe("latestManifestVersion", () => {
  it("returns the highest listed version and 0 for an empty manifest", () => {
    expect(latestManifestVersion(MANIFEST_54)).toBe(54);
    expect(latestManifestVersion("")).toBe(0);
  });

  it("throws on a malformed manifest line instead of guessing", () => {
    expect(() => latestManifestVersion(`${HASH}  0001_a.sql\nnot a manifest line\n`)).toThrow(/line 2/u);
  });

  it("reads the real manifest on this branch", () => {
    const manifest = readFileSync(join(REPO_ROOT, "migrations", MIGRATION_MANIFEST), "utf8");
    expect(latestManifestVersion(manifest)).toBeGreaterThanOrEqual(54);
  });
});

describe("nextFreeVersion", () => {
  it("skips every version another open PR already claims", () => {
    expect(nextFreeVersion(54, [])).toBe(55);
    expect(
      nextFreeVersion(54, [
        { pr: 1, version: 55, file: "migrations/0055_a.sql" },
        { pr: 2, version: 56, file: "migrations/0056_b.sql" },
        { pr: 3, version: 58, file: "migrations/0058_c.sql" },
      ]),
    ).toBe(57);
  });
});

describe("checkMigrationClaims", () => {
  it("passes a PR whose numbers are above main and unclaimed by lower-numbered open PRs", () => {
    expect(checkMigrationClaims(input())).toEqual({ kind: "ok", claims: [{ pr: 20, version: 55, file: "migrations/0055_mine.sql" }] });
  });

  it("passes a PR that adds no migration", () => {
    expect(checkMigrationClaims(input({ files: ["src/a.ts"] }))).toEqual({ kind: "ok", claims: [] });
  });

  it("reports a number that main already has, which is also how editing a merged migration shows up", () => {
    const result = checkMigrationClaims(input({ files: ["migrations/0054_mine.sql", "migrations/0050_m50.sql"] }));
    expect(result).toEqual({
      kind: "conflict",
      conflicts: [
        { kind: "on-main", version: 54, file: "migrations/0054_mine.sql", mainLatest: 54 },
        { kind: "on-main", version: 50, file: "migrations/0050_m50.sql", mainLatest: 54 },
      ],
      next: 55,
    });
  });

  it("makes the higher-numbered PR renumber when two open PRs add the same version", () => {
    const openPrs = [
      { pr: 10, files: ["migrations/0055_theirs.sql"], filesTruncated: false },
      { pr: 20, files: ["migrations/0055_mine.sql"], filesTruncated: false },
    ];
    expect(checkMigrationClaims(input({ pr: 20, openPrs }))).toEqual({
      kind: "conflict",
      conflicts: [{ kind: "claimed", version: 55, file: "migrations/0055_mine.sql", otherPr: 10, otherFile: "migrations/0055_theirs.sql" }],
      next: 56,
    });
    expect(checkMigrationClaims(input({ pr: 10, files: ["migrations/0055_theirs.sql"], openPrs })).kind).toBe("ok");
  });

  it("suggests a number no other open PR holds, even one with a higher PR number", () => {
    const openPrs = [
      { pr: 10, files: ["migrations/0055_a.sql"], filesTruncated: false },
      { pr: 30, files: ["migrations/0056_c.sql"], filesTruncated: false },
    ];
    const result = checkMigrationClaims(input({ pr: 20, openPrs }));
    expect(result.kind === "conflict" ? result.next : null).toBe(57);
  });

  it("fails closed when any file list or the open-PR list was truncated", () => {
    expect(checkMigrationClaims(input({ filesTruncated: true })).kind).toBe("incomplete");
    expect(checkMigrationClaims(input({ openPrsTruncated: true })).kind).toBe("incomplete");
    expect(checkMigrationClaims(input({ openPrs: [{ pr: 10, files: [], filesTruncated: true }] })).kind).toBe("incomplete");
  });
});

describe("formatClaimReport", () => {
  it("names the conflicting file, the other PR, and the number to take", () => {
    const lines = formatClaimReport(20, {
      kind: "conflict",
      conflicts: [{ kind: "claimed", version: 55, file: "migrations/0055_mine.sql", otherPr: 10, otherFile: "migrations/0055_theirs.sql" }],
      next: 56,
    }).join("\n");
    expect(lines).toContain("migrations/0055_mine.sql");
    expect(lines).toContain("#10");
    expect(lines).toContain("0056");
  });
});
