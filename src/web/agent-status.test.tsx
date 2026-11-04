// agent 在做什么显示在头像旁；停止并进输入框的发送键。
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../shared/index.ts";
import { AgentStatus, hasAgentStatus } from "./components/AgentStatus.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import type { MessageActions } from "./components/Messages.tsx";
import { makeMessage, makeSession, makeSystemMessage, makeToolMessage, makeUserMessage, makeWorkerLine } from "./test-utils.ts";
import type { PendingMessage } from "./state.ts";
import type { StagedFiles } from "./upload.ts";
import type { StopControl } from "./useStop.ts";

const working = (over: Partial<SessionState> = {}) => makeSession({ status: "running", activity: "working", ...over });

describe("AgentStatus：头像旁的状态", () => {
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

  it("干活：按 step 显示，后面带省略号动效（装饰，读屏不读）", () => {
    const { container } = render(<AgentStatus session={working({ step: { type: "thinking" } })} />);
    const status = screen.getByRole("status", { name: "状态" });
    expect(status).toHaveTextContent("在思考...");
    const dots = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(dots).toHaveTextContent("...");
    expect(dots.querySelectorAll(".animate-pulse, [class*='animate-pulse']")).toHaveLength(3);
  });

  it("没有 step（老服务端、刚开始）：在处理", () => {
    expect(text(working())).toBe("在处理...");
    expect(text(working({ step: null }))).toBe("在处理...");
  });

  it("正在停止、准备中（Worker 在跑准备命令）", () => {
    expect(text(makeSession({ activity: "stopping", step: { type: "thinking" } }))).toBe("正在停止...");
    expect(text(makeSession({ activity: "preparing" }))).toBe("正在跑准备命令...");
  });

  it("网络出错在重试：第几次 / 共几次，比 step 优先；正在停止比重试优先", () => {
    const apiRetry = { attempt: 2, maxRetries: 10, retryAt: null, errorStatus: null, error: "unknown" };
    expect(text(working({ step: { type: "thinking" }, apiRetry }))).toContain("网络出错，正在重试（第 2/10 次）");
    expect(text(working({ activity: "stopping", apiRetry }))).toContain("正在停止");
  });

  it("等额度：额度用完（rejected）时写恢复时间；空闲也显示；比别的都优先；没有时间点只写“等额度”", () => {
    const rejected = { status: "rejected", resetsAt: 1_900_000_000, windows: {} };
    expect(text(makeSession({ rateLimit: rejected }))).toMatch(/^等额度，.+ 恢复$/);
    expect(text(working({ step: { type: "thinking" }, rateLimit: rejected }))).toMatch(/^等额度，/);
    expect(text(makeSession({ rateLimit: { ...rejected, resetsAt: null } }))).toBe("等额度");
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

describe("MessageList：状态跟着最后一条回复的头像行", () => {
  it("这一轮还没出回复（最后一条是用户的消息）：底部先出一行“头像 名字 · 状态”", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事", status: "processing" })]);
    const [head] = heads(container);
    expect(head).toBeDefined();
    expect(head).toHaveTextContent("项目经理·在写回复...");
    expect(head!.parentElement).toHaveAttribute("data-typing");
    // 在用户消息后面
    const user = container.querySelector("article[data-side='right']") as HTMLElement;
    expect(user.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("用户消息还在发（待发的）、空对话：也在底部出这一行", () => {
    const pending: PendingMessage = { clientId: "c", text: "hi", attachments: [], phase: "sending", failure: null } as unknown as PendingMessage;
    expect(heads(list([makeMessage({ id: 1, text: "旧回复" })], { pending: [pending] }).container).at(-1)).toHaveTextContent("在写回复");
  });

  it("回复出来后：状态在这一轮最后一条回复的头像行上，不再单独出一行", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事" }), makeMessage({ id: 2, text: "好的" })]);
    expect(container.querySelector("[data-typing]")).toBeNull();
    const [head] = heads(container);
    expect(head).toHaveTextContent("项目经理·在写回复...");
    expect(head!.closest("article")).toHaveTextContent("好的");
  });

  it("最后一条是一组操作：状态在它的头像行上", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事" }), makeToolMessage({ id: 2 }), makeToolMessage({ id: 3 })]);
    const [head] = heads(container);
    expect(head).toHaveTextContent("在写回复");
    expect(head!.parentElement).toHaveTextContent("执行了 2 个操作");
  });

  it("一串连续回复：状态在这一串第一行的头像行上，后面的回复不再多出同名头像行", () => {
    const { container } = list([
      makeUserMessage({ id: 1, text: "做点事" }),
      makeToolMessage({ id: 2 }),
      makeMessage({ id: 3, text: "第二段回复" }),
      makeToolMessage({ id: 4 }),
    ]);
    const all = heads(container);
    expect(all).toHaveLength(1);
    expect(all[0]).toHaveTextContent("项目经理·在写回复...");
    expect(all[0]!.parentElement).toHaveTextContent("执行了 1 个操作");
    expect(container.querySelectorAll("article[data-head='true'], [data-head='true']")).toHaveLength(1);
  });

  it("上一轮的回复后面又有用户消息：状态只在新这一串的头像行上，上一串的头像行照旧", () => {
    const { container } = list([
      makeMessage({ id: 1, text: "上一轮回复" }),
      makeUserMessage({ id: 2, text: "再来" }),
      makeToolMessage({ id: 3 }),
      makeMessage({ id: 4, text: "这一轮回复" }),
    ]);
    const all = heads(container);
    expect(all).toHaveLength(2);
    expect(all[0]).not.toHaveTextContent("在写回复");
    expect(all[1]).toHaveTextContent("在写回复");
  });

  it("这一轮结束（没有状态）：状态没了，只有第一条回复带头像", () => {
    const { container } = list([makeUserMessage({ id: 1, text: "做点事" }), makeToolMessage({ id: 2 }), makeMessage({ id: 3, text: "好了" })], { status: null });
    expect(heads(container)).toHaveLength(1);
    expect(container.textContent).not.toContain("在写回复");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("最后一条是系统消息、Worker 那一行：状态在底部单独一行（不挂到它们上）", () => {
    const { container } = list([makeMessage({ id: 1, text: "旧回复" }), makeSystemMessage({ id: 2, text: "改了设置" })]);
    expect(heads(container).at(-1)!.parentElement).toHaveAttribute("data-typing");
    const worker = list([makeMessage({ id: 3, text: "旧回复" }), makeWorkerLine({ id: 4, conversationId: 1 })]);
    expect(heads(worker.container).at(-1)!.parentElement).toHaveAttribute("data-typing");
  });

  it("状态文字是小号次要色", () => {
    list([makeUserMessage({ id: 1, text: "做点事" })]);
    const box = screen.getByRole("status", { name: "状态" }).parentElement as HTMLElement;
    expect(box).toHaveClass("text-[13.5px]", "text-muted-foreground");
  });
});

const staging = (over: Partial<StagedFiles> = {}): StagedFiles => ({
  files: [],
  busy: false,
  notice: null,
  add: vi.fn(),
  remove: vi.fn(),
  removeSent: vi.fn(),
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
