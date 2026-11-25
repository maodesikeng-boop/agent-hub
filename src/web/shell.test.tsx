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

async function boot(snapshot: StateSnapshot = three(), { keepEmptyHash = false }: { keepEmptyHash?: boolean } = {}) {
  if (!keepEmptyHash && (window.location.hash === "" || window.location.hash === "#")) {
    window.history.replaceState(null, "", "/#/c/1");
  }
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

const nav = () => screen.getByRole("region", { name: "Project managers" });
const row = (name: string) => within(nav()).getAllByRole("button", { name: new RegExp(name) }).find((b) => !b.closest(".row-shortcuts"))!;
const title = () => screen.getByRole("main").querySelector("h1")?.textContent;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("URL", () => {
  it("routeHash / parseRoute 来回一致；认不出来的是 null", () => {
    for (const route of [{ view: "router" }, { view: "conversation", id: 12 }, { view: "worker", id: 30 }, { view: "profile", pmId: 3 }] as const) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(routeHash({ view: "router" })).toBe("#/router");
    expect(routeHash({ view: "conversation", id: 12 })).toBe("#/c/12");
    for (const bad of ["", "#", "#/c/", "#/c/0", "#/c/-1", "#/c/1.5", "#/x/1", "#/c/1/2", "#/c/99999999999999999999"]) expect(parseRoute(bad)).toBeNull();
  });

  it("第一次打开（没写网址）：电脑外壳默认落到 #/router，不多记一条历史", async () => {
    window.history.replaceState(null, "", "/");
    const length = window.history.length;
    await boot(three(), { keepEmptyHash: true });
    expect(title()).toBe("Router");
    await waitFor(() => expect(window.location.hash).toBe("#/router"));
    expect(window.history.length).toBe(length);
  });

  it("刷新：网址写着哪个对话就回到哪个，不跳回第一个", async () => {
    window.history.replaceState(null, "", "/#/c/2");
    await boot();
    expect(title()).toBe("老马");
    expect(row("老马")).toHaveAttribute("aria-current", "page");
  });

  it("刷新：Worker 的对话、资料页也回到原来那个", async () => {
    window.history.replaceState(null, "", "/#/w/30");
    await boot();
    const panel = screen.getByRole("complementary", { name: "修 X" });
    expect(within(panel).getByRole("region", { name: "Piece 修 X" })).toBeInTheDocument();
    // 对话与左栏仍停在派它的项目经理上
    expect(title()).toBe("小林");
    expect(row("小林")).toHaveAttribute("aria-current", "page");
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

describe("ProjectList", () => {
  it("选中的对话：奶油导航底上一条平的白色选中带，没有描边和投影，选中的名字用深色", async () => {
    await boot();
    const activeRow = row("小林").closest(".project-row")!;
    const idleRow = row("老马").closest(".project-row")!;
    expect(row("小林")).toHaveAttribute("aria-current", "page");
    expect(activeRow).toHaveClass("row-selected", "rounded-sm");
    expect(idleRow).toHaveClass("hover:bg-list-hover", "rounded-sm");
    expect(idleRow.className).not.toMatch(/row-selected|tile-selected|border-select-line|bg-background|bg-jelly/);
    expect(within(row("小林")).getByText("小林")).toHaveClass("text-list-ink");
  });

  it("项目经理在忙：行里不另加标记，也不显示时间", async () => {
    const ws = await boot();
    expect(within(row("老马")).queryByText(formatTime(20_000))).not.toBeInTheDocument();
    push(ws, sessionChange(11, makeSession({ sessionId: 2, conversationId: 2, pmId: 2, status: "running", activity: "working" })));
    expect(within(row("老马")).queryByText(/Working/)).not.toBeInTheDocument();
  });

  it("每行只有头像和名字：有消息和没消息的行一样高，都不显示最近消息", async () => {
    await boot();
    const empty = row("新来的");
    const withMessage = row("小林");
    expect(within(withMessage).queryByText("小林你好")).not.toBeInTheDocument();
    expect(empty.closest(".project-row")).toHaveClass("h-6.5");
    expect(withMessage.closest(".project-row")).toHaveClass("h-6.5");
    expect(empty).toHaveTextContent("新来的");
  });

  it("额度、设置与账号常驻最左栏 AppRail，切到资料页也不搬家；新建在项目列表顶栏", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    const settingsBtn = within(rail).getByRole("button", { name: "Settings" });
    expect(settingsBtn).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Account" })).toBeInTheDocument();
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
    const quotaBtn = within(rail).getByRole("button", { name: /5h usage 37%/ });
    expect(quotaBtn).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project manager" })).toHaveClass("btn-honey");

    await user.click(screen.getByRole("button", { name: "View 小林's profile" }));
    expect(within(rail).getByRole("button", { name: /5h usage 37%/ })).toBe(quotaBtn);
    await user.click(settingsBtn);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("左栏列表区带 page-fade 顶部边缘渐隐与横向/滚动链锁定", async () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    const block = css.match(/(?:^|\n)(?:[^}]*,\s*)?\.page-fade(?:,\s*\.[\w-]+)*\s*\{([^}]*)\}/)?.[1] ?? "";
    const gradient = "linear-gradient(to bottom, transparent, #000 var(--fade-top, 0px), #000 calc(100% - var(--fade-bottom, 0px)), transparent)";
    expect(css).toMatch(/\n\.page-fade\s*\{\s*--fade-top:\s*1rem;\s*\}/);
    expect(block).toContain(`-webkit-mask-image: ${gradient};`);
    expect(block).toContain(`mask-image: ${gradient};`);

    await boot();
    expect(nav().closest(".page-fade")).toHaveClass("page-fade", "overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");
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
    expect(main).toHaveClass("chat-main", "min-w-0", "overflow-hidden");
    const header = screen.getByRole("heading", { level: 1, name: "小林" }).closest("header")!;
    expect(header).toHaveClass("min-w-0", "overflow-hidden");
    expect(within(header).getByRole("button", { name: "View 小林's profile" })).toHaveClass("min-w-0", "max-w-full");
    expect(header.className).toContain("pl-[var(--header-gutter-start)]");
    expect(header.className).toContain("pr-[var(--header-gutter-end)]");
    expect(header.className).not.toContain("chat-left");

    const convComposerCol = screen.getByPlaceholderText("Message 小林…").closest(".chat-column")!;
    expect(convComposerCol).toHaveClass("-mt-6.5", "relative", "z-10", "pointer-events-none", "*:pointer-events-auto");

    act(() => {
      window.history.replaceState(null, "", "/#/w/30");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const workerPanel = screen.getByRole("complementary", { name: "修 X" });
    expect(workerPanel).toBeInTheDocument();
    expect(within(workerPanel).getByRole("heading", { level: 1, name: "修 X" })).toBeInTheDocument();
    const workerComposerCol = screen.getByPlaceholderText("Message 修 X…").closest(".chat-column")!;
    expect(workerComposerCol).toHaveClass("-mt-6.5", "relative", "z-10", "pointer-events-none", "*:pointer-events-auto");

    act(() => {
      window.history.replaceState(null, "", "/#/router");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const routerHeader = screen.getByRole("heading", { level: 1, name: "Router" }).closest("header")!;
    expect(routerHeader).toHaveClass("min-w-0", "overflow-hidden");
  });
});

describe("Mac 原生桌面应用适配（docs/ui-standard.md 第 16 条）", () => {
  afterEach(() => {
    delete document.documentElement.dataset.macosApp;
    delete window.webkit;
    window.history.replaceState(null, "", "/");
  });

  it("data-macos-app='true' 下最左栏带交通灯避让类名，各列顶栏带 data-window-drag", async () => {
    document.documentElement.dataset.macosApp = "true";
    const user = userEvent.setup();
    await boot();

    const rail = screen.getByRole("navigation", { name: "Workspace" });
    expect(rail.className).toContain("pt-[calc(var(--safe-top)+var(--macos-traffic-lights-height))]");
    expect(rail.querySelector("[data-window-drag]")).not.toBeNull();

    const convHeader = screen.getByRole("heading", { level: 1, name: "小林" }).closest("header")!;
    expect(convHeader).toHaveAttribute("data-window-drag");
    expect(convHeader.className).toContain("pr-[var(--header-gutter-end)]");

    // 切到资料侧栏检查顶栏
    await user.click(screen.getByRole("button", { name: "View 小林's profile" }));
    const profilePanel = screen.getByRole("complementary", { name: "小林's settings" });
    const profileHeader = profilePanel.querySelector("header")!;
    expect(profileHeader).toHaveAttribute("data-window-drag");

    // 切到 Worker 侧栏检查顶栏
    act(() => {
      window.history.replaceState(null, "", "/#/w/30");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const workerPanel = screen.getByRole("complementary", { name: "修 X" });
    expect(workerPanel.querySelector("header")).toHaveAttribute("data-window-drag");
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
    const avatarBtn = screen.getByRole("button", { name: "View 小林's profile" });
    const searchInput = screen.getByRole("searchbox", { name: "Search conversations" });
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

    const listScroller = nav().closest(".page-fade") as HTMLElement;
    expect(listScroller).toHaveClass("overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");

    const rightRail = screen.getByRole("complementary", { name: "Pieces" });
    const rightRailScroller = rightRail.querySelector(".overflow-y-auto") as HTMLElement;
    expect(rightRailScroller).toHaveClass("overflow-x-hidden", "overscroll-y-contain");

    await user.click(screen.getByRole("button", { name: "New project manager" }));
    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    const dialogBody = dialog.querySelector('[data-slot="dialog-body"]') as HTMLElement;
    expect(dialogBody).toHaveClass("overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: "View 小林's profile" }));
    const profileRegion = screen.getByRole("complementary", { name: "小林's settings" });
    const profileScroller = profileRegion.querySelector(".overflow-y-auto") as HTMLElement;
    expect(profileScroller).toHaveClass("overflow-x-hidden", "overscroll-y-contain");
  });

  it("窄窗口 strip 档下项目列表收紧为 72px 垂直头像窄条，隐藏搜索框，居中列出项目经理头像", async () => {
    const observers: Array<{ obs: ResizeObserver; cb: ResizeObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private rec: { obs: ResizeObserver; cb: ResizeObserverCallback; targets: Element[] };
        constructor(cb: ResizeObserverCallback) {
          this.rec = { obs: this as unknown as ResizeObserver, cb, targets: [] };
          observers.push(this.rec);
        }
        observe(el: Element) {
          this.rec.targets.push(el);
        }
        disconnect() {
          this.rec.targets = [];
        }
        unobserve(el: Element) {
          this.rec.targets = this.rec.targets.filter((t) => t !== el);
        }
      },
    );
    await boot();
    const shell = document.querySelector<HTMLElement>("[data-shell='desktop']")!;
    shell.getBoundingClientRect = () => ({ width: 1040, height: 800, top: 0, left: 0, right: 1040, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    act(() => {
      for (const { obs, cb, targets } of observers) {
        if (targets.includes(shell)) cb([{ target: shell, contentRect: { width: 1040 } } as unknown as ResizeObserverEntry], obs);
      }
    });
    const listRegion = screen.getByRole("region", { name: "This computer" });
    expect(listRegion).toHaveClass("w-18", "shrink-0", "bg-list");
    expect(within(listRegion).queryByRole("searchbox", { name: "Search conversations" })).toBeNull();
    const btn = within(listRegion).getByRole("button", { name: /小林/ });
    expect(btn).toHaveClass("size-13");
    expect(btn.className).not.toMatch(/border-2|rounded-(?!sm\b)/);
    expect(within(listRegion).getByRole("button", { name: "New project manager" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});
