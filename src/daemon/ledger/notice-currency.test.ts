import { describe, it } from "vitest";

describe("delivery note currency", () => {
  it.todo("does not write a delivered delivery note again after graph patch adds an unfinished step and the driver requeues it");
  it.todo("does not write a delivered delivery note again after graph finish and the driver requeues it");
  it.todo("drops a delivery note in the driver's pending queue when the graph gains an unfinished step before the write");
  it.todo("still delivers the note when the graph is active and every step is done or skipped");
});

describe("timeout reminder currency", () => {
  it.todo("does not write a queued timeout reminder after the PM extends the Worker's max time");
  it.todo("does not write a queued timeout reminder after the turn ends while the Worker stays open");
  it.todo("does not write a queued timeout reminder after the Worker ends");
  it.todo("does not write a requeued timeout reminder from an earlier turn once a newer turn has its own deadline");
  it.todo("still delivers the reminder while the same turn is running past the same deadline");
  it.todo("treats a legacy reminder without deadlineAt as current only while the stored deadline has passed and is notified");
});

describe("stale system messages", () => {
  it.todo("marks a stale queued, delivered, or processing system message stopped so restart recovery does not resend it");
  it.todo("keeps the existing Worker notice rules for ended and superseded Workers");
  it.todo("never blocks user messages or system messages without a currency rule");
});
