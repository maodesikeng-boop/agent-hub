import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { changeOf, FakeApi, FakeWebSocket, installFakeWebSocket, makeSnapshot, makeMessage, makePm, makeConvSnapshot, makeWorkerLine, makeWorkerConversation } from "./test-utils.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function boot(media?: { mobile: boolean; listeners: Set<() => void> }) {
  vi.stubGlobal("matchMedia", (query: string) => ({ get matches() { return query.includes("coarse") && (media?.mobile ?? true); }, addEventListener(_: string, cb: () => void) { media?.listeners.add(cb); }, removeEventListener(_: string, cb: () => void) { media?.listeners.delete(cb); } }));
  new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "空经理" })], conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, title: "空经理" } }), makeConvSnapshot([makeMessage({ id: 99, conversationId: 1, text: "确认发布", meta: { needsUser: true }, dedupeKey: "ask:1:99" }), makeWorkerLine({ id: 10 }), makeWorkerLine({ id: 11, line: { workerConversationId: 31, title: "修 Y", workerId: 4 } })], { conversation: { id: 1, pmId: 1, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation() }), makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, title: "修 Y" }) })] })).install();
  installFakeWebSocket();
  return render(<App />);
}
it("手机首页不自动选择，点行进聊天且不自动聚焦，返回保留列表节点", async () => {
  boot();
  const row = within(await screen.findByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /小林/ });
  expect(location.hash).toBe("");
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  fireEvent.click(row);
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(location.hash).toBe("#/c/1");
  expect(box).toHaveAttribute("placeholder", "Message…");
  expect(box).not.toHaveFocus();
  const historyBack = vi.spyOn(history, "back");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(historyBack).toHaveBeenCalledOnce();
  await waitFor(() => expect(location.hash).toBe(""));
  expect(within(await screen.findByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /小林/ })).toBe(row);
});
it("直达聊天的返回 replace 到列表", async () => {
  history.replaceState(null, "", "/#/c/1");
  boot();
  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe(""));
});
it("无效路由 replace 到列表", async () => {
  history.replaceState(null, "", "/#/c/999");
  boot();
  within(await screen.findByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /小林/ });
  await waitFor(() => expect(location.hash).toBe(""));
});

it("抽屉点 Piece 先关闭再进整屏页面", async () => {
  history.replaceState(null, "", "/#/c/1");
  boot();
  fireEvent.click(await screen.findByRole("button", { name: /Show side panel/ }));
  const drawer = await screen.findByRole("dialog");
  fireEvent.click(within(drawer).getByRole("button", { name: "修 X" }));
  await waitFor(() => expect(location.hash).toBe("#/w/30"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "修 X" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveFocus();
});

it("直达 Piece 返回上级聊天，不增加历史", async () => {
  history.replaceState(null, "", "/#/w/30");
  const length = history.length;
  boot();
  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe("#/c/1"));
  expect(history.length).toBe(length);
  expect(history.state).toBeNull();
});

it("新建 HTTP 先于 WS 时保留新对话，WS 到达后显示它", async () => {
  boot();
  fireEvent.click(await screen.findByRole("button", { name: "New project manager" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "新经理" } });
  fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
  await waitFor(() => expect(location.hash).toBe("#/c/50"));
  act(() => {
    FakeWebSocket.last.push(changeOf(11, "conversation.created", { conversation: makeConvSnapshot([], { conversation: { id: 50, pmId: 50, title: "新经理" } }).conversation }));
  });
  expect(location.hash).toBe("#/c/50");
  act(() => FakeWebSocket.last.push(changeOf(12, "pm.created", { pm: makePm({ id: 50, name: "新经理" }) })));

  expect(await screen.findByRole("heading", { name: /^新经理$/ })).toBeInTheDocument();
});

it("打开抽屉后浏览器回列表，再进聊天不重开抽屉", async () => {
  history.replaceState(null, "", "/#/c/1");
  boot();
  fireEvent.click(await screen.findByRole("button", { name: /Show side panel/ }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  act(() => { history.replaceState(null, "", "/"); dispatchEvent(new PopStateEvent("popstate")); });
  fireEvent.click(within(await screen.findByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /小林/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("同 PM 切 Piece 替换当前层，抽屉提问返回 PM，浏览器后退到列表", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  boot();
  fireEvent.click(within(await screen.findByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /小林/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Show side panel/ }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "修 X" }));
  const length = history.length;
  fireEvent.click(await screen.findByRole("button", { name: /Show side panel/ }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "修 Y" }));
  expect(location.hash).toBe("#/w/31");
  expect(history.length).toBe(length);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe("#/c/1"));
  fireEvent.click(screen.getByRole("button", { name: /Show side panel/ }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "修 X" }));
  fireEvent.click(screen.getByRole("button", { name: /Show side panel/ }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /确认发布/ }));
  await waitFor(() => expect(location.hash).toBe("#/c/1"));
  act(() => history.back());
  await waitFor(() => expect(location.hash).toBe(""));
});

it("手机断点切换保留聊天与输入框节点", async () => {
  history.replaceState(null, "", "/#/c/1");
  const media = { mobile: true, listeners: new Set<() => void>() };
  boot(media);
  const box = await screen.findByRole("textbox", { name: "Message" });
  act(() => { media.mobile = false; media.listeners.forEach((cb) => cb()); });
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(box);
  act(() => { media.mobile = true; media.listeners.forEach((cb) => cb()); });
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(box);
});

it("跨 PM 跳转关闭抽屉，无 Piece 聊天不出现空抽屉，返回列表不循环", async () => {
  boot();
  fireEvent.click(within(await screen.findByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /小林/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Show side panel/ }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  act(() => { history.replaceState(history.state, "", "/#/c/2"); dispatchEvent(new PopStateEvent("popstate")); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /Show side panel/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe(""));
});
