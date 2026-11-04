// agent 消息按 Markdown 渲染；用户和系统消息保持纯文本；左栏预览去掉 Markdown 符号。
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble, type MessageActions } from "./components/Messages.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import type { ConversationEntry } from "./selectors.ts";
import { makeMessage, makeUserMessage } from "./test-utils.ts";
import { stripMarkdown } from "./plainText.ts";

const identity = { name: "小林", avatarKey: 1 };
const actions: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() };
const sidebarProps = { waiting: new Set<number>(), notify: { permission: "granted" as const, enabled: true, setEnabled: async () => {} }, quota: [], onNewPm: () => {} };

function agentSays(text: string) {
  return render(<MessageBubble message={makeMessage({ id: 1, text })} identity={identity} head actions={actions} />);
}

describe("agent 消息的 Markdown", () => {
  it("加粗和斜体渲染成 strong / em", () => {
    agentSays("这是 **重点** 和 *强调*");
    expect(screen.getByText("重点").tagName).toBe("STRONG");
    expect(screen.getByText("强调").tagName).toBe("EM");
    expect(document.body).not.toHaveTextContent("**");
  });

  it("列表渲染成 list / listitem", () => {
    agentSays("步骤：\n\n- 先读\n- 再改\n\n1. 跑测试\n2. 提 PR");
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(within(lists[0] as HTMLElement).getByText("先读")).toBeInTheDocument();
  });

  it("代码块渲染成 pre > code，内容原样保留", () => {
    const { container } = agentSays("看这段：\n\n```ts\nconst a = 1;\nconst b = 2;\n```");
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector("code")).toHaveTextContent("const a = 1; const b = 2;");
    expect(pre?.textContent).toContain("const a = 1;\nconst b = 2;");
  });

  it("行内代码渲染成 code", () => {
    const { container } = agentSays("改 `ack` 的顺序");
    expect(container.querySelector("code")).toHaveTextContent("ack");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("GFM：表格和删除线", () => {
    const { container } = agentSays("| a | b |\n| - | - |\n| 1 | 2 |\n\n~~旧的~~");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("del")).toHaveTextContent("旧的");
  });

  it("链接在新窗口打开，带 rel=noopener noreferrer", () => {
    agentSays("见 [文档](https://example.com/doc) 和 https://example.org/x");
    const doc = screen.getByRole("link", { name: "文档" });
    expect(doc).toHaveAttribute("href", "https://example.com/doc");
    expect(doc).toHaveAttribute("target", "_blank");
    expect(doc).toHaveAttribute("rel", "noopener noreferrer");
    const auto = screen.getByRole("link", { name: "https://example.org/x" });
    expect(auto).toHaveAttribute("target", "_blank");
    expect(auto).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("javascript: 链接不会带 href", () => {
    agentSays("[点我](javascript:alert(1))");
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("原始 HTML 不会变成元素，也不会执行", () => {
    const { container } = agentSays(
      '<img src="x" onerror="window.__pwned = 1"><script>window.__pwned = 2</script>\n\n<b>粗</b> <a href="https://evil.example">钓鱼</a>',
    );
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(container.querySelector('a[href="https://evil.example"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // 当字面文字显示，用户看得到发生了什么
    expect(container).toHaveTextContent("<b>粗</b>");
  });
});

describe("用户消息和系统消息保持纯文本", () => {
  it("用户消息里的 ** 原样显示，不渲染", () => {
    const { container } = render(
      <MessageBubble message={makeUserMessage({ id: 2, text: "**别渲染** `code` [a](https://x.y)" })} identity={identity} head actions={actions} />,
    );
    expect(container).toHaveTextContent("**别渲染** `code` [a](https://x.y)");
    expect(container.querySelector("strong, code, a")).toBeNull();
  });

  it("系统消息原样显示", () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ id: 3, sender: "system", text: "**已建工单**" })} identity={identity} head actions={actions} />,
    );
    expect(container).toHaveTextContent("**已建工单**");
    expect(container.querySelector("strong")).toBeNull();
  });
});

describe("stripMarkdown", () => {
  it.each([
    ["**加粗** 和 *斜体* 和 __粗__ 和 _斜_", "加粗 和 斜体 和 粗 和 斜"],
    ["改 `ack` 的顺序", "改 ack 的顺序"],
    ["**这是一条 `**bold**` 和 `x` 的句子。**", "这是一条 **bold** 和 x 的句子。"],
    ["[文档](https://example.com) 在这", "文档 在这"],
    ["![图](https://example.com/a.png)", "图"],
    ["# 标题\n正文", "标题 正文"],
    ["- 一\n- 二\n1. 三", "一 二 三"],
    ["> 引用\n~~删~~", "引用 删"],
    ["```ts\nconst a = 1;\n```\n后面", "const a = 1; 后面"],
    ["没有符号的 snake_case_name 保持不变", "没有符号的 snake_case_name 保持不变"],
  ])("%j → %j", (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });
});

describe("左栏预览", () => {
  function entry(text: string): ConversationEntry {
    return { id: 1, name: "小林", avatarKey: 1, lastMessage: makeMessage({ id: 9, text }), lastAt: 1, pm: null, project: null, folders: [] };
  }

  it("agent 的最后一条消息去掉 Markdown 符号", () => {
    render(<Sidebar entries={[entry("原因找到了：**ack** 发早了，见 [文档](https://x.y)")]} activeId={1} onSelect={() => {}} {...sidebarProps} />);
    const button = screen.getByRole("button", { name: /小林/ });
    expect(button).toHaveTextContent("原因找到了：ack 发早了，见 文档");
    expect(button).not.toHaveTextContent("**");
    expect(button).not.toHaveTextContent("](");
  });

  it("用户发的最后一条消息也按原文显示（不是 Markdown）", () => {
    const e = entry("我写了 **两个** 星号");
    e.lastMessage = makeUserMessage({ id: 9, text: "我写了 **两个** 星号" });
    render(<Sidebar entries={[e]} activeId={1} onSelect={() => {}} {...sidebarProps} />);
    expect(screen.getByRole("button", { name: /小林/ })).toHaveTextContent("我写了 **两个** 星号");
  });
});
