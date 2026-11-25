// 消息流：一轮回复一个头像、操作合成一行 Worked for、Worker 的发言、系统行、消息状态、复制、空对话、老数据。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../shared/index.ts";
import { AgentStatus } from "./components/AgentStatus.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { displayText, type AgentIdentity, type MessageActions } from "./components/Messages.tsx";
import type { PendingMessage } from "./state.ts";
import { makeMessage, makeSession, makeSystemMessage, makeToolMessage, makeUserMessage, makeWorkerLine } from "./test-utils.ts";
import { jellyColorOf, slimePaths } from "../shared/slimes.ts";

import { defaultLookOf } from "../shared/slimes.ts";
const ORANGE = jellyColorOf("orange");

const pm: AgentIdentity = { name: "小林", look: defaultLookOf(1) };
const actions = (over: Partial<MessageActions> = {}): MessageActions => ({
  retry: {},
  onOpenWorker: () => {},
  onRetryMessage: () => {},
  onRevertPersona: () => Promise.resolve(),
  ...over,
});
const running = (step: Parameters<typeof makeSession>[0] = {}) => (
  <AgentStatus session={makeSession({ status: "running", activity: "working", step: { type: "tool_use", name: "Bash", input: {} }, ...step })} />
);

function list(
  messages: Message[],
  over: { status?: React.ReactNode; pending?: PendingMessage[]; actions?: MessageActions; agentOf?: (m: Message) => AgentIdentity; hasMore?: boolean } = {},
) {
  return render(
    <MessageList
      messages={messages}
      pending={over.pending ?? []}
      agentOf={over.agentOf ?? (() => pm)}
      hasMore={over.hasMore ?? false}
      older={undefined}
      onLoadOlder={() => {}}
      onRetry={() => {}}
      actions={over.actions ?? actions()}
      status={over.status ?? null}
      statusAgent={pm}
    />,
  );
}

const heads = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-slot='agent-head']")) as HTMLElement[];
const workLines = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-work-line]")) as HTMLElement[];

/** 一轮：工具、派出 Worker、文字、工具、建定时任务、文字。消息时间 = 10s + 编号 × 1s。 */
const turn = (): Message[] => [
  makeUserMessage({ id: 1, text: "派两个 Worker" }),
  makeToolMessage({ id: 2, text: "Bash: hub worker start" }),
  makeWorkerLine({ id: 3, line: { event: "started", title: "修登录页" } }),
  makeMessage({ id: 4, text: "先派了一个。" }),
  makeToolMessage({ id: 5, text: "Bash: hub schedule add" }),
  makeSystemMessage({ id: 6, text: "已建定时任务：每天 09:00，日报", event: { event: "schedule.created", scheduleId: 1, name: "日报" } }),
  makeMessage({ id: 7, text: "**派好了**\n\n- 修登录页" }),
];

describe("一轮回复只出一次头像", () => {
  it("夹着工具调用、Worker 行、建定时任务、文字：一个头像，操作合成一行 Worked for，文字照常显示", () => {
    const { container } = list(turn());
    expect(heads(container)).toHaveLength(1);
    expect(container.querySelectorAll("[data-slot='avatar']")).toHaveLength(1);
    const lines = workLines(container);
    expect(lines).toHaveLength(1);
    // 用户消息 11s，最后一条 17s
    expect(lines[0]).toHaveTextContent("Worked for 6s");
    expect(container).toHaveTextContent("先派了一个。");
    expect(container).toHaveTextContent("派好了");
    // 操作、派出 Worker、建定时任务默认看不见，也没有“执行了 N 个操作”
    expect(container).not.toHaveTextContent("hub worker start");
    expect(container).not.toHaveTextContent("已派出");
    expect(container).not.toHaveTextContent("已建定时任务");
    expect(container).not.toHaveTextContent("执行了");
    // Worked for 在名字下面、文字上面
    expect(heads(container)[0]!.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lines[0]!.compareDocumentPosition(screen.getByText("先派了一个。")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("点开 Worked for 看明细：工具原样、派出的 Worker 可点开它的对话、建的定时任务", async () => {
    const onOpenWorker = vi.fn();
    const { container } = list(turn(), { actions: actions({ onOpenWorker }) });
    await userEvent.click(within(workLines(container)[0]!).getByRole("button", { name: /Worked for/ }));
    expect(container).toHaveTextContent("Bash: hub worker start");
    expect(container).toHaveTextContent("Bash: hub schedule add");
    expect(container).toHaveTextContent("已建定时任务：每天 09:00，日报");
    await userEvent.click(screen.getByRole("button", { name: "修登录页 Started" }));
    expect(onOpenWorker).toHaveBeenCalledWith(30);
  });

  it("头像旁只有名字，不带状态、不用“·”", () => {
    const { container } = list(turn(), { status: running() });
    expect(heads(container)[0]!.textContent).toBe("小林");
    expect(container.textContent).not.toContain("·");
  });

  it("没有操作的一轮：不出 Worked for", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "hi" }), makeMessage({ id: 2, text: "你好" })]);
    expect(workLines(container)).toHaveLength(0);
    expect(heads(container)).toHaveLength(1);
  });

  it("隔着用户消息的两轮：两个头像", () => {
    const { container } = list([...turn(), makeUserMessage({ id: 8, text: "再来" }), makeToolMessage({ id: 9 }), makeMessage({ id: 10, text: "好" })]);
    expect(heads(container)).toHaveLength(2);
    expect(workLines(container)).toHaveLength(2);
  });

  it("一轮中间夹着很淡的系统行（改了性格设定）：不另起头像，系统行在原位置", () => {
    const { container } = list([
      makeUserMessage({ id: 1, text: "改改性格" }),
      makeToolMessage({ id: 2 }),
      makeSystemMessage({ id: 3, text: "项目经理改了性格设定", event: { event: "persona.changed", pmId: 1, personaChangeId: 1, revertOf: null } }),
      makeMessage({ id: 4, text: "改好了" }),
    ]);
    expect(heads(container)).toHaveLength(1);
    const notice = screen.getByText("项目经理改了性格设定").closest("[data-notice]")!;
    expect(notice.compareDocumentPosition(screen.getByText("改好了")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(notice as HTMLElement).getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});

describe("正在跑和跑完", () => {
  it("正在跑：这一轮正文上方一行英文状态，可点开看明细；没有 Worked for、没有复制", async () => {
    const { container } = list(turn(), { status: running() });
    const lines = workLines(container);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveTextContent("Worked for");
    const status = within(lines[0]!).getByRole("status", { name: "Status" });
    expect(status).toHaveTextContent("Running command...");
    // 在名字下面、正文上面（与 Worked for 共用同一个位置）
    expect(heads(container)[0]!.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lines[0]!.compareDocumentPosition(screen.getByText("派好了")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    await userEvent.click(within(lines[0]!).getByRole("button"));
    expect(container).toHaveTextContent("Bash: hub worker start");
  });

  it("这一轮还没出东西（最后是用户消息）：底部出头像 + 名字，下面一行状态", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事", status: "processing" })], { status: running({ step: { type: "thinking" } }) });
    expect(heads(container)).toHaveLength(1);
    const line = workLines(container)[0]!;
    expect(line).toHaveTextContent("Thinking...");
    // 没有操作可看：不是按钮
    expect(within(line).queryByRole("button")).toBeNull();
    const user = container.querySelector("article[data-side='right']")!;
    expect(user.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("最后是 Worker 的汇报：项目经理的新一轮单独出头像和状态", () => {
    const { container } = list([makeMessage({ id: 1, text: "派好了" }), makeWorkerLine({ id: 2, line: { event: "report", status: "done", summary: "改好了" } })], {
      status: running({ step: { type: "text" } }),
    });
    const all = heads(container);
    expect(all.at(-1)).toHaveTextContent("小林");
    expect(workLines(container).at(-1)).toHaveTextContent("Writing...");
  });

  it("跑完：没有状态，Worked for 回到名字下面", () => {
    const { container } = list(turn());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(workLines(container)[0]).toHaveTextContent("Worked for");
  });
});

describe("Worker 线程卡（ThreadCard）", () => {
  const report = (over: Parameters<typeof makeWorkerLine>[0]["line"] = {}) =>
    makeWorkerLine({ id: 5, line: { event: "report", status: "done", summary: "按钮统一成 36px，开了 PR #128", ...over } });

  it("汇报是一行：纸片小灵头像、标题、时间和箭头，状态词和第一行摘要只给读屏，没有常驻边框，整行可点开 Worker 对话", async () => {
    const onOpenWorker = vi.fn();
    const { container } = list([report()], { actions: actions({ onOpenWorker }) });
    const row = container.querySelector("[data-worker-report]") as HTMLElement;
    expect(row).toHaveAttribute("data-side", "left");
    const bubble = within(row).getByRole("button", { name: "修 X, Done, 按钮统一成 36px，开了 PR #128" });
    expect(bubble).toHaveAttribute("data-bubble");
    expect(bubble.querySelector("[data-slot='avatar']")).toHaveAttribute("data-neutral", "true");
    expect(bubble).toHaveTextContent("修 X");
    expect(bubble).not.toHaveTextContent("Done");
    expect(bubble).not.toHaveTextContent("按钮统一成 36px");
    const userBubble = list([makeUserMessage({ id: 1 })]).container.querySelector("[data-bubble]") as HTMLElement;
    expect(bubble).toHaveClass("rounded-sm", "text-minor", "hover:bg-hover");
    expect(bubble).not.toHaveClass("border", "bg-background");
    expect(userBubble.className).not.toMatch(/rounded-(?!sm\b)/);
    expect(row.innerHTML).not.toContain("Piece「");
    await userEvent.click(bubble);
    expect(onOpenWorker).toHaveBeenCalledWith(30);
  });

  it("状态词 Done / Problem / Gave up / Error 和写成人话的失败原因只在读屏名字里，行内只看得到标题", () => {
    const { container } = list([
      report(),
      report({ status: "problem", summary: "缺一个 key" }),
      makeWorkerLine({ id: 6, line: { event: "report", status: "gave_up", summary: "做不了" } }),
      makeWorkerLine({ id: 7, line: { event: "turn_failed", summary: "error_during_execution: API Error: 529 Overloaded" } }),
      makeWorkerLine({ id: 8, line: { event: "turn_failed", summary: "被停止了" } }),
    ]);
    const rows = Array.from(container.querySelectorAll("[data-worker-report]")) as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-tone"))).toEqual(["success", "warn", "danger", "danger", "danger"]);
    const buttons = rows.map((r) => within(r).getByRole("button"));
    for (const [i, label] of ["Done", "Problem", "Gave up", "Error", "Error"].entries()) {
      expect(buttons[i]!).not.toHaveTextContent(label);
    }
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "修 X, Done, 按钮统一成 36px，开了 PR #128",
      "修 X, Problem, 缺一个 key",
      "修 X, Gave up, 做不了",
      "修 X, Error, Claude 服务繁忙，稍后重试",
      "修 X, Error, 被停止了",
    ]);
    expect(rows[3]).not.toHaveTextContent("Claude 服务繁忙");
  });

  it("卡片内部状态方块按 tone 着色（bg-success / bg-caution / bg-danger），无状态时无方块", () => {
    const { container } = list([report({ status: "problem" })]);
    const dot = container.querySelector("[data-dot]") as HTMLElement;
    expect(dot).toHaveAttribute("data-dot", "warn");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot.className).toContain("bg-caution");
    expect(dot.className).toContain("rounded-full");
    expect(dot.closest("[data-bubble]")).not.toBeNull();
    const dots = list([report(), report({ status: "gave_up" }), report({ status: "unformatted" })]).container.querySelectorAll("[data-dot]");
    expect(Array.from(dots).map((d) => d.getAttribute("data-dot"))).toEqual(["success", "danger"]);
  });

  it("没按格式：没有状态点，读屏名字是标题加第一行", () => {
    const { container } = list([report({ status: "unformatted", summary: "我改完了" })]);
    const row = container.querySelector("[data-worker-report]") as HTMLElement;
    expect(row).toHaveAttribute("data-tone", "neutral");
    expect(row.querySelector("[data-dot]")).toBeNull();
    expect(within(row).getByRole("button")).toHaveAccessibleName("修 X, 我改完了");
  });

  it("老数据：meta 里没有 summary、status 也能显示", () => {
    const old = makeWorkerLine({ id: 5, line: { event: "report" } });
    old.meta = { workerId: 3, workerConversationId: 30, title: "修 X", readonly: false, event: "report" };
    const { container } = list([old]);
    expect(container.querySelector("[data-worker-report]")).toHaveTextContent("修 X");
  });

  it("汇报后面项目经理的回复另起一轮（新头像）", () => {
    const { container } = list([makeMessage({ id: 1, text: "派好了" }), report(), makeMessage({ id: 6, text: "收到" })]);
    expect(heads(container)).toHaveLength(2);
    expect(container.querySelectorAll("[data-worker-report]")).toHaveLength(1);
  });

  it("Worker 对话里：项目经理的话是项目经理的水果小动物头像 + 名字，Worker 自己是同一只小动物的纸片分身头像", () => {
    const worker: AgentIdentity = { name: "修 X", look: pm.look, neutral: true };
    const { container } = list([makeMessage({ id: 1, sender: "pm", text: "任务：修 X", status: "replied" }), makeMessage({ id: 2, text: "好的" })], {
      agentOf: (m) => (m.sender === "pm" ? pm : worker),
    });
    const all = heads(container);
    expect(all.map((h) => h.textContent)).toEqual(["小林", "修 X"]);
    expect(all[0]!.querySelector("[data-slot='avatar']")).not.toHaveAttribute("data-neutral");
    expect(all[1]!.querySelector("[data-slot='avatar']")).toHaveAttribute("data-neutral", "true");
    const fillsOf = (el: Element) => [...el.querySelectorAll("[data-slot='avatar'] path")].map((p) => p.getAttribute("fill"));
    expect(fillsOf(all[0]!)).toEqual(slimePaths(pm.look, "main").map((p) => p.fill));
    expect(fillsOf(all[1]!)).toEqual(slimePaths(pm.look, "piece").map((p) => p.fill));
  });

  it("项目经理对话里 Worker 汇报的头像是所属项目经理颜色的便签小灵（而非按 workerId 取）", () => {
    const { container } = list([report()]);
    const row = container.querySelector("[data-worker-report]") as HTMLElement;
    const avatar = row.querySelector("[data-slot='avatar']")!;
    expect(avatar).toHaveAttribute("data-neutral", "true");
    expect([...avatar.querySelectorAll("path")].map((p) => p.getAttribute("fill"))).toContain(ORANGE.roles.light);
  });
});

describe("系统行", () => {
  it("建项目、挂文件夹：结构化活动条靠左展示（带标签，纸色底、4px 圆角、没有框），不居中、没有灰气泡", () => {
    const { container } = list([makeSystemMessage({ id: 1, text: "项目已建好", event: { event: "project.created", projectId: 1 } })]);
    const notice = screen.getByText("项目已建好").closest("[data-notice]") as HTMLElement;
    expect(notice).toHaveAttribute("data-side", "left");
    expect(within(notice).getByText("Project")).toBeInTheDocument();
    expect(notice.parentElement).toHaveClass("rounded-sm", "bg-panel");
    expect(notice.parentElement?.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(notice.className).not.toContain("justify-center");
    expect(container.innerHTML).not.toContain("bg-muted");
  });

  it("连续同族系统事件合并在同一个活动条容器里，不重复画外边框", () => {
    const { container } = list([
      makeSystemMessage({ id: 1, text: "挂上了文件夹：/repo", event: { event: "folder.attached", projectId: 1, folderId: 1, path: "/repo" } }),
      makeSystemMessage({ id: 2, text: "项目经理改了性格设定", event: { event: "persona.changed", pmId: 1, personaChangeId: 1, revertOf: null } }),
    ]);
    const groups = container.querySelectorAll("[data-event-group]");
    expect(groups).toHaveLength(1);
    expect(within(groups[0] as HTMLElement).getByText("Folder")).toBeInTheDocument();
    expect(within(groups[0] as HTMLElement).getByText("Persona")).toBeInTheDocument();
    expect(within(groups[0] as HTMLElement).getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("不在一轮里的派出、收工：很淡的一行，点开 Worker", async () => {
    const onOpenWorker = vi.fn();
    list([makeUserMessage({ id: 1, text: "hi" }), makeWorkerLine({ id: 2, line: { event: "ended" } })], { actions: actions({ onOpenWorker }) });
    await userEvent.click(screen.getByRole("button", { name: "修 X Ended" }));
    expect(onOpenWorker).toHaveBeenCalledWith(30);
  });

  it("你直接对 Worker 说的话：很淡的一行，不另起项目经理的头像", () => {
    const { container } = list([makeWorkerLine({ id: 1, line: { event: "user_message", summary: "顺便改 README" } })]);
    expect(screen.getByRole("button", { name: "修 X You said 顺便改 README" }).closest("[data-notice]")).not.toBeNull();
    expect(heads(container)).toHaveLength(0);
  });

  it("定时任务到点：一行系统样子的标题（没有头像），点开看任务说明；项目经理的回复另起一轮", async () => {
    const { container } = list([
      makeSystemMessage({
        id: 1,
        text: "【定时任务：日报（原定 09:00）】\n汇总昨天合并的 PR",
        status: "replied",
        event: { event: "schedule.run", scheduleId: 1, name: "日报", scheduledAt: 0, catchUp: false },
      }),
      makeMessage({ id: 2, text: "昨日汇报" }),
    ]);
    const run = container.querySelector("[data-event='schedule.run']") as HTMLElement;
    expect(run.querySelector("[data-slot='avatar']")).toBeNull();
    expect(screen.queryByText("汇总昨天合并的 PR")).not.toBeInTheDocument();
    await userEvent.click(within(run).getByRole("button", { name: /定时任务：日报（原定 09:00）/ }));
    expect(screen.getByText("汇总昨天合并的 PR")).toBeInTheDocument();
    expect(heads(container)).toHaveLength(1);
    expect(run.compareDocumentPosition(heads(container)[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("定时任务没跑成、换会话失败：很淡的一行，原因写成人话，meta.rawReason 在 [data-notice] 的 title（老数据回退到 text）", () => {
    list([
      makeSystemMessage({
        id: 1,
        text: "定时任务没跑成：日报：claude_not_found: spawn claude ENOENT",
        event: { event: "schedule.failed", scheduleId: 1, name: "日报", messageId: 9 },
      }),
      makeSystemMessage({
        id: 2,
        text: "定时任务没跑成：巡检：Claude 服务繁忙，稍后重试",
        event: { event: "schedule.failed", scheduleId: 2, name: "巡检", messageId: 10, rawReason: 'API Error: 529 {"type":"overloaded_error"}' },
      }),
      makeSystemMessage({
        id: 3,
        text: "交接没写成，没换会话：Claude 服务繁忙，稍后重试",
        event: { event: "handover.failed", handoverId: 5, attempt: 1, rawReason: 'API Error: 529 {"type":"overloaded_error"}' },
      }),
    ]);
    expect(screen.getByText("定时任务没跑成：日报：claude_not_found: spawn claude ENOENT").closest("[data-notice]")).toHaveAttribute(
      "title",
      "定时任务没跑成：日报：claude_not_found: spawn claude ENOENT",
    );
    expect(screen.getByText('Scheduled task "巡检" failed: Claude 服务繁忙，稍后重试').closest("[data-notice]")).toHaveAttribute(
      "title",
      'API Error: 529 {"type":"overloaded_error"}',
    );
    expect(screen.getByText("交接没写成，没换会话：Claude 服务繁忙，稍后重试").closest("[data-notice]")).toHaveAttribute(
      "title",
      'API Error: 529 {"type":"overloaded_error"}',
    );
  });

  it("一轮结束后的系统行不并进这一轮：排在复制和时间后面", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "hi" }), makeMessage({ id: 2, text: "好" }), makeSystemMessage({ id: 3, text: "挂上了文件夹" })]);
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy.compareDocumentPosition(screen.getByText("挂上了文件夹")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heads(container)).toHaveLength(1);
  });
});

describe("消息状态（照微信）：不写字，只有没发出去左边一个红色感叹号", () => {
  const UNSENT = "Not sent. Click to resend";
  const rightArticles = (container: HTMLElement) => Array.from(container.querySelectorAll("article[data-side='right']")) as HTMLElement[];

  it("排队中、已送达、处理中、已回复、已停止、已取消：气泡下面和旁边都不写字", () => {
    const { container } = list(
      (["queued", "delivered", "processing", "replied", "stopped", "cancelled"] as const).map((status, i) => makeUserMessage({ id: i + 1, text: `第 ${i + 1} 句`, status })),
    );
    for (const article of rightArticles(container)) {
      expect(article.querySelector("[data-unsent]")).toBeNull();
      expect(article.textContent).toMatch(/^第 \d 句$/);
    }
    expect(screen.queryByText(/Queued|已停止|已取消|已回复/)).toBeNull();
  });

  it("已取消的气泡变淡，别的不变淡", () => {
    const { container } = list([makeUserMessage({ id: 1, status: "cancelled" }), makeUserMessage({ id: 2, status: "stopped" }), makeUserMessage({ id: 3, status: "queued" })]);
    const bubbles = Array.from(container.querySelectorAll("[data-bubble]"));
    expect(bubbles[0]).toHaveClass("opacity-60");
    for (const bubble of bubbles.slice(1)) expect(bubble).not.toHaveClass("opacity-60");
  });

  it("失败：气泡左边、垂直居中一个红色感叹号按钮，点了重发；人话和原始错误在 title，不另起一行", () => {
    const raw = "error_during_execution: API Error: 529 Overloaded";
    const onRetryMessage = vi.fn();
    const { container } = render(
      <MessageList messages={[makeUserMessage({ id: 1, text: "查一下", status: "failed", failureReason: raw })]} pending={[]} agentOf={() => pm} hasMore={false} older={undefined} onLoadOlder={() => {}} onRetry={() => {}} actions={actions({ onRetryMessage })} />,
    );
    const [article] = rightArticles(container);
    const mark = within(article!).getByRole("button", { name: UNSENT });
    expect(mark).toHaveAttribute("title", `Not sent: Claude 服务繁忙，稍后重试. Click to resend\n${raw}`);
    expect(article).toHaveTextContent(/^!查一下$/);
    const row = mark.parentElement as HTMLElement;
    expect(row).toHaveClass("flex", "items-center", "justify-end");
    expect(row.firstElementChild).toBe(mark);
    expect(mark.querySelector("span")).toHaveClass("size-5", "bg-danger", "text-white");
    expect(mark.querySelector("span")!.className).not.toMatch(/rounded-/);
    fireEvent.click(mark);
    expect(onRetryMessage).toHaveBeenCalledWith(1);
  });

  it("失败没有原因（老数据）：只有感叹号，title 是“Not sent. Click to resend”", () => {
    const { container } = list([makeUserMessage({ id: 1, status: "failed", failureReason: null })]);
    expect(within(rightArticles(container)[0]!).getByRole("button", { name: UNSENT })).toHaveAttribute("title", UNSENT);
  });
});

describe("Copy", () => {
  it("每一轮回复下面：复制按钮 + 时间；复制拿到的是这一轮文字的 Markdown 原文", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    list(turn());
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy.parentElement).toHaveTextContent(/\d{1,2}[:/]\d{1,2}/);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith("先派了一个。\n\n**派好了**\n\n- 修登录页");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("每一轮各有一个复制", () => {
    list([...turn(), makeUserMessage({ id: 8, text: "再来" }), makeMessage({ id: 9, text: "好" })]);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });
});

describe("老数据、空对话、字号", () => {
  it("工具消息没有 meta、消息没有时间以外的字段：照常显示", async () => {
    const tool = makeToolMessage({ id: 2, text: "Read: a.ts", meta: null });
    const { container } = list([makeUserMessage({ id: 1 }), tool, makeMessage({ id: 3, text: "看完了" })]);
    await userEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    expect(container).toHaveTextContent("Read: a.ts");
  });

  it("没有 step 的会话（老服务端）：状态写 Working", () => {
    const { container } = list([makeUserMessage({ id: 1 })], { status: <AgentStatus session={makeSession({ status: "running", activity: "working" })} /> });
    expect(workLines(container)[0]).toHaveTextContent("Working...");
  });

  it("空对话：120px 的头像、名字和“还没有消息”", () => {
    const { container } = list([]);
    const empty = container.querySelector("[data-empty]") as HTMLElement;
    expect(empty).toHaveTextContent("小林");
    expect(empty).toHaveTextContent("No messages yet");
    expect((empty.querySelector("[data-slot='avatar']") as HTMLElement).style.width).toBe("7.5rem");
  });

  it("消息流里不用 13px（右栏那一档）", () => {
    const { container } = list([...turn(), makeUserMessage({ id: 8, status: "queued" })], { hasMore: true });
    expect(container.innerHTML).not.toMatch(/\btext-small\b/);
  });
});

describe("Worker 回复末尾的汇报块", () => {
  it("显示时去掉 === 汇报 === 标记、每项一行；复制拿到的还是原文", async () => {
    const raw = "改好了\n\n=== 汇报 ===\n状态: 做完了\n摘要: 按钮统一\n=== 汇报结束 ===";
    expect(displayText(raw)).toBe("改好了\n\n---\n\n- 状态: 做完了\n- 摘要: 按钮统一");
    expect(displayText("没有汇报块")).toBe("没有汇报块");
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = list([makeMessage({ id: 1, text: raw })]);
    expect(container).not.toHaveTextContent("=== 汇报");
    expect(container.querySelectorAll(".markdown li")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(raw);
  });
});

describe("送达与执行失败分开显示", () => {
  it("服务端确认送达后执行失败：没有红色未发送标记，仍能重试并查看错误", async () => {
    const onRetryMessage = vi.fn();
    const { container } = list([makeUserMessage({ id: 1, status: "failed", meta: { deliveryConfirmed: true }, failureReason: "error: http2: server sent GOAWAY" })], { actions: actions({ onRetryMessage }) });
    expect(container.querySelector("[data-unsent]")).toBeNull();
    const retry = screen.getByRole("button", { name: "Failed. Retry" });
    expect(retry.title).toContain("GOAWAY");
    await userEvent.click(retry);
    expect(onRetryMessage).toHaveBeenCalledWith(1);
  });
  it("服务端未送达而失败，仍显示红色发送失败标记", () => {
    const { container } = list([makeUserMessage({ id: 1, status: "failed", failureReason: "spawn_failed: rejected" })]);
    expect(container.querySelector("[data-unsent]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Not sent. Click to resend" })).toBeInTheDocument();
  });
});
