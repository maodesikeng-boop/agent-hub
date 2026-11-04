// 文件预览窗：按类型选渲染方式、大文件截断、下载 / 在 Finder 中显示 / 用默认程序打开三个按钮（components/FilePreview.tsx）。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, MAX_PREVIEW_CSV_ROWS, MAX_PREVIEW_TEXT_BYTES, sentFileMime, type FileActionResponse } from "../shared/index.ts";
import { FilePreview, type PreviewFile } from "./components/FilePreview.tsx";

const highlight = vi.hoisted(() => vi.fn());
vi.mock("./highlight.ts", () => ({ highlightHtml: highlight }));

const ID = "0123456789abcdef";

function file(name: string, over: Partial<PreviewFile> = {}): PreviewFile {
  return { name, mime: sentFileMime(name), size: 100, url: API_PATHS.sentFile(ID, name), target: { kind: "sent", messageId: 5, index: 0 }, ...over };
}

function show(f: PreviewFile) {
  return render(<FilePreview file={f} open onOpenChange={() => {}} />);
}

interface Reply {
  status?: number;
  body?: string | object;
}
let calls: { url: string; method: string; headers: Record<string, string> }[];
let textBody: string;
let actionReply: Reply;

beforeEach(() => {
  calls = [];
  textBody = "";
  actionReply = { body: { target: "original" } satisfies FileActionResponse };
  highlight.mockReset();
  highlight.mockImplementation(async (code: string) => `<pre class="shiki"><code>${code.split("\n").map((l) => `<span class="line">${l}</span>`).join("\n")}</code></pre>`);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
      if (method === "POST") {
        const body = typeof actionReply.body === "string" ? actionReply.body : JSON.stringify(actionReply.body ?? {});
        return new Response(body, { status: actionReply.status ?? 200 });
      }
      return new Response(textBody, { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const user = userEvent.setup();

describe("按类型选渲染方式", () => {
  it("Markdown：渲染成排版，限制行宽（72 字），可以切到源码再切回来", async () => {
    textBody = "# 标题\n\n正文 **加粗**";
    show(file("说明.md", { mime: "text/markdown" }));
    expect(await screen.findByRole("heading", { level: 1, name: "标题" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 }).closest("[data-preview-markdown]")!.className).toContain("max-w-[72ch]");
    await user.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    await waitFor(() => expect(highlight).toHaveBeenCalledWith(textBody, "markdown"));
    expect(document.querySelector("[data-preview-code]")).toHaveTextContent("# 标题");
    await user.click(screen.getByRole("button", { name: "渲染" }));
    expect(await screen.findByRole("heading", { level: 1, name: "标题" })).toBeInTheDocument();
  });

  it("代码：按需加载 Shiki 上色（带语言），每行一个 .line（行号靠 CSS 计数），上色前先显示纯文本", async () => {
    textBody = "const a = 1;\nconst b = 2;";
    let release!: (html: string) => void;
    highlight.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    show(file("a.ts"));
    const code = await waitFor(() => {
      const el = document.querySelector("[data-preview-code]");
      expect(el).toHaveTextContent("const a = 1;");
      return el!;
    });
    expect(code.querySelectorAll(".line")).toHaveLength(2);
    expect(highlight).toHaveBeenCalledWith(textBody, "typescript");
    release('<pre class="shiki"><code><span class="line">HL1</span>\n<span class="line">HL2</span></code></pre>');
    await waitFor(() => expect(document.querySelector("[data-preview-code]")).toHaveTextContent("HL1"));
  });

  it("纯文本（.txt、.log）：不加载 Shiki，只有行号", async () => {
    textBody = "第一行\n第二行\n第三行";
    show(file("a.txt"));
    await waitFor(() => expect(document.querySelector("[data-preview-code]")).toHaveTextContent("第二行"));
    expect(document.querySelectorAll("[data-preview-code] .line")).toHaveLength(3);
    expect(highlight).not.toHaveBeenCalled();
  });

  it("代码有复制按钮，复制的是显示的文字", async () => {
    textBody = '{"a":1}';
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show(file("a.json"));
    await user.click(await screen.findByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith('{"a":1}');
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("大文本：超过 1 MB 只取前 1 MB（Range 请求），写明只显示前 1 MB；服务端不理 Range 也只显示前 1 MB", async () => {
    textBody = "a".repeat(MAX_PREVIEW_TEXT_BYTES + 500);
    show(file("big.txt", { size: MAX_PREVIEW_TEXT_BYTES + 500 }));
    await screen.findByText(/只显示前 1 MB/);
    expect(calls[0]!.headers.range).toBe(`bytes=0-${MAX_PREVIEW_TEXT_BYTES - 1}`);
    await waitFor(() => expect(document.querySelector("[data-preview-code] .line")!.textContent!.trimEnd().length).toBe(MAX_PREVIEW_TEXT_BYTES));
  });

  it("不超过 1 MB 的文本：不带 Range，没有截断提示", async () => {
    textBody = "hi";
    show(file("small.txt", { size: 2 }));
    await waitFor(() => expect(document.querySelector("[data-preview-code]")).toHaveTextContent("hi"));
    expect(calls[0]!.headers.range).toBeUndefined();
    expect(screen.queryByText(/只显示前/)).toBeNull();
  });

  it("CSV：表格，表头固定，只显示前 1000 行并写明总行数", async () => {
    textBody = ["名字,数", ...Array.from({ length: 2500 }, (_, i) => `n${i},${i}`)].join("\n");
    show(file("数据.csv", { size: textBody.length }));
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["名字", "数"]);
    expect(table.querySelector("thead th")!.className).toContain("sticky");
    expect(table.closest("[data-preview-table]")!.className).toContain("overflow-auto");
    expect(within(table).getAllByRole("row")).toHaveLength(MAX_PREVIEW_CSV_ROWS + 1);
    expect(screen.getByText("共 2500 行，只显示前 1000 行")).toBeInTheDocument();
    expect(calls[0]!.headers.range).toBeUndefined();
  });

  it("CSV 行数不多：只写总行数；TSV 按制表符分", async () => {
    textBody = "a\tb\n1\t2";
    show(file("t.tsv"));
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("cell").map((c) => c.textContent)).toEqual(["1", "2"]);
    expect(screen.getByText("共 1 行")).toBeInTheDocument();
  });

  it("PDF：iframe 放浏览器自带的查看器，地址带 ?inline=1，不加 sandbox 属性（加了 Chrome 渲染不出）", () => {
    show(file("报告.pdf"));
    const frame = screen.getByTitle("报告.pdf");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", `${API_PATHS.sentFile(ID, "报告.pdf")}?inline=1`);
    expect(frame).not.toHaveAttribute("sandbox");
    expect(calls).toEqual([]);
  });

  it("HTML：iframe sandbox 只有 allow-scripts（没有 allow-same-origin）", () => {
    show(file("页面.html"));
    const frame = screen.getByTitle("页面.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame).toHaveAttribute("src", `${API_PATHS.sentFile(ID, "页面.html")}?inline=1`);
  });

  it("视频、音频：原生播放器", () => {
    const { unmount } = show(file("a.mp4"));
    expect(document.querySelector("video")).toHaveAttribute("src", `${API_PATHS.sentFile(ID, "a.mp4")}?inline=1`);
    expect(document.querySelector("video")).toHaveAttribute("controls");
    unmount();
    show(file("a.mp3"));
    expect(document.querySelector("audio")).toHaveAttribute("src", `${API_PATHS.sentFile(ID, "a.mp3")}?inline=1`);
  });

  it("图片：大图", () => {
    show(file("a.png"));
    const img = screen.getByRole("img", { name: "a.png" });
    expect(img).toHaveAttribute("src", `${API_PATHS.sentFile(ID, "a.png")}?inline=1`);
    expect(img.className).toContain("object-contain");
  });

  it("其他类型：只有文件信息和按钮，不发请求", () => {
    show(file("a.zip", { size: 2048 }));
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /在 Finder 中显示/ })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("读文件失败：写原因", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    show(file("a.txt"));
    expect(await screen.findByText(/读不了这个文件/)).toBeInTheDocument();
  });
});

describe("三个按钮", () => {
  it("下载：链接到文件，带 download", () => {
    show(file("报告.pdf"));
    const link = screen.getByRole("link", { name: /下载/ });
    expect(link).toHaveAttribute("href", API_PATHS.sentFile(ID, "报告.pdf"));
    expect(link).toHaveAttribute("download", "报告.pdf");
  });

  it("在 Finder 中显示、用默认程序打开：POST 对应接口", async () => {
    show(file("报告.pdf"));
    await user.click(screen.getByRole("button", { name: /在 Finder 中显示/ }));
    await user.click(screen.getByRole("button", { name: /用默认程序打开/ }));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([API_PATHS.sentFileAction(5, 0, "reveal"), API_PATHS.sentFileAction(5, 0, "open")]);
  });

  it("上传的附件：走附件接口", async () => {
    show(file("a.pdf", { target: { kind: "upload", id: ID } }));
    await user.click(screen.getByRole("button", { name: /用默认程序打开/ }));
    expect(calls.at(-1)!.url).toBe(API_PATHS.attachmentAction(ID, "open"));
  });

  it(".sh、.app 这类：“用默认程序打开”点不了，“在 Finder 中显示”可以", async () => {
    show(file("run.sh"));
    expect(screen.getByRole("button", { name: /用默认程序打开/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /在 Finder 中显示/ }));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/reveal"))).toBe(true);
  });

  it("服务端拒绝：把原因写出来", async () => {
    actionReply = { status: 403, body: { error: "这种文件打开可能会直接运行，只能在 Finder 中显示" } };
    show(file("tool"));
    await user.click(screen.getByRole("button", { name: /用默认程序打开/ }));
    expect(await screen.findByText("这种文件打开可能会直接运行，只能在 Finder 中显示")).toBeInTheDocument();
  });

  it("用的是副本时说一声", async () => {
    actionReply = { body: { target: "copy" } };
    show(file("a.pdf"));
    await user.click(screen.getByRole("button", { name: /在 Finder 中显示/ }));
    expect(await screen.findByText("原文件已经不在了，显示的是发出时存的副本")).toBeInTheDocument();
  });

  it("没有 target（找不到对应的消息）：只有下载", () => {
    show(file("a.pdf", { target: null }));
    expect(screen.getByRole("link", { name: /下载/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Finder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /默认程序/ })).toBeNull();
  });

  it("标题是文件名，关闭按钮在", () => {
    show(file("报告.pdf"));
    expect(screen.getByRole("dialog", { name: "报告.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  });
});
