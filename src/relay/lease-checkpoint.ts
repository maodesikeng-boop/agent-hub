// Web-standard APIs only; shared by Cloudflare Durable Object and Node relay rooms.
import { isDeviceId, type DeviceId } from "../shared/api.ts";
import { RELAY_LEASE_CHECKPOINT_MAX_BYTES } from "../shared/limits.ts";
import { MESH_LEASE_NAMES, parseAccountId, type AccountId, type MeshLeaseName } from "../shared/mesh.ts";
import { isRelayToken, parseRelayLeaseCheckpointPut, type RelayLeaseCheckpointPutRequest, type RelayLeaseCheckpointRecord } from "./protocol.ts";

export const RELAY_CHECKPOINT_BODY_LIMIT = RELAY_LEASE_CHECKPOINT_MAX_BYTES + 4 * 1024;

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
  const match = /^\/v1\/accounts\/([^/]+)\/leases\/([^/]+)\/checkpoint$/.exec(pathname);
  if (match === null) return null;
  const accountId = parseAccountId(match[1]);
  const leaseName = MESH_LEASE_NAMES.find((name) => name === match[2]);
  return accountId === null || leaseName === undefined ? null : { accountId, leaseName };
}

type CheckpointAuthError = Extract<RelayLeaseCheckpointReadResult, { ok: false }>;

function authenticate(ctx: RelayLeaseCheckpointContext, auth: RelayLeaseCheckpointAuth): CheckpointAuthError | null {
  if (ctx.sessionOf(auth.device) !== auth.session) return { ok: false, status: 401, error: "unauthorized" };
  return ctx.isActive(auth.device) ? null : { ok: false, status: 403, error: "not_active" };
}

/**
 * Precondition: ctx reflects the loaded account room state; auth carries device and session from the request query.
 * Postcondition: returns the stored opaque checkpoint when device has an active authenticated control session, or 401/403 without mutating state.
 */
export function readLeaseCheckpoint(ctx: RelayLeaseCheckpointContext, auth: RelayLeaseCheckpointAuth): RelayLeaseCheckpointReadResult {
  return authenticate(ctx, auth) ?? { ok: true, checkpoint: ctx.storedCheckpoint(auth.name) };
}

/**
 * Precondition: ctx reflects the loaded account room state; input.request has already passed schema and size validation.
 * Postcondition: persists the opaque checkpoint when the authenticated active device currently holds the lease at input.request.epoch and advances lexicographic (epoch, seq); rejects stale holders with 409 stale_epoch and regressed seq with 409 stale_seq.
 */
export async function writeLeaseCheckpoint(
  ctx: RelayLeaseCheckpointContext,
  input: RelayLeaseCheckpointPutInput,
): Promise<RelayLeaseCheckpointWriteResult> {
  const denied = authenticate(ctx, input);
  if (denied !== null) return denied;
  const holder = ctx.currentHolder(input.name);
  const { epoch, seq, ciphertext } = input.request;
  if (holder?.holder !== input.device || holder.epoch !== epoch) {
    return { ok: false, status: 409, error: "stale_epoch", currentEpoch: ctx.latestEpoch(input.name) };
  }
  const stored = ctx.storedCheckpoint(input.name);
  if (stored !== null && (stored.epoch > epoch || (stored.epoch === epoch && stored.seq >= seq))) {
    return stored.epoch > epoch
      ? { ok: false, status: 409, error: "stale_epoch", currentEpoch: stored.epoch }
      : { ok: false, status: 409, error: "stale_seq", currentSeq: stored.seq };
  }
  const checkpoint = { epoch, seq, ciphertext, updatedAt: ctx.now(), writer: input.device };
  await ctx.storeCheckpoint(input.name, checkpoint);
  return { ok: true, checkpoint };
}

interface CheckpointRoom {
  getLeaseCheckpoint(auth: RelayLeaseCheckpointAuth): Promise<RelayLeaseCheckpointReadResult>;
  putLeaseCheckpoint(input: RelayLeaseCheckpointPutInput): Promise<RelayLeaseCheckpointWriteResult>;
}

export async function handleLeaseCheckpoint(
  room: CheckpointRoom,
  name: MeshLeaseName,
  url: URL,
  method: string,
  readBody: () => Promise<unknown>,
): Promise<Response> {
  const json = (status: number, payload: unknown) =>
    Response.json(payload, { status, headers: { "cache-control": "no-store" } });
  const device = url.searchParams.get("device");
  const session = url.searchParams.get("session");
  if (device === null || !isDeviceId(device) || session === null || !isRelayToken(session)) {
    return json(401, { error: "unauthorized" });
  }
  let result: RelayLeaseCheckpointReadResult | RelayLeaseCheckpointWriteResult;
  if (method === "GET") {
    result = await room.getLeaseCheckpoint({ name, device, session });
  } else {
    const request = parseRelayLeaseCheckpointPut(await readBody().catch(() => null));
    if (request === null) return json(400, { error: "bad_frame" });
    result = await room.putLeaseCheckpoint({ name, device, session, request });
  }
  if (result.ok) return json(200, { checkpoint: result.checkpoint });
  const { ok: _ok, status, ...error } = result;
  return json(status, error);
}

export async function readBoundedJson(response: Request | Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(text + decoder.decode()) as unknown;
      size += chunk.value.byteLength;
      if (size > limit) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
