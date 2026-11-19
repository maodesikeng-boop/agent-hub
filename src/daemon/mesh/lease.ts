// 中心租约在设备这一侧（docs/account-mesh-design.md「中心顺序与租约」）：要不要 claim、什么时候挂上 / 断开飞书长连接。
// 裁决在中继（relay/core.ts），这里只照中继给的结果做，外加两条本机规则：
// - 自己掐断：持有时超过 MESH_LEASE_TTL_MS - MESH_LEASE_FENCE_MARGIN_MS 没收到续约回执，先断开长连接，中继要满 MESH_LEASE_TTL_MS 才改授；
// - 降级：中继连不上超过 MESH_LEASE_ORPHAN_MS，且本机是中心顺序里的第一台，就不经租约自己挂上，中继恢复后照租约来。
// stepCenterLease 是纯函数（时间从事件里来），createCenterLease 把它接到 RelayClient 和定时器上。
import type { DeviceId } from "../../shared/api.ts";
import { MESH_LEASE_FENCE_MARGIN_MS, MESH_LEASE_ORPHAN_MS, MESH_LEASE_RENEW_MS, MESH_LEASE_TTL_MS } from "../../shared/limits.ts";
import type { MeshLeaseGrant, MeshLeaseName, RelayConnectionState } from "../../shared/mesh.ts";
import type { RelayClient } from "./relay-client.ts";

/** 每个状态都带着中继从什么时候起连不上（连着是 null），降级判断用。 */
export type CenterLeaseState =
  /** 不是候选（没有飞书凭证、不在中心顺序里、没登录）。 */
  | { kind: "idle"; relayDownSince: number | null }
  /** 候选，没持有。 */
  | { kind: "candidate"; relayDownSince: number | null }
  /** 持有。lastAckAt 是最后一次收到中继确认（授予或续约回执）的时刻。 */
  | { kind: "holder"; epoch: number; lastAckAt: number; relayDownSince: number | null }
  /** 收到 lease.yield，正在断开长连接，断完回 release。 */
  | { kind: "yielding"; epoch: number; relayDownSince: number | null }
  /** 降级持有：中继连不上，本机是中心顺序第一台。 */
  | { kind: "orphan_holder"; since: number; relayDownSince: number };

export const INITIAL_CENTER_LEASE_STATE: CenterLeaseState = { kind: "idle", relayDownSince: null };

export type CenterLeaseEvent =
  | { kind: "eligible"; eligible: boolean; at: number }
  | { kind: "relay"; state: RelayConnectionState; at: number }
  | { kind: "grant"; grant: MeshLeaseGrant | null; at: number }
  | { kind: "yield"; epoch: number; at: number }
  /** 飞书长连接已经断开（响应 disconnect 效果之后由调用方发来）。 */
  | { kind: "disconnected"; at: number }
  | { kind: "tick"; at: number };

export type CenterLeaseEffect =
  | { kind: "claim" }
  | { kind: "release"; epoch: number }
  | { kind: "connect" }
  | { kind: "disconnect" };

export interface CenterLeaseContext {
  selfId: DeviceId;
  /** 中心顺序里的第一台（降级判断用）。 */
  firstInPriority: DeviceId | null;
  /** 局域网探测发现其他设备正持有该租约时为 true，禁止进入或继续保持 orphan_holder。 */
  peerHolding?: boolean;
  ttlMs: number;
  fenceMarginMs: number;
  orphanMs: number;
}

/**
 * 状态机的一步。
 * 后置：
 * - 只有 holder 和 orphan_holder 会发出 connect，离开这两个状态时一定先发 disconnect；
 * - holder 在 lastAckAt + ttlMs - fenceMarginMs 之后的第一个事件（含 tick）里变成 candidate 并发 disconnect；
 * - 收到 grant.holder 不是本机或 epoch 比当前小的 grant 时，持有者变成 candidate 并发 disconnect；
 * - yield 后先 disconnect，收到 disconnected 才发 release；
 * - orphan_holder 只在中继连不上满 orphanMs、本机是 firstInPriority 时进入，中继连上后发 disconnect 回到 candidate；
 * - eligible 变成 false 时无论在哪个状态都回到 idle（持有的先 disconnect、再 release）。
 */
export function stepCenterLease(state: CenterLeaseState, event: CenterLeaseEvent, context: CenterLeaseContext): { state: CenterLeaseState; effects: CenterLeaseEffect[] } {
  const effects: CenterLeaseEffect[] = [];
  // 持有者先看自己是不是该掐断了：任何事件都算一次检查
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
  /** 有这个聊天软件的凭证且在中心顺序里。变化时调 refresh。 */
  eligible: () => boolean;
  priority: () => DeviceId[];
  /** 中继失联准备降级持有（或处于降级持有）时经局域网探测是否有其他设备正持有该租约。 */
  hasPeerHolder?: () => Promise<boolean>;
  /** 挂上 / 断开长连接。断开完成后 resolve。 */
  connect: () => void;
  disconnect: () => Promise<void>;
  now?: () => number;
  log: (line: string) => void;
}

export interface CenterLease {
  /** 本机现在是否挂着长连接（holder 或 orphan_holder）。 */
  holding(): boolean;
  /** 中继最近说的持有者；不知道是 null。 */
  holder(): DeviceId | null;
  /** 后置：eligible 或中心顺序变了时调，马上按新条件走一步。 */
  refresh(): void;
  onChange(listener: (holder: DeviceId | null) => void): () => void;
  /** 后置：持有的先断开长连接再 release；不再 claim。 */
  close(): Promise<void>;
}

/** 后置：候选时每 MESH_LEASE_RENEW_MS 发一次 claim；其余照 stepCenterLease。 */
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
  /** 走一步并把效果排进队列，按顺序执行（断开长连接要等它断完再 release）。 */
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
    if (closed) return;
    const t = now();
    const shouldProbe =
      options.hasPeerHolder !== undefined &&
      options.relay.state() !== "connected" &&
      (state.kind === "orphan_holder" ||
        (state.kind === "candidate" &&
          state.relayDownSince !== null &&
          t - state.relayDownSince >= MESH_LEASE_ORPHAN_MS &&
          (options.priority()[0] ?? null) === options.selfId));
    if (shouldProbe && !probing) {
      probing = true;
      try {
        peerHolding = await options.hasPeerHolder!();
      } catch {
        peerHolding = false;
      } finally {
        probing = false;
      }
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
