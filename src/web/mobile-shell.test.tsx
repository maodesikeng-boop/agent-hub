import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { DeviceInfo } from "../shared/index.ts";
import { App } from "./App.tsx";
import { changeOf, FakeApi, FakeWebSocket, installFakeWebSocket, makeSnapshot, makeMessage, makePm, makeConvSnapshot, makeWorkerLine, makeWorkerConversation } from "./test-utils.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function boot(media?: { mobile: boolean; listeners: Set<() => void> }, stub?: (query: string) => object) {
  vi.stubGlobal("matchMedia", stub ?? ((query: string) => ({ get matches() { return query.includes("coarse") && (media?.mobile ?? true); }, addEventListener(_: string, cb: () => void) { media?.listeners.add(cb); }, removeEventListener(_: string, cb: () => void) { media?.listeners.delete(cb); } })));
  const api = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "空经理" })], conversations: [makeConvSnapshot([], { conversation: { id: 2, pmId: 2, title: "空经理" } }), makeConvSnapshot([makeMessage({ id: 99, conversationId: 1, text: "确认发布", meta: { needsUser: true }, dedupeKey: "ask:1:99" }), makeWorkerLine({ id: 10 }), makeWorkerLine({ id: 11, line: { workerConversationId: 31, title: "修 Y", workerId: 4 } })], { conversation: { id: 1, pmId: 1, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation() }), makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 31, title: "修 Y" }) })] }));
  api.install();
  installFakeWebSocket();
  return { ...render(<App />), api };
}
it("手机首页不自动选择，点行进聊天且不自动聚焦，返回保留列表节点", async () => {
  boot();
  const row = within(await screen.findByRole("region", { name: "Project managers" })).getByRole("button", { name: /^小林/ });
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
  expect(within(await screen.findByRole("region", { name: "Project managers" })).getByRole("button", { name: /^小林/ })).toBe(row);
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
  within(await screen.findByRole("region", { name: "Project managers" })).getByRole("button", { name: /^小林/ });
  await waitFor(() => expect(location.hash).toBe(""));
});

it("手机工作面板点 Worker 先关闭再进整屏页面", async () => {
  history.replaceState(null, "", "/#/c/1");
  boot();
  fireEvent.click(await screen.findByRole("button", { name: /Show work panel/ }));
  const panel = await screen.findByRole("complementary", { name: "Work panel" });
  expect(panel).toHaveAttribute("data-layout", "page");
  fireEvent.click(within(panel).getByRole("button", { name: /修 X/ }));
  await waitFor(() => expect(location.hash).toBe("#/w/30"));
  expect(screen.queryByRole("complementary", { name: "Work panel" })).toBeNull();
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

it("打开手机工作面板后浏览器回列表，再进聊天不重开面板", async () => {
  history.replaceState(null, "", "/#/c/1");
  boot();
  fireEvent.click(await screen.findByRole("button", { name: /Show work panel/ }));
  expect(await screen.findByRole("complementary", { name: "Work panel" })).toBeInTheDocument();
  act(() => { history.replaceState(null, "", "/"); dispatchEvent(new PopStateEvent("popstate")); });
  fireEvent.click(within(await screen.findByRole("region", { name: "Project managers" })).getByRole("button", { name: /^小林/ }));
  expect(screen.queryByRole("complementary", { name: "Work panel" })).toBeNull();
});

it("同 PM 切 Worker 替换当前层，面板返回 PM，浏览器后退到列表", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  boot();
  fireEvent.click(within(await screen.findByRole("region", { name: "Project managers" })).getByRole("button", { name: /^小林/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Show work panel/ }));
  fireEvent.click(within(await screen.findByRole("complementary", { name: "Work panel" })).getByRole("button", { name: /修 X/ }));
  const length = history.length;
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe("#/c/1"));
  fireEvent.click(await screen.findByRole("button", { name: /Show work panel/ }));
  fireEvent.click(within(await screen.findByRole("complementary", { name: "Work panel" })).getByRole("button", { name: /修 Y/ }));
  expect(location.hash).toBe("#/w/31");
  expect(history.length).toBeGreaterThanOrEqual(length);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe("#/c/1"));
  fireEvent.click(screen.getByRole("button", { name: /Show work panel/ }));
  fireEvent.click(within(await screen.findByRole("complementary", { name: "Work panel" })).getByRole("button", { name: "Back to conversation" }));
  expect(screen.queryByRole("complementary", { name: "Work panel" })).toBeNull();
  expect(location.hash).toBe("#/c/1");
  act(() => history.back());
  await waitFor(() => expect(location.hash).toBe(""));
});

it("手机断点切换保留当前会话与输入框草稿", async () => {
  history.replaceState(null, "", "/#/c/1");
  const media = { mobile: true, listeners: new Set<() => void>() };
  boot(media);
  const box = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(box, { target: { value: "跨断点草稿" } });
  act(() => { media.mobile = false; media.listeners.forEach((cb) => cb()); });
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("跨断点草稿");
  act(() => { media.mobile = true; media.listeners.forEach((cb) => cb()); });
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("跨断点草稿");
});

it("a mouse window too narrow for the PM column and a usable conversation uses the single column, and widening restores the columns", async () => {
  const view = { width: 400, listeners: new Set<() => void>() };
  const mouseWindow = (query: string) => ({
    get matches() {
      const max = /^\(max-width: (\d+)px\)$/.exec(query);
      return max !== null && view.width <= Number(max[1]);
    },
    addEventListener: (_: string, cb: () => void) => view.listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => view.listeners.delete(cb),
  });
  const { container } = boot(undefined, mouseWindow);
  const resize = (width: number) => act(() => { view.width = width; view.listeners.forEach((cb) => cb()); });
  fireEvent.click(within(await screen.findByRole("region", { name: "Project managers" })).getByRole("button", { name: /^小林/ }));
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(container.querySelector("[data-shell]")).toHaveAttribute("data-shell", "mobile");
  expect(location.hash).toBe("#/c/1");
  fireEvent.change(box, { target: { value: "窄窗口草稿" } });

  resize(1280);
  expect(container.querySelector("[data-shell]")).toHaveAttribute("data-shell", "desktop");
  expect(screen.getByRole("region", { name: "Project managers" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("窄窗口草稿");
  resize(676);
  expect(container.querySelector("[data-shell]")).toHaveAttribute("data-shell", "desktop");
  resize(675);
  expect(container.querySelector("[data-shell]")).toHaveAttribute("data-shell", "mobile");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("窄窗口草稿");
});

it("跨 PM 跳转关闭手机工作面板，空 PM 仍可打开面板看到空态，返回列表不循环", async () => {
  boot();
  fireEvent.click(within(await screen.findByRole("region", { name: "Project managers" })).getByRole("button", { name: /^小林/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Show work panel/ }));
  expect(await screen.findByRole("complementary", { name: "Work panel" })).toBeInTheDocument();
  act(() => { history.replaceState(history.state, "", "/#/c/2"); dispatchEvent(new PopStateEvent("popstate")); });
  expect(screen.queryByRole("complementary", { name: "Work panel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show work panel" }));
  expect(within(await screen.findByRole("complementary", { name: "Work panel" })).getByText("Nothing running")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe(""));
});

it("手机切到远端电脑进对话再点 Back：保留远端电脑而不跳回本机", async () => {
  const MAC = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
  const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
  const devices: DeviceInfo[] = [
    { id: MAC, name: "Studio Mac", platform: "darwin", self: true, online: true, link: "local", fingerprint: null },
    { id: TOKYO, name: "Tokyo Mini", platform: "linux", self: false, online: true, link: "relay", fingerprint: null },
  ];
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("coarse"), addEventListener() {}, removeEventListener() {} }));
  const localApi = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "本机经理" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "本机经理" } })] }));
  const remoteApi = new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "东京经理" })], conversations: [makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "东京经理" } })] }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:1");
      if (url.pathname === "/api/devices" && (init?.method ?? "GET") === "GET") return Response.json({ devices });
      const proxied = /^\/d\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (proxied && proxied[1] === TOKYO) return remoteApi.fetch(`${proxied[2]}${url.search}`, init);
      return localApi.fetch(input, init);
    }),
  );
  installFakeWebSocket();
  render(<App />);

  const switcher = await screen.findByRole("button", { name: "Switch computer (Studio Mac)" });
  fireEvent.click(switcher);
  const dialog = await screen.findByRole("dialog", { name: "Computers" });
  fireEvent.click(within(dialog).getByRole("button", { name: /Tokyo Mini/ }));

  expect(await screen.findByRole("button", { name: "Switch computer (Tokyo Mini)" })).toBeInTheDocument();
  const remotePm = await within(screen.getByRole("region", { name: "Project managers" })).findByRole("button", { name: /^东京经理/ });
  fireEvent.click(remotePm);
  await waitFor(() => expect(location.hash).toBe(`#/d/${TOKYO}/c/1`));

  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.hash).toBe(""));
  expect(screen.getByRole("button", { name: "Switch computer (Tokyo Mini)" })).toBeInTheDocument();
});


it("pins from mobile Info, then unpins from the Projects page", async () => {
  const user = userEvent.setup();
  const { api } = boot();
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const ws = FakeWebSocket.last;
  act(() => ws.open());
  const projects = await screen.findByRole("region", { name: "Project managers" });
  await user.click(within(projects).getByRole("button", { name: /^小林/ }));
  await user.click(await screen.findByRole("button", { name: /Show work panel/ }));
  const active = screen.getByRole("tab", { name: /^Active/ });
  active.focus();
  await user.keyboard("{End}");
  expect(await screen.findByRole("tab", { name: "Info", selected: true })).toHaveFocus();
  await user.click(await screen.findByRole("button", { name: "Pin project" }));
  const pinPath = /^\/api\/pms\/1\/pin$/;
  expect(api.callsTo("PUT", pinPath).map(({ body }) => body)).toEqual([{ pinned: true }]);
  act(() => ws.push(changeOf(11, "pm.updated", { pm: makePm({ id: 1, name: "小林", pinnedAt: 1_000 }) })));
  expect(await screen.findByRole("button", { name: "Unpin project" })).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "Back to conversation" }));
  await user.click(await screen.findByRole("button", { name: "Back" }));
  const pinned = await screen.findByRole("region", { name: "Pinned" });
  await user.click(within(pinned).getByRole("button", { name: "Unpin 小林" }));
  expect(api.callsTo("PUT", pinPath).map(({ body }) => body)).toEqual([{ pinned: true }, { pinned: false }]);
  act(() => ws.push(changeOf(12, "pm.updated", { pm: makePm({ id: 1, name: "小林", pinnedAt: null }) })));
  expect(await screen.findByRole("button", { name: "Pin 小林" })).toBeEnabled();
  expect(screen.queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument();
});
