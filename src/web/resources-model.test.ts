import { describe, it } from "vitest";

describe("resources-model", () => {
  it.todo("returns the same ResourcesSummary reference when the snapshot object is unchanged");
  it.todo("returns the same PartitionedHeldResources reference when the held array reference is unchanged");
  it.todo("marks attention true when at least one held item has keptAt === null");
  it.todo("reads only the React Query cache in useCachedResourcesSummary with zero network requests");
  it.todo("prevents a stale in-flight GET from overwriting a newer manual refresh or decision mutation");
});
