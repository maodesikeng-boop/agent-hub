import { describe, expect, it, vi } from "vitest";
import {
  DriverError,
  type ActionRow,
  type AgentSessionRow,
  type DriverSendResult,
  type Message,
  type RateLimitInfo,
} from "../shared/index.ts";
import { QUEUED_RECHECK_MS, createSessionSendHandler, createSessionStartHandler, type HandlerDeps } from "./handlers.ts";

const NOW = 1_800_000_000_000;

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 7,
    conversationId: 1,
    sessionId: 1,
    ticketId: null,
    sender: "user",
    kind: "text",
    text: "你好",
    meta: null,
    collapsed: false,
    dedupeKey: "client:1:a",
    status: "queued",
    failureReason: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function action<T extends "session.start" | "session.send">(type: T, params: ActionRow<T>["params"]): ActionRow<T> {
  return { id: 1, type, dedupeKey: "k", params, status: "running", attempts: 0, nextAttemptAt: 0, lastError: null, createdAt: 0, updatedAt: 0 };
}

function deps(options: { message?: Message | null; send?: DriverSendResult | Error; rateLimit?: RateLimitInfo | null } = {}) {
  const send = vi.fn(async () => {
    if (options.send instanceof Error) throw options.send;
    return options.send ?? { kind: "written" as const };
  });
  const start = vi.fn(async () => {});
  const d: HandlerDeps = {
    driver: { start, send },
    ledger: { getMessage: () => (options.message === undefined ? message() : options.message) },
    sessions: { get: () => ({ rateLimit: options.rateLimit ?? null }) as AgentSessionRow },
    now: () => NOW,
  };
  return { d, send, start };
}

const sendAction = (extra: { resend?: boolean } = {}) =>
  action("session.send", { sessionId: 1, messageId: 7, source: "user", ...extra });

describe("session.start 处理函数", () => {
  it("调 driver.start，recovery 原样传过去", async () => {
    const { d, start } = deps();
    expect(await createSessionStartHandler(d)(action("session.start", { sessionId: 3, generation: 1, recovery: true }))).toEqual({ kind: "done" });
    expect(start).toHaveBeenCalledWith(3, { recovery: true });
    await createSessionStartHandler(d)(action("session.start", { sessionId: 3, generation: 1 }));
    expect(start).toHaveBeenLastCalledWith(3, {});
  });

  it("起不来的 DriverError 抛给执行器退避", async () => {
    const { d, start } = deps();
    start.mockRejectedValueOnce(new DriverError("claude_not_found", "claude: ENOENT"));
    await expect(createSessionStartHandler(d)(action("session.start", { sessionId: 3, generation: 1 }))).rejects.toThrow(/^claude_not_found/);
  });
});

describe("session.send 处理函数", () => {
  it("读出消息文字，调 driver.send；写进去了 → done", async () => {
    const { d, send } = deps();
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
    expect(send).toHaveBeenCalledWith(1, { messageIds: [7], source: "user", text: "你好" });
  });

  it("重启后重发：resend 传过去（重发说明由驱动层加，这里不加标签）", async () => {
    const { d, send } = deps({ message: message({ status: "processing" }) });
    await createSessionSendHandler(d)(sendAction({ resend: true }));
    expect(send).toHaveBeenCalledWith(1, { messageIds: [7], source: "user", text: "你好", resend: true });
  });

  it("会话正忙、在驱动层排队 → later，过一会儿再问", async () => {
    const { d } = deps({ send: { kind: "queued" } });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "session_busy" });
  });

  it("写入前校验没过 → done（驱动层已经出了 driver.error，账本标失败）", async () => {
    const { d } = deps({ send: { kind: "rejected" } });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
  });

  it("可重试的 DriverError 直接抛出去", async () => {
    const { d } = deps({ send: new DriverError("spawn_failed", "boom") });
    await expect(createSessionSendHandler(d)(sendAction())).rejects.toBeInstanceOf(DriverError);
  });

  it("额度用完 → later 到恢复之后，不调 driver", async () => {
    const resetsAt = NOW / 1000 + 60;
    const { d, send } = deps({ rateLimit: { status: "rejected", resetsAt, windows: {} } });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "later", delayMs: 61_000, reason: "rate_limited" });
    expect(send).not.toHaveBeenCalled();
  });

  it("额度很久以后才恢复：最多推迟 5 分钟再看", async () => {
    const { d } = deps({ rateLimit: { status: "rejected", resetsAt: NOW / 1000 + 3600, windows: {} } });
    expect(await createSessionSendHandler(d)(sendAction())).toMatchObject({ kind: "later", delayMs: 300_000 });
  });

  it("额度快用完（allowed_warning）、或者恢复时间已经过了：照常发", async () => {
    for (const rateLimit of [
      { status: "allowed_warning", resetsAt: NOW / 1000 + 60, windows: {} },
      { status: "rejected", resetsAt: NOW / 1000 - 1, windows: {} },
      { status: "rejected", resetsAt: null, windows: {} },
    ]) {
      const { d, send } = deps({ rateLimit });
      expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("消息不在了，或者已经有结果（已回复、已停止）→ done，不再发", async () => {
    for (const m of [null, message({ status: "replied" }), message({ status: "stopped" })]) {
      const { d, send } = deps({ message: m });
      expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("失败过的消息再发（用户重试）照常发", async () => {
    const { d, send } = deps({ message: message({ status: "failed", failureReason: "crash" }) });
    expect(await createSessionSendHandler(d)(sendAction())).toEqual({ kind: "done" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
