import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TOKEN_USAGE,
  type AgentSessionRow,
  type Driver,
  type DriverEvent,
  type DriverEventListener,
  type DriverSendInput,
  type SessionId,
  type SessionStore,
} from "../../shared/index.ts";
import { DriverSessionError, createMultiVendorDriver } from "./multi-driver.ts";

function makeRow(id: SessionId, vendor: string): AgentSessionRow {
  return {
    id,
    role: "worker",
    conversationId: id,
    pmId: null,
    workerId: id,
    vendor,
    vendorSessionId: `v-${id}`,
    cwd: "/tmp",
    addDirs: [],
    generation: 1,
    model: null,
    effort: null,
    pid: null,
    status: "idle",
    hasCompletedTurn: false,
    lastEventAt: null,
    rateLimit: null,
    usage: { ...EMPTY_TOKEN_USAGE },
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeFakeDriver(name: string) {
  const listeners = new Set<DriverEventListener>();
  const running = new Set<SessionId>();
  const driver: Driver & {
    name: string;
    running: Set<SessionId>;
    emit: (sessionId: SessionId, event: DriverEvent) => void;
    isRunning: (sessionId: SessionId) => boolean;
  } = {
    name,
    running,
    emit(sessionId, event) {
      for (const l of listeners) l(sessionId, event);
    },
    start: vi.fn(async (id: SessionId) => {
      running.add(id);
    }),
    send: vi.fn(async () => ({ kind: "written" as const })),
    interrupt: vi.fn(async () => {}),
    end: vi.fn(async (id: SessionId) => {
      running.delete(id);
    }),
    isRunning: vi.fn((id: SessionId) => running.has(id)),
    queryCommands: vi.fn(async () => [{ name: `cmd-${name}`, description: "" }]),
    cleanupStale: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {
      running.clear();
    }),
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return driver;
}

describe("createMultiVendorDriver：多厂商驱动分发", () => {
  it("按 store.get(sessionId)?.vendor 分发 start / send / interrupt / end / queryCommands / isRunning", async () => {
    const rows = new Map<SessionId, AgentSessionRow>([
      [1, makeRow(1, "claude")],
      [2, makeRow(2, "agy")],
      [3, makeRow(3, "codex")],
    ]);
    const store: SessionStore = {
      get: (id) => rows.get(id) ?? null,
      update: (id, patch) => {
        const cur = rows.get(id);
        if (!cur) throw new Error("not found");
        const next = { ...cur, ...patch };
        rows.set(id, next);
        return next;
      },
      listWithProcess: () => [],
    };
    const claude = makeFakeDriver("claude");
    const agy = makeFakeDriver("agy");
    const codex = makeFakeDriver("codex");
    const multi = createMultiVendorDriver({ store, drivers: { claude, agy, codex } });

    await multi.start(1);
    await multi.start(2);
    expect(claude.start).toHaveBeenCalledWith(1);
    expect(agy.start).toHaveBeenCalledWith(2);
    expect(codex.start).not.toHaveBeenCalled();

    expect(multi.isRunning?.(1)).toBe(true);
    expect(multi.isRunning?.(2)).toBe(true);
    expect(multi.isRunning?.(3)).toBe(false);

    const input: DriverSendInput = { messageIds: [10], source: "user", text: "hi" };
    await multi.send(3, input);
    expect(codex.send).toHaveBeenCalledWith(3, input);

    await multi.interrupt(2);
    expect(agy.interrupt).toHaveBeenCalledWith(2);

    expect(await multi.queryCommands(3)).toEqual([{ name: "cmd-codex", description: "" }]);

    await multi.end(1);
    expect(claude.end).toHaveBeenCalledWith(1);
    expect(multi.isRunning?.(1)).toBe(false);
  });

  it("会话不存在时：start / send 抛 DriverSessionError('session_not_found', sessionId)；interrupt / end 安全处理；isRunning 查所有已注册 driver", async () => {
    const store: SessionStore = {
      get: () => null,
      update: () => {
        throw new Error("not found");
      },
      listWithProcess: () => [],
    };
    const claude = makeFakeDriver("claude");
    const agy = makeFakeDriver("agy");
    agy.running.add(99);
    const multi = createMultiVendorDriver({ store, drivers: { claude, agy } });

    await expect(multi.start(404)).rejects.toThrow(DriverSessionError);
    await expect(multi.start(404)).rejects.toThrow(/session_not_found/);
    await expect(multi.send(404, { messageIds: [1], source: "user", text: "x" })).rejects.toThrow(DriverSessionError);

    // store 查不到但 agy 里跑着 99
    expect(multi.isRunning?.(99)).toBe(true);
    expect(multi.isRunning?.(404)).toBe(false);

    // interrupt / end 在会话不存在时不抛错
    await expect(multi.interrupt(99)).resolves.toBeUndefined();
    expect(agy.interrupt).toHaveBeenCalledWith(99);
    await expect(multi.end(99)).resolves.toBeUndefined();
    expect(multi.isRunning?.(99)).toBe(false);
  });

  it("会话的 vendor 未配置对应 driver 时抛清晰错误", async () => {
    const store: SessionStore = {
      get: (id) => (id === 1 ? makeRow(1, "codex") : null),
      update: () => {
        throw new Error("not found");
      },
      listWithProcess: () => [],
    };
    const claude = makeFakeDriver("claude");
    const multi = createMultiVendorDriver({ store, drivers: { claude } });

    await expect(multi.start(1)).rejects.toThrow(/codex/);
    await expect(multi.send(1, { messageIds: [1], source: "user", text: "x" })).rejects.toThrow(/codex/);
  });

  it("onEvent 汇总所有已注册 driver 的事件，cleanupStale 与 shutdown 调用所有已注册 driver", async () => {
    const store: SessionStore = {
      get: () => null,
      update: () => {
        throw new Error("not found");
      },
      listWithProcess: () => [],
    };
    const claude = makeFakeDriver("claude");
    const agy = makeFakeDriver("agy");
    const multi = createMultiVendorDriver({ store, drivers: { claude, agy } });

    const received: Array<[SessionId, string]> = [];
    const off = multi.onEvent((id, ev) => received.push([id, ev.type]));

    claude.emit(1, { type: "turn.started", at: 1 });
    agy.emit(2, { type: "turn.started", at: 2 });
    expect(received).toEqual([
      [1, "turn.started"],
      [2, "turn.started"],
    ]);

    off();
    claude.emit(1, { type: "turn.started", at: 3 });
    expect(received).toHaveLength(2);

    await multi.cleanupStale();
    expect(claude.cleanupStale).toHaveBeenCalledTimes(1);
    expect(agy.cleanupStale).toHaveBeenCalledTimes(1);

    await multi.shutdown();
    expect(claude.shutdown).toHaveBeenCalledTimes(1);
    expect(agy.shutdown).toHaveBeenCalledTimes(1);
  });
});
