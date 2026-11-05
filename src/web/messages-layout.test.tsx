/// <reference types="node" />
// agent 消息从对话区最左边开始、占满宽度、没有气泡底色；用户气泡不变。
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MessageList } from "./components/MessageList.tsx";
import { MessageBubble, ToolGroup, type MessageActions } from "./components/Messages.tsx";
import { makeMessage, makeUserMessage } from "./test-utils.ts";

const identity = { name: "小林", avatarKey: 1 };
const actions: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() };

function agent(text: string, head = true) {
  return render(<MessageBubble message={makeMessage({ id: 1, text })} identity={identity} head={head} actions={actions} />);
}

describe("agent 消息布局", () => {
  it("没有头像那一列的缩进：头像和名字在正文上方，正文占满整行", () => {
    const { container } = agent("你好");
    const row = container.querySelector("article[data-side='left']") as HTMLElement;
    expect(row.className).not.toContain("flex-row");
    expect(row.className).not.toMatch(/\bgap-3\b/);
    expect(row.querySelector(".w-9")).toBeNull();
    const body = row.querySelector(".markdown")!.parentElement as HTMLElement;
    expect(body.className).not.toContain("max-w-[85%]");
    expect(body.className).toContain("w-full");
    expect(body.className).toContain("min-w-0");
    // 名字在正文前面
    const name = Array.from(row.querySelectorAll("div")).find((d) => d.textContent === "小林")!;
    expect(name.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("头像缩小到 24px", () => {
    const { container } = agent("你好");
    const avatar = container.querySelector("[data-slot='avatar']") as HTMLElement;
    expect(avatar.style.width).toBe("24px");
  });

  it("正文不带气泡底色和圆角气泡", () => {
    const { container } = agent("你好");
    expect(container.innerHTML).not.toContain("bg-bubble-agent");
    expect(container.innerHTML).not.toContain("rounded-[22px]");
  });

  it("连续消息只有第一条带头像和名字", () => {
    const messages = [makeMessage({ id: 1, text: "第一条" }), makeMessage({ id: 2, text: "第二条" })];
    const { container } = render(
      <MessageList
        messages={messages}
        pending={[]}
        agentOf={() => identity}
        hasMore={false}
        older={undefined}
        onLoadOlder={() => {}}
        onRetry={() => {}}
        actions={actions}
      />,
    );
    const rows = container.querySelectorAll("article[data-side='left']");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-head")).toBe("true");
    expect(rows[1]!.getAttribute("data-head")).toBe("false");
    expect(container.querySelectorAll("[data-slot='avatar']")).toHaveLength(1);
    expect(container.textContent?.match(/小林/g)).toHaveLength(1);
  });

  it("工具调用折叠行同样从最左边开始", () => {
    const { container } = render(<ToolGroup messages={[makeMessage({ id: 1, text: "ls" })]} identity={identity} head />);
    expect(container.querySelector(".w-9")).toBeNull();
  });

  it("宽表格和代码块在自己的容器里横向滚动，不撑破消息列", () => {
    const { container } = agent("| a | b |\n| - | - |\n| 1 | 2 |\n\n```\nconst a = 1;\n```");
    expect((container.querySelector(".markdown")!.parentElement as HTMLElement).className).toContain("min-w-0");
    const css = readFileSync("src/web/styles.css", "utf8");
    // 表格套在 [data-md-table] 里滚动；代码块的正文（.md-code-body）自己横向滚动
    // 同一个选择器会在几条规则里出现（共用的 margin 那条），把声明合在一起看
    const rule = (selector: string) =>
      [...css.matchAll(new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]!.replace(/\s+/g, "")).join(";");
    expect(container.querySelector("[data-md-table] table")).not.toBeNull();
    expect(rule(".markdown [data-md-table]")).toContain("overflow-x:auto");
    expect(rule(".markdown [data-md-table]")).toContain("max-width:100%");
    expect(css).toMatch(/\.markdown \.md-code-body,[^{]*\{[^}]*overflow-x:\s*auto/);
  });

  it("用户消息的气泡样式不变", () => {
    const { container } = render(
      <MessageBubble message={makeUserMessage({ id: 2, text: "你好" })} identity={identity} head actions={actions} />,
    );
    const bubble = container.querySelector("article[data-side='right'] > div") as HTMLElement;
    expect(bubble.className).toContain("bg-bubble-me");
    expect(bubble.className).toContain("rounded-[22px]");
    expect(bubble.className).toContain("max-w-[80%]");
  });
});
