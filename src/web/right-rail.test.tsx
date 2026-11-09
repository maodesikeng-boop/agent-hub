// 右栏（docs/ui-standard.md 第 12 条，照 Claude desktop 的右栏）：组标题 + 紧凑的行，每组最多 3 条、多了 Show more，分隔线分组。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationId, Message } from "../shared/index.ts";
import { EMPTY_TOKEN_USAGE } from "../shared/index.ts";
import { RIGHT_RAIL_COLLAPSED_KEY, RIGHT_RAIL_VISIBLE_ROWS, RightRail, RightRailToggle } from "./components/RightRail.tsx";
import type { WorkerEntry } from "./selectors.ts";
import { makeMessage } from "./test-utils.ts";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const worker = (id: number, over: Partial<WorkerEntry> = {}): WorkerEntry => ({
  conversationId: id,
  title: `活 ${id}`,
  activity: "idle",
  ended: false,
  usage: EMPTY_TOKEN_USAGE,
  tone: "neutral",
  ...over,
});
const busy = (id: number) => worker(id, { activity: "working" });
const done = (id: number) => worker(id, { ended: true });
const ask = (id: number): Message => makeMessage({ id, text: `问题 ${id}`, meta: { needsUser: true } });

function renderRail(props: { asks?: Message[]; workers?: WorkerEntry[]; openWorkerId?: ConversationId | null; avatarKey?: number; onOpenWorker?: (id: ConversationId) => void } = {}) {
  render(
    <RightRail
      asks={props.asks ?? []}
      workers={props.workers ?? []}
      openWorkerId={props.openWorkerId ?? null}
      layout="side"
      avatarKey={props.avatarKey ?? 0}
      onOpenAsk={() => {}}
      onOpenWorker={props.onOpenWorker ?? (() => {})}
    />,
  );
}
const workerGroup = () => screen.getByRole("region", { name: /^Pieces/ });
const asksGroup = () => screen.getByRole("region", { name: /^等你确定/ });
/** 一组里的行和 Show more 之类的按钮（不含组标题那个收起按钮）。 */
const buttons = (group: HTMLElement) => within(group).getAllByRole("button").filter((b) => !b.closest("h2"));
const titleButton = (group: HTMLElement) => within(group).getByRole("heading").querySelector("button")!;

describe("右栏：照 Claude desktop 的样子", () => {
  it("组标题：13px、前景色（不是灰色小标题）、展开时没有计数；“等你确定”前一个 6px 强调色圆点；Pieces 前不放果瓣（右栏只在开关上放一颗）", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30)] });
    for (const [name, group] of [["等你确定", asksGroup()], ["Pieces", workerGroup()]] as const) {
      const heading = within(group).getByRole("heading");
      expect(heading).toHaveTextContent(new RegExp(`^${name}$`));
      expect(heading).toHaveClass("text-small", "text-foreground");
      expect(heading.className).not.toMatch(/muted-foreground/);
    }
    expect(asksGroup().querySelector("h2 button > span.bg-primary")).toHaveClass("size-1.5", "rounded-full");
    expect(workerGroup().querySelector("h2 [data-neutral='true']")).toBeNull();
  });

  it("组和组之间一条 1px 细分隔线（border-border），上下留白一样；没有框、没有阴影", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30)] });
    const sections = [asksGroup(), workerGroup()];
    expect(sections[0]!.parentElement).toHaveClass("divide-y", "divide-border");
    for (const section of sections) expect(section).toHaveClass("py-3");
    expect(screen.getByRole("complementary", { name: "右栏" }).innerHTML).not.toMatch(/shadow|bg-sidebar(?!-)/);
  });

  it("Piece 行：无左侧图标，14px 标题 + 右边英文状态词；紧凑行", () => {
    renderRail({ workers: [busy(30)], avatarKey: 2 });
    const row = within(workerGroup()).getByRole("button", { name: /活 30/ });
    expect(row).toHaveClass("px-2", "-mx-2", "rounded-xl");
    expect(row.className).not.toMatch(/rounded-2xl|py-2(\s|$)/);
    expect(row.querySelector("[data-neutral='true']")).toBeNull();
    expect(within(row).getByText("活 30")).toHaveClass("text-label", "truncate");
    expect(within(row).getByText("Working…")).toHaveClass("text-small", "text-primary", "status-shimmer");
  });

  it("在等后台命令跑完的 Piece：状态词 Waiting for background command…，算在忙（强调色、排在前面）", () => {
    renderRail({ workers: [worker(41), worker(42), worker(43), worker(44, { activity: "background", tone: "success" })], openWorkerId: null });
    const row = within(workerGroup()).getByRole("button", { name: /活 44/ });
    expect(within(row).getByText("Waiting for background command…")).toHaveClass("text-primary");
    expect(within(workerGroup()).getAllByRole("button", { name: /活 \d+/ })[0]).toBe(row);
  });

  it("Piece 行状态展示：在忙用强调色，空闲及收工用灰色；收工的在“已收工”折叠行里", () => {
    renderRail({
      workers: [busy(30), worker(31), worker(32, { tone: "success" }), worker(33, { tone: "warn" }), worker(34, { tone: "danger" }), { ...busy(35), tone: "danger" }, done(36)],
      openWorkerId: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(within(screen.getByRole("button", { name: /活 30/ })).getByText("Working…")).toHaveClass("text-primary");
    expect(within(screen.getByRole("button", { name: /活 31/ })).getByText("Idle")).toHaveClass("text-muted-foreground");
    expect(within(screen.getByRole("button", { name: /活 31/ })).getByText("Idle")).not.toHaveClass("status-shimmer");
    // 收工的在“已收工”里，没展开时看不到
    expect(screen.queryByRole("button", { name: /活 36/ })).toBeNull();
  });

  it("没有厂商、模型信息时第二行只有一个“—”；有就是模型、思考程度、现在的对话长度（小一号灰字，之间用间距）", () => {
    renderRail({ workers: [worker(30), worker(31, { vendor: "claude", model: "sonnet", effort: "high", usage: { input: 1, cacheRead: 2_000_000, cacheWrite: 0, output: 5, context: 158_000 } })] });
    const meta = (name: RegExp) => within(screen.getByRole("button", { name })).getByTestId("worker-meta");
    expect(meta(/活 30/)).toHaveTextContent(/^—$/);
    expect([...meta(/活 31/).children].map((c) => c.textContent)).toEqual(["Sonnet", "high", "158K context"]);
    expect(within(meta(/活 31/)).getByText("158K context")).toHaveClass("tabular-nums");
    expect(meta(/活 31/)).toHaveClass("text-small", "leading-4.5", "text-muted-foreground", "gap-3");
    expect(meta(/活 31/)).not.toHaveTextContent("·");
    expect(meta(/活 31/)).not.toHaveTextContent("tokens");
  });

  it("悬停 context 看明细：累计的 Input、Cache read、Cache write、Output，外加一行说明是累计", () => {
    renderRail({ workers: [worker(31, { vendor: "claude", model: "sonnet", usage: { input: 392, cacheRead: 47_000_000, cacheWrite: 448_354, output: 154_408, context: 117_000 } })] });
    expect(within(screen.getByRole("button", { name: /活 31/ })).getByText("117K context")).toHaveAttribute(
      "title",
      ["Context 117,000 tokens", "Cumulative so far", "Input 392 tokens", "Cache read 47,000,000 tokens", "Cache write 448,354 tokens", "Output 154,408 tokens"].join("\n"),
    );
  });

  it("有模型、还没有对话长度：不显示“—”占位，只有模型和思考程度", () => {
    renderRail({ workers: [worker(30, { vendor: "claude", model: "sonnet", effort: "high" })] });
    expect([...within(screen.getByRole("button", { name: /活 30/ })).getByTestId("worker-meta").children].map((c) => c.textContent)).toEqual(["Sonnet", "high"]);
  });

  it("Antigravity：模型和思考程度分开显示；老数据里带档位的完整 ID 也一样（Gemini 4 Argon + high）", () => {
    renderRail({
      workers: [
        worker(30, { vendor: "agy", model: "gemini-4-argon", effort: "high" }),
        worker(31, { vendor: "agy", model: "claude-opus-5-5-low", effort: null }),
        worker(32, { vendor: "agy", model: "gpt-oss-120b-medium", effort: null }),
      ],
    });
    const parts = (name: RegExp) => [...within(screen.getByRole("button", { name })).getByTestId("worker-meta").children].map((c) => c.textContent);
    expect(parts(/活 30/)).toEqual(["Gemini 4 Argon", "high"]);
    expect(parts(/活 31/)).toEqual(["Claude Opus 5.5", "low"]);
    expect(parts(/活 32/)).toEqual(["GPT-OSS 120B", "medium"]);
  });
});

describe("右栏：顶上不留空", () => {
  const toggle = <button type="button" aria-label="收起右栏" />;
  const renderWithToggle = (props: { asks?: Message[]; workers?: WorkerEntry[] }) =>
    render(<RightRail asks={props.asks ?? []} workers={props.workers ?? []} openWorkerId={null} layout="side" toggle={toggle} onOpenAsk={() => {}} onOpenWorker={() => {}} />);

  it("开关和第一组的标题在同一行（右边），开关上面没有单独的一行；内容从最顶上开始", () => {
    renderWithToggle({ workers: [busy(30)] });
    const aside = screen.getByRole("complementary", { name: "右栏" });
    const heading = within(workerGroup()).getByRole("heading");
    expect(within(heading.parentElement!).getByRole("button", { name: "收起右栏" })).toBeInTheDocument();
    expect(heading.parentElement).toHaveClass("flex", "items-center");
    // aside 里第一个元素就是滚动的内容区，没有放开关的 64px 高的空行
    expect(aside.firstElementChild).toBe(workerGroup().parentElement);
    expect(aside.innerHTML).not.toMatch(/h-16/);
  });

  it("有“等你确定”时开关在“等你确定”那一行，Worker 那一行没有；只有一个开关", () => {
    renderWithToggle({ asks: [ask(1)], workers: [busy(30)] });
    expect(within(asksGroup()).getByRole("button", { name: "收起右栏" })).toBeInTheDocument();
    expect(within(workerGroup()).queryByRole("button", { name: "收起右栏" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "收起右栏" })).toHaveLength(1);
  });

  it("点标题还是收起这一组；点开关不会连带收起（两个按钮各管各的）", async () => {
    const user = userEvent.setup();
    renderWithToggle({ workers: [busy(30)] });
    await user.click(screen.getByRole("button", { name: "收起右栏" }));
    expect(titleButton(workerGroup())).toHaveAttribute("aria-expanded", "true");
    await user.click(titleButton(workerGroup()));
    expect(titleButton(workerGroup())).toHaveAttribute("aria-expanded", "false");
  });
});

describe("右栏：行的底色是完整的圆角（不被收起动画的容器剪掉）", () => {
  /** class 里 -mx-N 的 N（单位 rem/4，即 Tailwind 的档位）。 */
  const bleed = (el: Element) => Number(/(?:^|\s)-mx-(\d+(?:\.\d+)?)(?:\s|$)/.exec(el.className)?.[1] ?? 0);

  it("行向两边伸出的距离，不超过外面 overflow-hidden 容器多留的（再留 0.5 档给聚焦圈）；选中、悬停都是 rounded-xl", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30), done(40)], openWorkerId: 30 });
    for (const group of [asksGroup(), workerGroup()]) {
      const clip = group.querySelector("[data-group-body] > .overflow-hidden")!;
      for (const row of within(group).getAllByRole("button").filter((b) => !b.closest("h2") && b.closest("li") !== null)) {
        expect(row).toHaveClass("rounded-xl");
        expect(row.className).toMatch(/px-2/);
        expect(bleed(clip)).toBeGreaterThanOrEqual(bleed(row) + 0.5);
        expect(clip).toHaveClass("px-3");
      }
    }
    const active = within(workerGroup()).getByRole("button", { name: /活 30/ });
    expect(active).toHaveClass("bg-sidebar-active", "rounded-xl");
    expect(within(workerGroup()).getByRole("button", { name: /^已收工/ })).toHaveClass("rounded-xl", "hover:bg-sidebar-hover");
  });

  it("没有横向滚动：外层滚动区向两边留的内边距（px-5）比行伸出的多", () => {
    renderRail({ workers: [busy(30)] });
    const scroller = workerGroup().parentElement!;
    expect(scroller).toHaveClass("overflow-y-auto", "px-5");
    expect(bleed(workerGroup().querySelector("[data-group-body] > .overflow-hidden")!)).toBeLessThan(5);
  });
});

describe("右栏：只列几条", () => {
  it("每组最多 3 条（常量 RIGHT_RAIL_VISIBLE_ROWS）", () => {
    expect(RIGHT_RAIL_VISIBLE_ROWS).toBe(3);
  });

  it("Worker 不到 4 个：全列，没有 Show more", () => {
    renderRail({ workers: [busy(30), worker(31), worker(32)] });
    expect(buttons(workerGroup())).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("Worker 多了：在忙的排前面，只显示前 3 条，下面一行灰色 Show more；点开展开全部，再点收回（Show less）", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [worker(1), worker(2), busy(3), worker(4), busy(5)] });
    const names = () => buttons(workerGroup()).map((b) => b.textContent).filter((t) => /活/.test(t!)).map((t) => /活 \d/.exec(t!)![0]);
    expect(names()).toEqual(["活 3", "活 5", "活 1"]);
    const more = screen.getByRole("button", { name: "Show more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveClass("text-label", "text-muted-foreground", "hover:text-foreground");
    expect(more.className).not.toMatch(/(^|\s)(bg-|border|rounded-full)/);
    await user.click(more);
    expect(names()).toEqual(["活 3", "活 5", "活 1", "活 2", "活 4"]);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(names()).toEqual(["活 3", "活 5", "活 1"]);
  });

  it("正开着的 Worker 在被收起的那几个里：自动展开，当前那行看得见", () => {
    renderRail({ workers: [busy(1), busy(2), busy(3), worker(4)], openWorkerId: 4 });
    expect(within(workerGroup()).getByRole("button", { name: /活 4/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("“等你确定”同样最多 3 条，多了 Show more，点开展开全部", async () => {
    const user = userEvent.setup();
    renderRail({ asks: [ask(1), ask(2), ask(3), ask(4)] });
    const rows = () => buttons(asksGroup()).filter((b) => /问题/.test(b.textContent!));
    expect(rows().map((b) => b.textContent)).toEqual(["问题 1", "问题 2", "问题 3"]);
    await user.click(within(asksGroup()).getByRole("button", { name: "Show more" }));
    expect(rows().map((b) => b.textContent)).toEqual(["问题 1", "问题 2", "问题 3", "问题 4"]);
  });

  it("没收工的只有几个、收工的很多：已收工收成 Show more 同一类的一行（灰、无底色），点开才列", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [busy(1), ...Array.from({ length: 30 }, (_, i) => done(100 + i))] });
    const ended = within(workerGroup()).getByRole("button", { name: /^已收工/ });
    expect(ended).toHaveTextContent("已收工 30");
    expect(ended).toHaveAttribute("aria-expanded", "false");
    expect(ended).toHaveClass("text-label", "text-muted-foreground", "hover:text-foreground");
    expect(ended.className).not.toMatch(/(^|\s)(bg-|border|rounded-full)/);
    expect(within(ended).getByText("30")).toHaveClass("tabular-nums");
    expect(buttons(workerGroup())).toHaveLength(2);
    await user.click(ended);
    expect(buttons(workerGroup())).toHaveLength(32);
    expect(within(workerGroup()).getByRole("button", { name: /活 100/ })).toHaveClass("opacity-60");
  });

  it("点一行打开那个 Worker", async () => {
    const onOpenWorker = vi.fn();
    renderRail({ workers: [busy(30)], onOpenWorker });
    await userEvent.setup().click(screen.getByRole("button", { name: /活 30/ }));
    expect(onOpenWorker).toHaveBeenCalledWith(30);
  });
});

describe("右栏：提问行", () => {
  it("16px 图标 + 14px 一行摘要 + 右边向右的小箭头；点开在下面展开全文", async () => {
    renderRail({ asks: [ask(1)] });
    const row = within(asksGroup()).getByRole("button", { name: /问题 1/ });
    expect(row).toHaveClass("px-2", "-mx-2", "gap-3", "rounded-xl");
    expect(row.querySelector("svg")).toHaveClass("size-4");
    expect(within(row).getByText("问题 1")).toHaveClass("text-label", "truncate");
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
  });
});

describe("右栏：每组可以收起", () => {
  const body = (group: HTMLElement) => group.querySelector("[data-group-body]") as HTMLElement;

  it("标题是按钮（aria-expanded），旁边一个小三角：展开时朝下、收起时朝右；点一下收起，只剩标题，再点展开", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [busy(30), worker(31)] });
    const title = titleButton(workerGroup());
    expect(title).toHaveAttribute("aria-expanded", "true");
    expect(title.querySelector("svg")).toHaveClass("rotate-90");
    await user.click(title);
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(title.querySelector("svg")).not.toHaveClass("rotate-90");
    // 收起：内容读屏和键盘都够不着（inert + aria-hidden），不再占高度（网格行 0fr）
    expect(body(workerGroup())).toHaveAttribute("aria-hidden", "true");
    expect(body(workerGroup())).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: /活 30/ })).toBeNull();
    expect(body(workerGroup()).className).toMatch(/grid-rows-\[0fr\]/);
    await user.click(title);
    expect(title).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /活 30/ })).toBeInTheDocument();
  });

  it("过渡很短、不跳：网格行高度的 transition（150ms 以内），减弱动效时关掉", () => {
    renderRail({ workers: [busy(30)] });
    const cls = body(workerGroup()).className;
    expect(cls).toMatch(/transition-\[grid-template-rows\]/);
    expect(cls).toMatch(/duration-(100|150)/);
    expect(cls).toMatch(/motion-reduce:transition-none/);
  });

  it("收起后标题后面带个数：等你确定是没回答的几条，Worker 是没收工的几个；展开时不带", async () => {
    const user = userEvent.setup();
    renderRail({ asks: [ask(1), ask(2), ask(3), ask(4)], workers: [busy(30), worker(31), done(32)] });
    expect(within(asksGroup()).getByRole("heading")).toHaveTextContent(/^等你确定$/);
    await user.click(titleButton(asksGroup()));
    await user.click(titleButton(workerGroup()));
    expect(within(asksGroup()).getByRole("heading")).toHaveTextContent(/^等你确定4$/);
    expect(within(workerGroup()).getByRole("heading")).toHaveTextContent(/^Pieces2$/);
    expect(within(within(asksGroup()).getByRole("heading")).getByText("4")).toHaveClass("tabular-nums");
  });

  it("每组各自记住（localStorage），刷新、切对话（重新挂载）都保持；两组互不影响", async () => {
    const user = userEvent.setup();
    renderRail({ asks: [ask(1)], workers: [busy(30)] });
    await user.click(titleButton(workerGroup()));
    expect(JSON.parse(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY)!)).toEqual({ workers: true });
    cleanup();
    renderRail({ asks: [ask(1)], workers: [busy(30)] });
    expect(titleButton(workerGroup())).toHaveAttribute("aria-expanded", "false");
    expect(titleButton(asksGroup())).toHaveAttribute("aria-expanded", "true");
    await user.click(titleButton(workerGroup()));
    await user.click(titleButton(asksGroup()));
    expect(JSON.parse(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY)!)).toEqual({ asks: true });
  });

  it("存的值坏了、没有：当作都展开，不报错", () => {
    localStorage.setItem(RIGHT_RAIL_COLLAPSED_KEY, "{不是 json");
    renderRail({ asks: [ask(1)], workers: [busy(30)] });
    expect(titleButton(workerGroup())).toHaveAttribute("aria-expanded", "true");
    expect(titleButton(asksGroup())).toHaveAttribute("aria-expanded", "true");
  });

  it("键盘：标题能聚焦（有聚焦圈），Enter 和空格都能收起展开", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [busy(30)] });
    const title = titleButton(workerGroup());
    expect(title.className).toMatch(/focus-visible:ring-2/);
    title.focus();
    await user.keyboard("{Enter}");
    expect(title).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(title).toHaveAttribute("aria-expanded", "true");
  });
});

describe("RightRailToggle: 切了的水果 Worker 果瓣图标", () => {
  it("开关使用当前项目经理对应水果切出的 Worker 果瓣（Avatar neutral 26px，按根字号缩放）", () => {
    render(<RightRailToggle visible open={false} attention={false} avatarKey={3} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "展开右栏" });
    const avatar = button.querySelector("[data-neutral='true']");
    expect(avatar).toBeInTheDocument();
    expect((avatar as HTMLElement).style.width).toBe("1.625rem");
  });

  it("有等你确定且收起时右上角显示 6px 强调色小圆点", () => {
    render(<RightRailToggle visible open={false} attention={true} avatarKey={1} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: /有等你确定的事/ });
    expect(button.querySelector("span.bg-primary")).toHaveClass("size-1.5", "rounded-full");
  });
});
