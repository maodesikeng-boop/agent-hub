// Web-standard APIs only; shared by Cloudflare Durable Object and Node relay rooms.
import type { DeviceId } from "../shared/api.ts";
import type { AccountId, MeshLeaseName } from "../shared/mesh.ts";
import type { RelayLeaseCheckpointPutRequest, RelayLeaseCheckpointRecord } from "./protocol.ts";

export interface RelayLeaseCheckpointAuth {
  name: MeshLeaseName;
  device: DeviceId;
  session: string;
}

export interface RelayLeaseCheckpointPutInput extends RelayLeaseCheckpointAuth {
  request: RelayLeaseCheckpointPutRequest;
}

export type RelayLeaseCheckpointReadResult =
  | { ok: true; checkpoint: RelayLeaseCheckpointRecord | null }
  | { ok: false; status: 401 | 403; error: "unauthorized" | "not_active" };

export type RelayLeaseCheckpointWriteResult =
  | { ok: true; checkpoint: RelayLeaseCheckpointRecord }
  | { ok: false; status: 401 | 403; error: "unauthorized" | "not_active" }
  | { ok: false; status: 409; error: "stale_epoch"; currentEpoch: number }
  | { ok: false; status: 409; error: "stale_seq"; currentSeq: number };

export interface RelayLeaseCheckpointContext {
  sessionOf(device: DeviceId): string | null;
  isActive(device: DeviceId): boolean;
  currentHolder(name: MeshLeaseName): { holder: DeviceId; epoch: number } | null;
  latestEpoch(name: MeshLeaseName): number;
  storedCheckpoint(name: MeshLeaseName): RelayLeaseCheckpointRecord | null;
  storeCheckpoint(name: MeshLeaseName, record: RelayLeaseCheckpointRecord): Promise<void>;
  now(): number;
}

/**
 * Precondition: pathname is the URL pathname of an incoming HTTP request to the relay.
 * Postcondition: returns the parsed accountId and leaseName when pathname matches /v1/accounts/:account/leases/:name/checkpoint with valid identifiers, or null otherwise.
 */
export function parseLeaseCheckpointRoute(pathname: string): { accountId: AccountId; leaseName: MeshLeaseName } | null {
  void pathname;
  throw new Error("Not implemented");
}

/**
 * Precondition: ctx reflects the loaded account room state; auth carries device and session from the request query.
 * Postcondition: returns the stored opaque checkpoint when device has an active authenticated control session, or 401/403 without mutating state.
 */
export function readLeaseCheckpoint(ctx: RelayLeaseCheckpointContext, auth: RelayLeaseCheckpointAuth): RelayLeaseCheckpointReadResult {
  void ctx;
  void auth;
  throw new Error("Not implemented");
}

/**
 * Precondition: ctx reflects the loaded account room state; input.request has already passed schema and size validation.
 * Postcondition: persists the opaque checkpoint when the authenticated active device currently holds the lease at input.request.epoch and advances lexicographic (epoch, seq); rejects stale holders with 409 stale_epoch and regressed seq with 409 stale_seq.
 */
export async function writeLeaseCheckpoint(
  ctx: RelayLeaseCheckpointContext,
  input: RelayLeaseCheckpointPutInput,
): Promise<RelayLeaseCheckpointWriteResult> {
  void ctx;
  void input;
  throw new Error("Not implemented");
}
