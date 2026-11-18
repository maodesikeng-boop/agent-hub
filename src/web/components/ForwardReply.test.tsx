// 总助时间流里转交问题下面的项目经理回复：各状态怎么画、点头像进对话、配对设备的文件链接。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createStore } from "zustand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverInfoFor, type ConversationId, type Message, type SentFile } from "../../shared/index.ts";
import { createClient, localClient } from "../client.ts";
import { FleetDeviceScopes } from "../device-scope.tsx";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import type { RouterTurnDestination } from "../router-stream.ts";
import { initialState, type HubState } from "../state.ts";
import { makeConversation, makeMessage, makeUserMessage } from "../test-utils.ts";
import { ForwardReply } from "./ForwardReply.tsx";

const dest = (over: Partial<RouterTurnDestination> = {}): RouterTurnDestination => ({
  key: "local:c:1:0",
  deviceKey: "",
  deviceName: "MacBook",
  self: true,
  worker: false,
  conversationId: 1,
  name: "小林",
  projectName: "agent-hub",
  avatarKey: 1,
  opLabel: null,
  forwardMessageId: 10,
  ...over,
});

function stores(messages: Message[], key = ""): DeviceStoreLookup {
  const store = createStore<HubState>(() => ({
    ...initialState,
    phase: "ready",
    connection: "open",
    conversations: { 1: { conversation: makeConversation({ id: 1 }), messages, hasMore: false } },
  }));
  return (k) => (k === key ? store : null);
}

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function renderReply(lookup: DeviceStoreLookup, d = dest(), onOpen: (deviceKey: string, id: ConversationId) => void = () => {}, extra?: React.ReactNode) {
  const ui = <ForwardReply dest={d} stores={lookup} client={localClient} onOpenConversation={onOpen} />;
  return render(<QueryClientProvider client={queryClient}>{extra ?? ui}</QueryClientProvider>);
}

describe("ForwardReply", () => {
  it("waiting：项目经理头像和名字下面一行 Working…", () => {
    const { container } = renderReply(stores([makeUserMessage({ id: 10, status: "processing" })]));
    expect(screen.getByRole("button", { name: /小林/ })).toBeInTheDocument();
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(container.querySelector("[data-forward-reply]")).toHaveAttribute("data-state", "waiting");
  });

  it("replied：用项目经理对话里同一个组件画回复正文和交付文件，结尾有复制键和回复的时间", () => {
    const reply = makeMessage({ id: 11, text: "飞书接入的 PR 还在审查", createdAt: new Date(2026, 10, 18, 12, 31).getTime() });
    const { container } = renderReply(stores([makeUserMessage({ id: 10, meta: { replyId: 11 } }), reply]));
    expect(screen.getByText("飞书接入的 PR 还在审查")).toBeInTheDocument();
    // MessageBubble 里的 AgentText 带 data-message-id
    expect(container.querySelector(`[data-message-id="11"]`)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByText("12:31")).toBeInTheDocument();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("ended stopped：一行 Stopped，没有 Retry", () => {
    renderReply(stores([makeUserMessage({ id: 10, status: "stopped" }), makeMessage({ id: 11, text: "我查一下……" })]));
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("我查一下……")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry|重试/ })).toBeNull();
  });

  it("ended failed：红色感叹号和失败原因", () => {
    const { container } = renderReply(stores([makeUserMessage({ id: 10, status: "failed", failureReason: "Connection error" })]));
    expect(screen.getByText("网络断了，稍后重试")).toBeInTheDocument();
    expect(container.querySelector("svg.text-danger")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Retry|重试/ })).toBeNull();
  });

  it("silent、unknown：什么都不画", () => {
    const silent = renderReply(stores([makeUserMessage({ id: 10 })]));
    expect(silent.container.querySelector("[data-forward-reply]")).toBeNull();
    silent.unmount();
    // 近窗里没有、补取也没取到：unknown
    const unknown = renderReply(stores([]), dest({ deviceKey: "gone" }));
    expect(unknown.container.querySelector("[data-forward-reply]")).toBeNull();
  });

  it("点头像和名字：按目标设备键打开项目经理的对话", async () => {
    const onOpen = vi.fn();
    renderReply(stores([makeUserMessage({ id: 10, status: "processing" })], "tokyo"), dest({ deviceKey: "tokyo", conversationId: 1 }), onOpen);
    await userEvent.click(screen.getByRole("button", { name: /小林/ }));
    expect(onOpen).toHaveBeenCalledWith("tokyo", 1);
  });

  it("配对设备上的回复：文件链接指向那台设备", () => {
    const file: SentFile = {
      href: "/Users/me/report.png",
      path: "/Users/me/report.png",
      id: "0123456789abcdef",
      name: "report.png",
      size: 10,
      mime: "image/png",
      status: "saved",
      mtime: 1,
    };
    const reply = makeMessage({ id: 11, text: "![](/Users/me/report.png)", meta: { files: [file] } });
    const lookup = stores([makeUserMessage({ id: 10, meta: { replyId: 11 } }), reply], "tokyo");
    const tokyoClient = createClient("tokyo-device");
    const d = dest({ deviceKey: "tokyo", self: false });
    const ui = (
      <FleetDeviceScopes lookup={(key) => (key === "tokyo" ? { client: tokyoClient, server: serverInfoFor("linux") } : null)}>
        <ForwardReply dest={d} stores={lookup} client={tokyoClient} onOpenConversation={() => {}} />
      </FleetDeviceScopes>
    );
    const { container } = renderReply(lookup, d, undefined, ui);
    const img = container.querySelector("[data-message-id] img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("/d/tokyo-device/");
  });
});
