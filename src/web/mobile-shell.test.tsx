import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { FakeApi, installFakeWebSocket, makeSnapshot, makePm, makeConvSnapshot, makeWorkerLine, makeWorkerConversation } from "./test-utils.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function boot() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("coarse"), addEventListener() {}, removeEventListener() {} }));
  new FakeApi(makeSnapshot({ pms: [makePm({ id: 1, name: "小林" })], conversations: [makeConvSnapshot([makeWorkerLine({ id: 10 })], { conversation: { id: 1, pmId: 1, title: "小林" } }), makeConvSnapshot([], { conversation: makeWorkerConversation() })] })).install();
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
  fireEvent.click(await screen.findByRole("button", { name: "Show side panel" }));
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
