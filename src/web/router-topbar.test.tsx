import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_VENDOR, type PostRouterCommandRequest, type RouterCommandRecord, type StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import { resetQueryClient } from "./query-client.ts";
import {
  FakeApi,
  FakeWebSocket,
  changeOf,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeUserMessage,
} from "./test-utils.ts";

function snapshot(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
    conversations: [
      makeConvSnapshot([makeMessage({ id: 1, conversationId: 1, text: "在的", createdAt: 30_000 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
      makeConvSnapshot(
        [
          makeMessage({ id: 2, conversationId: 2, text: "老马在", createdAt: 20_000 }),
          makeUserMessage({ id: 5, conversationId: 2, text: "老马那边怎么样", status: "processing", createdAt: 40_500 }),
        ],
        { conversation: { id: 2, pmId: 2, title: "老马" } },
      ),
    ],
    sessions: [makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }), makeSession({ sessionId: 2, conversationId: 2, pmId: 2 })],
  });
}

function record(body: PostRouterCommandRequest, over: Partial<RouterCommandRecord> = {}): RouterCommandRecord {
  return {
    id: 500,
    clientId: body.clientId,
    inputText: body.text,
    vendor: DEFAULT_AGENT_VENDOR,
    model: null,
    effort: null,
    status: "planning",
    plan: null,
    dispatched: null,
    error: null,
    durationMs: null,
    createdAt: 40_000,
    updatedAt: 40_000,
    ...over,
  };
}

const LOCAL_ID = "00000000-0000-4000-8000-0000000000aa";
let api: FakeApi;
let seq = 100;

function installApi() {
  api = new FakeApi(snapshot());
  const devices = [{ id: LOCAL_ID, name: "MacBook", self: true, platform: "darwin", online: true, link: "local", fingerprint: null }];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:1");
    if (url.pathname === "/api/devices" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ devices }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return api.fetch(input, init);
  });
}

async function boot(hash = "#/c/1") {
  window.history.replaceState(null, "", `/${hash}`);
  installApi();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return screen.findByRole("textbox", { name: "Message Router" });
}

const pushed = new Set<number>();
function push(command: RouterCommandRecord) {
  const type = pushed.has(command.id) ? "router.command.updated" : "router.command.created";
  pushed.add(command.id);
  act(() => FakeWebSocket.last.push(changeOf(++seq, type, { command })));
}
const popover = () => screen.getByRole("dialog", { name: "Router" });
const replyBox = () => screen.getByRole("textbox", { name: "Reply to Router" });
const sentBodies = () => api.callsTo("POST", /^\/api\/router\/commands$/).map((c) => c.body as PostRouterCommandRequest);

async function sendFromTopBar(text: string) {
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Message Router" });
  await user.click(input);
  await user.type(input, `${text}{Enter}`);
  await screen.findByRole("dialog", { name: "Router" });
  await waitFor(() => expect(sentBodies().at(-1)?.text).toBe(text));
  return user;
}

beforeEach(() => {
  resetQueryClient();
  pushed.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.macosApp;
  delete window.webkit;
  window.history.replaceState(null, "", "/");
});

describe("RouterTopBar", () => {
  it("renders the centered translucent Message Router input with RouterAvatar in the 40px top bar on desktop conversation views", async () => {
    const input = await boot();
    const shell = document.querySelector<HTMLElement>("[data-shell='desktop']")!;
    const bar = shell.firstElementChild as HTMLElement;
    expect(bar).toHaveClass("shell-topbar");
    expect(bar).toHaveAttribute("data-window-drag");
    expect(bar).not.toHaveAttribute("aria-hidden");
    expect(bar.style.getPropertyValue("--topbar-input-max")).toBe("35rem");
    const field = input.closest("label")!;
    expect(field).toHaveClass("topbar-router");
    expect(field).toHaveAttribute("data-no-drag");
    expect(field.querySelector("[data-slot='router-avatar']")).not.toBeNull();
    expect(input).toHaveAttribute("placeholder", "Message Router…");
    expect(within(field).queryByRole("button", { name: "Send to Router" })).toBeNull();
  });

  it("shows the Send button once there is a draft and blurs on Escape while the popover is closed", async () => {
    const input = await boot();
    const user = userEvent.setup();
    await user.click(input);
    expect(input).toHaveFocus();
    await user.type(input, "hi");
    expect(screen.getByRole("button", { name: "Send to Router" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(input).not.toHaveFocus();
    expect(input).toHaveValue("hi");
  });

  it("keeps the 40px wood top bar empty when hidden on #/router", async () => {
    window.history.replaceState(null, "", "/#/router");
    installApi();
    installFakeWebSocket();
    render(<App />);
    await screen.findByRole("log", { name: "Router timeline" });
    const bar = document.querySelector(".shell-topbar")!;
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar).toBeEmptyDOMElement();
    expect(screen.queryByRole("textbox", { name: "Message Router" })).toBeNull();
  });

  it("does not render in the mobile shell", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("coarse"), addEventListener() {}, removeEventListener() {} }));
    window.history.replaceState(null, "", "/#/c/1");
    installApi();
    installFakeWebSocket();
    render(<App />);
    await screen.findByRole("log", { name: "Messages" });
    expect(document.querySelector("[data-shell='desktop']")).toBeNull();
    expect(document.querySelector(".shell-topbar")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message Router" })).toBeNull();
  });

  it("sends a Router command on Enter without leaving the current PM conversation and opens the anchored reply popover", async () => {
    await boot();
    await sendFromTopBar("今天各项目进度怎么样？");
    expect(window.location.hash).toBe("#/c/1");
    expect(screen.getByRole("heading", { level: 1, name: "小林" })).toBeInTheDocument();
    expect(sentBodies()).toEqual([{ clientId: expect.any(String), text: "今天各项目进度怎么样？", routerOnly: true }]);
    expect(screen.getByRole("textbox", { name: "Message Router" })).toHaveValue("");
    const log = within(popover()).getByRole("log", { name: "Router replies" });
    expect(within(log).getByText("今天各项目进度怎么样？")).toBeInTheDocument();
    expect(await within(log).findByText("Working…")).toBeInTheDocument();
  });

  it("shows live Working status, Router Markdown reply, clickable PM and Worker destinations, and inline ForwardReply inside the popover", async () => {
    await boot();
    await sendFromTopBar("老马那边怎么样");
    const sent = sentBodies()[0]!;
    push(record(sent, { status: "planning" }));
    expect(await within(popover()).findByText("Working…")).toBeInTheDocument();
    push(
      record(sent, {
        status: "dispatched",
        plan: { intent: "dispatch", reply: "已转给**老马**。", actions: [], track: "B" },
        dispatched: [{ deviceId: LOCAL_ID, pmId: 2, conversationId: 2, messageId: 5, ok: true, op: "pm.forward", pmName: "老马" }],
        updatedAt: 41_000,
      }),
    );
    const log = within(popover()).getByRole("log", { name: "Router replies" });
    expect(await within(log).findByText("老马", { selector: "strong" })).toBeInTheDocument();
    expect(log.querySelector("[data-router-turn]")).toHaveAttribute("data-status", "dispatched");
    const destination = log.querySelector<HTMLButtonElement>("[data-destination]")!;
    expect(destination).toHaveTextContent("老马");
    expect(log.querySelector("[data-forward-reply][data-state='waiting']")).not.toBeNull();

    fireEvent.click(destination);
    await waitFor(() => expect(window.location.hash).toBe("#/c/2"));
    expect(screen.queryByRole("dialog", { name: "Router" })).toBeNull();
  });

  it("focuses the bottom follow-up reply row on popover open and appends follow-up turns into the same popover", async () => {
    await boot();
    const user = await sendFromTopBar("第一句");
    await waitFor(() => expect(replyBox()).toHaveFocus());
    await user.type(replyBox(), "第二句{Enter}");
    await waitFor(() => expect(sentBodies().map((b) => b.text)).toEqual(["第一句", "第二句"]));
    const log = within(popover()).getByRole("log", { name: "Router replies" });
    await waitFor(() => expect(log.querySelectorAll("[data-router-turn]")).toHaveLength(2));
    expect(replyBox()).toHaveValue("");

    await user.type(screen.getByRole("textbox", { name: "Message Router" }), "第三句{Enter}");
    await waitFor(() => expect(log.querySelectorAll("[data-router-turn]")).toHaveLength(3));
  });

  it("supports Shift+Enter for newlines and Enter to send inside the popover reply row while respecting IME composition", async () => {
    await boot();
    const user = await sendFromTopBar("开个头");
    await user.type(replyBox(), "第一行{Shift>}{Enter}{/Shift}第二行");
    expect(replyBox()).toHaveValue("第一行\n第二行");
    fireEvent.keyDown(replyBox(), { key: "Enter", isComposing: true, keyCode: 229 });
    expect(sentBodies()).toHaveLength(1);
    fireEvent.keyDown(replyBox(), { key: "Enter" });
    await waitFor(() => expect(sentBodies().map((b) => b.text)).toEqual(["开个头", "第一行\n第二行"]));
  });

  it("supports retrying both send_failed and failed server Router turns directly inside the popover", async () => {
    await boot();
    let down = true;
    const ok = api.postRouterCommand;
    api.postRouterCommand = (body) => (down ? { status: 503, body: { error: "busy" } } : ok(body));
    const user = await sendFromTopBar("先试一下");
    const turn = await waitFor(() => {
      const el = popover().querySelector<HTMLElement>("[data-router-turn][data-status='send_failed']");
      expect(el).not.toBeNull();
      return el!;
    });
    down = false;
    await user.click(within(turn).getByRole("button", { name: /resend/ }));
    await waitFor(() => expect(sentBodies()).toHaveLength(2));
    expect(sentBodies()[1]).toEqual(sentBodies()[0]);

    push(record(sentBodies()[0]!, { status: "failed", error: "Router 没有回应", updatedAt: 42_000 }));
    const failed = await waitFor(() => {
      const el = popover().querySelector<HTMLElement>("[data-router-turn][data-status='failed']");
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/router\/commands\/500\/retry$/)).toHaveLength(1));
  });

  it("hands a typed or pasted @name to Router itself instead of forwarding it straight to that PM", async () => {
    await boot();
    const user = await sendFromTopBar("@小林 顶栏定向转发");
    await user.click(replyBox());
    await user.paste("@老马 追问一句");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sentBodies()).toHaveLength(2));
    expect(sentBodies()).toEqual([
      { clientId: expect.any(String), text: "@小林 顶栏定向转发", routerOnly: true },
      { clientId: expect.any(String), text: "@老马 追问一句", routerOnly: true },
    ]);
  });

  it("keeps one shared retry running across Expand, so the full Router page shows it in progress and cannot send it twice", async () => {
    await boot();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ok = api.retryRouterCommand;
    api.retryRouterCommand = async (id) => {
      await gate;
      return ok(id);
    };
    const retryCalls = () => api.callsTo("POST", /^\/api\/router\/commands\/500\/retry$/);
    const user = await sendFromTopBar("重试不重复");
    const sent = sentBodies()[0]!;
    push(record(sent, { status: "failed", error: "Router 没有回应", updatedAt: 42_000 }));
    const failed = await waitFor(() => {
      const el = popover().querySelector<HTMLElement>("[data-router-turn][data-status='failed']");
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retryCalls()).toHaveLength(1));
    expect(within(popover()).getByText("Working…")).toBeInTheDocument();

    await user.click(within(popover()).getByRole("button", { name: "Expand" }));
    await waitFor(() => expect(window.location.hash).toBe("#/router"));
    const timeline = await screen.findByRole("log", { name: "Router timeline" });
    const row = await waitFor(() => {
      const el = [...timeline.querySelectorAll<HTMLElement>("[data-router-turn]")].find((r) => r.textContent?.includes("重试不重复"));
      expect(el).toBeDefined();
      return el!;
    });
    expect(row).toHaveAttribute("data-status", "planning");
    expect(within(row).getByText("Working…")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Retry" })).toBeNull();

    await act(async () => release());
    push(record(sent, { status: "planning", updatedAt: 43_000 }));
    expect(row).toHaveAttribute("data-status", "planning");
    expect(retryCalls()).toHaveLength(1);
  });

  it("brings Retry back when the retry fails again before its HTTP reply lands and both failures share an updatedAt", async () => {
    await boot();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retryCalls = () => api.callsTo("POST", /^\/api\/router\/commands\/500\/retry$/);
    const user = await sendFromTopBar("同一时刻又失败");
    const sent = sentBodies()[0]!;
    const failedAt42 = { status: "failed", error: "Router 没有回应", updatedAt: 42_000 } as const;
    api.retryRouterCommand = async () => {
      await gate;
      return { status: 200, body: { command: record(sent, { status: "planning", updatedAt: 42_000 }) } };
    };
    push(record(sent, failedAt42));
    const failed = await waitFor(() => {
      const el = popover().querySelector<HTMLElement>("[data-router-turn][data-status='failed']");
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retryCalls()).toHaveLength(1));
    await user.click(within(popover()).getByRole("button", { name: "Expand" }));
    await waitFor(() => expect(window.location.hash).toBe("#/router"));
    const timeline = await screen.findByRole("log", { name: "Router timeline" });
    const row = await waitFor(() => {
      const el = [...timeline.querySelectorAll<HTMLElement>("[data-router-turn]")].find((r) => r.textContent?.includes("同一时刻又失败"));
      expect(el).toBeDefined();
      return el!;
    });

    push(record(sent, { status: "planning", updatedAt: 42_000 }));
    push(record(sent, failedAt42));
    expect(within(row).getByText("Working…")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Retry" })).toBeNull();

    await act(async () => release());
    const retry = await within(row).findByRole("button", { name: "Retry" });
    expect(row).toHaveAttribute("data-status", "failed");
    expect(retryCalls()).toHaveLength(1);
    await user.click(retry);
    await waitFor(() => expect(retryCalls()).toHaveLength(2));
  });

  it("navigates to #/router, hands off any unsent follow-up draft, and closes the popover when Expand is clicked", async () => {
    await boot();
    const user = await sendFromTopBar("先发一句");
    await user.type(replyBox(), "还没发的追问");
    await user.click(within(popover()).getByRole("button", { name: "Expand" }));
    await waitFor(() => expect(window.location.hash).toBe("#/router"));
    expect(screen.queryByRole("dialog", { name: "Router" })).toBeNull();
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue("还没发的追问");
    expect(within(screen.getByRole("log", { name: "Router timeline" })).getByText("先发一句")).toBeInTheDocument();
  });

  it("closes the popover on Close button, Escape, or outside click without cancelling an in-flight Router command", async () => {
    await boot();
    const user = await sendFromTopBar("一");
    await user.click(within(popover()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Router" })).toBeNull();

    await sendFromTopBar("二");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Router" })).toBeNull();

    await sendFromTopBar("三");
    await user.click(screen.getByRole("log", { name: "Messages" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Router" })).toBeNull());
    expect(api.calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/router/") && c.path !== "/api/router/commands")).toEqual([]);
  });

  it("returns focus to the top-bar input after Escape or Close", async () => {
    const input = await boot();
    const user = await sendFromTopBar("一");
    await waitFor(() => expect(replyBox()).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Router" })).toBeNull();
    await waitFor(() => expect(input).toHaveFocus());

    await sendFromTopBar("二");
    await waitFor(() => expect(replyBox()).toHaveFocus());
    await user.click(within(popover()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Router" })).toBeNull();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("moves Tab from the top bar into the open popover and Shift+Tab back without closing it", async () => {
    const input = await boot();
    const user = await sendFromTopBar("一");
    await user.click(input);
    await user.tab();
    expect(within(popover()).getByRole("button", { name: "Expand" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(input).toHaveFocus();

    await user.type(input, "草稿");
    await user.tab();
    expect(screen.getByRole("button", { name: "Send to Router" })).toHaveFocus();
    await user.tab();
    expect(within(popover()).getByRole("button", { name: "Expand" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Send to Router" })).toHaveFocus();
    expect(popover()).toBeInTheDocument();
  });

  it("keeps the popover open when clicking inside the top-bar input", async () => {
    await boot();
    const user = await sendFromTopBar("一");
    await user.click(screen.getByRole("textbox", { name: "Message Router" }));
    expect(popover()).toBeInTheDocument();
  });

  it("starts a fresh quick-chat view on the next send after closing the popover", async () => {
    await boot();
    const user = await sendFromTopBar("旧的一句");
    await user.click(within(popover()).getByRole("button", { name: "Close" }));
    await sendFromTopBar("新的一句");
    const log = within(popover()).getByRole("log", { name: "Router replies" });
    expect(within(log).queryByText("旧的一句")).toBeNull();
    expect(within(log).getByText("新的一句")).toBeInTheDocument();
  });

  it("marks the input wrapper [data-no-drag] so clicking it never fires windowDrag, while clicking blank top-bar wood still drags and zooms", async () => {
    document.documentElement.dataset.macosApp = "true";
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { windowDrag: { postMessage } } };
    const input = await boot();
    fireEvent.mouseDown(input, { button: 0, detail: 1 });
    fireEvent.mouseDown(input.closest("label")!, { button: 0, detail: 2 });
    expect(postMessage).not.toHaveBeenCalled();
    const bar = document.querySelector(".shell-topbar")!;
    fireEvent.mouseDown(bar, { button: 0, detail: 1 });
    fireEvent.mouseDown(bar, { button: 0, detail: 2 });
    expect(postMessage.mock.calls).toEqual([[{ doubleClick: false }], [{ doubleClick: true }]]);
  });

  it("dismisses the Settings page and focuses the Router input when the top-bar input is clicked while Settings is open", async () => {
    const input = await boot();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() => {
      fireEvent.pointerDown(input, { button: 0, pointerType: "mouse" });
      fireEvent.mouseDown(input, { button: 0 });
      fireEvent.pointerUp(input, { button: 0, pointerType: "mouse" });
      fireEvent.mouseUp(input, { button: 0 });
      fireEvent.click(input, { button: 0 });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    await waitFor(() => expect(input).toHaveFocus());
  });
});
