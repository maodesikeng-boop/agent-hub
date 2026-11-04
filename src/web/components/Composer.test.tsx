import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StagedFiles } from "../upload.ts";
import { Composer } from "./Composer.tsx";

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

const setup = (over: Partial<StagedFiles> = {}) =>
  render(<Composer value="第一行\n第二行" placeholder="发消息" staging={staging(over)} onChange={() => {}} onSend={() => {}} />);

describe("Composer 布局", () => {
  it("回形针和发送键同尺寸、同圆角", () => {
    setup();
    const attach = screen.getByRole("button", { name: "添加文件" });
    const send = screen.getByRole("button", { name: "发送" });
    expect(attach).toHaveClass("bg-secondary");
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

  it("获得焦点时外框不带粉色（primary / ring）", () => {
    const { container } = setup();
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toContain("focus-within:border-foreground");
    expect(frame.className).not.toMatch(/(primary|ring)/);
    expect(screen.getByRole("textbox", { name: "输入消息" }).className).not.toMatch(/(primary|ring)/);
  });

  it("发送中：文字框只读，两个按钮都锁住", () => {
    setup({ busy: true });
    expect(screen.getByRole("textbox", { name: "输入消息" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "添加文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
