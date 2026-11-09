// Markdown 排版：保留单个换行、代码块（高亮、语言名、复制、流式输出）、表格（对齐、宽表格）。
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./components/Markdown.tsx";

const highlight = vi.hoisted(() => vi.fn());
vi.mock("./highlight.ts", () => ({ highlightHtml: highlight }));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** 假的 Shiki 输出：每行一个 .line，里面包一层 .tok，方便看出“是上过色的”。 */
const fakeShiki = (code: string) =>
  `<pre class="shiki" style="background-color:#fff"><code>${code.split("\n").map((l) => `<span class="line"><span class="tok">${esc(l)}</span></span>`).join("\n")}</code></pre>`;

beforeEach(() => {
  highlight.mockReset();
  highlight.mockImplementation(async (code: string) => fakeShiki(code));
});

describe("换行", () => {
  it("单个换行保留成 <br>，两个换行照旧分段", () => {
    const { container } = render(<Markdown text={"状态: 做完了\n摘要: 一句话\n\n第二段"} />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.querySelectorAll("br")).toHaveLength(1);
    expect(paragraphs[0]).toHaveTextContent("状态: 做完了 摘要: 一句话");
    expect(paragraphs[1]!.querySelector("br")).toBeNull();
  });

  it("列表项里的单个换行也保留，列表结构不变", () => {
    const { container } = render(<Markdown text={"- 选项 A\n  说明 A\n- 选项 B"} />);
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelectorAll("br")).toHaveLength(1);
  });

  it("代码块和表格里的换行不受影响", () => {
    const { container } = render(<Markdown text={"```\na\nb\n```\n\n| x | y |\n| - | - |\n| 1 | 2 |"} />);
    expect(container.querySelector("pre br")).toBeNull();
    expect(container.querySelector("pre")!.textContent).toContain("a\nb");
    expect(container.querySelector("table br")).toBeNull();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });
});

describe("代码块", () => {
  it("有语言：右上角写语言名，按语言上色", async () => {
    const { container } = render(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(screen.getByText("ts")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".tok")).not.toBeNull());
    expect(highlight).toHaveBeenCalledWith("const a = 1;", "ts");
    expect(container.querySelector("[data-md-code]")).toHaveTextContent("const a = 1;");
  });

  it("没写语言：不写语言名、不上色，也有复制按钮，代码照常显示", async () => {
    const { container } = render(<Markdown text={"```\npnpm test\n```"} />);
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(container.querySelector("[data-md-code-lang]")).toBeNull();
    expect(container.querySelector("[data-md-code] code")).toHaveTextContent("pnpm test");
    expect(highlight).not.toHaveBeenCalled();
  });

  it("不认识的语言：退回纯文本，不报错", async () => {
    highlight.mockRejectedValue(new Error("Language `nope` not found"));
    const { container } = render(<Markdown text={"```nope\nhello <b>\n```"} />);
    await waitFor(() => expect(highlight).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByText("nope")).toBeInTheDocument();
    expect(container.querySelector(".tok")).toBeNull();
    expect(container.querySelector("[data-md-code] code")).toHaveTextContent("hello <b>");
  });

  it("复制按钮拿到的是代码原文（不含语言名、末尾多余的换行）", async () => {
    const user = userEvent.setup();
    render(<Markdown text={"```py\nif x:\n    print('a')\n\n# end\n```"} />);
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await navigator.clipboard.readText()).toBe("if x:\n    print('a')\n\n# end");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("上过色之后复制，拿到的还是原文", async () => {
    const user = userEvent.setup();
    const { container } = render(<Markdown text={"```ts\nlet a = 1 < 2;\n```"} />);
    await waitFor(() => expect(container.querySelector(".tok")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await navigator.clipboard.readText()).toBe("let a = 1 < 2;");
  });

  it("流式输出：代码块没闭合不报错，后面再来内容时不卸载重建、不闪回纯文本", async () => {
    const { container, rerender } = render(<Markdown text={"先看：\n\n```ts\nconst a = 1;"} />);
    const block = container.querySelector("[data-md-code]");
    expect(block).not.toBeNull();
    expect(block).toHaveTextContent("const a = 1;");
    await waitFor(() => expect(container.querySelector(".tok")).not.toBeNull());

    rerender(<Markdown text={"先看：\n\n```ts\nconst a = 1;\nconst b = 2;"} />);
    // 新尾巴马上看得到，已经上过的颜色还在
    expect(container.querySelector("[data-md-code]")).toBe(block);
    expect(block).toHaveTextContent("const b = 2;");
    expect(container.querySelector(".tok")).not.toBeNull();
    // 停一会儿后整段重新上色
    await waitFor(() => expect(highlight).toHaveBeenLastCalledWith("const a = 1;\nconst b = 2;", "ts"));
    await waitFor(() => expect(container.querySelectorAll(".tok")).toHaveLength(2));

    rerender(<Markdown text={"先看：\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n完了"} />);
    expect(container.querySelector("[data-md-code]")).toBe(block);
    expect(screen.getByText("完了")).toBeInTheDocument();
  });

  it("流式输出：连续来很多段只在停下来后上一次色", async () => {
    const { rerender } = render(<Markdown text={"```ts\nl0"} />);
    for (let i = 1; i < 6; i++) rerender(<Markdown text={`\`\`\`ts\n${Array.from({ length: i + 1 }, (_, n) => `l${n}`).join("\n")}`} />);
    await waitFor(() => expect(highlight).toHaveBeenLastCalledWith("l0\nl1\nl2\nl3\nl4\nl5", "ts"));
    expect(highlight.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("表格", () => {
  const table = "| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | 1.5 | 34.5% |";

  it("左、中、右对齐：表头和同一列的内容一致", () => {
    const { container } = render(<Markdown text={table} />);
    const heads = [...container.querySelectorAll("th")];
    const cells = [...container.querySelectorAll("td")];
    for (const [i, align] of (["left", "center", "right"] as const).entries()) {
      expect(heads[i]).toHaveStyle({ textAlign: align });
      expect(cells[i]).toHaveStyle({ textAlign: align });
    }
  });

  it("数字用等宽数字（tabular-nums）", () => {
    const { container } = render(<Markdown text={table} />);
    expect(container.querySelector("table")!.className).toContain("tabular-nums");
  });

  it("宽表格：外面套横向滚动的容器，表格不撑破消息列", () => {
    const cols = Array.from({ length: 30 }, (_, i) => `列${i}`);
    const wide = `| ${cols.join(" | ")} |\n| ${cols.map(() => "-").join(" | ")} |\n| ${cols.map((_, i) => `长长长长长长长值${i}`).join(" | ")} |`;
    const { container } = render(<Markdown text={wide} />);
    const wrap = container.querySelector("[data-md-table]")!;
    expect(wrap).not.toBeNull();
    expect(wrap.querySelector("table")).not.toBeNull();
    expect(container.querySelector(".markdown > table")).toBeNull();
    const css = readFileSync(join(process.cwd(), "src/web/styles.css"), "utf8");
    expect(css).toMatch(/\[data-md-table\]\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\[data-md-table\]\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.markdown th,\s*\.markdown td\s*\{[^}]*text-align:\s*left/);
  });
});

describe("链接与行内文件链接样式", () => {
  it("styles.css 定义 --link: #2563eb，.markdown a 与 [data-file-link] 统一用蓝色链接字，内嵌 code 继承链接颜色", () => {
    const css = readFileSync(join(process.cwd(), "src/web/styles.css"), "utf8");
    expect(css).toMatch(/--link:\s*#2563eb;/);
    expect(css).toMatch(/\.markdown a,\s*\.markdown \[data-file-link\]\s*\{[^}]*color:\s*var\(--link\)/);
    expect(css).toMatch(/\.markdown a code,\s*\.markdown \[data-file-link\] code\s*\{[^}]*color:\s*inherit/);
  });
});
