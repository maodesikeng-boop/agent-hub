// 右栏（docs/ui-standard.md 第 12 条，照 Claude desktop 的右栏）：组标题 + 紧凑的行，每组最多 3 条、多了 Show more，分隔线分组。
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationId, Message } from "../shared/index.ts";
import { EMPTY_TOKEN_USAGE } from "../shared/index.ts";
import { RIGHT_RAIL_VISIBLE_ROWS, RightRail } from "./components/RightRail.tsx";
import type { WorkerEntry } from "./selectors.ts";
import { makeMessage } from "./test-utils.ts";

afterEach(cleanup);

const worker = (id: number, over: Partial<WorkerEntry> = {}): WorkerEntry => ({
  conversationId: id,
  title: `活 ${id}`,
  activity: "idle",
  ended: false,
  usage: EMPTY_TOKEN_USAGE,
  ...over,
});
const busy = (id: number) => worker(id, { activity: "working" });
const done = (id: number) => worker(id, { ended: true });
const ask = (id: number): Message => makeMessage({ id, text: `问题 ${id}`, meta: { needsUser: true } });

function renderRail(props: { asks?: Message[]; workers?: WorkerEntry[]; openWorkerId?: ConversationId | null; onOpenWorker?: (id: ConversationId) => void } = {}) {
  render(
    <RightRail
      asks={props.asks ?? []}
      workers={props.workers ?? []}
      openWorkerId={props.openWorkerId ?? null}
      layout="side"
      onOpenAsk={() => {}}
      onOpenWorker={props.onOpenWorker ?? (() => {})}
    />,
  );
}
const workerGroup = () => screen.getByRole("region", { name: "Worker" });
const asksGroup = () => screen.getByRole("region", { name: "等你确定" });

describe("右栏：照 Claude desktop 的样子", () => {
  it("组标题：13px、前景色（不是灰色小标题）、没有计数；“等你确定”前一个 6px 主色圆点", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30)] });
    for (const [name, group] of [["等你确定", asksGroup()], ["Worker", workerGroup()]] as const) {
      const heading = within(group).getByRole("heading");
      expect(heading).toHaveTextContent(new RegExp(`^${name}$`));
      expect(heading).toHaveClass("text-[13px]", "text-foreground");
      expect(heading.className).not.toMatch(/muted-foreground/);
    }
    expect(asksGroup().querySelector("h2 > span.bg-primary")).toHaveClass("size-1.5", "rounded-full");
    expect(workerGroup().querySelector("h2 > span.bg-primary")).toBeNull();
  });

  it("组和组之间一条 1px 细分隔线（border-border），上下留白一样；没有框、没有阴影", () => {
    renderRail({ asks: [ask(1)], workers: [busy(30)] });
    const sections = [asksGroup(), workerGroup()];
    expect(sections[0]!.parentElement).toHaveClass("divide-y", "divide-border");
    for (const section of sections) expect(section).toHaveClass("py-3");
    expect(screen.getByRole("complementary", { name: "右栏" }).innerHTML).not.toMatch(/shadow|bg-sidebar(?!-)/);
  });

  it("Worker 行：16px 线条图标 + 14px 标题 + 右边英文状态词；一行 32px 的紧凑行（icon 在最左）", () => {
    renderRail({ workers: [busy(30)] });
    const row = within(workerGroup()).getByRole("button", { name: /活 30/ });
    expect(row).toHaveClass("px-2", "-mx-2", "gap-3", "rounded-xl");
    expect(row.className).not.toMatch(/rounded-2xl|py-2(\s|$)/);
    const icon = row.querySelector("svg")!;
    expect(icon).toHaveClass("size-4");
    expect(row.firstElementChild!.contains(icon)).toBe(true);
    expect(within(row).getByText("活 30")).toHaveClass("text-[14px]", "truncate");
    expect(within(row).getByText("Working…")).toHaveClass("text-[13px]", "text-primary");
  });

  it("状态用颜色：图标右下角一个小色点；在忙主色，Idle 灰，Ended 没有；图标本身一直是中性灰", () => {
    renderRail({ workers: [busy(30), worker(31), done(32)], openWorkerId: null });
    const dot = (name: RegExp) => within(screen.getByRole("button", { name })).queryByTestId("status-dot");
    expect(dot(/活 30/)).toHaveClass("bg-primary", "size-1.5", "rounded-full");
    expect(dot(/活 31/)).toHaveClass("bg-muted-foreground/50");
    expect(dot(/活 30/)!.parentElement!.querySelector("svg")).toHaveClass("text-muted-foreground");
    // 收工的在“已收工”里，没展开时看不到
    expect(screen.queryByRole("button", { name: /活 32/ })).toBeNull();
  });

  it("没有厂商、模型信息时第二行只有一个“—”；有就是模型、思考程度、token（小一号灰字，之间用间距）", () => {
    renderRail({ workers: [worker(30), worker(31, { vendor: "claude", model: "sonnet", effort: "high", usage: { input: 1, cacheRead: 2_000_000, cacheWrite: 0, output: 0, context: 0 } })] });
    const meta = (name: RegExp) => within(screen.getByRole("button", { name })).getByTestId("worker-meta");
    expect(meta(/活 30/)).toHaveTextContent(/^—$/);
    expect([...meta(/活 31/).children].map((c) => c.textContent)).toEqual(["Sonnet", "high", "2M tokens"]);
    expect(meta(/活 31/)).toHaveClass("text-xs", "text-muted-foreground", "gap-3");
    expect(meta(/活 31/)).not.toHaveTextContent("·");
  });
});

describe("右栏：只列几条", () => {
  it("每组最多 3 条（常量 RIGHT_RAIL_VISIBLE_ROWS）", () => {
    expect(RIGHT_RAIL_VISIBLE_ROWS).toBe(3);
  });

  it("Worker 不到 4 个：全列，没有 Show more", () => {
    renderRail({ workers: [busy(30), worker(31), worker(32)] });
    expect(within(workerGroup()).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("Worker 多了：在忙的排前面，只显示前 3 条，下面一行灰色 Show more；点开展开全部，再点收回（Show less）", async () => {
    const user = userEvent.setup();
    renderRail({ workers: [worker(1), worker(2), busy(3), worker(4), busy(5)] });
    const names = () => within(workerGroup()).getAllByRole("button").map((b) => b.textContent).filter((t) => /活/.test(t!)).map((t) => /活 \d/.exec(t!)![0]);
    expect(names()).toEqual(["活 3", "活 5", "活 1"]);
    const more = screen.getByRole("button", { name: "Show more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveClass("text-[13px]", "text-muted-foreground", "hover:text-foreground");
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
    const rows = () => within(asksGroup()).getAllByRole("button").filter((b) => /问题/.test(b.textContent!));
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
    expect(ended).toHaveClass("text-[13px]", "text-muted-foreground", "hover:text-foreground");
    expect(ended.className).not.toMatch(/(^|\s)(bg-|border|rounded-full)/);
    expect(within(ended).getByText("30")).toHaveClass("tabular-nums");
    expect(within(workerGroup()).getAllByRole("button")).toHaveLength(2);
    await user.click(ended);
    expect(within(workerGroup()).getAllByRole("button")).toHaveLength(32);
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
    expect(within(row).getByText("问题 1")).toHaveClass("text-[14px]", "truncate");
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
  });
});
