import { describe, it } from "vitest";

describe("change stream recovery across daemon restarts", () => {
  it.todo("resyncs an old cursor whose sequence overlaps a new daemon and recovers a PM created while the client was disconnected");
  it.todo("starts sequence numbering independently of the wall clock");
});
