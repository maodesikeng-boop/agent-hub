import { describe, expect, it } from "vitest";
import { parseServerMessage, reconnectDelay } from "./connection.ts";
import { describeError, formatTime } from "./format.ts";
import { groupMessages } from "./selectors.ts";
import { applyChange, initialState, reducer, upsertMessage, type HubState } from "./state.ts";
import {
  makeConvSnapshot,
  makeMessage,
  makeSnapshot,
  makeToolMessage,
  makeUserMessage,
  messageChange,
} from "./test-utils.ts";

function loaded(over: Parameters<typeof makeSnapshot>[0] = {}): HubState {
  return reducer(initialState, { type: "loaded", snapshot: makeSnapshot(over) });
}

describe("upsertMessage", () => {
  const a = makeMessage({ id: 1 });
  const c = makeMessage({ id: 3 });
  it("按编号插到正确的位置", () => {
    expect(upsertMessage([a, c], makeMessage({ id: 2 })).map((m) => m.id)).toEqual([1, 2, 3]);
    expect(upsertMessage([a, c], makeMessage({ id: 4 })).map((m) => m.id)).toEqual([1, 3, 4]);
    expect(upsertMessage([a, c], makeMessage({ id: 0 })).map((m) => m.id)).toEqual([0, 1, 3]);
  });
  it("同一个编号原地替换，不改原数组", () => {
    const list = [a, c];
    const updated = upsertMessage(list, makeMessage({ id: 3, text: "新" }));
    expect(updated.map((m) => m.text)).toEqual([a.text, "新"]);
    expect(list[1]).toBe(c);
  });
});

describe("applyChange", () => {
  it("seq 不比已有的大就忽略，同一条推两次只生效一次", () => {
    const s0 = loaded({ seq: 10 });
    const change = messageChange(11, "message.created", makeMessage({ id: 5 }));
    const s1 = applyChange(s0, change);
    expect(s1.seq).toBe(11);
    expect(applyChange(s1, change)).toBe(s1);
    expect(applyChange(s1, messageChange(3, "message.created", makeMessage({ id: 6 })))).toBe(s1);
  });

  it("用户消息的真消息到了，对应的临时消息被去掉", () => {
    let s = loaded({ seq: 10 });
    s = reducer(s, {
      type: "pendingAdd",
      pending: { clientId: "abc", conversationId: 1, text: "hi", phase: "sending", createdAt: 1 },
    });
    s = applyChange(s, messageChange(11, "message.created", makeUserMessage({ id: 7, dedupeKey: "client:1:abc" })));
    expect(s.pending).toEqual([]);
  });

  it("不认识的对话：只推进 seq，不改消息", () => {
    const s0 = loaded();
    const s1 = applyChange(s0, messageChange(11, "message.created", makeMessage({ id: 5, conversationId: 99 })));
    expect(s1.conversations).toBe(s0.conversations);
  });
});

describe("loaded", () => {
  it("新快照里已经有的用户消息，对应的临时消息被去掉；没有的留着", () => {
    let s = loaded();
    for (const clientId of ["a", "b"]) {
      s = reducer(s, {
        type: "pendingAdd",
        pending: { clientId, conversationId: 1, text: clientId, phase: "failed", createdAt: 1 },
      });
    }
    s = reducer(s, {
      type: "loaded",
      snapshot: makeSnapshot({
        seq: 20,
        conversations: [makeConvSnapshot([makeUserMessage({ id: 1, dedupeKey: "client:1:a" })])],
      }),
    });
    expect(s.pending.map((p) => p.clientId)).toEqual(["b"]);
    expect(s.seq).toBe(20);
  });

  it("重复拉取失败不会把已经显示的界面清掉", () => {
    const s = loaded();
    expect(reducer(s, { type: "loadFailed", unauthorized: false }).phase).toBe("ready");
    expect(reducer(initialState, { type: "loadFailed", unauthorized: false }).phase).toBe("error");
    expect(reducer(s, { type: "loadFailed", unauthorized: true }).phase).toBe("unauthorized");
  });
});

describe("olderDone", () => {
  it("已经有的不重复加，按编号排好", () => {
    const s0 = loaded({
      conversations: [makeConvSnapshot([makeMessage({ id: 5 }), makeMessage({ id: 6 })], { hasMore: true })],
    });
    const s1 = reducer(s0, {
      type: "olderDone",
      conversationId: 1,
      messages: [makeMessage({ id: 3 }), makeMessage({ id: 4 }), makeMessage({ id: 5 })],
      hasMore: false,
    });
    expect(s1.conversations[1]?.messages.map((m) => m.id)).toEqual([3, 4, 5, 6]);
    expect(s1.conversations[1]?.hasMore).toBe(false);
  });
});

describe("groupMessages", () => {
  it("连续的工具调用合成一组", () => {
    const items = groupMessages([
      makeMessage({ id: 1 }),
      makeToolMessage({ id: 2 }),
      makeToolMessage({ id: 3 }),
      makeMessage({ id: 4 }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "tools", "message"]);
    expect(items[1]?.kind === "tools" && items[1].messages.length).toBe(2);
  });
});

describe("parseServerMessage", () => {
  it("认识 resync 和四种变化", () => {
    expect(parseServerMessage('{"type":"resync"}')).toEqual({ type: "resync" });
    expect(parseServerMessage('{"seq":3,"type":"health.updated","data":{}}')).not.toBeNull();
  });
  it("坏的、不认识的返回 null", () => {
    for (const bad of ["x", "null", "[]", '{"type":"x","seq":1}', '{"type":"message.created"}', 5, undefined]) {
      expect(parseServerMessage(bad)).toBeNull();
    }
  });
});

describe("reconnectDelay", () => {
  it("1、2、4、8 秒，最多 10 秒", () => {
    expect([0, 1, 2, 3, 4, 20].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
});

describe("describeError", () => {
  it("认识的错误码显示中文，细节分开", () => {
    expect(describeError("claude_not_found: spawn claude ENOENT")).toEqual({
      label: "找不到 claude",
      detail: "spawn claude ENOENT",
    });
    expect(describeError("start_timeout")).toEqual({ label: "claude 启动超时", detail: "" });
  });
  it("不认识的原样", () => {
    expect(describeError("disk full: /tmp")).toEqual({ label: "disk full: /tmp", detail: "" });
  });
});

describe("formatTime", () => {
  const now = new Date(2026, 10, 3, 12, 0);
  it("今天时分，今年月日，更早带年", () => {
    expect(formatTime(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatTime(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe("10/20");
    expect(formatTime(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe("2025/1/2");
  });
});
