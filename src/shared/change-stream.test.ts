import { describe, expect, it } from "vitest";
import { changeCursorFromSnapshot, encodeChangeStreamQuery, resolveChangeStreamRequest } from "./change-stream.ts";

const BOOT = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const OTHER_BOOT = "7d6c5b4a-3e2f-4a1b-9c8d-7e6f5a4b3c2d";

const resolve = (query: string, bootId = BOOT) => resolveChangeStreamRequest(new URLSearchParams(query), bootId);

describe("change stream cursor", () => {
  it.each([0, 1, 41, Number.MAX_SAFE_INTEGER])("round trips a boot UUID with sequence %d", (seq) => {
    const query = encodeChangeStreamQuery({ bootId: BOOT, seq });
    expect(query).toBe(`?since=${BOOT}%3A${seq}`);
    expect(resolve(query.slice(1))).toEqual({ kind: "replay", since: seq });
  });

  it("builds a cursor from a valid snapshot and rejects an absent or invalid boot ID or sequence", () => {
    expect(changeCursorFromSnapshot({ bootId: BOOT, seq: 0 })).toEqual({ bootId: BOOT, seq: 0 });
    for (const snapshot of [
      { seq: 5 },
      { bootId: "", seq: 5 },
      { bootId: "boot-1", seq: 5 },
      { bootId: BOOT.toUpperCase(), seq: 5 },
      { bootId: BOOT, seq: -1 },
      { bootId: BOOT, seq: 1.5 },
      { bootId: BOOT, seq: Number.MAX_SAFE_INTEGER + 1 },
      { bootId: BOOT, seq: Number.NaN },
    ]) {
      expect(changeCursorFromSnapshot(snapshot), JSON.stringify(snapshot)).toBeNull();
    }
  });

  it("allows a live subscription when since is absent", () => {
    expect(resolve("")).toEqual({ kind: "live" });
    expect(resolve("other=1")).toEqual({ kind: "live" });
  });

  it("requires resync for a cursor from another boot even when the sequence matches", () => {
    const query = encodeChangeStreamQuery({ bootId: OTHER_BOOT, seq: 12 }).slice(1);
    expect(resolve(query)).toEqual({ kind: "resync" });
    expect(resolve(query, OTHER_BOOT)).toEqual({ kind: "replay", since: 12 });
  });

  it.each([
    "since=12",
    "since=",
    `since=${BOOT}:12&since=${BOOT}:12`,
    `since=${BOOT}:`,
    `since=${BOOT}:-1`,
    `since=${BOOT}:01`,
    `since=${BOOT}:1.5`,
    `since=${BOOT}:1e3`,
    `since=${BOOT}:%2012`,
    `since=${BOOT}:${Number.MAX_SAFE_INTEGER + 1}`,
    `since=${BOOT}:12:13`,
    `since=${BOOT}12`,
  ])("requires resync for %s", (query) => {
    expect(resolve(query)).toEqual({ kind: "resync" });
  });

  it("requires resync when the server boot ID itself is invalid", () => {
    expect(resolve("since=boot:1", "boot")).toEqual({ kind: "resync" });
  });
});
