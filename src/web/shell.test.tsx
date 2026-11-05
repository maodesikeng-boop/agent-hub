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

const nav = () => screen.getByRole("navigation", { name: "对话列表" });
const row = (name: string) => within(nav()).getByRole("button", { name: new RegExp(name) });
const title = () => screen.getByRole("main").querySelector("h1")?.textContent;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("网址", () => {
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
    expect(screen.getByRole("region", { name: "Worker 修 X" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "查看 小林 的资料" }));
    expect(window.location.hash).toBe("#/pm/1");
  });
});

describe("焦点", () => {
  it("打开、切换对话时焦点在输入框里", async () => {
    const user = userEvent.setup();
    await boot();
    await waitFor(() => expect(screen.getByPlaceholderText("给 小林 发消息")).toHaveFocus());
    await user.click(row("老马"));
    expect(screen.getByPlaceholderText("给 老马 发消息")).toHaveFocus();
  });
});

describe("左栏", () => {
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
    expect(preview).toHaveClass("block", "text-[13.5px]");
  });

  it("左下角：“我”的头像用颜色变量；额度、设置、新建都是同一种 ghost 按钮（没有底色、不是胶囊底）", async () => {
    await boot();
    const me = screen.getByText("我", { selector: "span[aria-hidden]" });
    expect(me).toHaveClass("bg-me", "text-me-foreground");
    expect(me.className).not.toMatch(/emerald/);
    for (const name of ["设置", "新建项目经理"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("text-muted-foreground", "hover:bg-accent");
      expect(button.className).not.toMatch(/(^|\s)bg-/);
    }
  });
});

describe("提示条", () => {
  it("“重连中”：没有阴影和描边，靠左放在对话列里", async () => {
    const ws = await boot();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => ws.drop());
    const pill = screen.getByText("重连中").parentElement!;
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

  it("主区套 chat-main；顶栏不跟着列居中：标题在左上、按钮在右上，边距是顶栏自己的 gutter", async () => {
    await boot();
    const main = screen.getByRole("main");
    expect(main).toHaveClass("chat-main");
    const header = screen.getByRole("heading", { level: 1, name: "小林" }).closest("header")!;
    expect(header.className).toContain("pl-[var(--header-gutter-start)]");
    expect(header.className).toContain("pr-[var(--header-gutter-end)]");
    expect(header.className).not.toContain("chat-left");
  });
});
