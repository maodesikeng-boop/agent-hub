import { describe, it } from "vitest";

describe("isPinned", () => {
  it.todo("is true only for an unarchived PM with a numeric pinnedAt");
  it.todo("treats a missing pinnedAt from an older daemon as not pinned");
});

describe("projectListOf", () => {
  it.todo("orders pinned PMs by pinnedAt, oldest first, with ties broken by PM id");
  it.todo("keeps active entries in the incoming most-recent-first order");
  it.todo("moves an archived pinned PM to archived instead of pinned");
  it.todo("places every entry in exactly one section");
  it.todo("returns the same sections object for the same entries array");
});

describe("filterProjectList", () => {
  it.todo("matches PM names and project names without regard to case");
  it.todo("returns the input sections for a blank query");
});
