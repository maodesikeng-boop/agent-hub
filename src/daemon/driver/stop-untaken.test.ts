import { describe, it } from "vitest";

describe("untakenReleaseCause", () => {
  it.todo("returns shutdown for a process closing for daemon shutdown even when the vendor reports interrupted");
  it.todo("returns user_stop for an interrupted turn on a process closing as interrupt, including a user stop that wins over shutdown");
  it.todo("returns user_stop for an interrupted turn on a process that is not closing");
  it.todo("returns turn_end when nothing was interrupted");
});

describe("untakenReleaseEvents", () => {
  it.todo("cancels user batches and requeues system batches only for user_stop");
  it.todo("requeues user and system batches for shutdown");
  it.todo("requeues user and system batches for turn_end");
  it.todo("returns no events for batches without message IDs");
});
