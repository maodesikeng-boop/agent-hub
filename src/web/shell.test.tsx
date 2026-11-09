// 网页外壳（docs/ui-standard.md 第 6、16 条）：每个对话的网址、刷新回到原来那个、前进后退，打开对话时焦点进输入框，
// 左栏的在忙、行高一致，左下角的按钮，“重连中”提示条。接口、WebSocket 都是假的。
import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateSnapshot, WsServerMessage } from "../shared/index.ts";
import { App } from "./App.tsx";
import { formatTime } from "./format.ts";
import { parseRoute, routeHash } from "./route.ts";
import { NARROW_QUERY } from "./useMediaQuery.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeUserMessage,
  makeWorkerConversation,
  messageChange,
  sessionChange,
} from "./test-utils.ts";

async function boot(snapshot: StateSnapshot = three()) {
  new FakeApi(snapshot).install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
}

const push = (ws: FakeWebSocket, msg: WsServerMessage) => act(() => ws.push(msg));

/** 小林（对话 1，最新）、老马（对话 2）、新来的（对话 3，没有消息）；小林派了 Worker 修 X（对话 30）。 */
function three(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" }), makePm({ id: 3, name: "新来的" })],
    conversations: [
      makeConvSnapshot([makeUserMessage({ id: 1, conversationId: 1, text: "小林你好", createdAt: 30_000 })], { conversation: { id: 1, pmId: 1, title: "小林" } }),
      makeConvSnapshot([makeMessage({ id: 2, conversationId: 2, text: "老马在", createdAt: 20_000 })], { conversation: { id: 2, pmId: 2, title: "老马" } }),
      makeConvSnapshot([], { conversation: { id: 3, pmId: 3, title: "新来的", createdAt: 1_000 } }),
      makeConvSnapshot([makeMessage({ id: 40, conversationId: 30, text: "在干活" })], { conversation: makeWorkerConversation({ id: 30, pmId: 1, title: "修 X" }) }),
    ],
    sessions: [
      makeSession({ sessionId: 1, conversationId: 1, pmId: 1 }),
      makeSession({ sessionId: 2, conversationId: 2, pmId: 2 }),
      makeSession({ sessionId: 3, conversationId: 3, pmId: 3 }),
    ],
  });
}

const nav = () => screen.getByRole("navigation", { name: "Conversations" });
const row = (name: string) => within(nav()).getByRole("button", { name: new RegExp(name) });
const title = () => screen.getByRole("main").querySelector("h1")?.textContent;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("URL", () => {
  it("routeHash / parseRoute 来回一致；认不出来的是 null", () => {
    for (const route of [{ view: "conversation", id: 12 }, { view: "worker", id: 30 }, { view: "profile", pmId: 3 }] as const) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(routeHash({ view: "conversation", id: 12 })).toBe("#/c/12");
    for (const bad of ["", "#", "#/c/", "#/c/0", "#/c/-1", "#/c/1.5", "#/x/1", "#/c/1/2", "#/c/99999999999999999999"]) expect(parseRoute(bad)).toBeNull();
  });

  it("第一次打开（没写网址）：显示第一个对话，网址改成它，不多记一条历史", async () => {
    const length = window.history.length;
    await boot();
    expect(title()).toBe("小林");
    await waitFor(() => expect(window.location.hash).toBe("#/c/1"));
    expect(window.history.length).toBe(length);
  });

  it("刷新：网址写着哪个对话就回到哪个，不跳回第一个", async () => {
    window.history.replaceState(null, "", "/#/c/2");
    await boot();
    expect(title()).toBe("老马");
    expect(row("老马")).toHaveAttribute("aria-current", "true");
  });

  it("刷新：Worker 的对话、资料页也回到原来那个", async () => {
    window.history.replaceState(null, "", "/#/w/30");
    await boot();
    expect(screen.getByRole("region", { name: "Piece 修 X" })).toBeInTheDocument();
    // 左栏高亮派它的项目经理
    expect(row("小林")).toHaveAttribute("aria-current", "true");
  });

  it("网址里的对话找不到：显示第一个", async () => {
    window.history.replaceState(null, "", "/#/c/999");
    await boot();
    expect(title()).toBe("小林");
  });

  it("点左栏换对话：网址跟着变；浏览器后退回到上一个", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(row("老马"));
    expect(window.location.hash).toBe("#/c/2");
    expect(title()).toBe("老马");
    act(() => {
      window.history.replaceState(null, "", "/#/c/1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(title()).toBe("小林");
  });

  it("点顶栏头像打开资料页：网址是 #/pm/<编号>", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    expect(window.location.hash).toBe("#/pm/1");
  });
});

describe("焦点", () => {
  it("打开、切换对话时焦点在输入框里", async () => {
    const user = userEvent.setup();
    await boot();
    await waitFor(() => expect(screen.getByPlaceholderText("Message 小林…")).toHaveFocus());
    await user.click(row("老马"));
    expect(screen.getByPlaceholderText("Message 老马…")).toHaveFocus();
  });
});

describe("Sidebar", () => {
  it("选中的对话：只靠底色 bg-sidebar-active 表示，名字字重不变（都是 500，不加粗）", async () => {
    await boot();
    const name = (label: string) => within(row(label)).getByText(label);
    expect(row("小林")).toHaveAttribute("aria-current", "true");
    expect(row("小林")).toHaveClass("bg-jelly");
    // 果冻底的颜色是这个项目经理水果的 accent（styles.css 的 --color-jelly 取行上的 --jelly）
    expect(row("小林").style.getPropertyValue("--jelly")).toMatch(/^#[0-9a-f]{6}$/);
    expect(row("老马")).toHaveClass("hover:bg-jelly-hover");
    expect(row("老马").className).not.toMatch(/bg-sidebar-active/);
    expect(name("小林")).toHaveClass("font-medium");
    expect(name("小林")).not.toHaveClass("font-semibold");
    expect(name("老马")).toHaveClass("font-medium");
  });

  it("项目经理在忙：不另加标记，行右边照旧是时间", async () => {
    const ws = await boot();
    const time = () => within(row("老马")).getByText(formatTime(20_000));
    expect(time()).toBeInTheDocument();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, status: "running", activity: "working" })));
    expect(within(row("老马")).queryByText(/Working/)).not.toBeInTheDocument();
    expect(time()).toBeInTheDocument();
  });

  it("没有消息的行：第二行留空但占位，和别的行一样高", async () => {
    await boot();
    const preview = row("新来的").querySelector("span.block")!;
    expect(preview.textContent).toBe(" ");
    expect(preview).toHaveClass("block", "text-minor");
  });

  it("左栏底部：不渲染“我”头像与文字；左侧放额度入口，右侧设置按钮 ml-auto 固定靠右；额度、设置、新建都是同一种 ghost 按钮", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).queryByText("我")).not.toBeInTheDocument();
    const settingsBtn = within(sidebar).getByRole("button", { name: "Settings" });
    expect(settingsBtn).toHaveClass("ml-auto");
    push(
      ws,
      sessionChange(
        11,
        makeSession({
          sessionId: 1,
          conversationId: 1,
          pmId: 1,
          lastEventAt: 5,
          rateLimit: {
            status: "allowed",
            resetsAt: null,
            windows: { five_hour: { utilization: 0.37, resetsAt: Math.floor(Date.now() / 1000) + 3600, status: "allowed" } },
          },
        }),
      ),
    );
    const quotaBtn = within(sidebar).getByRole("button", { name: "5h usage 37%" });
    for (const button of [quotaBtn, settingsBtn, screen.getByRole("button", { name: "New project manager" })]) {
      expect(button).toHaveClass("text-muted-foreground", "hover:bg-accent");
      expect(button.className).not.toMatch(/(^|\s)bg-/);
    }
    await user.click(settingsBtn);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("左栏对话列表带 sidebar-list 边缘渐变遮罩与 pb-3 底部内边距，与顶部搜索栏和底部栏柔和过渡", async () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const block = css.match(/(?:^|\n)\.sidebar-list\s*\{([^}]*)\}/)?.[1] ?? "";
    const gradient = "linear-gradient(to bottom, transparent, #000 8px, #000 calc(100% - 20px), transparent)";
    expect(block).toContain(`-webkit-mask-image: ${gradient};`);
    expect(block).toContain(`mask-image: ${gradient};`);

    await boot();
    expect(nav()).toHaveClass("sidebar-list", "pt-1", "pb-3");
  });
});

describe("提示条", () => {
  it("“Reconnecting…”：没有阴影和描边，靠左放在对话列里", async () => {
    const ws = await boot();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => ws.drop());
    const pill = screen.getByText("Reconnecting…").parentElement!;
    expect(pill.className).not.toMatch(/shadow|ring-/);
    expect(pill.parentElement).toHaveClass("chat-column", "items-start");
    vi.useRealTimers();
  });
});

describe("对话列的宽度（docs/ui-standard.md 第 8 条，照 t3code）", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  /** 样式块：selector 是正则源码（不带前后的空白）。 */
  const body = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  const value = (block: string, prop: string) => block.match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1]?.replace(/\s+/g, " ").trim();
  /** 每一档：主区宽度到了 min-width（rem）时，对话列最宽是 max（rem）（只改边距的那一档不算）。 */
  const tiers = [...css.matchAll(/@container chat \(min-width: ([\d.]+)rem\)\s*\{([^}]*\{[^}]*\})\s*\}/g)].map((m) => ({
    min: Number(m[1]),
    max: Number(value(m[2]!, "--chat-max")?.replace("rem", "")),
  })).filter((t) => !Number.isNaN(t.max));

  it("默认 46rem（t3code 的 --chat-content-max-width），主区越宽越宽、分几档，有最大值；数字全用 rem，不写 px", () => {
    expect(value(body("\\.messages,\\s*\\.chat-column"), "--chat-max")).toBe("46rem");
    expect(tiers.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]!.min).toBeGreaterThan(tiers[i - 1]!.min);
      expect(tiers[i]!.max).toBeGreaterThan(tiers[i - 1]!.max);
    }
    expect(tiers.at(-1)!.max).toBeLessThanOrEqual(64);
    const lengths = [...css.matchAll(/(--chat-[\w-]+|--header-gutter[\w-]*):\s*([^;]+);/g)].map((m) => m[2]!);
    expect(lengths.length).toBeGreaterThan(4);
    for (const v of lengths) expect(v).not.toMatch(/\d\s*px/);
  });

  it("主区是容器（按主区宽度分档，不按窗口宽度）；列在主区里居中：两边内边距相等，至少一个 gutter", () => {
    expect(value(body("\\.chat-main"), "container")).toBe("chat / inline-size");
    const column = body("\\.messages,\\s*\\.chat-column");
    expect(value(column, "padding-inline")).toBe("max(var(--chat-gutter), calc((100% - var(--chat-max)) / 2))");
    expect(value(column, "padding-left")).toBeUndefined();
    expect(value(column, "padding-right")).toBeUndefined();
  });

  it("主区套 chat-main；顶栏不跟着列居中：标题在左上、按钮在右上，边距是顶栏自己的 gutter；底部输入框外层向上叠盖 26px 避免顶部圆角外侧水平硬切", async () => {
    await boot();
    const main = screen.getByRole("main");
    expect(main).toHaveClass("chat-main");
    const header = screen.getByRole("heading", { level: 1, name: "小林" }).closest("header")!;
    expect(header.className).toContain("pl-[var(--header-gutter-start)]");
    expect(header.className).toContain("pr-[var(--header-gutter-end)]");
    expect(header.className).not.toContain("chat-left");

    const convComposerCol = screen.getByPlaceholderText("Message 小林…").closest(".chat-column")!;
    expect(convComposerCol).toHaveClass("-mt-6.5", "relative", "z-10", "pointer-events-none", "*:pointer-events-auto");

    act(() => {
      window.history.replaceState(null, "", "/#/w/30");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const workerComposerCol = screen.getByPlaceholderText("Message 修 X…").closest(".chat-column")!;
    expect(workerComposerCol).toHaveClass("-mt-6.5", "relative", "z-10", "pointer-events-none", "*:pointer-events-auto");
  });
});

describe("Mac 原生桌面应用适配（docs/ui-standard.md 第 16 条）", () => {
  afterEach(() => {
    delete document.documentElement.dataset.macosApp;
    delete window.webkit;
    window.history.replaceState(null, "", "/");
  });

  it("data-macos-app='true' 下左栏与各顶栏带 data-window-drag 及红黄绿交通灯避让类名", async () => {
    document.documentElement.dataset.macosApp = "true";
    const user = userEvent.setup();
    await boot();

    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(sidebar.className).toContain("pt-[calc(var(--safe-top)+var(--macos-traffic-lights-height))]");
    const searchInput = within(sidebar).getByRole("searchbox", { name: "Search" });
    expect(searchInput.closest("[data-window-drag]")).not.toBeNull();

    const convHeader = screen.getByRole("heading", { level: 1, name: "小林" }).closest("header")!;
    expect(convHeader).toHaveAttribute("data-window-drag");
    expect(convHeader.className).toContain("pl-[var(--header-gutter-start)]");

    // 切到资料页检查顶栏
    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    const profileBackBtn = screen.getByRole("button", { name: "Back" });
    const profileHeader = profileBackBtn.closest("header")!;
    expect(profileHeader).toHaveAttribute("data-window-drag");
    expect(profileHeader.className).toContain("px-6");
    expect(profileHeader.className).not.toContain("max-[1100px]:pl");

    // 切到 Worker 对话页检查顶栏
    act(() => {
      window.history.replaceState(null, "", "/#/w/30");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const workerHeader = screen.getByRole("heading", { level: 1, name: "修 X" }).closest("header")!;
    expect(workerHeader).toHaveAttribute("data-window-drag");
    expect(workerHeader.className).toContain("pl-[var(--header-gutter-start)]");
  });

  it("webkit.messageHandlers.hubStatus 随状态变化事件驱动上报 runningWorkers、askingCount、waitingCount", async () => {
    document.documentElement.dataset.macosApp = "true";
    const postHubStatus = vi.fn();
    window.webkit = {
      messageHandlers: {
        hubStatus: { postMessage: postHubStatus },
      },
    };

    const ws = await boot();
    expect(postHubStatus).toHaveBeenLastCalledWith({ runningWorkers: 0, askingCount: 0, waitingCount: 0 });

    // Worker 30 开始干活 -> runningWorkers = 1
    push(
      ws,
      sessionChange(
        11,
        makeSession({ sessionId: 30, conversationId: 30, pmId: 1, status: "running", activity: "working" }),
      ),
    );
    expect(postHubStatus).toHaveBeenLastCalledWith({ runningWorkers: 1, askingCount: 0, waitingCount: 0 });

    // 对话 2 收到一条等你确定的提问 -> askingCount = 1
    push(
      ws,
      messageChange(
        12,
        "message.created",
        makeMessage({ id: 99, conversationId: 2, text: "需要确认部署吗？", meta: { needsUser: true }, dedupeKey: "ask:2:99" }),
      ),
    );
    expect(postHubStatus).toHaveBeenLastCalledWith({ runningWorkers: 1, askingCount: 1, waitingCount: 0 });
  });

  it("webkit.messageHandlers.windowDrag：点 [data-window-drag] 空白处触发拖拽或双击缩放，点按钮或输入框不触发", async () => {
    document.documentElement.dataset.macosApp = "true";
    const postWindowDrag = vi.fn();
    window.webkit = {
      messageHandlers: {
        windowDrag: { postMessage: postWindowDrag },
      },
    };

    await boot();
    const convHeader = screen.getByRole("heading", { level: 1, name: "小林" }).closest("header")!;

    // 单击顶栏标题/空白区域 -> 触发拖拽（doubleClick: false）
    act(() => {
      convHeader.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
    });
    expect(postWindowDrag).toHaveBeenCalledTimes(1);
    expect(postWindowDrag).toHaveBeenLastCalledWith({ doubleClick: false });

    // 双击顶栏空白区域 -> 触发缩放（doubleClick: true）
    act(() => {
      convHeader.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 }));
    });
    expect(postWindowDrag).toHaveBeenCalledTimes(2);
    expect(postWindowDrag).toHaveBeenLastCalledWith({ doubleClick: true });

    // 右键点击不触发
    act(() => {
      convHeader.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2, detail: 1 }));
    });
    expect(postWindowDrag).toHaveBeenCalledTimes(2);

    // 点击顶栏里的头像按钮、左栏里的搜索输入框或新建按钮 -> 不触发拖拽
    const avatarBtn = screen.getByRole("button", { name: "View 小林\'s profile" });
    const searchInput = screen.getByRole("searchbox", { name: "Search" });
    const newPmBtn = screen.getByRole("button", { name: "New project manager" });
    for (const interactive of [avatarBtn, searchInput, newPmBtn]) {
      act(() => {
        interactive.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
      });
    }
    expect(postWindowDrag).toHaveBeenCalledTimes(2);
  });
});

describe("视口与滚动容器锁定（docs/ui-standard.md 第 19 条）", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const body = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  const value = (block: string, prop: string) => block.match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1]?.replace(/\s+/g, " ").trim();

  it("styles.css 锁定外层 html, body, #root 不随手势整页晃动，且 .messages 锁死横向溢出与纵向滚动链", () => {
    const rootBlock = body("html,\\s*body,\\s*#root");
    expect(value(rootBlock, "width")).toBe("100%");
    expect(value(rootBlock, "overflow")).toBe("hidden");
    expect(value(rootBlock, "overscroll-behavior")).toBe("none");

    const messagesBlock = body("\\.messages");
    expect(value(messagesBlock, "overflow-x")).toBe("hidden");
    expect(value(messagesBlock, "overscroll-behavior-y")).toBe("contain");
  });

  it("主滚动区（消息区、左栏、右栏、资料页、弹窗）统一带 overflow-x-hidden 与 overscroll-y-contain", async () => {
    const user = userEvent.setup();
    await boot();

    const messageLog = screen.getByRole("log", { name: "Messages" });
    expect(messageLog).toHaveClass("overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");

    const sidebarNav = screen.getByRole("navigation", { name: "Conversations" });
    expect(sidebarNav).toHaveClass("overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");

    const rightRail = screen.getByRole("complementary", { name: "Side panel" });
    const rightRailScroller = rightRail.firstElementChild as HTMLElement;
    expect(rightRailScroller).toHaveClass("overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");

    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    const dialogBody = dialog.querySelector('[data-slot="dialog-body"]') as HTMLElement;
    expect(dialogBody).toHaveClass("overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: "View 小林\'s profile" }));
    const profileRegion = screen.getByRole("region", { name: "小林\'s profile" });
    const profileScroller = profileRegion.querySelector(".overflow-y-auto") as HTMLElement;
    expect(profileScroller).toHaveClass("overflow-x-hidden", "overscroll-y-contain");
  });

  it("窄屏下左栏收紧为 72px 垂直头像窄栏，隐藏搜索框，居中列出各项目经理头像，没有顶栏抽屉按钮", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === NARROW_QUERY,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    await boot();
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(sidebar).toHaveClass("w-18", "border-r", "border-border", "bg-sidebar");
    expect(within(sidebar).queryByRole("searchbox", { name: "Search" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversations" })).toBeNull();
    const navEl = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(navEl).getByRole("button", { name: /小林/ })).toHaveClass("size-13", "rounded-2xl");
    expect(within(sidebar).getByRole("button", { name: "New project manager" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});
