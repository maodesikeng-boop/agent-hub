// 聊天里的图表块（docs/charts-diagrams-design.md）：```mermaid / ```vega-lite 闭合后换成图表外壳。
// jsdom 画不出真图，registry 里的渲染器换成假的，验证分流、状态、缓存；真库的效果和安全在浏览器里验。
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./components/Markdown.tsx";
import { chartCache, chartCacheKey, ChartLruCache } from "./charts/cache.ts";
import { CHART_MAX_SOURCE_CHARS, CHART_MIN_HEIGHT, CHART_RENDERERS, resetChartRegistry, type ChartEngine, type ChartRenderer } from "./charts/registry.ts";
import { remarkChartBlocks, CHART_CLOSED_ATTR } from "./charts/remark-chart-blocks.ts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { MdNode } from "../shared/index.ts";

const highlight = vi.hoisted(() => vi.fn());
vi.mock("./highlight.ts", () => ({ highlightHtml: highlight }));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fakeShiki = (code: string) => `<pre class="shiki"><code>${code.split("\n").map((l) => `<span class="line"><span class="tok">${esc(l)}</span></span>`).join("\n")}</code></pre>`;

const dispose = vi.fn();
const renderFake = vi.fn<ChartEngine["render"]>();
const load = vi.fn<ChartRenderer["load"]>();

function fakeRenderer(zoomOnClick = true): ChartRenderer {
  return { load, zoomOnClick, sourceLanguage: "mermaid" };
}

/** IntersectionObserver 的假实现：auto 时一观察就算进了视口；never 时从不触发。 */
function stubIntersectionObserver(mode: "auto" | "never") {
  class Fake {
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      if (mode === "auto") this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Fake);
}

beforeEach(() => {
  resetChartRegistry();
  chartCache.clear();
  highlight.mockReset();
  highlight.mockImplementation(async (code: string) => fakeShiki(code));
  dispose.mockReset();
  renderFake.mockReset();
  renderFake.mockImplementation(async (source, _theme, el) => {
    const svg = `<svg data-fake viewBox="0 0 800 600"><text>${esc(source)}</text></svg>`;
    el.innerHTML = svg;
    return { svg, dispose };
  });
  load.mockReset();
  load.mockImplementation(async () => ({ render: renderFake }));
  CHART_RENDERERS.mermaid = fakeRenderer();
  CHART_RENDERERS["vega-lite"] = fakeRenderer(false);
  CHART_RENDERERS.vegalite = fakeRenderer(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(CHART_RENDERERS)) delete CHART_RENDERERS[key];
});

const fence = (lang: string, body = "graph TD\n  A --> B") => `\`\`\`${lang}\n${body}\n\`\`\``;
const chartOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-chart]");
const rendered = (container: HTMLElement) =>
  waitFor(() => {
    expect(chartOf(container)?.querySelector("svg[data-fake]")).not.toBeNull();
    expect(chartOf(container)?.querySelector("[data-chart-loading]")).toBeNull();
  });

describe("图表块：分流", () => {
  it("1. mermaid 闭合：出现 data-chart 外壳，不再是普通代码块；语言名和各个按钮都在", async () => {
    const { container } = render(<Markdown text={fence("mermaid")} />);
    await rendered(container);
    const chart = chartOf(container)!;
    expect(container.querySelector("[data-md-code]")).toBeNull();
    expect(chart.querySelector("[data-chart-lang]")).toHaveTextContent("mermaid");
    const bar = within(chart);
    expect(bar.getByRole("button", { name: "查看源码" })).toHaveAttribute("aria-pressed", "false");
    expect(bar.getByRole("button", { name: "放大" })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
    expect(renderFake).toHaveBeenCalledTimes(1);
    expect(renderFake.mock.calls[0]![0]).toBe("graph TD\n  A --> B");
  });

  it("2. 没闭合（流式中）：仍是普通代码块、不调用渲染器；补上收尾 fence 后调用一次", async () => {
    const half = "```mermaid\ngraph TD\n  A --> B";
    const { container, rerender } = render(<Markdown text={half} />);
    expect(container.querySelector("[data-md-code]")).not.toBeNull();
    expect(chartOf(container)).toBeNull();
    expect(renderFake).not.toHaveBeenCalled();
    rerender(<Markdown text={`${half}\n\`\`\``} />);
    await rendered(container);
    expect(renderFake).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-md-code]")).toBeNull();
  });

  it("3. 图后面继续追加文字：渲染器只调用一次，图不重画", async () => {
    const text = fence("mermaid");
    const { container, rerender } = render(<Markdown text={text} />);
    await rendered(container);
    const svg = container.querySelector("svg[data-fake]");
    for (const tail of ["\n\n后", "\n\n后面接着", "\n\n后面接着写的一大段文字。"]) rerender(<Markdown text={text + tail} />);
    expect(container).toHaveTextContent("后面接着写的一大段文字。");
    expect(renderFake).toHaveBeenCalledTimes(1);
    expect(container.querySelector("svg[data-fake]")).toBe(svg);
  });

  it.each([
    ["vega", false],
    ["json", false],
    ["text", false],
    ["", false],
    ["vegalite", true],
    ["vega-lite", true],
    ["mermaid", true],
  ])("7. ```%s → 图表块 %s", async (lang, isChart) => {
    const { container } = render(<Markdown text={fence(lang, '{"a": 1}')} />);
    if (isChart) {
      await rendered(container);
      expect(container.querySelector("[data-md-code]")).toBeNull();
    } else {
      expect(container.querySelector("[data-md-code]")).not.toBeNull();
      expect(chartOf(container)).toBeNull();
      expect(renderFake).not.toHaveBeenCalled();
    }
  });
});

describe("图表块：失败", () => {
  it("4. 渲染器抛错：代码块原文 + 上方一行 text-danger 错误，title 是完整错误", async () => {
    renderFake.mockRejectedValue(new Error("Parse error on line 2\nExpecting 'SEMI'"));
    const { container } = render(<Markdown text={fence("mermaid", "graph TD\n  A -->")} />);
    const error = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-chart-error]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(error).toHaveClass("text-danger");
    expect(error).toHaveTextContent("Parse error on line 2");
    expect(error).not.toHaveTextContent("Expecting");
    expect(error).toHaveAttribute("title", "Parse error on line 2\nExpecting 'SEMI'");
    expect(container.querySelector("[data-md-code]")!.textContent).toContain("graph TD\n  A -->");
    expect(chartOf(container)).toBeNull();
    expect(error.compareDocumentPosition(container.querySelector("[data-md-code]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("4b. 同样的源码失败后换个位置再出现：不再重试，直接显示错误", async () => {
    renderFake.mockRejectedValue(new Error("bad"));
    const text = fence("mermaid", "x");
    const first = render(<Markdown text={text} />);
    await waitFor(() => expect(first.container.querySelector("[data-chart-error]")).not.toBeNull());
    first.unmount();
    const second = render(<Markdown text={text} />);
    expect(second.container.querySelector("[data-chart-error]")).not.toBeNull();
    expect(renderFake).toHaveBeenCalledTimes(1);
  });

  it("5. 库加载失败（load reject）：同样是代码块 + “图表组件加载失败”；下次可以重试", async () => {
    load.mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"));
    const text = fence("mermaid");
    const first = render(<Markdown text={text} />);
    const error = await waitFor(() => {
      const el = first.container.querySelector<HTMLElement>("[data-chart-error]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(error).toHaveTextContent("图表组件加载失败");
    expect(error).toHaveClass("text-danger");
    expect(first.container.querySelector("[data-md-code]")).not.toBeNull();
    first.unmount();
    const second = render(<Markdown text={text} />);
    await rendered(second.container);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("6. 源码超过上限：不调用渲染器，代码块 + 错误", () => {
    const { container } = render(<Markdown text={fence("mermaid", "A".repeat(CHART_MAX_SOURCE_CHARS + 1))} />);
    expect(container.querySelector("[data-chart-error]")).toHaveTextContent("图表源码太长");
    expect(container.querySelector("[data-md-code]")).not.toBeNull();
    expect(renderFake).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("图表块：加载、视口、缓存", () => {
  it("8. 不在视口（IntersectionObserver 不触发）：不加载、不渲染，占位 160px；进了视口才渲染", async () => {
    let fire: IntersectionObserverCallback | undefined;
    class Manual {
      constructor(callback: IntersectionObserverCallback) {
        fire = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Manual);
    const { container } = render(<Markdown text={fence("mermaid")} />);
    const chart = chartOf(container)!;
    expect(chart.querySelector("[data-chart-body]")).toHaveStyle({ minHeight: `${CHART_MIN_HEIGHT}px` });
    expect(CHART_MIN_HEIGHT).toBe(160);
    expect(renderFake).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    act(() => fire!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await rendered(container);
    expect(renderFake).toHaveBeenCalledTimes(1);
  });

  it("加载中：占位里一个转圈（没有字），渲染完转圈消失、不再撑 160px", async () => {
    let finish!: () => void;
    renderFake.mockImplementation(async (source, _theme, el) => {
      await new Promise<void>((resolve) => (finish = resolve));
      const svg = `<svg data-fake><text>${esc(source)}</text></svg>`;
      el.innerHTML = svg;
      return { svg };
    });
    const { container } = render(<Markdown text={fence("mermaid")} />);
    await waitFor(() => expect(container.querySelector("[data-chart-loading]")).not.toBeNull());
    expect(container.querySelector("[data-chart-loading]")).toHaveTextContent("");
    expect(container.querySelector("[data-chart-body]")).toHaveStyle({ minHeight: "160px" });
    await act(async () => finish());
    await rendered(container);
    expect(container.querySelector("[data-chart-loading]")).toBeNull();
    expect(container.querySelector("[data-chart-body]")).not.toHaveStyle({ minHeight: "160px" });
  });

  it("多张图一次一张地渲染（串行队列）", async () => {
    let running = 0;
    let peak = 0;
    renderFake.mockImplementation(async (source, _theme, el) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      const svg = `<svg data-fake><text>${esc(source)}</text></svg>`;
      el.innerHTML = svg;
      return { svg };
    });
    const { container } = render(<Markdown text={[fence("mermaid", "a"), fence("mermaid", "b"), fence("mermaid", "c")].join("\n\n")} />);
    await waitFor(() => expect(container.querySelectorAll("svg[data-fake]")).toHaveLength(3));
    expect(renderFake).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it("11. 卸载再挂载同一源码：同步出图，不出现转圈，不再调用渲染器", async () => {
    const text = fence("mermaid");
    const first = render(<Markdown text={text} />);
    await rendered(first.container);
    first.unmount();
    const second = render(<Markdown text={text} />);
    expect(second.container.querySelector("[data-chart-loading]")).toBeNull();
    expect(second.container.querySelector("[data-chart] svg[data-fake]")).not.toBeNull();
    expect(renderFake).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("卸载时释放渲染器给的 dispose", async () => {
    const { container, unmount } = render(<Markdown text={fence("mermaid")} />);
    await rendered(container);
    expect(dispose).not.toHaveBeenCalled();
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("缓存键带语言、源码、主题版本", () => {
    expect(chartCacheKey("mermaid", "a", "v1")).not.toBe(chartCacheKey("vega-lite", "a", "v1"));
    expect(chartCacheKey("mermaid", "a", "v1")).not.toBe(chartCacheKey("mermaid", "b", "v1"));
    expect(chartCacheKey("mermaid", "a", "v1")).not.toBe(chartCacheKey("mermaid", "a", "v2"));
  });

  it("LRU：超出条数丢最久没用的，取过的算最近用过", () => {
    const cache = new ChartLruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });
});

describe("图表块：源码切换、放大、复制", () => {
  it("9. 切换源码：显示 Shiki 上色的代码块；再切回图，不重新渲染", async () => {
    const user = userEvent.setup();
    const { container } = render(<Markdown text={fence("mermaid")} />);
    await rendered(container);
    const chart = chartOf(container)!;
    expect(highlight).not.toHaveBeenCalled();

    await user.click(within(chart).getByRole("button", { name: "查看源码" }));
    expect(within(chart).getByRole("button", { name: "查看源码" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(chart.querySelector(".tok")).not.toBeNull());
    expect(highlight).toHaveBeenCalledWith("graph TD\n  A --> B", "mermaid");
    expect(chart.querySelector("[data-chart-body]")).toHaveAttribute("hidden");
    expect(chart.querySelector("[data-chart-source]")).toHaveTextContent("graph TD");
    expect(within(chart).queryByRole("button", { name: "放大" })).toBeNull();

    await user.click(within(chart).getByRole("button", { name: "查看源码" }));
    expect(chart.querySelector("[data-chart-source]")).toBeNull();
    expect(chart.querySelector("[data-chart-body]")).not.toHaveAttribute("hidden");
    expect(chart.querySelector("[data-chart-body] svg[data-fake]")).not.toBeNull();
    expect(renderFake).toHaveBeenCalledTimes(1);
  });

  it("vega-lite 的源码按 json 上色（渲染器表里的 sourceLanguage）", async () => {
    CHART_RENDERERS["vega-lite"] = { load, zoomOnClick: false, sourceLanguage: "json" };
    const user = userEvent.setup();
    const { container } = render(<Markdown text={fence("vega-lite", '{"mark": "bar"}')} />);
    await rendered(container);
    await user.click(screen.getByRole("button", { name: "查看源码" }));
    await waitFor(() => expect(highlight).toHaveBeenCalledWith('{"mark": "bar"}', "json"));
    expect(container.querySelector("[data-chart-lang]")).toHaveTextContent("vega-lite");
  });

  it("10. 复制：剪贴板里是源码原文", async () => {
    const user = userEvent.setup();
    const body = "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C\n";
    const { container } = render(<Markdown text={fence("mermaid", body.trimEnd())} />);
    await rendered(container);
    await user.click(within(chartOf(container)!).getByRole("button", { name: "复制代码" }));
    expect(await navigator.clipboard.readText()).toBe(body.trimEnd());
  });

  it("放大：打开窗，里面是原图；点图本身也能放大（mermaid），Esc 关闭", async () => {
    const user = userEvent.setup();
    const { container } = render(<Markdown text={fence("mermaid")} />);
    await rendered(container);
    await user.click(screen.getByRole("button", { name: "放大" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("svg[data-fake]")).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(chartOf(container)).not.toBeNull();

    await user.click(container.querySelector("[data-chart-body]")!);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("vega-lite：点图本身不放大（和图表自己的交互冲突），只有放大按钮", async () => {
    const user = userEvent.setup();
    const { container } = render(<Markdown text={fence("vega-lite", "{}")} />);
    await rendered(container);
    await user.click(container.querySelector("[data-chart-body]")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "放大" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("12. 主包不静态引用图表库", () => {
  const files = ["components/Markdown.tsx", "components/CodeBlock.tsx", "components/ChartBlock.tsx", "charts/registry.ts", "charts/cache.ts", "charts/remark-chart-blocks.ts", "charts/theme.ts"];
  const staticImport = /^\s*(?:import|export)\s[^;]*?from\s*["'](?:mermaid|vega|vega-[^"']*)["']|^\s*import\s*["'](?:mermaid|vega|vega-[^"']*)["']/m;

  it.each(files)("%s 里没有 import ... from \"mermaid\" / \"vega*\"", (file) => {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    expect(source).not.toMatch(staticImport);
  });

  it("检查本身有效：能认出静态引入，认不出动态 import()", () => {
    expect(staticImport.test('import mermaid from "mermaid";')).toBe(true);
    expect(staticImport.test("import { embed } from 'vega-embed';")).toBe(true);
    expect(staticImport.test('import "vega";')).toBe(true);
    expect(staticImport.test('  load: () => import("mermaid"),')).toBe(false);
  });
});

describe("remarkChartBlocks：哪些代码块算闭合", () => {
  /** 解析 Markdown，返回每个带语言的 code 节点有没有被标上闭合。 */
  function closedFlags(text: string): boolean[] {
    const processor = unified().use(remarkParse).use(remarkChartBlocks);
    const tree = processor.parse(text) as unknown as MdNode;
    processor.runSync(tree as never, { value: text } as never);
    const out: boolean[] = [];
    const walk = (node: MdNode) => {
      if (node.type === "code") out.push((node.data?.hProperties as Record<string, string> | undefined)?.[CHART_CLOSED_ATTR] === "true");
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    return out;
  }

  it.each([
    ["```mermaid\nA-->B\n```", [true]],
    ["```mermaid\nA-->B\n```\n", [true]],
    ["```mermaid\nA-->B", [false]],
    ["```mermaid\nA-->B\n\n\n", [false]],
    ["```mermaid", [false]],
    ["````mermaid\nA-->B\n```", [false]],
    ["````mermaid\nA-->B\n`````", [true]],
    ["~~~mermaid\nA-->B\n~~~", [true]],
    ["~~~mermaid\nA-->B\n```", [false]],
    ["```mermaid\nA-->B\n~~~", [false]],
    ["```mermaid\nA-->B\n```  ", [true]],
    ["> ```mermaid\n> A-->B\n> ```", [true]],
    ["> ```mermaid\n> A-->B", [false]],
    ["- 步骤\n\n  ```mermaid\n  A-->B\n  ```", [true]],
    ["```mermaid\nA-->B\n```\n\n```mermaid\nC-->D", [true, false]],
  ])("%j", (text, expected) => {
    expect(closedFlags(text)).toEqual(expected);
  });
});
