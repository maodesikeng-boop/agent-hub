import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import * as limits from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import {
  RESOURCE_REGISTRY,
  findResourceEntry,
  validateResourceRegistry,
  type ResourceRegistryEntry,
} from "../../shared/resource-registry.ts";
import { openTestDb } from "../store/test-helpers.ts";

function migratedTableNames(): string[] {
  const db = openTestDb();
  try {
    return db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function hubPathStringKeys(): string[] {
  const resolved = resolveHubPaths({}, "/tmp/test-home");
  return Object.entries(resolved)
    .filter(([, value]) => typeof value === "string")
    .map(([key]) => key)
    .sort();
}

function exportedNumericLimitNames(): Set<string> {
  return new Set(
    Object.entries(limits)
      .filter(([, value]) => typeof value === "number")
      .map(([name]) => name),
  );
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function productionSourceFiles(): string[] {
  const srcRoot = join(REPO_ROOT, "src");
  return (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !/(^|[\\/])(test-helpers|test-utils)\.tsx?$/.test(file) && !file.includes("fixture"))
    .map((file) => relative(REPO_ROOT, join(srcRoot, file)).split(sep).join("/"));
}

describe("RESOURCE_REGISTRY structural guard", () => {
  it("registers every module that creates a temp directory, so each one names who removes it", () => {
    const owners = new Set(
      RESOURCE_REGISTRY.filter((e) => e.kind === "temp_dir").flatMap((e) => e.owner.split(",").map((part) => part.trim())),
    );
    const creators = productionSourceFiles().filter((file) => /\bmkdtemp(Sync)?\(/.test(readFileSync(join(REPO_ROOT, file), "utf8")));
    expect(creators.length).toBeGreaterThan(0);
    expect(creators.filter((file) => !owners.has(file))).toEqual([]);
  });

  it("covers every non-internal SQLite table created by migrations/*.sql", () => {
    const tables = migratedTableNames();
    expect(tables.length).toBeGreaterThan(0);
    const violations = validateResourceRegistry(RESOURCE_REGISTRY, {
      sqliteTables: tables,
      hubPathKeys: hubPathStringKeys(),
      exportedLimitNames: exportedNumericLimitNames(),
    });
    expect(violations.filter((v) => v.code === "unregistered_table")).toEqual([]);
  });

  it("contains no stale sqlite_table entries missing from the migrated schema", () => {
    const violations = validateResourceRegistry(RESOURCE_REGISTRY, {
      sqliteTables: migratedTableNames(),
      hubPathKeys: hubPathStringKeys(),
      exportedLimitNames: exportedNumericLimitNames(),
    });
    expect(violations.filter((v) => v.code === "stale_table")).toEqual([]);
  });

  it("covers every data-directory path returned by resolveHubPaths", () => {
    const violations = validateResourceRegistry(RESOURCE_REGISTRY, {
      sqliteTables: migratedTableNames(),
      hubPathKeys: hubPathStringKeys(),
      exportedLimitNames: exportedNumericLimitNames(),
    });
    expect(violations).toEqual([]);
  });

  it("covers worker processes, worktrees, managed git branches, session temp directories, and logs", () => {
    expect(findResourceEntry("process", "worker_process_tree")).not.toBeNull();
    expect(findResourceEntry("worktree", "worktreesDir")).not.toBeNull();
    expect(findResourceEntry("git_branch", "managed_hub_branches")).not.toBeNull();
    expect(findResourceEntry("temp_dir", "session_tmp_dirs")).not.toBeNull();
    expect(findResourceEntry("log_file", "logsDir")).not.toBeNull();
    expect(findResourceEntry("log_file", "setupLogsDir")).not.toBeNull();
  });

  it("requires every growing resource to declare a non-empty cleaner and at least one positive limit exported by src/shared/limits.ts", () => {
    const exported = exportedNumericLimitNames();
    const growing = RESOURCE_REGISTRY.filter((e) => e.growth === "growing");
    expect(growing.length).toBeGreaterThan(20);
    for (const entry of growing) {
      expect(entry.cleaner.trim(), entry.id).not.toBe("");
      expect(entry.limits.length, entry.id).toBeGreaterThan(0);
      for (const ref of entry.limits) {
        expect(exported.has(ref.constantName), `${entry.id}:${ref.constantName}`).toBe(true);
        expect(ref.value, `${entry.id}:${ref.constantName}`).toBeGreaterThan(0);
      }
    }
  });

  it("rejects duplicate ids, unknown limit constants, and unregistered tables in validateResourceRegistry", () => {
    const badRegistry: ResourceRegistryEntry[] = [
      {
        id: "table:foo",
        kind: "sqlite_table",
        target: "foo",
        growth: "growing",
        owner: "a.ts",
        cleaner: "",
        cleanupMode: "automatic",
        limits: [],
      },
      {
        id: "table:foo",
        kind: "sqlite_table",
        target: "stale_one",
        growth: "growing",
        owner: "b.ts",
        cleaner: "b.ts",
        cleanupMode: "automatic",
        limits: [
          { constantName: "NO_SUCH_LIMIT", value: 10, unit: "rows" },
          { constantName: "WORKER_RETENTION_DAYS", value: 0, unit: "days" },
        ],
      },
    ];
    const violations = validateResourceRegistry(badRegistry, {
      sqliteTables: ["foo", "bar"],
      hubPathKeys: ["home"],
      exportedLimitNames: exportedNumericLimitNames(),
    });
    const codes = new Set(violations.map((v) => v.code));
    expect(codes).toEqual(
      new Set([
        "duplicate_id",
        "stale_table",
        "missing_cleaner",
        "missing_limit",
        "unknown_limit_constant",
        "non_positive_limit",
        "unregistered_table",
        "unregistered_path",
      ]),
    );
  });

  it("finds registered entries by kind and target via findResourceEntry", () => {
    const msgEntry = findResourceEntry("sqlite_table", "messages");
    expect(msgEntry).toMatchObject({ id: "table:messages", kind: "sqlite_table", target: "messages", growth: "growing" });
    expect(findResourceEntry("sqlite_table", "nonexistent_table")).toBeNull();
    expect(findResourceEntry("data_dir", "messages")).toBeNull();
  });
});
