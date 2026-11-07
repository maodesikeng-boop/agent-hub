import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_THEME as THEME } from "./test-theme.ts";

// 假的 mermaid 库：验证“怎么用它”（只初始化一次、临时节点收拾干净、结果再洗一遍）。真库在 mermaid.real.test.ts。
const lib = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, text: string) => Promise<{ svg: string }>>(),
}));
vi.mock("mermaid", () => ({ default: { initialize: lib.initialize, render: lib.render } }));

const OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g class="node"><rect width="10" height="10"/></g></svg>';

async function freshModule() {
  vi.resetModules();
  return import("./mermaid.ts");
}

beforeEach(() => {
  lib.initialize.mockReset();
  lib.render.mockReset();
  lib.render.mockResolvedValue({ svg: OK });
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("render（registry 的 ChartEngine）", () => {
  it("画进 el，返回同一份洗过的 SVG（进缓存用）；initialize 只调一次", async () => {
    const { render } = await freshModule();
    const el = document.createElement("div");
    const { svg } = await render("graph TD; A-->B", THEME, el);
    await render("graph TD; B-->C", THEME, document.createElement("div"));
    expect(svg).toContain("<svg");
    expect(el.innerHTML).toBe(svg);
    expect(lib.initialize).toHaveBeenCalledTimes(1);
    expect(lib.initialize.mock.calls[0]![0]).toMatchObject({ securityLevel: "strict", startOnLoad: false, theme: "base" });
    expect(lib.render).toHaveBeenCalledTimes(2);
  });

  it("el 在页面里时也不会被清理临时节点的那一步误删（svg 的 id 和临时节点的 id 相同）", async () => {
    const { render } = await freshModule();
    lib.render.mockImplementation(async (id) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><g/></svg>` }));
    const el = document.createElement("div");
    document.body.append(el);
    await render("a", THEME, el);
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("主题版本变了才重新 initialize", async () => {
    const { render } = await freshModule();
    const el = document.createElement("div");
    await render("a", THEME, el);
    await render("a", { ...THEME }, el);
    expect(lib.initialize).toHaveBeenCalledTimes(1);
    await render("a", { ...THEME, version: "dark", foreground: "#ffffff" }, el);
    expect(lib.initialize).toHaveBeenCalledTimes(2);
    expect(lib.initialize.mock.calls[1]![0].themeVariables.textColor).toBe("#ffffff");
  });

  it("每次渲染用不同的元素 id（mermaid 用它在页面里放临时节点）", async () => {
    const { render } = await freshModule();
    const el = document.createElement("div");
    await render("a", THEME, el);
    await render("a", THEME, el);
    const ids = lib.render.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);
  });

  it("源码超过上限：不渲染，直接报错（mermaid 自己超限只会画一张“超限”的图）", async () => {
    const { render } = await freshModule();
    const el = document.createElement("div");
    await expect(render("a".repeat(50_001), THEME, el)).rejects.toThrow("太长");
    expect(lib.render).not.toHaveBeenCalled();
    expect(el.innerHTML).toBe("");
  });

  it("语法错误：去掉 mermaid 贴的源码片段和指针行，剩一行“第几行 + 期望什么”（界面只显示第一行）", async () => {
    const { render } = await freshModule();
    lib.render.mockRejectedValue(new Error("Parse error on line 2:\n...A-->\n-----^\nExpecting 'SEMI', got 'LINK'"));
    await expect(render("bad", THEME, document.createElement("div"))).rejects.toThrow("Parse error on line 2: Expecting 'SEMI', got 'LINK'");
  });

  it("渲染失败：清掉 mermaid 留在 body 里的临时节点，错误信息往外抛，el 不动", async () => {
    const { render } = await freshModule();
    lib.render.mockImplementation(async (id) => {
      const leftover = document.createElement("div");
      leftover.id = `d${id}`;
      document.body.append(leftover);
      throw new Error("Parse error on line 2: Expecting 'SEMI'");
    });
    const el = document.createElement("div");
    await expect(render("bad", THEME, el)).rejects.toThrow("Parse error on line 2");
    expect(document.body.children).toHaveLength(0);
    expect(el.innerHTML).toBe("");
  });
});

describe("render 的输出再洗一遍（mermaid 自己洗过也不信）", () => {
  const dirty = async (svg: string) => {
    const { render } = await freshModule();
    lib.render.mockResolvedValue({ svg });
    return (await render("x", THEME, document.createElement("div"))).svg;
  };

  it("去掉 <script>", async () => {
    const out = await dirty('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g/></svg>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("<g");
  });

  it("去掉 on* 事件属性", async () => {
    const out = await dirty('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect onclick="alert(2)" onmouseover="alert(3)"/></svg>');
    expect(out).not.toMatch(/\son\w+=/i);
  });

  it("去掉 javascript: 链接（href 和 xlink:href）", async () => {
    const out = await dirty(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a href="javascript:alert(1)"><text>a</text></a><a xlink:href="javascript:alert(2)"><text>b</text></a></svg>',
    );
    expect(out).not.toMatch(/javascript:/i);
  });

  it("去掉 foreignObject 里的 HTML（img onerror、iframe）", async () => {
    const out = await dirty(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/><iframe src="javascript:alert(2)"></iframe></div></foreignObject></svg>',
    );
    expect(out).not.toMatch(/<img|<iframe|onerror/i);
  });

  it("保留正常图形和样式", async () => {
    const out = await dirty('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:#fff}</style><g class="a"><path d="M0 0L10 10"/><text>中文</text></g></svg>');
    expect(out).toContain("viewBox");
    expect(out).toContain("<path");
    expect(out).toContain("中文");
    expect(out).toContain("<style");
  });
});

describe("样式里的外链", () => {
  it("去掉 <style> 里的 @import 和指向外部的 url()，留 url(#id) 这种页内引用", async () => {
    const { render } = await freshModule();
    lib.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("http://evil.test/a.css");.a{fill:url(#grad)}.b{background:url(https://evil.test/x.png)}</style><g/></svg>',
    });
    const out = (await render("x", THEME, document.createElement("div"))).svg;
    expect(out).not.toMatch(/evil\.test|@import/);
    expect(out).toContain("url(#grad)");
  });
});
