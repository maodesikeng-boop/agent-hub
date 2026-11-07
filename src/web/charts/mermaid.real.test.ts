// 真的 mermaid 库 + 真的 DOMPurify，在 jsdom 里跑安全用例（jsdom 没有排版，下面补几个量尺寸的假实现，只管能画出来）。
// 逐条验证：agent 写的内容不能执行脚本、不能带出外链、不能把安全等级改松。像素效果看截图（PR 说明）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render as renderEngine } from "./mermaid.ts";
import { TEST_THEME } from "./test-theme.ts";

const proto = SVGElement.prototype as unknown as Record<string, unknown>;
const saved = { getBBox: proto.getBBox, getComputedTextLength: proto.getComputedTextLength };

beforeAll(() => {
  proto.getBBox = () => ({ x: 0, y: 0, width: 50, height: 16 });
  proto.getComputedTextLength = () => 50;
});
afterAll(() => {
  proto.getBBox = saved.getBBox;
  proto.getComputedTextLength = saved.getComputedTextLength;
});

const render = async (source: string) => (await renderEngine(source, TEST_THEME, document.createElement("div"))).svg;
const asDom = (svg: string) => new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;

/** 渲染期间页面里出现过的 <img>（浏览器会立刻去取它的 src）。 */
async function imagesDuringRender(run: () => Promise<unknown>): Promise<HTMLImageElement[]> {
  const seen: HTMLImageElement[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        seen.push(...(node instanceof HTMLImageElement ? [node] : []), ...node.querySelectorAll("img"));
      }
  });
  observer.observe(document, { childList: true, subtree: true });
  await run().catch(() => undefined);
  observer.disconnect();
  return seen;
}

/** 输出里不能有任何会执行脚本或发请求的东西。 */
function expectInert(svg: string) {
  expect(svg).not.toMatch(/<script/i);
  const root = asDom(svg);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      expect(attr.name, `<${el.tagName}> 的 ${attr.name}`).not.toMatch(/^on/i);
      expect(attr.value, `<${el.tagName}> 的 ${attr.name}`).not.toMatch(/javascript:/i);
    }
  }
  expect(root.querySelector("script, iframe, object, embed, image, img, foreignObject, a[href]")).toBeNull();
  // 样式里也不能有外链
  expect(svg).not.toMatch(/@import|url\(\s*["']?(?!#)/i);
}

describe("真 mermaid：安全", () => {
  it("正常的流程图（含中文节点）能画出来，节点文字在", async () => {
    const svg = await render("flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[完成]\n  B -->|否| A");
    expect(svg).toContain("<svg");
    for (const word of ["开始", "判断", "完成"]) expect(svg).toContain(word);
    expectInert(svg);
  });

  it("标签里的 <img onerror>、<script>：不会变成元素", async () => {
    const svg = await render('flowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]');
    expectInert(svg);
    expect(asDom(svg).querySelector("img, script")).toBeNull();
  });

  it("标签里的 <img src=外部地址>：渲染期间页面里根本不出现 img（不发请求）", async () => {
    const images = await imagesDuringRender(() => render('flowchart TD\n  A["<img src=\'https://evil.test/p.png\'>"] --> B["x <img src=//evil.test/q.png> y"]'));
    expect(images).toHaveLength(0);
  });

  it("图里的 %%{init}%% 想放开 dompurifyConfig 也不行", async () => {
    const images = await imagesDuringRender(() =>
      render('%%{init: {"dompurifyConfig": {"ADD_TAGS": ["img"], "ADD_ATTR": ["src"]}}}%%\nflowchart TD\n  A["<img src=\'https://evil.test/p.png\'>"] --> B'),
    );
    expect(images).toHaveLength(0);
  });

  it("click 回调和 javascript: 链接不生效", async () => {
    const svg = await render('flowchart TD\n  A --> B\n  click A call alert()\n  click B href "javascript:alert(1)"');
    expectInert(svg);
  });

  it("图里的 %%{init}%% 改不了 securityLevel，标签照样被洗", async () => {
    const svg = await render('%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B');
    expectInert(svg);
  });

  it("时序图里的脚本标签也被洗掉", async () => {
    const svg = await render("sequenceDiagram\n  A->>B: <img src=x onerror=alert(1)>\n  B-->>A: <script>alert(2)</script>");
    expectInert(svg);
  });

  it("语法错误：抛错，页面里不留临时节点、不弹窗", async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    await expect(render("flowchart TD\n  A --> --> B")).rejects.toThrow();
    expect(document.body.querySelectorAll("[id^='dchart-mermaid'], [id^='chart-mermaid']")).toHaveLength(0);
    expect(alertSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("超过大小上限：不渲染，抛错", async () => {
    const huge = `flowchart TD\n${"  A --> B\n".repeat(6_000)}`;
    await expect(render(huge)).rejects.toThrow();
  });

  it("饼图、甘特图用页面的分类色，不用 mermaid 自己算的色", async () => {
    const [first, second] = TEST_THEME.categoryColors;
    const pie = await render('pie title 来源\n  "网页" : 60\n  "iOS" : 40');
    expect(pie.toLowerCase()).toContain(first);
    expect(pie.toLowerCase()).toContain(second);
    expect(pie).not.toMatch(/hsl\(/i);
    const gantt = await render("gantt\n  dateFormat YYYY-MM-DD\n  section 一\n  做事 :a1, 2026-11-01, 3d\n  在做 :active, a2, after a1, 2d");
    expect(gantt.toLowerCase()).toContain(first);
    expect(gantt.toLowerCase()).toContain(second);
  });
});
