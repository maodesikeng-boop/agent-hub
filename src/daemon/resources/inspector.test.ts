import { describe, it } from "vitest";

describe("createResourceInspector", () => {
  it.todo("measures database file size, WAL size, freelist bytes, and per-table usage via dbstat with fallback when dbstat is unavailable");
  it.todo("measures directory sizes asynchronously without following symlinks and stops cleanly at maxEntries or timeoutMs");
  it.todo("coalesces concurrent inspect() calls and serves cached results within RESOURCES_INSPECT_TTL_MS unless refresh is true");
  it.todo("merges held worktrees, unmerged branches, orphan temp dirs, and leaked tagged processes with stored Keep decisions");
  it.todo("applies keep, unkeep, and validated discard decisions, invalidates cache, and rejects unknown or unmanaged target keys");
  it.todo("runs safe automatic cleanups on runCleanup() without deleting held unsaved work");
  it.todo("aborts in-flight scans on close() without touching the database after shutdown starts");
});
