import type { DeviceId } from "../../shared/api.ts";
import { MESH_LEASE_FENCE_MARGIN_MS, MESH_LEASE_ORPHAN_MS, MESH_LEASE_RENEW_MS, MESH_LEASE_TTL_MS } from "../../shared/limits.ts";
import type { MeshLeaseGrant, MeshLeaseName, RelayConnectionState } from "../../shared/mesh.ts";
import type { RelayClient } from "./relay-client.ts";

export type CenterLeaseState =
  | { kind: "idle"; relayDownSince: number | null }
  | { kind: "candidate"; relayDownSince: number | null }
  | { kind: "holder"; epoch: number; lastAckAt: number; relayDownSince: number | null }
  | { kind: "yielding"; epoch: number; relayDownSince: number | null }
  | { kind: "orphan_holder"; since: number; relayDownSince: number };

export const INITIAL_CENTER_LEASE_STATE: CenterLeaseState = { kind: "idle", relayDownSince: null };

export type CenterLeaseEvent =
  | { kind: "eligible"; eligible: boolean; at: number }
  | { kind: "relay"; state: RelayConnectionState; at: number }
  | { kind: "grant"; grant: MeshLeaseGrant | null; at: number }
  | { kind: "yield"; epoch: number; at: number }
  | { kind: "disconnected"; at: number }
  | { kind: "tick"; at: number };

export type CenterLeaseEffect =
  | { kind: "claim" }
  | { kind: "release"; epoch: number }
  | { kind: "connect" }
  | { kind: "disconnect" };

export interface CenterLeaseContext {
  selfId: DeviceId;
  firstInPriority: DeviceId | null;
  peerHolding?: boolean;
  ttlMs: number;
  fenceMarginMs: number;
  orphanMs: number;
}

/** Only holder and orphan_holder emit connect, and leaving either state always emits disconnect first. */
export function stepCenterLease(state: CenterLeaseState, event: CenterLeaseEvent, context: CenterLeaseContext): { state: CenterLeaseState; effects: CenterLeaseEffect[] } {
  const effects: CenterLeaseEffect[] = [];
  if (state.kind === "holder" && event.at - state.lastAckAt > context.ttlMs - context.fenceMarginMs) {
    effects.push({ kind: "disconnect" });
    state = { kind: "candidate", relayDownSince: state.relayDownSince };
  }
  if (state.kind === "orphan_holder" && context.peerHolding) {
    effects.push({ kind: "disconnect" });
    state = { kind: "candidate", relayDownSince: state.relayDownSince };
  }
  const done = (next: CenterLeaseState, ...more: CenterLeaseEffect[]) => ({ state: next, effects: [...effects, ...more] });
  const down = state.relayDownSince;

  switch (event.kind) {
    case "eligible": {
      if (!event.eligible) {
        if (state.kind === "holder") return done({ kind: "idle", relayDownSince: down }, { kind: "disconnect" }, { kind: "release", epoch: state.epoch });
        if (state.kind === "yielding") return done({ kind: "idle", relayDownSince: down }, { kind: "release", epoch: state.epoch });
        if (state.kind === "orphan_holder") return done({ kind: "idle", relayDownSince: down }, { kind: "disconnect" });
        return done({ kind: "idle", relayDownSince: down });
      }
      if (state.kind === "idle") return done({ kind: "candidate", relayDownSince: down }, { kind: "claim" });
      return done(state);
    }
    case "relay": {
      const connected = event.state === "connected";
      const nextDown = connected ? null : (down ?? event.at);
      if (state.kind === "orphan_holder") {
        return connected ? done({ kind: "candidate", relayDownSince: null }, { kind: "disconnect" }, { kind: "claim" }) : done(state);
      }
      if (state.kind === "candidate" && connected) return done({ kind: "candidate", relayDownSince: null }, { kind: "claim" });
      return done({ ...state, relayDownSince: nextDown } as CenterLeaseState);
    }
    case "grant": {
      const grant = event.grant;
      const mine = grant !== null && grant.holder === context.selfId;
      if (state.kind === "holder") {
        if (!mine || grant.epoch < state.epoch) return done({ kind: "candidate", relayDownSince: down }, { kind: "disconnect" });
        return done({ kind: "holder", epoch: grant.epoch, lastAckAt: event.at, relayDownSince: down });
      }
      if (state.kind === "candidate" && mine) return done({ kind: "holder", epoch: grant.epoch, lastAckAt: event.at, relayDownSince: down }, { kind: "connect" });
      if (state.kind === "idle" && mine) return done(state, { kind: "release", epoch: grant.epoch });
      return done(state);
    }
    case "yield": {
      if (state.kind === "holder" && event.epoch === state.epoch) return done({ kind: "yielding", epoch: state.epoch, relayDownSince: down }, { kind: "disconnect" });
      return done(state);
    }
    case "disconnected": {
      if (state.kind === "yielding") return done({ kind: "candidate", relayDownSince: down }, { kind: "release", epoch: state.epoch });
      return done(state);
    }
    case "tick": {
      if (state.kind === "candidate") {
        if (down !== null && event.at - down >= context.orphanMs && context.firstInPriority === context.selfId && !context.peerHolding) {
          return done({ kind: "orphan_holder", since: event.at, relayDownSince: down }, { kind: "connect" });
        }
        return done(state, { kind: "claim" });
      }
      if (state.kind === "holder") return done(state, { kind: "claim" });
      return done(state);
    }
  }
}

export interface CenterLeaseOptions {
  name: MeshLeaseName;
  selfId: DeviceId;
  relay: RelayClient;
  eligible: () => boolean;
  priority: () => DeviceId[];
  hasPeerHolder?: () => Promise<boolean>;
  connect: () => void;
  disconnect: () => Promise<void>;
  now?: () => number;
  log: (line: string) => void;
}

export interface CenterLease {
  holding(): boolean;
  holder(): DeviceId | null;
  refresh(): void;
  onChange(listener: (holder: DeviceId | null) => void): () => void;
  close(): Promise<void>;
}

export function createCenterLease(options: CenterLeaseOptions): CenterLease {
  const now = options.now ?? Date.now;
  const listeners = new Set<(holder: DeviceId | null) => void>();
  let state: CenterLeaseState = INITIAL_CENTER_LEASE_STATE;
  let relayHolder: DeviceId | null = null;
  let reported: DeviceId | null = null;
  let peerHolding = false;
  let probing = false;
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const holding = () => state.kind === "holder" || state.kind === "orphan_holder";
  const effectiveHolder = () => (holding() ? options.selfId : relayHolder);
  const notify = () => {
    const holder = effectiveHolder();
    if (holder === reported) return;
    reported = holder;
    for (const listener of listeners) listener(holder);
  };
  const context = (): CenterLeaseContext => ({
    selfId: options.selfId,
    firstInPriority: options.priority()[0] ?? null,
    peerHolding,
    ttlMs: MESH_LEASE_TTL_MS,
    fenceMarginMs: MESH_LEASE_FENCE_MARGIN_MS,
    orphanMs: MESH_LEASE_ORPHAN_MS,
  });
  const run = async (effects: CenterLeaseEffect[]) => {
    for (const effect of effects) {
      switch (effect.kind) {
        case "claim":
          options.relay.send({ type: "lease.claim", name: options.name });
          break;
        case "release":
          options.relay.send({ type: "lease.release", name: options.name, epoch: effect.epoch });
          break;
        case "connect":
          options.log(`中心租约：本机挂上${options.name}长连接`);
          options.connect();
          break;
        case "disconnect":
          options.log(`中心租约：本机断开${options.name}长连接`);
          await options.disconnect();
          step({ kind: "disconnected", at: now() });
          break;
      }
    }
  };
  /** Effects run in order so release waits until the long connection is closed. */
  function step(event: CenterLeaseEvent): void {
    const result = stepCenterLease(state, event, context());
    state = result.state;
    notify();
    if (result.effects.length === 0) return;
    queue = queue.then(() => run(result.effects)).catch((error: unknown) => options.log(`中心租约：${error instanceof Error ? error.message : String(error)}`));
  }

  const unsubscribe = [
    options.relay.on("lease", (name, grant) => {
      if (name !== options.name || closed) return;
      relayHolder = grant?.holder ?? null;
      step({ kind: "grant", grant, at: now() });
      notify();
    }),
    options.relay.on("leaseYield", (name, epoch) => {
      if (name === options.name && !closed) step({ kind: "yield", epoch, at: now() });
    }),
    options.relay.on("state", (relayState) => {
      if (closed) return;
      if (relayState !== "connected") relayHolder = null;
      else peerHolding = false;
      step({ kind: "relay", state: relayState, at: now() });
    }),
  ];
  const tick = async () => {
    if (closed || probing) return;
    const t = now();
    const shouldProbe =
      options.hasPeerHolder !== undefined &&
      options.relay.state() !== "connected" &&
      (state.kind === "orphan_holder" ||
        ((state.kind === "candidate" || state.kind === "holder") &&
          state.relayDownSince !== null &&
          t - state.relayDownSince >= MESH_LEASE_ORPHAN_MS &&
          (options.priority()[0] ?? null) === options.selfId));
    if (shouldProbe) {
      probing = true;
      let detected = false;
      try {
        detected = await options.hasPeerHolder!();
      } catch {
        detected = false;
      } finally {
        probing = false;
      }
      if (options.relay.state() !== "connected") peerHolding = detected;
    }
    if (!closed) step({ kind: "tick", at: now() });
  };
  const timer = setInterval(() => void tick(), MESH_LEASE_RENEW_MS);
  timer.unref?.();
  step({ kind: "relay", state: options.relay.state(), at: now() });
  step({ kind: "eligible", eligible: options.eligible(), at: now() });

  return {
    holding,
    holder: effectiveHolder,
    refresh() {
      if (!closed) step({ kind: "eligible", eligible: options.eligible(), at: now() });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return queue;
      step({ kind: "eligible", eligible: false, at: now() });
      closed = true;
      clearInterval(timer);
      for (const off of unsubscribe) off();
      await queue;
    },
  };
}
