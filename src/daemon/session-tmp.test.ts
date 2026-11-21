import { describe, it } from "vitest";

describe("SessionTmpStore", () => {
  it.todo("returns a realpath-resolved short temp root fitting macOS Unix socket path limits");
  it.todo("creates a 0700 SESSION_TMP_DIR_PREFIX directory on allocate and persists it in state/session-tmp.json");
  it.todo("reuses an existing tracked directory when allocate is called twice for the same session");
  it.todo("removes the tracked directory and ledger entry on remove and succeeds when already absent");
  it.todo("sweeps tracked directories for non-active sessions and stale orphaned prefix directories while keeping active sessions untouched");
});
