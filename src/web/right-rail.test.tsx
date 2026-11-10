// 右栏（docs/ui-standard.md 第 12 条，照 Claude desktop 的右栏）：组标题 + 紧凑的行，每组最多 3 条、多了 Show more，分隔线分组。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationId, Message } from "../shared/index.ts";
import { EMPTY_TOKEN_USAGE } from "../shared/index.ts";
import { RIGHT_RAIL_COLLAPSED_KEY, RIGHT_RAIL_VISIBLE_ROWS, RightRail, RightRailToggle } from "./components/RightRail.tsx";
import { cleanPieceTitle } from "./format.ts";
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
const asksGroup = () => screen.getByRole("region", { name: /^Needs You/ });
const completedGroup = () => screen.getByRole("region", { name: /^Completed/ });
/** 组标题后面的果瓣箭头（14px 圆角扇形 SVG）。 */
const arrowOf = (group: HTMLElement) => within(group).getByRole("heading").querySelector<SVGElement>("[data-wedge-arrow]")!;
/** 一组里的行和 Show more 之类的按钮（不含组标题那个收起按钮）。 */
const buttons = (group: HTMLElement) => within(group).getAllByRole("button").filter((b) => !b.closest("h2"));
const titleButton = (group: HTMLElement) => within(group).getByRole("heading").querySelector("button")!;

describe("右栏：照 Claude desktop 的样子", () => {
  it("三组标题（Needs You、Pieces、Completed）一模一样：12px、灰、500，不带个数；后面一个果瓣箭头；“等你确定”前一个 6px 强调色圆点", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30), done(31)], avatarKey: 2 });
    const classes = new Set<string>();
    for (const [name, group] of [["Needs You", asksGroup()], ["Pieces", workerGroup()], ["Completed", completedGroup()]] as const) {
      const heading = within(group).getByRole("heading");
      expect(heading).toHaveTextContent(new RegExp(`^${name}$`));
      expect(heading).toHaveClass("text-xs", "font-medium", "text-muted-foreground");
      classes.add(heading.className);
      // 标题里不放头像，只有字后面一个果瓣箭头
      expect(heading.querySelector("[data-neutral='true']")).toBeNull();
      expect(heading.querySelectorAll("[data-wedge-arrow]")).toHaveLength(1);
      expect(heading.querySelector("button")!.lastElementChild).toBe(arrowOf(group));
    }
    expect(classes.size).toBe(1);
    expect(asksGroup().querySelector("h2 button > span.bg-primary")).toHaveClass("size-1.5", "rounded-full");
  });

  it("组和组之间一条 1px 细分隔线（掺水果色的 divide-line），上下留白一样；没有框、没有阴影", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30), done(31)] });
    const sections = [asksGroup(), workerGroup(), completedGroup()];
    expect(sections[0]!.parentElement).toHaveClass("divide-y", "divide-line");
    for (const section of sections) expect(section).toHaveClass("py-3");
    expect(screen.getByRole("complementary", { name: "Side panel" }).innerHTML).not.toMatch(/shadow|bg-sidebar(?!-)/);
  });

  it("Piece 行：单行，无左侧图标，只有 15px 标题，不写状态词；行距舒展（py-2 px-2.5）", () => {
    renderRail({ workers: [busy(30)], avatarKey: 2 });
    const row = within(workerGroup()).getByRole("button", { name: /活 30/ });
    expect(row).toHaveClass("px-2.5", "-mx-2.5", "py-2", "rounded-xl");
    expect(row.className).not.toMatch(/rounded-2xl|rounded-lg/);
    expect(row.querySelector("[data-neutral='true']")).toBeNull();
    expect(within(row).getByText("活 30")).toHaveClass("text-body", "truncate");
    // 只有标题一样，没有状态词、没有第二行
    expect(row.children).toHaveLength(1);
    expect(row).not.toHaveTextContent(/Working|Thinking|Idle|…/);
  });

  it("在跑的 Piece（干活、准备、等后台命令）：标题字本身带流光（.status-shimmer），排在前面；空闲、停止中、收工的标题静态", () => {
    renderRail({
      workers: [worker(41), worker(42, { activity: "stopping" }), worker(44, { activity: "background", tone: "success" }), busy(45), worker(46, { activity: "preparing" }), done(47)],
      openWorkerId: 47,
    });
    for (const id of [44, 45, 46]) {
      const row = screen.getByRole("button", { name: `活 ${id}` });
      expect(within(row).getByText(`活 ${id}`)).toHaveClass("status-shimmer");
      expect(row).not.toHaveTextContent(/Working…|Waiting|Running setup/);
    }
    expect(within(workerGroup()).getAllByRole("button", { name: /活 \d+/ }).slice(0, 3).map((b) => b.getAttribute("aria-label"))).toEqual(["活 44", "活 45", "活 46"]);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    for (const id of [41, 42, 47]) expect(within(screen.getByRole("button", { name: `活 ${id}` })).getByText(`活 ${id}`)).not.toHaveClass("status-shimmer");
    // 整栏只有在跑的三行挂流光
    expect(screen.getByRole("complementary").querySelectorAll(".status-shimmer")).toHaveLength(3);
  });

  it("收工的在 Completed 组里（默认收着），行里不写 Ended", async () => {
    renderRail({ workers: [busy(30), worker(31), done(36)], openWorkerId: null });
    // 收工的在“Completed”里，没展开时看不到
    expect(screen.queryByRole("button", { name: /活 36/ })).toBeNull();
    fireEvent.click(titleButton(completedGroup()));
    const ended = screen.getByRole("button", { name: /活 36/ });
    expect(ended).toHaveTextContent(/^活 36$/);
    // 只把字调淡，选中时果冻底不跟着变淡
    expect(within(ended).getByText("活 36")).toHaveClass("opacity-60");
    expect(ended).not.toHaveClass("opacity-60");
    expect(within(completedGroup()).queryByText("Ended")).toBeNull();
  });

  it("模型、思考程度、对话长度不常驻显示，收进整行的悬停提示（第一行是完整标题，每项一行，不用“·”）", () => {
    renderRail({ workers: [worker(30), worker(31, { vendor: "claude", model: "sonnet", effort: "high", usage: { input: 1, cacheRead: 2_000_000, cacheWrite: 0, output: 5, context: 158_000 } })] });
    const row31 = screen.getByRole("button", { name: /活 31/ });
    expect(row31).toHaveAttribute("title", ["活 31", "Sonnet", "high", "158K context"].join("\n"));
    expect(row31).not.toHaveTextContent(/Sonnet|158K/);
    expect(screen.queryByTestId("worker-meta")).toBeNull();
    // 没有厂商、模型、用量：提示里只有标题，不放“—”
    expect(screen.getByRole("button", { name: /活 30/ })).toHaveAttribute("title", "活 30");
  });

  it("有模型、还没有对话长度：提示里只有模型和思考程度", () => {
    renderRail({ workers: [worker(30, { vendor: "claude", model: "sonnet", effort: "high" })] });
    expect(screen.getByRole("button", { name: /活 30/ })).toHaveAttribute("title", ["活 30", "Sonnet", "high"].join("\n"));
  });

  it("Antigravity：模型和思考程度分开写；老数据里带档位的完整 ID 也一样（Gemini 4 Argon + high）", () => {
    renderRail({
      workers: [
        worker(30, { vendor: "agy", model: "gemini-4-argon", effort: "high" }),
        worker(31, { vendor: "agy", model: "claude-opus-5-5-low", effort: null }),
        worker(32, { vendor: "agy", model: "gpt-oss-120b-medium", effort: null }),
      ],
    });
    const parts = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("title")!.split("\n").slice(1);
    expect(parts(/活 30/)).toEqual(["Gemini 4 Argon", "high"]);
    expect(parts(/活 31/)).toEqual(["Claude Opus 5.5", "low"]);
    expect(parts(/活 32/)).toEqual(["GPT-OSS 120B", "medium"]);
  });

  it("标题开头的分类前缀（界面：、修复：……）在列表里去掉，读屏名字和悬停提示还是完整标题", () => {
    renderRail({ workers: [worker(30, { title: "界面：右栏单行" }), worker(31, { title: "修复: 额度显示" }), worker(32, { title: "接手 #269：验证" })] });
    const row = screen.getByRole("button", { name: "界面：右栏单行" });
    expect(within(row).getByText("右栏单行")).toBeInTheDocument();
    expect(row).toHaveAttribute("title", "界面：右栏单行");
    expect(within(screen.getByRole("button", { name: "修复: 额度显示" })).getByText("额度显示")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "接手 #269：验证" })).getByText("接手 #269：验证")).toBeInTheDocument();
  });
});

describe("右栏：顶上不留空", () => {
  const toggle = <button type="button" aria-label="Hide side panel" />;
  const renderWithToggle = (props: { asks?: Message[]; workers?: WorkerEntry[] }) =>
    render(<RightRail asks={props.asks ?? []} workers={props.workers ?? []} openWorkerId={null} layout="side" toggle={toggle} onOpenAsk={() => {}} onOpenWorker={() => {}} />);

  it("开关和第一组的标题在同一行（右边），开关上面没有单独的一行；内容从最顶上开始", () => {
    renderWithToggle({ workers: [busy(30)] });
    const aside = screen.getByRole("complementary", { name: "Side panel" });
    const heading = within(workerGroup()).getByRole("heading");
    expect(within(heading.parentElement!).getByRole("button", { name: "Hide side panel" })).toBeInTheDocument();
    expect(heading.parentElement).toHaveClass("flex", "items-center");
    // aside 里第一个元素就是滚动的内容区，没有放开关的 64px 高的空行
    expect(aside.firstElementChild).toBe(workerGroup().parentElement);
    expect(aside.innerHTML).not.toMatch(/h-16/);
  });

  it("有“等你确定”时开关在“等你确定”那一行，Worker 那一行没有；只有一个开关", () => {
    renderWithToggle({ asks: [ask(1)], workers: [busy(30)] });
    expect(within(asksGroup()).getByRole("button", { name: "Hide side panel" })).toBeInTheDocument();
    expect(within(workerGroup()).queryByRole("button", { name: "Hide side panel" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Hide side panel" })).toHaveLength(1);
  });

  it("点标题还是收起这一组；点开关不会连带收起（两个按钮各管各的）", async () => {
    const user = userEvent.setup();
    renderWithToggle({ workers: [busy(30)] });
    await user.click(screen.getByRole("button", { name: "Hide side panel" }));
    expect(titleButton(workerGroup())).toHaveAttribute("aria-expanded", "true");
    await user.click(titleButton(workerGroup()));
    expect(titleButton(workerGroup())).toHaveAttribute("aria-expanded", "false");
  });
});

describe("右栏：行的底色是完整的圆角（不被收起动画的容器剪掉）", () => {
  /** class 里 -mx-N 的 N（单位 rem/4，即 Tailwind 的档位）。 */
  const bleed = (el: Element) => Number(/(?:^|\s)-mx-(\d+(?:\.\d+)?)(?:\s|$)/.exec(el.className)?.[1] ?? 0);

  it("行向两边伸出的距离，不超过外面 overflow-hidden 容器多留的（再留 0.5 档给聚焦圈）；选中、悬停都是 rounded-xl", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30), done(40)], openWorkerId: 40 });
    for (const group of [asksGroup(), workerGroup(), completedGroup()]) {
      const clip = group.querySelector("[data-group-body] > .overflow-hidden")!;
      for (const row of within(group).getAllByRole("button").filter((b) => !b.closest("h2") && b.closest("li") !== null)) {
        expect(row).toHaveClass("rounded-xl");
        expect(row.className).toMatch(/px-2\.5/);
        expect(bleed(clip)).toBeGreaterThanOrEqual(bleed(row) + 0.5);
        expect(clip).toHaveClass("px-3");
      }
    }
    const active = within(completedGroup()).getByRole("button", { name: /活 40/ });
    // 选中、悬停是当前项目经理水果色的极淡果冻底（styles.css 的 --color-jelly）
    expect(active).toHaveClass("bg-jelly", "rounded-xl");
    expect(active.className).not.toMatch(/bg-sidebar-active/);
    expect(titleButton(completedGroup())).toHaveClass("rounded-xl", "hover:bg-sidebar-hover");
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
    expect(more).toHaveClass("text-minor", "text-muted-foreground", "hover:text-foreground");
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

  it("没收工的只有几个、收工的很多：收工的单独一组 Completed，标题不带数字，默认收着，点开才列（全部列出，标题字淡）", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [busy(1), ...Array.from({ length: 30 }, (_, i) => done(100 + i))] });
    const title = titleButton(completedGroup());
    expect(within(completedGroup()).getByRole("heading")).toHaveTextContent(/^Completed$/);
    expect(within(completedGroup()).getByRole("heading").textContent).not.toMatch(/\d/);
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(buttons(workerGroup())).toHaveLength(1);
    expect(within(completedGroup()).queryByText("活 100")).toBeNull();
    expect(completedGroup().querySelectorAll("li")).toHaveLength(0);
    expect(document.getElementById("rail-completed-body")).toBeNull();
    await user.click(title);
    expect(buttons(completedGroup())).toHaveLength(30);
    expect(within(within(completedGroup()).getByRole("button", { name: /活 100/ })).getByText("活 100")).toHaveClass("opacity-60");
  });

  it("Completed 收着时不挂载已收工的行（300 个也一样），点开才渲染；300 个展开不到 1 秒", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [busy(1), ...Array.from({ length: 300 }, (_, i) => done(1000 + i))] });
    expect(completedGroup().querySelectorAll("li")).toHaveLength(0);
    expect(screen.queryByText("活 1000")).toBeNull();
    const t0 = performance.now();
    await user.click(titleButton(completedGroup()));
    const ms = performance.now() - t0;
    console.log(`completed 300 rows expand: ${ms.toFixed(0)}ms`);
    expect(completedGroup().querySelectorAll("li")).toHaveLength(300);
    expect(ms).toBeLessThan(1000);
    await user.click(titleButton(completedGroup()));
    expect(completedGroup().querySelectorAll("li")).toHaveLength(0);
  });

  it("只有收工的（手动打开右栏）：只有 Completed 一组，开关放在它那一行", () => {
    render(<RightRail asks={[]} workers={[done(1)]} openWorkerId={null} layout="side" toggle={<button type="button" aria-label="Hide side panel" />} onOpenAsk={() => {}} onOpenWorker={() => {}} />);
    expect(screen.queryByRole("region", { name: /^Pieces/ })).toBeNull();
    expect(within(completedGroup()).getByRole("button", { name: "Hide side panel" })).toBeInTheDocument();
  });

  it("正开着的是收工的 Piece：Completed 自动展开，当前那行看得见", () => {
    renderRail({ workers: [busy(1), done(2)], openWorkerId: 2 });
    expect(titleButton(completedGroup())).toHaveAttribute("aria-expanded", "true");
    expect(within(completedGroup()).getByRole("button", { name: /活 2/ })).toHaveAttribute("aria-current", "true");
  });

  it("点一行打开那个 Worker", async () => {
    const onOpenWorker = vi.fn();
    renderRail({ workers: [busy(30)], onOpenWorker });
    await userEvent.setup().click(screen.getByRole("button", { name: /活 30/ }));
    expect(onOpenWorker).toHaveBeenCalledWith(30);
  });
});

describe("右栏：提问行", () => {
  it("16px 图标 + 15px 一行摘要 + 右边向右的小箭头；点开在下面展开全文", async () => {
    renderRail({ asks: [ask(1)] });
    const row = within(asksGroup()).getByRole("button", { name: /问题 1/ });
    expect(row).toHaveClass("px-2.5", "-mx-2.5", "gap-3", "rounded-xl");
    expect(row.querySelector("svg")).toHaveClass("size-4");
    expect(within(row).getByText("问题 1")).toHaveClass("text-body", "truncate");
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
  });
});

describe("右栏：每组可以收起", () => {
  const body = (group: HTMLElement) => group.querySelector("[data-group-body]") as HTMLElement;

  it("标题是按钮（aria-expanded），旁边一个果瓣箭头：展开时朝下、收起时朝右；点一下收起，只剩标题，再点展开", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [busy(30), worker(31)] });
    const title = titleButton(workerGroup());
    expect(title).toHaveAttribute("aria-expanded", "true");
    // 扇形的尖本来朝下：展开不转，收起转 -90° 朝右
    expect(arrowOf(workerGroup()).getAttribute("class")).not.toMatch(/rotate/);
    await user.click(title);
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(arrowOf(workerGroup())).toHaveClass("-rotate-90");
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

  it("果瓣箭头：14px、当前强调色（text-primary），三组共用同一个；转向 200ms 以内，减弱动效时关掉", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30), done(31)], avatarKey: 3 });
    const shapes = new Set<string>();
    for (const group of [asksGroup(), workerGroup(), completedGroup()]) {
      const arrow = arrowOf(group);
      const cls = arrow.getAttribute("class")!;
      expect(arrow).toHaveClass("size-3.5", "text-primary", "transition-transform", "motion-reduce:transition-none");
      expect(cls).toMatch(/duration-(100|150|200)\b/);
      shapes.add(arrow.innerHTML);
    }
    expect(shapes.size).toBe(1);
  });

  it("收起后标题也不带个数（三组都是）", async () => {
    const user = userEvent.setup();
    renderRail({ asks: [ask(1), ask(2), ask(3), ask(4)], workers: [busy(30), worker(31), done(32)] });
    await user.click(titleButton(asksGroup()));
    await user.click(titleButton(workerGroup()));
    expect(within(asksGroup()).getByRole("heading")).toHaveTextContent(/^Needs You$/);
    expect(within(workerGroup()).getByRole("heading")).toHaveTextContent(/^Pieces$/);
    expect(within(completedGroup()).getByRole("heading")).toHaveTextContent(/^Completed$/);
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
    const button = screen.getByRole("button", { name: "Show side panel" });
    const avatar = button.querySelector("[data-neutral='true']");
    expect(avatar).toBeInTheDocument();
    expect((avatar as HTMLElement).style.width).toBe("1.625rem");
  });

  it("有等你确定且收起时右上角显示 6px 强调色小圆点", () => {
    render(<RightRailToggle visible open={false} attention={true} avatarKey={1} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: /needs you/ });
    expect(button.querySelector("span.bg-primary")).toHaveClass("size-1.5", "rounded-full");
  });
});

describe("cleanPieceTitle：列表里去掉标题开头的分类前缀", () => {
  it.each([
    ["界面：右栏单行", "右栏单行"],
    ["修复: hub ask 误判", "hub ask 误判"],
    ["功能 ： 最大时间", "最大时间"],
    ["接手 #269：验证上传", "接手 #269：验证上传"],
    ["界面：", "界面："],
    ["修复界面：别的", "修复界面：别的"],
  ])("%s → %s", (title, shown) => {
    expect(cleanPieceTitle(title)).toBe(shown);
  });
});
