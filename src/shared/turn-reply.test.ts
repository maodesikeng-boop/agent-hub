import { describe, expect, it } from "vitest";
import type { Message, MessageStatus } from "./domain.ts";
import { replyIdOf, turnReplyStateOf } from "./turn-reply.ts";

const message = (patch: Partial<Message> = {}): Message => ({
  id: 10,
  conversationId: 1,
  sessionId: 1,
  workerId: null,
  sender: "user",
  kind: "text",
  text: "问",
  meta: null,
  collapsed: false,
  dedupeKey: "client:1:x",
  status: "queued",
  failureReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("replyIdOf", () => {
  it("用户消息 meta.replyId 是正整数时返回它", () => {
    expect(replyIdOf(message({ meta: { replyId: 12 } }))).toBe(12);
  });

  it("agent 消息、系统消息、meta 是 null、replyId 不是正整数时返回 null", () => {
    expect(replyIdOf(message({ sender: "agent", meta: { replyId: 12 } }))).toBeNull();
    expect(replyIdOf(message({ sender: "system", meta: { replyId: 12 } }))).toBeNull();
    expect(replyIdOf(message({ meta: null }))).toBeNull();
    for (const bad of [0, -3, 1.5, "12", null, Number.NaN]) expect(replyIdOf(message({ meta: { replyId: bad } }))).toBeNull();
  });
});

describe("turnReplyStateOf", () => {
  const reply = message({ id: 11, sender: "agent", status: null, text: "答" });

  it("排队、已送达、处理中返回 waiting", () => {
    for (const status of ["queued", "delivered", "processing"] as MessageStatus[]) expect(turnReplyStateOf(message({ status }), null)).toEqual({ kind: "waiting" });
  });

  it("replied 且有回复返回 replied，带着那条回复", () => {
    expect(turnReplyStateOf(message({ status: "replied", meta: { replyId: 11 } }), reply)).toEqual({ kind: "replied", reply });
  });

  it("replied 但 reply 是 null 返回 silent", () => {
    expect(turnReplyStateOf(message({ status: "replied" }), null)).toEqual({ kind: "silent" });
  });

  it("stopped、cancelled 返回 ended，reason 是 null", () => {
    expect(turnReplyStateOf(message({ status: "stopped" }), null)).toEqual({ kind: "ended", status: "stopped", reason: null });
    expect(turnReplyStateOf(message({ status: "cancelled" }), null)).toEqual({ kind: "ended", status: "cancelled", reason: null });
  });

  it("failed 返回 ended，reason 是 failureReason", () => {
    expect(turnReplyStateOf(message({ status: "failed", failureReason: "claude_not_found" }), null)).toEqual({
      kind: "ended",
      status: "failed",
      reason: "claude_not_found",
    });
  });

  it("同样的 request 和 reply 对象返回同一个结果对象", () => {
    const request = message({ status: "replied", meta: { replyId: 11 } });
    expect(turnReplyStateOf(request, reply)).toBe(turnReplyStateOf(request, reply));
    const waiting = message({ status: "processing" });
    expect(turnReplyStateOf(waiting, null)).toBe(turnReplyStateOf(waiting, null));
    expect(turnReplyStateOf(message({ status: "queued" }), null)).toBe(turnReplyStateOf(message({ status: "processing" }), null));
  });
});
