import { describe, it } from "vitest";

describe("change stream cursor", () => {
  it.todo("round trips a boot UUID with sequence zero or a positive safe integer");
  it.todo("builds a cursor from a valid snapshot and rejects an absent or invalid boot ID or sequence");
  it.todo("allows a live subscription when since is absent");
  it.todo("requires resync for a cursor from another boot even when the sequence matches");
  it.todo("requires resync for numeric-only, duplicate, empty, malformed, or unsafe since values");
});
