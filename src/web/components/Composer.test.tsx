import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// jsdom 没有 canvas：给量文字宽度的 getContext 一个假的（每个字 8px）
const savedGetContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({ font: "", measureText: (t: string) => ({ width: t.length * 8 }) })) as never;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = savedGetContext;
});

describe("Composer 布局", () => {
  it("回形针和发送键同尺寸、同圆角；回形针是不带底色的 ghost 图标按钮（悬停才有浅底）", () => {
    setup();
    const attach = screen.getByRole("button", { name: "Add files" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(attach).toHaveClass("text-muted-foreground", "hover:bg-accent");
    expect(attach.className).not.toMatch(/(^|\s)bg-/);
    for (const cls of ["size-9", "rounded-[var(--radius-btn)]"]) {
      expect(attach).toHaveClass(cls);
      expect(send).toHaveClass(cls);
    }
  });

  it("空输入框是单行：回形针、文字区、发送键在同一个网格行，从左到右排开", () => {
    const { container } = render(<Composer value="" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame).toHaveAttribute("data-multiline", "false");
    const box = screen.getByRole("textbox", { name: "Message" });
    const attach = screen.getByRole("button", { name: "Add files" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(attach.parentElement).toBe(box.parentElement);
    expect(send.parentElement?.parentElement).toBe(box.parentElement);
    for (const el of [attach, box, send.parentElement as HTMLElement]) expect(el).toHaveClass("row-start-1");
    expect(attach).toHaveClass("col-start-1");
    expect(box).toHaveClass("col-start-2");
    expect(send.parentElement).toHaveClass("col-start-3");
    expect(box).toHaveClass("min-h-9"); // 文字区 36px，和按钮同高，整条约 48px
    expect(attach.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("有待发文件时按多行布局：文字区占满一行，回形针在左、发送在右落到下一行；文件小条在文字上方", () => {
    const { container } = setup({ files: [{ key: "a", file: new File(["x"], "a.txt") }] });
    expect(container.firstElementChild).toHaveAttribute("data-multiline", "true");
    const box = screen.getByRole("textbox", { name: "Message" });
    const attach = screen.getByRole("button", { name: "Add files" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(box).toHaveClass("w-full", "col-span-3", "col-start-1", "row-start-1");
    expect(attach).toHaveClass("col-start-1", "row-start-2");
    expect(send.parentElement).toHaveClass("col-start-3", "row-start-2", "justify-self-end");
    const list = screen.getByRole("list", { name: "Files to send" });
    expect(list.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("待发文件列表和文字的左边距一致（文件条 20px，多行时文字区 12px + 外层 8px）", () => {
    setup({ files: [{ key: "a", file: new File(["x"], "a.txt") }] });
    expect(screen.getByRole("list", { name: "Files to send" })).toHaveClass("px-5");
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box).toHaveClass("px-3");
    expect(box.parentElement).toHaveClass("px-2");
  });

  describe("单行 ⇄ 多行切换（按 scrollHeight 判断，jsdom 里用假的排版数据）", () => {
    let style: HTMLStyleElement;
    const proto = HTMLTextAreaElement.prototype;
    beforeEach(() => {
      style = document.createElement("style");
      style.textContent = "textarea { line-height: 24px; padding-top: 6px; padding-bottom: 6px; }";
      document.head.append(style);
      // 一行 36px（24 + 上下内边距）；有换行符或超过 40 个字符就算多行（模拟窄栏里自动换行）
      Object.defineProperty(proto, "scrollHeight", {
        configurable: true,
        get(this: HTMLTextAreaElement) {
          const text = this.value;
          return text.includes("\n") ? 60 : text.length > 40 ? 60 : 36;
        },
      });
      Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 600 });
    });
    afterEach(() => {
      style.remove();
      delete (proto as { scrollHeight?: number }).scrollHeight;
      delete (proto as { clientWidth?: number }).clientWidth;
    });
    const view = (value: string) => <Composer value={value} placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />;

    it("一行字仍是单行；有换行符或自动换行变多行，文字区占满一行、回形针和发送键落到下一行", () => {
      const { container, rerender } = render(view("一行字"));
      const frame = container.firstElementChild as HTMLElement;
      const box = screen.getByRole("textbox", { name: "Message" });
      expect(frame).toHaveAttribute("data-multiline", "false");
      rerender(view("第一行\n第二行"));
      expect(frame).toHaveAttribute("data-multiline", "true");
      expect(box).toHaveClass("col-span-3", "row-start-1");
      expect(screen.getByRole("button", { name: "Add files" })).toHaveClass("row-start-2");
      expect(screen.getByRole("button", { name: "Send" }).parentElement).toHaveClass("row-start-2");
      rerender(view("一".repeat(45)));
      expect(frame).toHaveAttribute("data-multiline", "true");
    });

    it("切换时是同一个文字区节点（不重建，光标和焦点不丢）", () => {
      const { rerender } = render(view("一行字"));
      const box = screen.getByRole("textbox", { name: "Message" });
      box.focus();
      rerender(view("第一行\n第二行"));
      expect(screen.getByRole("textbox", { name: "Message" })).toBe(box);
      expect(box).toHaveFocus();
    });

    it("多行删回一行、放得进回形针和发送键中间时退回单行；清空也回单行", () => {
      const { container, rerender } = render(view("第一行\n第二行"));
      const frame = container.firstElementChild as HTMLElement;
      expect(frame).toHaveAttribute("data-multiline", "true");
      rerender(view("短"));
      expect(frame).toHaveAttribute("data-multiline", "false");
      rerender(view("第一行\n第二行"));
      expect(frame).toHaveAttribute("data-multiline", "true");
      rerender(view(""));
      expect(frame).toHaveAttribute("data-multiline", "false");
    });

    it("宽度够一行、但放不进回形针和发送键中间的文字，留在多行（不来回切）", () => {
      const { container, rerender } = render(view("第一行\n第二行"));
      Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 100 });
      rerender(view("一".repeat(30))); // 30 × 8 = 240 > 100
      expect(container.firstElementChild).toHaveAttribute("data-multiline", "true");
    });

    it("切换布局时先把 height 重置成 auto 再量，不沿用旧布局的高度", () => {
      const { rerender } = render(view("一行字"));
      const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      rerender(view("第一行\n第二行"));
      expect(box.style.height).toBe("60px");
      rerender(view("短"));
      expect(box.style.height).toBe("36px");
    });
  });

  it("停止键和发送键在同一个位置、同样大小（单行和多行都在按钮组里）", () => {
    const stop = { busy: true, stopping: false, failed: false, onStop: vi.fn() };
    for (const files of [[], [{ key: "a", file: new File(["x"], "a.txt") }]]) {
      const { unmount } = render(
        <Composer value="" placeholder="发消息" staging={staging({ files: [...files] })} stop={stop as never} onChange={() => {}} onSend={() => {}} />,
      );
      const btn = screen.queryByRole("button", { name: "Stop" });
      if (files.length === 0) {
        expect(btn).toHaveClass("size-9", "rounded-[var(--radius-btn)]");
        expect(btn?.parentElement).toHaveClass("col-start-3", "row-start-1");
      } else {
        expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument(); // 有待发文件：不是停止
      }
      unmount();
    }
  });

  it("聚焦态写在 styles.css 的 .composer-frame（只多一团水果色模糊光晕，边框不变，不套圈）：外框不带 ring / 实心描边类，边框粗细不变，文字框自身无 focus ring，不用内联 <style>", () => {
    const { container } = setup();
    const frame = container.firstElementChild as HTMLElement;
    expect(frame).toHaveClass("composer-frame", "border", "border-border");
    expect(frame.className).not.toMatch(/border-primary|border-2|ring|focus-within:|0_0_0_3px/);
    expect(screen.getByRole("textbox", { name: "Message" }).className).not.toMatch(/ring/);
    expect(container.querySelector("style")).toBeNull();
  });

  it("发送键状态：空输入且无附件时不可点（中性灰），有内容时变为强调色且可点，空变有内容时触发轻微回弹动效类", () => {
    const { rerender } = render(<Composer value="" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send.className).not.toContain("composer-send-bounce");

    // 从空变有内容：可点，并带回弹动效类
    rerender(<Composer value="新输入" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    expect(send).toBeEnabled();
    expect(send.className).toContain("composer-send-bounce");

    // 继续打字：可点，保持已触发状态，不重新抖动
    rerender(<Composer value="新输入继续打字" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    expect(send).toBeEnabled();

    // 清空：恢复不可点，移除动效类
    rerender(<Composer value="" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={() => {}} />);
    expect(send).toBeDisabled();
    expect(send.className).not.toContain("composer-send-bounce");

    // 仅添加待发文件也是有内容：发送键可点
    rerender(
      <Composer
        value=""
        placeholder="发消息"
        staging={staging({ files: [{ key: "f1", file: new File(["x"], "f.txt") }] })}
        onChange={() => {}}
        onSend={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("发送中：文字框只读，两个按钮都锁住", () => {
    setup({ busy: true });
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Add files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("继续往后打字时不把 height 先重置成 auto（避免多行时每次按键触发整页同步回流），删字或清空时才重置", () => {
    const files = [{ key: "a", file: new File(["x"], "a.txt") }]; // 有待发文件：始终多行布局，布局切换不会插进来
    const view = (value: string) => <Composer value={value} placeholder="发消息" staging={staging({ files })} onChange={() => {}} onSend={() => {}} />;
    const { rerender } = render(view("第一行"));
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    box.style.height = "80px";
    Object.defineProperty(box, "scrollHeight", {
      configurable: true,
      get: () => (box.style.height === "auto" ? 36 : 80),
    });
    rerender(view("第一行继续打字"));
    expect(box.style.height).toBe("80px");
    rerender(view("第一"));
    expect(box.style.height).toBe("36px");
  });

  it("文字框关闭系统自动拼写检查、自动纠错与自动大写（防 macOS AppleSpell 同步扫描卡顿）", () => {
    setup();
    const box = screen.getByRole("textbox", { name: "Message" });
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

    const box = screen.getByRole("textbox", { name: "Message" });
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

      screen.getByRole("button", { name: "Dismiss" }).click();
      expect(dismissNotice).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "新内容" } });
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


/** 换掉 matchMedia：pointer 是 fine（鼠标、触控板）还是 coarse（手指）。 */
const stubPointer = (pointer: "fine" | "coarse") =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === `(pointer: ${pointer})`, addEventListener() {}, removeEventListener() {} }));

describe("Composer 聚焦和 Enter（按主指针）", () => {
  afterEach(() => vi.unstubAllGlobals());

  const mount = (over: Partial<React.ComponentProps<typeof Composer>> = {}) => {
    const onSend = vi.fn();
    render(<Composer value="你好" placeholder="发消息" staging={staging()} onChange={() => {}} onSend={onSend} {...over} />);
    return { onSend, box: screen.getByRole("textbox", { name: "Message" }) };
  };

  it("pointer: fine：出现时把焦点放进输入框", () => {
    stubPointer("fine");
    const { box } = mount({ autoFocus: true });
    expect(box).toHaveFocus();
  });

  it("pointer: coarse（手机、iPad）：出现时不聚焦，不弹键盘", () => {
    stubPointer("coarse");
    const { box } = mount({ autoFocus: true });
    expect(box).not.toHaveFocus();
  });

  it("pointer: fine：Enter 发送，Shift+Enter 不发送", () => {
    stubPointer("fine");
    const { onSend, box } = mount();
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("你好", []);
  });

  it("pointer: coarse：Enter 只换行（不拦截、不发送），发送键照常发送", () => {
    stubPointer("coarse");
    const { onSend, box } = mount();
    const prevented = !fireEvent.keyDown(box, { key: "Enter" });
    expect(prevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("你好", []);
  });

  it("输入法选字时的 Enter 不发送（电脑）", () => {
    stubPointer("fine");
    const { onSend, box } = mount();
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });
});
