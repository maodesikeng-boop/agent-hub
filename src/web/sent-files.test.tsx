// agent 发来的文件：Markdown 里对上 meta.files 的图片内联、链接换成文件卡片；老消息照原样（shared/sent-files.ts、components/Markdown.tsx）。
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { API_PATHS, SENT_FILE_REASONS, type SentFile } from "../shared/index.ts";
import { MessageBubble, type MessageActions } from "./components/Messages.tsx";
import { makeMessage } from "./test-utils.ts";

const identity = { name: "小林", avatarKey: 1 };
const actions: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() };

function sent(over: Partial<SentFile> & Pick<SentFile, "href" | "name">): SentFile {
  return { path: over.href, id: "0123456789abcdef", size: 2048, mime: "image/png", status: "saved", mtime: 1, ...over };
}

function agentSays(text: string, files: SentFile[] | null, extra: Partial<Parameters<typeof makeMessage>[0]> = {}) {
  return render(
    <MessageBubble message={makeMessage({ id: 1, text, meta: files === null ? null : { files }, ...extra })} identity={identity} head actions={actions} />,
  );
}

/** 页面上所有会让浏览器发请求的地址（img 的 src）和链接地址。 */
function urls(container: HTMLElement) {
  return {
    src: [...container.querySelectorAll("img")].map((img) => img.getAttribute("src")),
    href: [...container.querySelectorAll("a")].map((a) => a.getAttribute("href")),
  };
}

describe("图片内联", () => {
  it("png：直接显示在正文里，地址是取副本的接口，点开在新窗口看大图", () => {
    const file = sent({ href: "/tmp/shot.png", name: "shot.png" });
    const { container } = agentSays("做好了：\n\n![首页截图](/tmp/shot.png)", [file]);
    const img = screen.getByRole("img", { name: "首页截图" });
    const url = API_PATHS.sentFile(file.id!, "shot.png");
    expect(img).toHaveAttribute("src", url);
    expect(img.className).toContain("max-h-[480px]");
    expect(img.className).toContain("max-w-full");
    const link = img.closest("a")!;
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(urls(container).src).toEqual([url]);
  });

  it("几张图：各自显示，对得上各自的副本", () => {
    const files = [1, 2, 3].map((i) => sent({ href: `/tmp/${i}.png`, name: `${i}.png`, id: `000000000000000${i}` }));
    agentSays("![一](/tmp/1.png)\n![二](/tmp/2.png)\n\n![三](/tmp/3.png)", files);
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual(files.map((f) => API_PATHS.sentFile(f.id!, f.name)));
  });

  it("中文、空格（尖括号）、%xx 写法：按 Markdown 里的原地址对上", () => {
    const file = sent({ href: "/tmp/周 报.png", name: "周 报.png" });
    const encoded = sent({ href: "/tmp/%E5%9B%BE.png", name: "图.png", id: "1111111111111111" });
    agentSays("![a](</tmp/周 报.png>) ![b](/tmp/%E5%9B%BE.png)", [file, encoded]);
    expect(screen.getByRole("img", { name: "a" })).toHaveAttribute("src", API_PATHS.sentFile(file.id!, "周 报.png"));
    expect(screen.getByRole("img", { name: "b" })).toHaveAttribute("src", API_PATHS.sentFile("1111111111111111", "图.png"));
  });

  it("svg 也当图片，只用 <img> 加载（脚本在 <img> 里不执行）", () => {
    const { container } = agentSays("![图](/tmp/a.svg)", [sent({ href: "/tmp/a.svg", name: "a.svg", mime: "image/svg+xml" })]);
    expect(container.querySelector("img")).toHaveAttribute("src", API_PATHS.sentFile("0123456789abcdef", "a.svg"));
    expect(container.querySelector("iframe, object, embed")).toBeNull();
  });
});

describe("文件卡片", () => {
  it("pdf、md、csv：链接换成卡片（文件名、大小），点了下载", () => {
    const files = [
      sent({ href: "/p/报告.pdf", name: "报告.pdf", mime: "application/pdf", id: "0000000000000001", size: 1536 }),
      sent({ href: "/p/说明.md", name: "说明.md", mime: "text/markdown", id: "0000000000000002" }),
      sent({ href: "/p/数据.csv", name: "数据.csv", mime: "text/csv", id: "0000000000000003" }),
    ];
    agentSays("见 [报告](/p/报告.pdf)、[说明](/p/说明.md) 和 ![表](/p/数据.csv)", files);
    for (const f of files) {
      const card = screen.getByRole("link", { name: new RegExp(f.name) });
      expect(card).toHaveAttribute("href", API_PATHS.sentFile(f.id!, f.name));
      expect(card).toHaveAttribute("download", f.name);
      expect(card).toHaveAttribute("data-file-card");
    }
    expect(screen.getByRole("link", { name: /报告\.pdf/ })).toHaveTextContent("1.5 KB");
  });

  it("普通链接写的图片：卡片带缩略图（不内联成大图），同一张图又用 ![]() 写了的照样内联", () => {
    const file = sent({ href: "/tmp/c.png", name: "c.png" });
    const { container } = agentSays("![图](/tmp/c.png)（路径 [c.png](/tmp/c.png)）", [file]);
    const url = API_PATHS.sentFile(file.id!, "c.png");
    const card = screen.getByRole("link", { name: /c\.png.*2\.0 KB/ });
    expect(card).toHaveAttribute("data-file-card");
    expect(card).toHaveAttribute("href", url);
    expect(card).not.toHaveAttribute("download");
    expect(card.querySelector("img")?.className).toContain("size-10");
    expect(container.querySelectorAll("[data-sent-image]")).toHaveLength(1);
  });

  it("没存下来的：卡片写原因，不是链接，不发请求", () => {
    const statuses = ["missing", "not_allowed", "not_file", "too_large", "unreadable"] as const;
    const files = statuses.map((status, i) => sent({ href: `/x/${i}.pdf`, name: `${i}.pdf`, id: null, size: null, mime: "application/pdf", status }));
    const { container } = agentSays(files.map((f, i) => `[${i}](${f.href})`).join("\n\n") + "\n\n![图](/x/img.png)", [
      ...files,
      sent({ href: "/x/img.png", name: "img.png", id: null, size: null, status: "not_allowed" }),
    ]);
    for (const status of statuses) expect(container).toHaveTextContent(SENT_FILE_REASONS[status]);
    expect(container.querySelectorAll("[data-file-card]")).toHaveLength(6);
    expect(urls(container)).toEqual({ src: [], href: [] });
  });
});

describe("老消息、没对上的链接", () => {
  it("没有 meta.files：本机图片显示成说明文字、不发请求；本机文件链接照原样", () => {
    const { container } = agentSays("![截图](/tmp/a.png) 和 [报告](/tmp/b.pdf) 和 ![远程](https://example.com/c.png)", null);
    expect(container).toHaveTextContent("截图");
    expect(urls(container).src).toEqual(["https://example.com/c.png"]);
    const link = screen.getByRole("link", { name: "报告" });
    expect(link).toHaveAttribute("href", "/tmp/b.pdf");
    expect(container.querySelector("[data-file-card]")).toBeNull();
  });

  it("file:// 写的图片在老消息里也不发请求", () => {
    const { container } = agentSays("![x](file:///tmp/a.png)", null);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("x");
  });

  it("代码块里的路径原样显示", () => {
    const { container } = agentSays("```\n![x](/tmp/a.png)\n```", [sent({ href: "/tmp/a.png", name: "a.png" })]);
    expect(container.querySelector("pre")).toHaveTextContent("![x](/tmp/a.png)");
    expect(container.querySelector("pre img")).toBeNull();
  });

  it("meta 形状不对（老数据、坏数据）：当没有，不报错", () => {
    const { container } = agentSays("[a](/tmp/a.pdf)", [{ href: "/tmp/a.pdf" } as SentFile]);
    expect(within(container).getByRole("link", { name: "a" })).toHaveAttribute("href", "/tmp/a.pdf");
  });
});

describe("Worker 页面", () => {
  it("Worker 回复里的图同样内联（Worker 对话用同一个消息组件）", () => {
    agentSays("![w](/wt/a.png)", [sent({ href: "/wt/a.png", name: "a.png" })], { workerId: 3, conversationId: 7 });
    expect(screen.getByRole("img", { name: "w" })).toHaveAttribute("src", API_PATHS.sentFile("0123456789abcdef", "a.png"));
  });
});

describe("重渲染（WS 推送让父组件重画）", () => {
  it("内联图和文件卡片不卸载重建：rerender 后还是同一个 DOM 节点", () => {
    const text = "![图](/tmp/a.png)\n\n[报告](/tmp/b.pdf)";
    const files = () => [
      sent({ href: "/tmp/a.png", name: "a.png" }),
      sent({ href: "/tmp/b.pdf", name: "b.pdf", mime: "application/pdf", id: "1111111111111111" }),
    ];
    // 每次都是新的 message、meta、files 对象（推送来的就是这样）
    const bubble = () => <MessageBubble message={makeMessage({ id: 1, text, meta: { files: files() } })} identity={identity} head actions={actions} />;
    const { container, rerender } = render(bubble());
    const img = container.querySelector("img[alt='图']");
    const card = container.querySelector("[data-file-card]");
    expect(img).not.toBeNull();
    rerender(bubble());
    rerender(bubble());
    expect(container.querySelector("img[alt='图']")).toBe(img);
    expect(container.querySelector("[data-file-card]")).toBe(card);
  });
});

describe("引用式链接（[a][r] + [r]: 地址）", () => {
  it("指向本机路径的引用式图片、链接：当文字显示，不发请求、没有链接", () => {
    const { container } = agentSays("看 ![截图][s] 和 [报告][r]\n\n[s]: /tmp/a.png\n[r]: file:///tmp/b.pdf", null);
    expect(container).toHaveTextContent("看 截图 和 报告");
    expect(urls(container)).toEqual({ src: [], href: [] });
  });

  it("有 meta.files 也一样（守护进程不处理引用式）", () => {
    const { container } = agentSays("![截图][s]\n\n[s]: /tmp/a.png", [sent({ href: "/tmp/a.png", name: "a.png" })]);
    expect(urls(container)).toEqual({ src: [], href: [] });
    expect(container).toHaveTextContent("截图");
  });

  it("指向网址的引用式链接照常", () => {
    agentSays("[文档][d]\n\n[d]: https://example.com/doc", null);
    expect(screen.getByRole("link", { name: "文档" })).toHaveAttribute("href", "https://example.com/doc");
  });
});
