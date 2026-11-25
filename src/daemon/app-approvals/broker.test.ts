import { describe, it } from "vitest";

describe("app approval broker", () => {
  it.todo("accepts at once when the store reports an allowed grant");
  it.todo("declines at once for denied or ineligible lookups");
  it.todo("waits on a pending row and accepts when the user allows it");
  it.todo("declines a waiting request when the user denies it");
  it.todo("declines a waiting request when the row expires");
  it.todo("cancels when the driver aborts the wait and leaves the card open");
  it.todo("settles every wait attached to the same row with one decision");
  it.todo("processEnded ends the rows and settles their waits");
  it.todo("close cancels open waits and declines later requests");
});
