import { describe, expect, it, vi } from "vitest";
import { MESH_LEASE_FENCE_MARGIN_MS, MESH_LEASE_ORPHAN_MS, MESH_LEASE_RENEW_MS, MESH_LEASE_TTL_MS } from "../../shared/limits.ts";
import type { MeshLeaseGrant, RelayConnectionState } from "../../shared/mesh.ts";
import type { RelayClientFrame } from "../../relay/protocol.ts";
import { createCenterLease, INITIAL_CENTER_LEASE_STATE, stepCenterLease, type CenterLeaseContext, type CenterLeaseEffect, type CenterLeaseEvent, type CenterLeaseState } from "./lease.ts";
import type { RelayClient, RelayClientEvents } from "./relay-client.ts";
import { DEVICE_A, DEVICE_B } from "./test-helpers.ts";

const ctx: CenterLeaseContext = { selfId: DEVICE_A, firstInPriority: DEVICE_A, ttlMs: MESH_LEASE_TTL_MS, fenceMarginMs: MESH_LEASE_FENCE_MARGIN_MS, orphanMs: MESH_LEASE_ORPHAN_MS };
const grant = (holder: string, epoch: number): MeshLeaseGrant => ({ name: "feishu", holder, epoch, ttlMs: MESH_LEASE_TTL_MS });
const holding = (s: CenterLeaseState) => s.kind === "holder" || s.kind === "orphan_holder";

/** 依次喂事件，回最后的状态和所有效果。 */
function run(events: CenterLeaseEvent[], start: CenterLeaseState = { kind: "candidate", relayDownSince: null }, context = ctx) {
  let state = start;
  const effects: CenterLeaseEffect[] = [];
  for (const event of events) {
    const result = stepCenterLease(state, event, context);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

describe("stepCenterLease", () => {
  it("候选收到授给本机的 grant 变成 holder 并发 connect", () => {
    const { state, effects } = run([{ kind: "grant", grant: grant(DEVICE_A, 1), at: 0 }]);
    expect(state).toEqual({ kind: "holder", epoch: 1, lastAckAt: 0, relayDownSince: null });
    expect(effects).toEqual([{ kind: "connect" }]);
  });

  it("holder 超过 ttl - fenceMargin 没收到回执，下一次 tick 变成 candidate 并发 disconnect", () => {
    const start: CenterLeaseState = { kind: "holder", epoch: 1, lastAckAt: 0, relayDownSince: null };
    const fence = MESH_LEASE_TTL_MS - MESH_LEASE_FENCE_MARGIN_MS;
    expect(run([{ kind: "tick", at: fence }], start).state.kind).toBe("holder");
    const { state, effects } = run([{ kind: "tick", at: fence + 1 }], start);
    expect(state.kind).toBe("candidate");
    expect(effects[0]).toEqual({ kind: "disconnect" });
  });

  it("holder 收到授给别的设备或 epoch 更小的 grant 时发 disconnect", () => {
    const start: CenterLeaseState = { kind: "holder", epoch: 3, lastAckAt: 0, relayDownSince: null };
    for (const g of [grant(DEVICE_B, 4), grant(DEVICE_A, 2), null]) {
      const { state, effects } = run([{ kind: "grant", grant: g, at: 1 }], start);
      expect(state.kind).toBe("candidate");
      expect(effects).toEqual([{ kind: "disconnect" }]);
    }
    // 同一台、epoch 不小：算续约回执
    expect(run([{ kind: "grant", grant: grant(DEVICE_A, 3), at: 9 }], start).state).toEqual({ kind: "holder", epoch: 3, lastAckAt: 9, relayDownSince: null });
  });

  it("收到 yield 先 disconnect，disconnected 之后才 release", () => {
    const start: CenterLeaseState = { kind: "holder", epoch: 2, lastAckAt: 0, relayDownSince: null };
    const yielded = run([{ kind: "yield", epoch: 2, at: 1 }], start);
    expect(yielded.state.kind).toBe("yielding");
    expect(yielded.effects).toEqual([{ kind: "disconnect" }]);
    const released = run([{ kind: "disconnected", at: 2 }], yielded.state);
    expect(released.state.kind).toBe("candidate");
    expect(released.effects).toEqual([{ kind: "release", epoch: 2 }]);
  });

  it("中继连不上满 orphanMs 且本机是中心顺序第一台时降级持有并发 connect", () => {
    const { state, effects } = run([
      { kind: "relay", state: "unreachable", at: 1_000 },
      { kind: "tick", at: 1_000 + MESH_LEASE_ORPHAN_MS - 1 },
      { kind: "tick", at: 1_000 + MESH_LEASE_ORPHAN_MS },
    ]);
    expect(state.kind).toBe("orphan_holder");
    expect(effects.at(-1)).toEqual({ kind: "connect" });
    expect(effects.filter((e) => e.kind === "connect")).toHaveLength(1);
  });

  it("不是中心顺序第一台时中继连不上多久都不降级", () => {
    const { state, effects } = run([{ kind: "relay", state: "unreachable", at: 0 }, { kind: "tick", at: MESH_LEASE_ORPHAN_MS * 10 }], undefined, { ...ctx, firstInPriority: DEVICE_B });
    expect(state.kind).toBe("candidate");
    expect(effects.some((e) => e.kind === "connect")).toBe(false);
  });

  it("降级持有时中继连上，发 disconnect 回到 candidate 重新 claim", () => {
    const { state, effects } = run([{ kind: "relay", state: "connected", at: 5 }], { kind: "orphan_holder", since: 0, relayDownSince: 0 });
    expect(state).toEqual({ kind: "candidate", relayDownSince: null });
    expect(effects).toEqual([{ kind: "disconnect" }, { kind: "claim" }]);
  });

  it("局域网探到其他设备持有租约（peerHolding）时不进入 orphan_holder，已在 orphan_holder 时发 disconnect 让出", () => {
    const blocked = run(
      [
        { kind: "relay", state: "unreachable", at: 1_000 },
        { kind: "tick", at: 1_000 + MESH_LEASE_ORPHAN_MS },
      ],
      undefined,
      { ...ctx, peerHolding: true },
    );
    expect(blocked.state.kind).toBe("candidate");
    expect(blocked.effects.some((e) => e.kind === "connect")).toBe(false);

    const yielded = run([{ kind: "tick", at: 2_000 }], { kind: "orphan_holder", since: 1_000, relayDownSince: 0 }, { ...ctx, peerHolding: true });
    expect(yielded.state).toEqual({ kind: "candidate", relayDownSince: 0 });
    expect(yielded.effects).toEqual([{ kind: "disconnect" }, { kind: "claim" }]);
  });

  it("eligible 变成 false 时持有的先 disconnect 再 release，回到 idle", () => {
    const { state, effects } = run([{ kind: "eligible", eligible: false, at: 1 }], { kind: "holder", epoch: 5, lastAckAt: 0, relayDownSince: null });
    expect(state.kind).toBe("idle");
    expect(effects).toEqual([{ kind: "disconnect" }, { kind: "release", epoch: 5 }]);
    expect(run([{ kind: "eligible", eligible: false, at: 1 }], { kind: "orphan_holder", since: 0, relayDownSince: 0 }).effects).toEqual([{ kind: "disconnect" }]);
    expect(run([{ kind: "eligible", eligible: true, at: 2 }], INITIAL_CENTER_LEASE_STATE).effects).toEqual([{ kind: "claim" }]);
  });

  it("任何一步都不会在没 disconnect 的情况下离开持有状态", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
    const relayStates: RelayConnectionState[] = ["connected", "unreachable", "connecting"];
    let state: CenterLeaseState = INITIAL_CENTER_LEASE_STATE;
    let at = 0;
    for (let i = 0; i < 5_000; i++) {
      at += Math.floor(rand() * 8_000);
      const event: CenterLeaseEvent = pick([
        { kind: "eligible", eligible: rand() < 0.8, at },
        { kind: "relay", state: pick(relayStates), at },
        { kind: "grant", grant: rand() < 0.2 ? null : grant(pick([DEVICE_A, DEVICE_B]), Math.floor(rand() * 5)), at },
        { kind: "yield", epoch: Math.floor(rand() * 5), at },
        { kind: "disconnected", at },
        { kind: "tick", at },
      ] as CenterLeaseEvent[]);
      const context = { ...ctx, firstInPriority: rand() < 0.5 ? DEVICE_A : DEVICE_B, peerHolding: rand() < 0.3 };
      const result = stepCenterLease(state, event, context);
      if (holding(state) && !holding(result.state)) expect(result.effects.some((e) => e.kind === "disconnect")).toBe(true);
      if (result.effects.some((e) => e.kind === "connect")) expect(holding(result.state)).toBe(true);
      state = result.state;
    }
  });
});

/** 假中继客户端：记下发出的帧，测试手动推事件。 */
function fakeRelay(initial: RelayConnectionState = "connected") {
  const sent: RelayClientFrame[] = [];
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  let state = initial;
  const relay = {
    state: () => state,
    send: (frame: RelayClientFrame) => {
      sent.push(frame);
      return state === "connected";
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(listener);
      handlers.set(event, set);
      return () => set.delete(listener);
    },
  } as unknown as RelayClient;
  const emit = <K extends keyof RelayClientEvents>(event: K, ...args: Parameters<RelayClientEvents[K]>) => {
    if (event === "state") state = args[0] as RelayConnectionState;
    for (const listener of handlers.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
  };
  return { relay, sent, emit };
}

describe("createCenterLease", () => {
  it("候选时每 MESH_LEASE_RENEW_MS 发一次 lease.claim，idle 时不发", async () => {
    vi.useFakeTimers();
    try {
      const { relay, sent } = fakeRelay();
      let eligible = true;
      const lease = createCenterLease({ name: "feishu", selfId: DEVICE_A, relay, eligible: () => eligible, priority: () => [DEVICE_A], connect: () => {}, disconnect: async () => {}, log: () => {} });
      await vi.advanceTimersByTimeAsync(0);
      const claims = () => sent.filter((f) => f.type === "lease.claim").length;
      expect(claims()).toBe(1);
      await vi.advanceTimersByTimeAsync(MESH_LEASE_RENEW_MS * 3);
      expect(claims()).toBe(4);
      eligible = false;
      lease.refresh();
      await vi.advanceTimersByTimeAsync(MESH_LEASE_RENEW_MS * 3);
      expect(claims()).toBe(4);
      await lease.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("持有时 holding() 为 true，onChange 收到本机编号", async () => {
    const { relay, emit } = fakeRelay();
    let connected = 0;
    const lease = createCenterLease({ name: "feishu", selfId: DEVICE_A, relay, eligible: () => true, priority: () => [DEVICE_A], connect: () => void connected++, disconnect: async () => {}, log: () => {} });
    const holders: Array<string | null> = [];
    lease.onChange((h) => holders.push(h));
    emit("lease", "feishu", grant(DEVICE_B, 1));
    expect(lease.holder()).toBe(DEVICE_B);
    expect(lease.holding()).toBe(false);
    emit("lease", "feishu", grant(DEVICE_A, 2));
    expect(lease.holding()).toBe(true);
    expect(holders).toEqual([DEVICE_B, DEVICE_A]);
    await new Promise((r) => setTimeout(r, 0));
    expect(connected).toBe(1);
    await lease.close();
  });

  it("close 时持有的先断开长连接再 release", async () => {
    const { relay, emit, sent } = fakeRelay();
    const order: string[] = [];
    const lease = createCenterLease({
      name: "feishu",
      selfId: DEVICE_A,
      relay,
      eligible: () => true,
      priority: () => [DEVICE_A],
      connect: () => order.push("connect"),
      disconnect: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("disconnected");
      },
      log: () => {},
    });
    emit("lease", "feishu", grant(DEVICE_A, 7));
    const originalSend = relay.send;
    relay.send = (frame) => {
      if (frame.type === "lease.release") order.push(`release:${frame.epoch}`);
      return originalSend(frame);
    };
    await lease.close();
    expect(order).toEqual(["connect", "disconnected", "release:7"]);
    expect(sent.at(-1)).toEqual({ type: "lease.release", name: "feishu", epoch: 7 });
  });
});
