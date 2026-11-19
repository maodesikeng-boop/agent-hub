// 中心租约在设备这一侧（docs/account-mesh-design.md「中心顺序与租约」）：要不要 claim、什么时候挂上 / 断开飞书长连接。
// 裁决在中继（relay/core.ts），这里只照中继给的结果做，外加两条本机规则：
// - 自己掐断：持有时超过 MESH_LEASE_TTL_MS - MESH_LEASE_FENCE_MARGIN_MS 没收到续约回执，先断开长连接，中继要满 MESH_LEASE_TTL_MS 才改授；
// - 降级：中继连不上超过 MESH_LEASE_ORPHAN_MS，且本机是中心顺序里的第一台，就不经租约自己挂上，中继恢复后照租约来。
// stepCenterLease 是纯函数（时间从事件里来），createCenterLease 把它接到 RelayClient 和定时器上。
import type { DeviceId } from "../../shared/api.ts";
import type { MeshLeaseGrant, MeshLeaseName, RelayConnectionState } from "../../shared/mesh.ts";
import type { RelayClient } from "./relay-client.ts";

export type CenterLeaseState =
  /** 不是候选（没有飞书凭证、不在中心顺序里、没登录）。 */
  | { kind: "idle" }
  /** 候选，没持有。 */
  | { kind: "candidate"; relayDownSince: number | null }
  /** 持有。lastAckAt 是最后一次收到中继确认（授予或续约回执）的时刻。 */
  | { kind: "holder"; epoch: number; lastAckAt: number }
  /** 收到 lease.yield，正在断开长连接，断完回 release。 */
  | { kind: "yielding"; epoch: number }
  /** 降级持有：中继连不上，本机是中心顺序第一台。 */
  | { kind: "orphan_holder"; since: number };

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
  throw new Error("未实现");
}

export interface CenterLeaseOptions {
  name: MeshLeaseName;
  selfId: DeviceId;
  relay: RelayClient;
  /** 有这个聊天软件的凭证且在中心顺序里。变化时调 refresh。 */
  eligible: () => boolean;
  priority: () => DeviceId[];
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
  throw new Error("未实现");
}
