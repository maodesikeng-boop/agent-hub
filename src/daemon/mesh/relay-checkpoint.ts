import { readBoundedJson, RELAY_CHECKPOINT_BODY_LIMIT } from "../../relay/lease-checkpoint.ts";
import {
  parseRelayLeaseCheckpointResponse, RELAY_PATHS, type RelayLeaseCheckpointPutRequest, type RelayLeaseCheckpointRecord,
} from "../../relay/protocol.ts";
import type { DeviceId } from "../../shared/api.ts";
import type { AccountId, MeshLeaseName } from "../../shared/mesh.ts";

type CheckpointUnavailable = { kind: "unavailable" } | { kind: "unsupported" };
export type LeaseCheckpointGet = CheckpointUnavailable | { kind: "ok"; checkpoint: RelayLeaseCheckpointRecord | null };
export type LeaseCheckpointPut = CheckpointUnavailable | { kind: "ok"; checkpoint: RelayLeaseCheckpointRecord } |
  { kind: "stale_epoch"; currentEpoch: number } | { kind: "stale_seq"; currentSeq: number };

export interface RelayCheckpoints {
  getCheckpoint(name: MeshLeaseName, signal?: AbortSignal): Promise<LeaseCheckpointGet>;
  putCheckpoint(name: MeshLeaseName, request: RelayLeaseCheckpointPutRequest, signal?: AbortSignal): Promise<LeaseCheckpointPut>;
}

export function createRelayCheckpoints(
  relayOrigin: string, accountId: AccountId, device: DeviceId, currentSession: () => string | null,
): RelayCheckpoints {
  let legacySession: string | null = null;
  async function request(name: MeshLeaseName, body: RelayLeaseCheckpointPutRequest | null, signal?: AbortSignal) {
    const session = currentSession();
    if (session === null || signal?.aborted === true) return { kind: "unavailable" } as const;
    if (session === legacySession) return { kind: "unsupported" } as const;
    const url = new URL(RELAY_PATHS.leaseCheckpoint(accountId, name), relayOrigin);
    url.searchParams.set("device", device);
    url.searchParams.set("session", session);
    try {
      const res = await fetch(url, {
        method: body === null ? "GET" : "PUT",
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
        ...(body === null ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (res.status === 404 && currentSession() === session) legacySession = session;
      if (currentSession() !== session || (!res.ok && res.status !== 409)) {
        void res.body?.cancel().catch(() => {});
        return { kind: res.status === 404 ? "unsupported" : "unavailable" } as CheckpointUnavailable;
      }
      const data = await readBoundedJson(res, RELAY_CHECKPOINT_BODY_LIMIT);
      return currentSession() !== session ? { kind: "unavailable" } as const : { kind: "response", data, status: res.status } as const;
    } catch {
      return { kind: "unavailable" } as const;
    }
  }
  return {
    async getCheckpoint(name, signal) {
      const result = await request(name, null, signal);
      if (result.kind !== "response") return result;
      const parsed = parseRelayLeaseCheckpointResponse(result.data);
      return parsed === null ? { kind: "unavailable" } : { kind: "ok", checkpoint: parsed.checkpoint };
    },
    async putCheckpoint(name, body, signal) {
      const result = await request(name, body, signal);
      if (result.kind !== "response") return result;
      if (result.status === 409 && typeof result.data === "object" && result.data !== null && "error" in result.data) {
        const data = result.data;
        if (data.error === "stale_epoch" && "currentEpoch" in data && typeof data.currentEpoch === "number" &&
          Number.isSafeInteger(data.currentEpoch) && data.currentEpoch >= 0) return { kind: "stale_epoch", currentEpoch: data.currentEpoch };
        if (data.error === "stale_seq" && "currentSeq" in data && typeof data.currentSeq === "number" &&
          Number.isSafeInteger(data.currentSeq) && data.currentSeq > 0) return { kind: "stale_seq", currentSeq: data.currentSeq };
      }
      const checkpoint = parseRelayLeaseCheckpointResponse(result.data)?.checkpoint;
      return checkpoint == null ? { kind: "unavailable" } : { kind: "ok", checkpoint };
    },
  };
}
