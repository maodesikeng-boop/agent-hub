import type { StateSnapshot } from "./api.ts";

// A sequence belongs to the boot that issued it.

export interface ChangeCursor {
  readonly bootId: string;
  readonly seq: number;
}

export type ChangeStreamRequest =
  | { kind: "live" }
  | { kind: "replay"; since: number }
  | { kind: "resync" };

/** Returns a cursor for a snapshot with a valid boot ID and sequence, or null for an unscoped or invalid snapshot. */
export function changeCursorFromSnapshot(snapshot: Pick<StateSnapshot, "bootId" | "seq">): ChangeCursor | null {
  throw new Error("Not implemented");
}

/** Encodes a validated cursor as a WebSocket query, including the leading question mark. */
export function encodeChangeStreamQuery(cursor: ChangeCursor): string {
  throw new Error("Not implemented");
}

/** Allows live delivery when since is absent and replay when one valid cursor matches bootId. All other requests require resync. */
export function resolveChangeStreamRequest(params: URLSearchParams, bootId: string): ChangeStreamRequest {
  throw new Error("Not implemented");
}
