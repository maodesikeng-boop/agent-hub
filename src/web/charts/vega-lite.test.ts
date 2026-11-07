// Vega-Lite 渲染器（docs/charts-diagrams-design.md 第 2.3、7.2 节）：真库（vega、vega-lite、vega-embed）跑在 jsdom 里，
// 验证安全（不发请求、没有链接、不用 new Function、没有脚本）和主题；jsdom 没有 canvas，所以只走 SVG。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_CATEGORY_COLORS } from "../lib/palette.ts";
import { CHART_RENDERERS, isChartLanguage, type ChartTheme } from "./registry.ts";
import { checkVegaLiteSpec, blockedLoader, parseVegaLiteSource, sanitizeSvg } from "./vega-lite-security.ts";
import { vegaLiteConfig } from "./vega-lite-theme.ts";
import { render } from "./vega-lite.ts";
import * as vega from "vega";
import * as vegaLite from "vega-lite";

const theme: ChartTheme = {
  version: "test",
  foreground: "#18181b",
  mutedForeground: "#71717a",
  border: "#ececef",
  muted: "#f3f3f5",
  background: "#ffffff",
  fontFamily: "-apple-system, sans-serif",
  fontSize: 13.5,
  axisFontSize: 12,
  categoryColors: CHART_CATEGORY_COLORS,
};

const bar = {
  data: { values: [{ k: "A", v: 3 }, { k: "B", v: 5 }, { k: "C", v: 2 }] },
  mark: "bar",
  encoding: { x: { field: "k", type: "nominal" }, y: { field: "v", type: "quantitative" } },
};

const line = {
  data: {
    values: [
      { m: "1月", n: 3, s: "甲" }, { m: "2月", n: 5, s: "甲" }, { m: "3月", n: 4, s: "甲" },
      { m: "1月", n: 2, s: "乙" }, { m: "2月", n: 3, s: "乙" }, { m: "3月", n: 6, s: "乙" },
    ],
  },
  mark: "line",
  encoding: { x: { field: "m", type: "ordinal" }, y: { field: "n", type: "quantitative" }, color: { field: "s", type: "nominal" } },
};

let el: HTMLElement;
const draw = (spec: unknown) => render(JSON.stringify(spec), theme, el);

const fetchSpy = vi.fn();
const xhrSpy = vi.fn();
const imageSpy = vi.fn();

beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  fetchSpy.mockReset();
  xhrSpy.mockReset();
  imageSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("XMLHttpRequest", xhrSpy);
  vi.stubGlobal("Image", imageSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  el.remove();
});

describe("注册：vega-lite / vegalite 两个别名", () => {
  it("都认，点图不放大，源码按 json 上色；不认 vega", () => {
    expect(isChartLanguage("vega-lite")).toBe(true);
    expect(isChartLanguage("vegalite")).toBe(true);
    expect(isChartLanguage("vega")).toBe(false);
    expect(CHART_RENDERERS["vega-lite"]).toBe(CHART_RENDERERS.vegalite);
    expect(CHART_RENDERERS["vega-lite"]).toMatchObject({ zoomOnClick: false, sourceLanguage: "json" });
  });
});

describe("渲染", () => {
  it("柱状图：画进容器，返回带 viewBox 的 SVG 和 dispose，柱子用分类色第一色", async () => {
    const result = await draw(bar);
    const live = el.querySelector("svg");
    expect(live).not.toBeNull();
    expect(live!.querySelectorAll("path[role='graphics-symbol']").length).toBe(3);
    const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    const svg = doc.documentElement;
    expect(svg.tagName).toBe("svg");
    expect(svg.getAttribute("viewBox")).toMatch(/^0 0 [\d.]+ [\d.]+$/);
    expect(result.svg).toContain(CHART_CATEGORY_COLORS[0]);
    expect(typeof result.dispose).toBe("function");
    result.dispose!();
  });

  it("折线图：多系列按分类色顺序上色，中文标签原样出现", async () => {
    const result = await draw(line);
    expect(result.svg).toContain(CHART_CATEGORY_COLORS[0]);
    expect(result.svg).toContain(CHART_CATEGORY_COLORS[1]);
    expect(result.svg).toContain("1月");
    expect(result.svg).toContain("甲");
    result.dispose!();
  });

  it("calculate 表达式用解释器算出来（证明 interpreter 生效）", async () => {
    const result = await draw({
      data: { values: [{ a: 3 }] },
      transform: [{ calculate: "datum.a * 2 + 1", as: "b" }],
      mark: { type: "text", fontSize: 20 },
      encoding: { text: { field: "b", type: "quantitative" } },
    });
    expect(el.textContent).toContain("7");
    result.dispose!();
  });

  it("全程没有 new Function / Function()（对照：不开 ast 的 vega 编译表达式会调用）", async () => {
    const Original = globalThis.Function;
    let calls = 0;
    const counted = new Proxy(Original, {
      construct(target, args, newTarget) {
        calls += 1;
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, self, args) {
        calls += 1;
        return Reflect.apply(target, self, args);
      },
    });
    vi.stubGlobal("Function", counted);
    try {
      const result = await draw({
        data: { values: [{ a: 3 }, { a: 4 }] },
        transform: [{ calculate: "datum.a * 2 + 1", as: "b" }, { filter: "datum.b > 0" }],
        mark: "bar",
        encoding: { x: { field: "a", type: "ordinal" }, y: { field: "b", type: "quantitative" } },
      });
      expect(calls).toBe(0);
      result.dispose!();

      const compiled = vegaLite.compile({ data: { values: [{ a: 1 }] }, transform: [{ calculate: "datum.a + 1", as: "b" }], mark: "point" } as vegaLite.TopLevelSpec).spec;
      const view = new vega.View(vega.parse(compiled), { renderer: "none" });
      await view.runAsync();
      view.finalize();
      expect(calls).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", fetchSpy);
      vi.stubGlobal("XMLHttpRequest", xhrSpy);
      vi.stubGlobal("Image", imageSpy);
    }
  });

  it("没有操作菜单（actions:false）：没有 .vega-actions、没有导出/编辑器入口", async () => {
    const result = await draw(bar);
    expect(el.querySelector(".vega-actions")).toBeNull();
    expect(el.querySelector("details")).toBeNull();
    expect(el.querySelector("a")).toBeNull();
    result.dispose!();
  });

  it("规格里的 usermeta.embedOptions 不生效（不能打开菜单、不能指向外部配置）", async () => {
    const result = await draw({ ...bar, usermeta: { embedOptions: { actions: true, config: "http://127.0.0.1:9/x.json", loader: { baseURL: "http://127.0.0.1:9/" } } } });
    expect(el.querySelector(".vega-actions")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    result.dispose!();
  });

  it("数据里的 <script>、<img onerror>、javascript: 只当文字：容器和缓存的 SVG 里都没有脚本、事件属性、链接", async () => {
    const evil = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
    const result = await draw({
      data: { values: [{ k: evil, v: 3, link: "javascript:alert(1)" }, { k: "B", v: 5, link: "javascript:alert(2)" }] },
      title: evil,
      mark: "bar",
      encoding: { x: { field: "k", type: "nominal" }, y: { field: "v", type: "quantitative" }, tooltip: { field: "link" } },
    });
    for (const root of [el, new DOMParser().parseFromString(result.svg, "image/svg+xml")] as ParentNode[]) {
      expect(root.querySelector("script")).toBeNull();
      expect(root.querySelector("img")).toBeNull();
      expect(root.querySelector("a")).toBeNull();
      for (const node of root.querySelectorAll("*")) {
        for (const attr of node.attributes) {
          expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
          if (["href", "xlink:href", "src"].includes(attr.name.toLowerCase())) expect(attr.value.toLowerCase()).not.toContain("javascript:");
        }
      }
    }
    expect(el.textContent).toContain("<script>");
    result.dispose!();
  });

  it("数据行里有叫 url / href 的列没关系（只管规格里的通道）", async () => {
    const result = await draw({
      data: { values: [{ url: "/a", href: "/b", n: 1 }, { url: "/c", href: "/d", n: 2 }] },
      mark: "bar",
      encoding: { x: { field: "url", type: "nominal" }, y: { field: "n", type: "quantitative" } },
    });
    expect(el.querySelector("svg")).not.toBeNull();
    result.dispose!();
  });

  it("不是 JSON、不是对象、不是 Vega-Lite（完整 Vega 规格）：抛错，容器里不留东西", async () => {
    await expect(render("{ not json", theme, el)).rejects.toThrow(/JSON/);
    await expect(render("[1,2]", theme, el)).rejects.toThrow(/JSON 对象/);
    await expect(draw({ $schema: "https://vega.github.io/schema/vega/v6.json", width: 100, height: 100, marks: [{ type: "rect" }] })).rejects.toThrow();
    expect(el.childElementCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("安全：不发请求、没有链接、没有外部图片", () => {
  it.each([
    ["data.url", { data: { url: "http://127.0.0.1:9/x.csv" }, mark: "bar" }, /url/],
    ["相对路径的 data.url", { data: { url: "data/x.json" }, mark: "bar" }, /url/],
    ["lookup 里的 data.url", { data: { values: [{ a: 1 }] }, transform: [{ lookup: "a", from: { data: { url: "http://127.0.0.1:9/y.json" }, key: "a", fields: ["b"] } }], mark: "bar" }, /url/],
    ["图层里的 data.url", { layer: [{ data: { url: "http://127.0.0.1:9/x.json" }, mark: "bar" }] }, /url/],
    ["href 通道", { data: { values: [{ a: 1 }] }, mark: "bar", encoding: { href: { value: "http://evil.example/" } } }, /href/],
    ["mark 上的 href", { data: { values: [{ a: 1 }] }, mark: { type: "bar", href: "javascript:alert(1)" } }, /href/],
    ["图片 mark（字符串）", { data: { values: [{ a: 1 }] }, mark: "image", encoding: { url: { value: "http://127.0.0.1:9/i.png" } } }, /图片/],
    ["图片 mark（对象、在图层里）", { layer: [{ data: { values: [{ a: 1 }] }, mark: { type: "image", url: "http://127.0.0.1:9/i.png" } }] }, /图片|url/],
    ["参数绑定到页面元素", { data: { values: [{ a: 1 }] }, params: [{ name: "p", value: 1, bind: { input: "range", element: "body" } }], mark: "bar" }, /element/],
  ])("%s：直接拒绝，没有发出任何请求", async (_name, spec, message) => {
    await expect(draw(spec)).rejects.toThrow(message);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(imageSpy).not.toHaveBeenCalled();
    expect(el.childElementCount).toBe(0);
  });

  it("checkVegaLiteSpec：数据行（values、datasets）里的键不算", () => {
    expect(() => checkVegaLiteSpec({ data: { values: [{ url: "x", href: "y" }] }, mark: "bar" })).not.toThrow();
    expect(() => checkVegaLiteSpec({ datasets: { d: [{ url: "x", mark: "image" }] }, data: { name: "d" }, mark: "bar" })).not.toThrow();
  });

  it("checkVegaLiteSpec：嵌套很深也不爆栈", () => {
    let deep: unknown = { href: "x" };
    for (let i = 0; i < 20_000; i++) deep = { a: deep };
    expect(() => checkVegaLiteSpec(deep)).toThrow(/href/);
  });

  it("blockedLoader：load / sanitize / http / file 一律拒绝", async () => {
    const loader = blockedLoader();
    await expect(loader.load("http://127.0.0.1:9/x.json")).rejects.toThrow();
    await expect(loader.sanitize("http://127.0.0.1:9/x.png", { context: "image" })).rejects.toThrow();
    await expect(loader.sanitize("javascript:alert(1)", { context: "href" })).rejects.toThrow();
    await expect(loader.http("http://127.0.0.1:9/x.json")).rejects.toThrow();
    await expect(loader.file("/etc/passwd")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blockedLoader 真的接进了 vega（绕过规格检查也发不出请求）：View 读 data.url 失败，没有 fetch", async () => {
    const runtime = vega.parse({ data: [{ name: "t", url: "http://127.0.0.1:9/x.json", format: { type: "json" } }] });
    const warn = vi.fn();
    const view = new vega.View(runtime, { loader: blockedLoader() as unknown as vega.Loader, logger: { level: () => 0, error: vi.fn(), warn, info: vi.fn(), debug: vi.fn(), } as unknown as vega.LoggerInterface });
    await view.runAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(view.data("t")).toEqual([]);
    view.finalize();
  });

  it("parseVegaLiteSource：去掉 usermeta，返回新对象", () => {
    const spec = parseVegaLiteSource(JSON.stringify({ ...bar, usermeta: { embedOptions: { actions: true } } }));
    expect(spec).not.toHaveProperty("usermeta");
    expect(spec).toMatchObject({ mark: "bar" });
  });
});

describe("sanitizeSvg：缓存的 SVG 再洗一遍", () => {
  it("去掉 script、foreignObject、a、image、事件属性、javascript: / 外部链接", () => {
    const dirty =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">` +
      `<script>alert(1)</script><foreignObject><div>x</div></foreignObject>` +
      `<a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a><rect width="5" height="5" onclick="alert(1)" fill="red"/>` +
      `<image href="http://127.0.0.1:9/i.png"/><use href="http://127.0.0.1:9/u.svg#a"/>` +
      `<text x="1" y="1">hi</text></svg>`;
    const clean = sanitizeSvg(dirty);
    const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
    for (const tag of ["script", "foreignObject", "a", "image", "use"]) expect(doc.querySelector(tag)).toBeNull();
    expect(clean).not.toMatch(/onload|onclick|javascript:|127\.0\.0\.1/);
    expect(doc.querySelector("rect")?.getAttribute("fill")).toBe("red");
    expect(doc.querySelector("text")?.textContent).toBe("hi");
  });

  it("解析不了的内容：抛错，不原样放行", () => {
    expect(() => sanitizeSvg("<svg><unclosed")).toThrow();
  });
});

describe("主题 vegaLiteConfig", () => {
  const c = vegaLiteConfig(theme);

  it("分类色取调色板，字体、字号、颜色取主题", () => {
    expect(c.range?.category).toEqual([...CHART_CATEGORY_COLORS]);
    expect(c.font).toBe(theme.fontFamily);
    expect(c.axis).toMatchObject({ labelFontSize: 12, titleFontSize: 13.5, labelColor: theme.mutedForeground, titleColor: theme.foreground, gridColor: theme.border });
    expect(c.legend).toMatchObject({ labelFontSize: 12, titleFontSize: 13.5, labelColor: theme.foreground });
    expect(c.title).toMatchObject({ fontSize: 13.5, color: theme.foreground, anchor: "start" });
    expect(c.background).toBe(theme.background);
  });

  it("没写颜色的 mark 用第一个分类色，悬停提示默认开；没有紫色", () => {
    expect(c.mark).toMatchObject({ color: CHART_CATEGORY_COLORS[0], tooltip: true });
    expect(JSON.stringify(c).toLowerCase()).not.toMatch(/purple|violet/);
  });
});
