import { describe, it } from "vitest";

describe("RESOURCE_REGISTRY structural guard", () => {
  it.todo("covers every non-internal SQLite table created by migrations/*.sql");
  it.todo("contains no stale sqlite_table entries missing from the migrated schema");
  it.todo("covers every data-directory path returned by resolveHubPaths");
  it.todo("covers worker processes, worktrees, managed git branches, session temp directories, and logs");
  it.todo("requires every growing resource to declare a non-empty cleaner and at least one positive limit exported by src/shared/limits.ts");
  it.todo("rejects duplicate ids, unknown limit constants, and unregistered tables in validateResourceRegistry");
  it.todo("finds registered entries by kind and target via findResourceEntry");
});
