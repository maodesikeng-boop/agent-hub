import { describe, it } from "vitest";

describe("ledger.setPmPinned", () => {
  it.todo("records pinnedAt on pin and returns the PM with it");
  it.todo("keeps the first pinnedAt when an already pinned PM is pinned again, and emits nothing");
  it.todo("clears pinnedAt on unpin and emits nothing when the PM was not pinned");
  it.todo("emits pm.updated with the new PM when the pin changes");
  it.todo("rejects an archived PM with conflict and an unknown PM with not_found");
  it.todo("keeps the pin across archive and restore");
  it.todo("drops the pm_pins row when the archived PM is purged");
  it.todo("returns pinnedAt null in the snapshot for PMs that were never pinned");
});
