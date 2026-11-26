import { readBoundedJson } from "../../relay/lease-checkpoint.ts";
import { API_PATHS, type DeviceId } from "../../shared/api.ts";
import { FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES } from "../../shared/limits.ts";
import type { CenterLease, Mesh } from "../mesh/index.ts";
import { parseFeishuInboundStateSnapshot, type FeishuInboundPeerPort } from "./inbound-checkpoint.ts";
import type { FeishuService } from "./service.ts";

export function createFeishuLease(mesh: Mesh, device: DeviceId, service: () => FeishuService | undefined): {
  lease: CenterLease;
  unsubscribe: () => void;
} {
  const inAccountMode = () => {
    const state = mesh.status().state;
    return state === "signed_in" || state === "awaiting_approval";
  };
  const accountLease = mesh.lease("feishu", {
    eligible: () => service()?.eligibleForLease() ?? false,
    connect: () => { void service()?.syncLeaseConnection(); },
    disconnect: async () => {
      if (inAccountMode()) await service()?.syncLeaseConnection();
    },
  });
  const holding = () => !inAccountMode() || accountLease.holding();
  const holder = () => holding() ? device : accountLease.holder();
  let previous = holding();
  const listeners = new Set<(holder: DeviceId | null) => void>();
  const notify = () => {
    const current = holding();
    if (current === previous) return;
    previous = current;
    for (const listener of listeners) listener(holder());
  };
  const refresh = () => {
    accountLease.refresh();
    notify();
  };
  const offs = [accountLease.onChange(notify), mesh.onChange(refresh)];
  return {
    lease: {
      holding,
      holder,
      epoch: () => inAccountMode() ? accountLease.epoch?.() ?? null : null,
      refresh,
      onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close: () => accountLease.close(),
    },
    unsubscribe: () => { for (const off of offs) off(); },
  };
}

export function createFeishuPeerCheckpointPort(mesh: Mesh): FeishuInboundPeerPort {
  const path = API_PATHS.peerFeishuInboundState;
  return {
    onlinePeers: () => mesh.status().state === "signed_in"
      ? mesh.trust.list().filter(({ id }) => id !== mesh.selfId && mesh.isOnline(id)).map(({ id }) => id)
      : [],
    async fetchPeerState(id, signal) {
      const res = await mesh.request(id, path, signal === undefined ? {} : { signal });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        return { kind: res.status === 404 ? "unsupported" : "unavailable" };
      }
      const data = await readBoundedJson(res, FEISHU_INBOUND_CHECKPOINT_PLAINTEXT_MAX_BYTES + 64);
      if (typeof data !== "object" || data === null || !("state" in data)) return { kind: "unavailable" };
      if (data.state === null) return { kind: "ok", state: null };
      const state = parseFeishuInboundStateSnapshot(data.state);
      return state === null ? { kind: "unavailable" } : { kind: "ok", state };
    },
    async pushPeerState(id, state, signal) {
      const res = await mesh.request(id, path, {
        method: "PUT", body: JSON.stringify(state), ...(signal === undefined ? {} : { signal }),
      });
      void res.body?.cancel().catch(() => {});
      return { kind: res.status === 204 ? "ok" : res.status === 404 ? "unsupported" : "unavailable" };
    },
  };
}
