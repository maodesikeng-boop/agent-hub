import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as shared from "../../shared/index.ts";
import { App } from "../App.tsx";
import * as composerSuggest from "../composer-suggest.ts";
import * as stepLabels from "../step-labels.ts";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSession,
  makeSnapshot,
  makeToolMessage,
  makeUserMessage,
  makeWorkerConversation,
  messageChange,
  sessionChange,
} from "../test-utils.ts";
import { NOTICE_AUTO_HIDE_MS, type StagedFiles } from "../upload.ts";
import { Composer } from "./Composer.tsx";
import * as messagesModule from "./Messages.tsx";

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

const setup = (over: Partial<StagedFiles> = {}) =>
  render(<Composer value="第一行\n第二行" placeholder="发消息" staging={staging(over)} onChange={() => {}} onSend={() => {}} />);

describe("Composer 布局", () => {
  it("回形针和发送键同尺寸、同圆角；回形针是不带底色的 ghost 图标按钮（悬停才有浅底）", () => {
    setup();
    const attach = screen.getByRole("button", { name: "添加文件" });
    const send = screen.getByRole("button", { name: "发送" });
    expect(attach).toHaveClass("text-muted-foreground", "hover:bg-accent");
    expect(attach.className).not.toMatch(/(^|\s)bg-/);
    for (const cls of ["size-9", "rounded-[var(--radius-btn)]"]) {
      expect(attach).toHaveClass(cls);
      expect(send).toHaveClass(cls);
    }
  });

  it("文字区占满整行，按钮行在它下面，回形针在左、发送在右", () => {
    setup();
    const box = screen.getByRole("textbox", { name: "输入消息" });
    expect(box).toHaveClass("w-full");
    const row = screen.getByRole("button", { name: "添加文件" }).parentElement as HTMLElement;
    expect(row).not.toContainElement(box);
    expect(box.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const attach = screen.getByRole("button", { name: "添加文件" });
    const send = screen.getByRole("button", { name: "发送" });
    expect(attach.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(send.parentElement).toHaveClass("ml-auto");
  });

  it("待发文件列表在文字上方，和文字同样的左边距", () => {
    setup({ files: [{ key: "a", file: new File(["x"], "a.txt") }] });
    const list = screen.getByRole("list", { name: "待发送的文件" });
    const box = screen.getByRole("textbox", { name: "输入消息" });
    expect(list.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list).toHaveClass("px-5");
    expect(box).toHaveClass("px-5");
  });

  it("获得焦点时外框不变（边框颜色、粗细都不变，也不带粉色），靠光标表示", () => {
    const { container } = setup();
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).not.toMatch(/(focus|primary|ring)/);
    expect(screen.getByRole("textbox", { name: "输入消息" }).className).not.toMatch(/(primary|ring)/);
  });

  it("发送中：文字框只读，两个按钮都锁住", () => {
    setup({ busy: true });
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "添加文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("继续往后打字时不把 height 先重置成 auto（避免多行时每次按键触发整页同步回流），删字或清空时才重置", () => {
    const { rerender } = render(<Composer value="第一行" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    const box = screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
    box.style.height = "80px";
    Object.defineProperty(box, "scrollHeight", {
      configurable: true,
      get: () => (box.style.height === "auto" ? 36 : 80),
    });
    rerender(<Composer value="第一行继续打字" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    expect(box.style.height).toBe("80px");
    rerender(<Composer value="第一" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    expect(box.style.height).toBe("36px");
  });

  it("文字框关闭系统自动拼写检查、自动纠错与自动大写（防 macOS AppleSpell 同步扫描卡顿）", () => {
    setup();
    const box = screen.getByRole("textbox", { name: "输入消息" });
    expect(box).toHaveAttribute("spellcheck", "false");
    expect(box).toHaveAttribute("autocorrect", "off");
    expect(box).toHaveAttribute("autocapitalize", "off");
  });

  it("在 App 输入框打字以及后台 Worker 持续推事件时，不重渲染当前对话的 MessageList / TurnView / MessageBubble / Markdown", async () => {
    const user = userEvent.setup();
    const snap = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" })],
      conversations: [
        makeConvSnapshot(
          [
            makeUserMessage({ id: 1, text: "你好", status: "replied", createdAt: 1_000 }),
            makeToolMessage({ id: 2, text: "Read App.tsx", createdAt: 3_000 }),
            makeMessage({ id: 3, text: "**加粗回复** `code`", createdAt: 6_000 }),
          ],
          { conversation: { id: 1, pmId: 1, title: "小林" } },
        ),
        makeConvSnapshot([], { conversation: makeWorkerConversation({ id: 30, pmId: 1 }) }),
      ],
      sessions: [
        makeSession({ sessionId: 1, conversationId: 1, pmId: 1, activity: "idle" }),
        makeSession({ sessionId: 2, conversationId: 30, activity: "working" }),
      ],
    });
    const api = new FakeApi(snap);
    api.install();
    installFakeWebSocket();
    const { unmount } = render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.last.open());
    await screen.findByText("加粗回复");

    const parseSpy = vi.spyOn(shared, "linkNodesOf");
    const workedForSpy = vi.spyOn(stepLabels, "workedFor");
    const displayTextSpy = vi.spyOn(messagesModule, "displayText");
    const attachmentsSpy = vi.spyOn(shared, "attachmentsOf");

    const box = screen.getByRole("textbox", { name: "输入消息" });
    await user.type(box, "正在输入一段长文字测试延迟");
    expect(parseSpy).not.toHaveBeenCalled();
    expect(workedForSpy).not.toHaveBeenCalled();
    expect(displayTextSpy).not.toHaveBeenCalled();
    expect(attachmentsSpy).not.toHaveBeenCalled();

    // 后台 Worker 推送会话状态与消息变化，不应触发当前打开的 PM 对话重渲染 MessageList / TurnView / MessageBubble / DraftComposer
    const suggestSpy = vi.spyOn(composerSuggest, "useComposerSuggest");
    act(() => {
      FakeWebSocket.last.push(sessionChange(10, makeSession({ sessionId: 2, conversationId: 30, activity: "working", step: { type: "thinking" } })));
      FakeWebSocket.last.push(messageChange(11, "message.created", makeMessage({ id: 100, conversationId: 30, text: "worker step" })));
    });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(workedForSpy).not.toHaveBeenCalled();
    expect(displayTextSpy).not.toHaveBeenCalled();
    expect(attachmentsSpy).not.toHaveBeenCalled();
    expect(suggestSpy).not.toHaveBeenCalled();

    suggestSpy.mockRestore();
    attachmentsSpy.mockRestore();
    displayTextSpy.mockRestore();
    workedForSpy.mockRestore();
    parseSpy.mockRestore();
    unmount();
    vi.unstubAllGlobals();
  });
});

describe("Composer 提示条", () => {
  it("加文件被拒（skipped）：浅灰底内联提示条，点 × 或打字立刻关闭，4 秒后自动消失", () => {
    vi.useFakeTimers();
    try {
      const dismissNotice = vi.fn();
      setup({ notice: { message: "「空.txt」是空文件，没有加入", kind: "skipped" }, dismissNotice });
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("bg-sidebar", "rounded-xl", "text-muted-foreground");
      expect(alert).toHaveTextContent("「空.txt」是空文件，没有加入");

      screen.getByRole("button", { name: "关闭提示" }).click();
      expect(dismissNotice).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByRole("textbox", { name: "输入消息" }), { target: { value: "新内容" } });
      expect(dismissNotice).toHaveBeenCalledTimes(2);

      act(() => vi.advanceTimersByTime(NOTICE_AUTO_HIDE_MS - 1));
      expect(dismissNotice).toHaveBeenCalledTimes(2);
      act(() => vi.advanceTimersByTime(1));
      expect(dismissNotice).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("发送失败（failed）：正文前景色、红色图标，4 秒后不自动消失", () => {
    vi.useFakeTimers();
    try {
      const dismissNotice = vi.fn();
      setup({ notice: { message: "上传失败", kind: "failed" }, dismissNotice });
      const alert = screen.getByRole("alert");
      expect(alert.querySelector(".text-danger")).not.toBeNull();
      expect(screen.getByText("上传失败")).toHaveClass("text-foreground");

      act(() => vi.advanceTimersByTime(NOTICE_AUTO_HIDE_MS * 2));
      expect(dismissNotice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

