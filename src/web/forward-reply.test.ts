// 总助时间流里转交回复的近窗选择器和补取钩子：归属只认消息编号和 replyId，本机和配对设备按设备键分开。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { createStore, type StoreApi } from "zustand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTER_FORWARD_REPLY_MISS_RETRY_MS, type ConversationId, type Message, type TurnReplyView } from "../shared/index.ts";
import { ApiError, type HubClient } from "./client.ts";
import { forwardReplyOf, forwardReplyQueryKey, useForwardReply, type DeviceStoreLookup } from "./forward-reply.ts";
import type { RouterTurnDestination } from "./router-stream.ts";
import { initialState, type ConversationView, type HubState } from "./state.ts";
import { makeConversation, makeMessage, makeUserMessage } from "./test-utils.ts";

const view = (messages: Message[]): ConversationView => ({ conversation: makeConversation({ id: 1 }), messages, hasMore: false });

const question = (id: number, over: Partial<Message> = {}) => makeUserMessage({ id, text: `问 ${id}`, ...over });
const answer = (id: number, text = `答 ${id}`) => makeMessage({ id, text });

describe("forwardReplyOf", () => {
  it("原消息在近窗且处理中：返回 waiting", () => {
    expect(forwardReplyOf(view([question(10, { status: "processing" })]), 10)).toEqual({ kind: "waiting" });
  });

  it("原消息 replied、回复也在近窗：返回 replied，带着那条回复", () => {
    const reply = answer(11);
    const state = forwardReplyOf(view([question(10, { meta: { replyId: 11 } }), reply]), 10);
    expect(state).toEqual({ kind: "replied", reply });
  });

  it("原消息 replied、有 replyId 但回复不在近窗：返回 null（要补取）", () => {
    expect(forwardReplyOf(view([question(10, { meta: { replyId: 11 } })]), 10)).toBeNull();
  });

  it("原消息 replied 但没有 replyId（没写文字、对方是老版本）：返回 silent", () => {
    expect(forwardReplyOf(view([question(10), answer(11)]), 10)).toEqual({ kind: "silent" });
  });

  it("原消息不在近窗：返回 null", () => {
    expect(forwardReplyOf(view([question(12)]), 10)).toBeNull();
    expect(forwardReplyOf(undefined, 10)).toBeNull();
  });

  it("原消息 stopped：返回 ended，不把它后面别的轮次的文字当回复", () => {
    const state = forwardReplyOf(view([question(10, { status: "stopped" }), answer(11, "我查一下……"), question(12), answer(13, "别的问题的答案")]), 10);
    expect(state).toEqual({ kind: "ended", status: "stopped", reason: null });
  });

  it("同一个项目经理对话里相近的两问两答：每条转交只拿到自己那一轮的回复", () => {
    const a1 = answer(11, "飞书接入做到一半");
    const a2 = answer(14, "飞书接入的 PR 还没合");
    const messages = [question(10, { text: "飞书接入做到哪里了", meta: { replyId: 11 } }), a1, question(12, { text: "飞书接入的 PR 合了吗", meta: { replyId: 14 } }), makeMessage({ id: 13, kind: "tool" }), a2];
    expect(forwardReplyOf(view(messages), 10)).toEqual({ kind: "replied", reply: a1 });
    expect(forwardReplyOf(view(messages), 12)).toEqual({ kind: "replied", reply: a2 });
  });

  it("messages 数组没变时返回同一个对象；对话里来了无关的新消息，已定的回复对象不变", () => {
    const messages = [question(10, { meta: { replyId: 11 } }), answer(11)];
    const first = forwardReplyOf(view(messages), 10);
    expect(forwardReplyOf(view(messages), 10)).toBe(first);
    expect(forwardReplyOf(view([...messages, answer(12, "无关的新消息")]), 10)).toBe(first);
  });
});

const dest = (over: Partial<RouterTurnDestination> = {}): RouterTurnDestination => ({
  key: "local:c:1:0",
  deviceKey: "",
  deviceName: "MacBook",
  self: true,
  worker: false,
  conversationId: 1,
  name: "小林",
  projectName: "agent-hub",
  pmId: 1,
  opLabel: null,
  forwardMessageId: 10,
  ...over,
});

const storeWith = (conversations: Record<ConversationId, ConversationView>, connection: HubState["connection"] = "open"): StoreApi<HubState> =>
  createStore<HubState>(() => ({ ...initialState, phase: "ready", connection, conversations }));

const putMessages = (store: StoreApi<HubState>, messages: Message[]) => store.setState((s) => ({ ...s, conversations: { 1: view(messages) } }));

const clientOf = (fetchTurnReply: (id: number) => Promise<TurnReplyView>): HubClient => ({ fetchTurnReply }) as unknown as HubClient;

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
const render = (d: RouterTurnDestination, stores: DeviceStoreLookup, client: HubClient) => renderHook(() => useForwardReply(d, stores, client), { wrapper });
const apiError = (status: number) => new ApiError(status, { code: null, text: "x", raw: "x" });

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("useForwardReply", () => {
  it("近窗能定时不发补取请求", () => {
    const fetchTurnReply = vi.fn();
    const store = storeWith({ 1: view([question(10, { meta: { replyId: 11 } }), answer(11)]) });
    const { result } = render(dest(), () => store, clientOf(fetchTurnReply));
    expect(result.current.kind).toBe("replied");
    expect(fetchTurnReply).not.toHaveBeenCalled();
  });

  it("近窗定不了时向目标设备补取一次，同一编号在多次渲染里不重复请求", async () => {
    const request = question(10, { meta: { replyId: 11 } });
    const reply = answer(11, "补取到的回复");
    const fetchTurnReply = vi.fn(async () => ({ request, reply }));
    const store = storeWith({ 1: view([]) });
    const { result, rerender } = render(dest(), () => store, clientOf(fetchTurnReply));
    expect(result.current).toEqual({ kind: "unknown" });
    await waitFor(() => expect(result.current).toEqual({ kind: "replied", reply }));
    rerender();
    rerender();
    expect(fetchTurnReply).toHaveBeenCalledTimes(1);
    expect(fetchTurnReply).toHaveBeenCalledWith(10);
    // 已经定了的结果：另一个同键的组件挂上来也不再取
    const second = render(dest(), () => store, clientOf(fetchTurnReply));
    expect(second.result.current).toEqual({ kind: "replied", reply });
    expect(fetchTurnReply).toHaveBeenCalledTimes(1);
  });

  it("补取到 waiting 后，那台设备推来原消息变 replied 和回复：改用近窗结果", async () => {
    const waiting = question(10, { status: "processing" });
    const fetchTurnReply = vi.fn(async () => ({ request: waiting, reply: null }));
    const store = storeWith({ 1: view([]) });
    const { result } = render(dest(), () => store, clientOf(fetchTurnReply));
    await waitFor(() => expect(result.current).toEqual({ kind: "waiting" }));
    const reply = answer(11, "推来的回复");
    act(() => putMessages(store, [question(10, { meta: { replyId: 11 } }), reply]));
    expect(result.current).toEqual({ kind: "replied", reply });
  });

  it("那台设备重拉快照后，在途状态的补取结果作废、重新取", async () => {
    const waiting = question(10, { status: "processing" });
    const done = question(10, { meta: { replyId: 11 } });
    const reply = answer(11, "断线期间答完的");
    let calls = 0;
    const fetchTurnReply = vi.fn(async () => (++calls === 1 ? { request: waiting, reply: null } : { request: done, reply }));
    const store = storeWith({ 1: view([]) });
    const { result } = render(dest(), () => store, clientOf(fetchTurnReply));
    await waitFor(() => expect(result.current).toEqual({ kind: "waiting" }));
    act(() => store.setState((s) => ({ ...s, connection: "reconnecting" })));
    act(() => store.setState((s) => ({ ...s, connection: "open" })));
    await waitFor(() => expect(result.current).toEqual({ kind: "replied", reply }));
    expect(fetchTurnReply).toHaveBeenCalledTimes(2);
  });

  it("消息滑出近窗：补取到 waiting 后，那台设备丢掉的近窗外更新（outsideRev 变了）让未决补取作废重取", async () => {
    const waiting = question(10, { status: "processing" });
    const done = question(10, { meta: { replyId: 11 } });
    const reply = answer(11, "滑出近窗后答完的");
    let calls = 0;
    const fetchTurnReply = vi.fn(async () => (++calls === 1 ? { request: waiting, reply: null } : { request: done, reply }));
    const store = storeWith({ 1: view([]) });
    const { result } = render(dest(), () => store, clientOf(fetchTurnReply));
    await waitFor(() => expect(result.current).toEqual({ kind: "waiting" }));
    act(() => store.setState((s) => ({ ...s, conversations: { 1: { ...s.conversations[1]!, outsideRev: 1 } } })));
    await waitFor(() => expect(result.current).toEqual({ kind: "replied", reply }));
    expect(fetchTurnReply).toHaveBeenCalledTimes(2);
  });

  it("连接一直是 open、只是重拉了快照（snapshotRev 变了）：未决补取作废重取", async () => {
    const waiting = question(10, { status: "processing" });
    const done = question(10, { meta: { replyId: 11 } });
    const reply = answer(11, "resync 后答完的");
    let calls = 0;
    const fetchTurnReply = vi.fn(async () => (++calls === 1 ? { request: waiting, reply: null } : { request: done, reply }));
    const store = storeWith({ 1: view([]) });
    const { result } = render(dest(), () => store, clientOf(fetchTurnReply));
    await waitFor(() => expect(result.current).toEqual({ kind: "waiting" }));
    act(() => store.setState((s) => ({ ...s, snapshotRev: s.snapshotRev + 1 })));
    await waitFor(() => expect(result.current).toEqual({ kind: "replied", reply }));
    expect(fetchTurnReply).toHaveBeenCalledTimes(2);
  });

  it("已经定了的补取结果不因快照重拉再取", async () => {
    const done = question(10, { meta: { replyId: 11 } });
    const fetchTurnReply = vi.fn(async () => ({ request: done, reply: answer(11) }));
    const store = storeWith({ 1: view([]) });
    const { result } = render(dest(), () => store, clientOf(fetchTurnReply));
    await waitFor(() => expect(result.current.kind).toBe("replied"));
    act(() => store.setState((s) => ({ ...s, snapshotRev: s.snapshotRev + 1 })));
    expect(fetchTurnReply).toHaveBeenCalledTimes(1);
  });

  it("目标设备首份快照还没到（phase 不是 ready）：不提前补取，快照到了近窗里有就直接用", async () => {
    const fetchTurnReply = vi.fn(async () => ({ request: question(10, { status: "processing" }), reply: null }));
    const store = storeWith({}, "connecting");
    store.setState((s) => ({ ...s, phase: "loading" }));
    const { result } = render(dest({ deviceKey: "tokyo" }), (key) => (key === "tokyo" ? store : null), clientOf(fetchTurnReply));
    expect(result.current).toEqual({ kind: "unknown" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchTurnReply).not.toHaveBeenCalled();
    act(() => store.setState((s) => ({ ...s, phase: "ready", conversations: { 1: view([question(10, { status: "processing" })]) } })));
    expect(result.current).toEqual({ kind: "waiting" });
    expect(fetchTurnReply).not.toHaveBeenCalled();
  });

  it("目标设备快照拉不到（phase error）：不补取", async () => {
    const fetchTurnReply = vi.fn();
    const store = storeWith({}, "reconnecting");
    store.setState((s) => ({ ...s, phase: "error" }));
    const { result } = render(dest({ deviceKey: "tokyo" }), (key) => (key === "tokyo" ? store : null), clientOf(fetchTurnReply));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toEqual({ kind: "unknown" });
    expect(fetchTurnReply).not.toHaveBeenCalled();
  });

  it("配对设备离线：返回 unknown，不报错；重连后补齐", async () => {
    const request = question(10, { meta: { replyId: 11 } });
    const reply = answer(11, "重连后补齐的回复");
    let online = false;
    const fetchTurnReply = vi.fn(async () => {
      if (!online) throw apiError(502);
      return { request, reply };
    });
    const store = storeWith({ 1: view([]) }, "reconnecting");
    const { result } = render(dest({ deviceKey: "tokyo" }), (key) => (key === "tokyo" ? store : null), clientOf(fetchTurnReply));
    await waitFor(() => expect(fetchTurnReply).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual({ kind: "unknown" });
    online = true;
    act(() => store.setState((s) => ({ ...s, connection: "open" })));
    await waitFor(() => expect(result.current).toEqual({ kind: "replied", reply }));
  });

  it("补取失败只短暂记：同一消息一分钟内不重复打请求，过了再取", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fetchTurnReply = vi.fn(async () => {
        throw apiError(502);
      });
      const store = storeWith({ 1: view([]) });
      const first = render(dest(), () => store, clientOf(fetchTurnReply));
      await vi.waitFor(() => expect(queryClient.getQueryData(forwardReplyQueryKey("", 10))).toEqual({ outcome: "failed" }));
      expect(fetchTurnReply).toHaveBeenCalledTimes(1);
      first.unmount();
      const second = render(dest(), () => store, clientOf(fetchTurnReply));
      expect(fetchTurnReply).toHaveBeenCalledTimes(1);
      second.unmount();
      vi.setSystemTime(Date.now() + ROUTER_FORWARD_REPLY_MISS_RETRY_MS + 1);
      render(dest(), () => store, clientOf(fetchTurnReply));
      await vi.waitFor(() => expect(fetchTurnReply).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("补取 404（老版本设备、消息已清理）：返回 silent", async () => {
    const fetchTurnReply = vi.fn(async () => {
      throw apiError(404);
    });
    const store = storeWith({ 1: view([]) });
    const { result } = render(dest(), () => store, clientOf(fetchTurnReply));
    await waitFor(() => expect(result.current).toEqual({ kind: "silent" }));
  });

  it("设备刚被删（找不到仓库）：unknown，不补取", () => {
    const fetchTurnReply = vi.fn();
    const { result } = render(dest({ deviceKey: "gone" }), () => null, clientOf(fetchTurnReply));
    expect(result.current).toEqual({ kind: "unknown" });
    expect(fetchTurnReply).not.toHaveBeenCalled();
  });

  it("本机和配对设备上编号相同的两条消息互不串：按设备键分开", async () => {
    const localReply = answer(11, "本机的回复");
    const tokyoReply = answer(11, "东京的回复");
    const local = storeWith({ 1: view([question(10, { meta: { replyId: 11 } }), localReply]) });
    const tokyo = storeWith({ 1: view([]) });
    const fetchTurnReply = vi.fn(async () => ({ request: question(10, { meta: { replyId: 11 } }), reply: tokyoReply }));
    const stores: DeviceStoreLookup = (key) => (key === "tokyo" ? tokyo : key === "" ? local : null);
    const a = render(dest(), stores, clientOf(fetchTurnReply));
    const b = render(dest({ deviceKey: "tokyo", self: false }), stores, clientOf(fetchTurnReply));
    expect(a.result.current).toEqual({ kind: "replied", reply: localReply });
    await waitFor(() => expect(b.result.current).toEqual({ kind: "replied", reply: tokyoReply }));
    expect(a.result.current).toEqual({ kind: "replied", reply: localReply });
  });
});
