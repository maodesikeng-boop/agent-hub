// agent 在做什么（英文状态词）显示在这一轮最下面那一行；停止并进输入框的发送键。
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../shared/index.ts";
import { AgentStatus, hasAgentStatus } from "./components/AgentStatus.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import type { MessageActions } from "./components/Messages.tsx";
import { makeMessage, makeSession, makeToolMessage, makeUserMessage, makeWorkerLine } from "./test-utils.ts";
import type { PendingMessage } from "./state.ts";
import type { StagedFiles } from "./upload.ts";
import type { StopControl } from "./useStop.ts";

const working = (over: Partial<SessionState> = {}) => makeSession({ status: "running", activity: "working", ...over });

describe("AgentStatus：消息流里的状态", () => {
  const text = (session: SessionState | null) => {
    const { container } = render(<AgentStatus session={session} />);
    return container.textContent;
  };

  it("空闲、没有会话：不显示", () => {
    expect(text(makeSession())).toBe("");
    expect(text(null)).toBe("");
    expect(hasAgentStatus(makeSession())).toBe(false);
    expect(hasAgentStatus(null)).toBe(false);
  });

  it("干活：按 step 显示，后面带省略号（装饰，读屏不读），整句流光", () => {
    const { container } = render(<AgentStatus session={working({ step: { type: "thinking" } })} />);
    const status = screen.getByRole("status", { name: "状态" });
    expect(status).toHaveTextContent("Thinking...");
    const dots = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(dots).toHaveTextContent("...");
    expect(status).toHaveClass("status-shimmer");
  });

  it("没有 step（老服务端、刚开始）：Working", () => {
    expect(text(working())).toBe("Working...");
    expect(text(working({ step: null }))).toBe("Working...");
  });

  it("正在停止、准备中（Worker 在跑准备命令）", () => {
    expect(text(makeSession({ activity: "stopping", step: { type: "thinking" } }))).toBe("Stopping...");
    expect(text(makeSession({ activity: "preparing" }))).toBe("Running setup...");
  });

  it("Worker 一轮结束了、还在等它放到后台的命令跑完：有状态（会话不算空闲），写在等后台命令", () => {
    const session = makeSession({ activity: "background", step: null });
    expect(hasAgentStatus(session)).toBe(true);
    expect(text(session)).toBe("Waiting for background command...");
  });

  it("网络出错在重试：第几次 / 共几次，比 step 优先；正在停止比重试优先", () => {
    const apiRetry = { attempt: 2, maxRetries: 10, retryAt: null, errorStatus: null, error: "unknown" };
    expect(text(working({ step: { type: "thinking" }, apiRetry }))).toContain("Retrying 2/10");
    expect(text(working({ activity: "stopping", apiRetry }))).toContain("Stopping");
  });

  it("等额度：额度用完（rejected）时写恢复时间；空闲也显示；比别的都优先；没有时间点只写“等额度”", () => {
    const rejected = { status: "rejected", resetsAt: 1_900_000_000, windows: {} };
    expect(text(makeSession({ rateLimit: rejected }))).toMatch(/^Usage limit reached, resets .+$/);
    expect(text(working({ step: { type: "thinking" }, rateLimit: rejected }))).toMatch(/^Usage limit reached/);
    expect(text(makeSession({ rateLimit: { ...rejected, resetsAt: null } }))).toBe("Usage limit reached");
    expect(screen.getAllByRole("status", { name: "状态" }).at(-1)).not.toHaveClass("status-shimmer");
    expect(hasAgentStatus(makeSession({ rateLimit: { status: "allowed_warning", resetsAt: null, windows: {} } }))).toBe(false);
  });
});

const actions: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() };
const pm = { name: "项目经理", avatarKey: 1 };
const status = <AgentStatus session={working({ step: { type: "text" } })} />;

function list(messages: ReturnType<typeof makeMessage>[], over: { pending?: PendingMessage[]; status?: React.ReactNode } = {}) {
  return render(
    <MessageList
      messages={messages}
      pending={over.pending ?? []}
      agentOf={() => pm}
      hasMore={false}
      older={undefined}
      onLoadOlder={() => {}}
      onRetry={() => {}}
      actions={actions}
      status={"status" in over ? over.status : status}
      statusAgent={pm}
    />,
  );
}

const heads = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-slot='agent-head']")) as HTMLElement[];
const statusLine = () => screen.getByRole("status", { name: "状态" }).closest("[data-work-line]") as HTMLElement;

describe("MessageList：状态在这一轮最下面", () => {
  it("这一轮还没出回复（最后一条是用户的消息）：底部先出一轮“头像 名字”，下面一行状态", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事", status: "processing" })]);
    const [head] = heads(container);
    expect(head).toHaveTextContent(/^项目经理$/);
    expect(statusLine()).toHaveTextContent("Writing...");
    expect(head!.closest("[data-turn]")).toHaveAttribute("data-running", "true");
    // 在用户消息后面
    const user = container.querySelector("article[data-side='right']") as HTMLElement;
    expect(user.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("用户消息还在发（待发的）：也在底部出这一轮", () => {
    const pending: PendingMessage = { clientId: "c", text: "hi", attachments: [], phase: "sending", failure: null } as unknown as PendingMessage;
    const { container } = list([makeMessage({ id: 1, text: "旧回复" })], { pending: [pending] });
    expect(heads(container)).toHaveLength(2);
    expect(statusLine().closest("[data-turn]")).toBe(heads(container)[1]!.closest("[data-turn]"));
  });

  it("回复出来后：状态在这一轮最下面，不再单独出一轮", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事" }), makeMessage({ id: 2, text: "好的" })]);
    expect(heads(container)).toHaveLength(1);
    expect(statusLine().closest("[data-turn]")).toHaveTextContent("好的");
    expect(screen.getByText("好的").compareDocumentPosition(statusLine()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("一串操作和回复：一个头像，状态那一行能点开看操作", () => {
    const { container } = list([
      makeUserMessage({ id: 1, text: "做点事" }),
      makeToolMessage({ id: 2 }),
      makeMessage({ id: 3, text: "第二段回复" }),
      makeToolMessage({ id: 4 }),
    ]);
    expect(heads(container)).toHaveLength(1);
    expect(statusLine()).toHaveTextContent("Writing...");
    expect(within(statusLine()).getByRole("button")).toBeInTheDocument();
  });

  it("上一轮的回复后面又有用户消息：状态只在新这一轮", () => {
    const { container } = list([
      makeMessage({ id: 1, text: "上一轮回复" }),
      makeUserMessage({ id: 2, text: "再来" }),
      makeToolMessage({ id: 3 }),
      makeMessage({ id: 4, text: "这一轮回复" }),
    ]);
    const all = heads(container);
    expect(all).toHaveLength(2);
    expect(all[0]!.closest("[data-turn]")).not.toHaveAttribute("data-running");
    expect(all[1]!.closest("[data-turn]")).toHaveAttribute("data-running", "true");
  });

  it("这一轮结束（没有状态）：状态没了，只有一个头像", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事" }), makeToolMessage({ id: 2 }), makeMessage({ id: 3, text: "好了" })], { status: null });
    expect(heads(container)).toHaveLength(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("最后一条是 Worker 的汇报、你对 Worker 说的话：状态在底部新的一轮", () => {
    const { container } = list([makeMessage({ id: 1, text: "旧回复" }), makeWorkerLine({ id: 2, conversationId: 1, line: { event: "report", status: "done", summary: "好了" } })]);
    expect(statusLine().closest("[data-turn]")).not.toHaveTextContent("旧回复");
    expect(heads(container).at(-1)).toHaveTextContent(/^项目经理$/);
  });

  it("状态文字是 13.5px 次要色", () => {
    list([makeUserMessage({ id: 1, text: "做点事" })]);
    expect(statusLine()).toHaveClass("text-minor", "text-muted-foreground");
  });
});

const staging = (over: Partial<StagedFiles> = {}): StagedFiles => ({
  files: [],
  busy: false,
  notice: null,
  add: vi.fn(),
  remove: vi.fn(),
  removeSent: vi.fn(),
  dismissNotice: vi.fn(),
  track: vi.fn(),
  ...over,
});
const stopControl = (over: Partial<StopControl> = {}): StopControl => ({ busy: true, stopping: false, failed: false, onStop: vi.fn(), ...over });
const composer = (value: string, stop: StopControl | undefined, over: Partial<StagedFiles> = {}, onSend = vi.fn()) =>
  render(<Composer value={value} placeholder="发消息" staging={staging(over)} stop={stop} onChange={() => {}} onSend={onSend} />);

describe("Composer：发送键和停止键", () => {
  it("忙 + 输入框是空的：发送键换成“停止”，同一个位置、同样大小；点它调停止", async () => {
    const stop = stopControl();
    composer("", stop);
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "停止" });
    expect(button).toBeEnabled();
    expect(button).toHaveClass("size-9", "rounded-[var(--radius-btn)]");
    expect(button.parentElement).toHaveClass("ml-auto");
    expect(button.querySelector("svg")).toHaveClass("fill-current");
    await userEvent.click(button);
    expect(stop.onStop).toHaveBeenCalledTimes(1);
  });

  it("停止键和发送键的外观一样（只是图标不同）", () => {
    const { unmount } = composer("", undefined);
    const sendClass = screen.getByRole("button", { name: "发送" }).className;
    unmount();
    composer("", stopControl());
    expect(screen.getByRole("button", { name: "停止" }).className).toBe(sendClass);
  });

  it("忙 + 有字：变回“发送”，发出去照常排队", async () => {
    const onSend = vi.fn();
    composer("再补一句", stopControl(), {}, onSend);
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("再补一句", []);
  });

  it("忙 + 只有空白：还是“停止”", () => {
    composer("   \n ", stopControl());
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  it("忙 + 有待发文件（没有字）：发送", () => {
    composer("", stopControl(), { files: [{ key: "a", file: new File(["x"], "a.txt") }] });
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("空闲：发送（输入框空着时不可点）", () => {
    composer("", stopControl({ busy: false }));
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("没传 stop（不管停止的页面）：永远是发送", () => {
    composer("", undefined);
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("正在停止：停止键不可点", () => {
    composer("", stopControl({ stopping: true }));
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
  });

  it("停止失败：显示“停止失败”，键恢复可点；有内容时（发送）不显示", () => {
    const { unmount } = composer("", stopControl({ failed: true }));
    expect(screen.getByText("停止失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
    unmount();
    composer("字", stopControl({ failed: true }));
    expect(screen.queryByText("停止失败")).not.toBeInTheDocument();
  });

  it("忙 + 空输入时按回车不发送也不停止", async () => {
    const onSend = vi.fn();
    const stop = stopControl();
    composer("", stop, {}, onSend);
    await userEvent.type(screen.getByRole("textbox", { name: "输入消息" }), "{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(stop.onStop).not.toHaveBeenCalled();
  });
});
