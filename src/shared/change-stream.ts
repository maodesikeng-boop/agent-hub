import type { StateSnapshot } from "./api.ts";

export interface ChangeCursor {
  readonly bootId: string;
  readonly seq: number;
}

export type ChangeStreamRequest =
  | { kind: "live" }
  | { kind: "replay"; since: number }
  | { kind: "resync" };

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isBootId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && BOOT_ID.test(value);
}

export function isChangeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Returns a cursor for a snapshot with a valid boot ID and sequence, or null for an unscoped or invalid snapshot. */
export function changeCursorFromSnapshot(snapshot: Pick<StateSnapshot, "bootId" | "seq">): ChangeCursor | null {
  const { bootId, seq } = snapshot;
  return isBootId(bootId) && isChangeSequence(seq) ? { bootId, seq } : null;
}

/** Encodes a validated cursor as a WebSocket query, including the leading question mark. */
export function encodeChangeStreamQuery(cursor: ChangeCursor): string {
  return `?${new URLSearchParams({ since: `${cursor.bootId}:${cursor.seq}` })}`;
}

/** Allows live delivery when since is absent and replay when one valid cursor matches bootId. All other requests require resync. */
export function resolveChangeStreamRequest(params: URLSearchParams, bootId: string): ChangeStreamRequest {
  const values = params.getAll("since");
  if (values.length === 0) return { kind: "live" };
  const prefix = `${bootId}:`;
  const value = values[0]!;
  if (values.length !== 1 || !isBootId(bootId) || !value.startsWith(prefix)) return { kind: "resync" };
  const rawSeq = value.slice(prefix.length);
  const since = Number(rawSeq);
  return isChangeSequence(since) && String(since) === rawSeq ? { kind: "replay", since } : { kind: "resync" };
}
