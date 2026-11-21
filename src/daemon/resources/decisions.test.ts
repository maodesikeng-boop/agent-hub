import { describe, it } from "vitest";

describe("createResourceDecisionsStore", () => {
  it.todo("persists and lists Keep decisions newest first");
  it.todo("updates decidedAt and reason when keeping an already-kept target");
  it.todo("evicts the oldest decisions when exceeding RESOURCE_DECISIONS_MAX_ROWS");
  it.todo("removes a Keep decision on unkeep and returns false when absent");
  it.todo("prunes stored decisions whose targets are absent from liveKeys");
});
