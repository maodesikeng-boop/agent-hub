import { describe, expect, it } from "vitest";
import { contrastRatio } from "../lib/palette.ts";
import { mermaidConfig, mermaidThemeVariables } from "./mermaid-theme.ts";
import { TEST_THEME } from "./test-theme.ts";

describe("mermaid 主题：白底节点、1px 描边、前景色字，连线灰；不用默认的紫色", () => {
  it("节点底 = background，描边和连线 = muted-foreground，字 = foreground，字号 13.5px；分组和注释的边 = border", () => {
    expect(mermaidThemeVariables(TEST_THEME)).toMatchObject({
      background: "#ffffff",
      primaryColor: "#ffffff",
      primaryBorderColor: "#71717a",
      nodeBorder: "#71717a",
      clusterBorder: "#ececef",
      clusterBkg: "#f3f3f5",
      primaryTextColor: "#18181b",
      lineColor: "#71717a",
      textColor: "#18181b",
      fontFamily: "sans-serif",
      fontSize: "13.5px",
    });
  });

  it("节点描边对白底 ≥ 3:1（图形元素，WCAG 1.4.11）", () => {
    expect(contrastRatio(mermaidThemeVariables(TEST_THEME).nodeBorder!, TEST_THEME.background)).toBeGreaterThanOrEqual(3);
  });

  it("所有颜色值都来自主题（含分类色），不含 mermaid 默认的紫色 #ECECFF 一类", () => {
    const allowed = new Set([TEST_THEME.foreground, TEST_THEME.mutedForeground, TEST_THEME.border, TEST_THEME.muted, TEST_THEME.background, ...TEST_THEME.categoryColors]);
    for (const [key, value] of Object.entries(mermaidThemeVariables(TEST_THEME))) {
      if (key === "fontFamily" || key.endsWith("Size") || key.endsWith("Opacity")) continue;
      expect(allowed.has(value), `${key}=${value}`).toBe(true);
    }
  });

  it("饼图 pie1..pie12 和 cScale0..11 按序取分类色，比颜色多时从头再来；扇区字白色", () => {
    const vars = mermaidThemeVariables(TEST_THEME);
    const [first, second] = TEST_THEME.categoryColors;
    expect([vars.pie1, vars.pie2, vars.pie3, vars.pie4]).toEqual([first, second, first, second]);
    expect([vars.cScale0, vars.cScale1, vars.cScale2]).toEqual([first, second, first]);
    expect(vars.pie12).toBe(second);
    expect(vars.pieSectionTextColor).toBe(TEST_THEME.background);
    expect(vars.pieStrokeColor).toBe(TEST_THEME.background);
  });

  it("甘特图：普通任务取第 1 个分类色，进行中第 2 个，关键任务第 4 个，已完成灰；任务条里的字白色", () => {
    const theme = { ...TEST_THEME, categoryColors: ["#2563eb", "#c2410c", "#15803d", "#cc2c66"] };
    expect(mermaidThemeVariables(theme)).toMatchObject({
      taskBkgColor: "#2563eb",
      activeTaskBkgColor: "#c2410c",
      critBkgColor: "#cc2c66",
      doneTaskBkgColor: theme.mutedForeground,
      taskTextColor: theme.background,
      gridColor: theme.border,
    });
  });

  it("初始化配置：strict、不自动扫页面、不画错误图、base 主题、宽度跟容器、标签用 SVG 文字", () => {
    const config = mermaidConfig(TEST_THEME);
    expect(config.securityLevel).toBe("strict");
    expect(config.startOnLoad).toBe(false);
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.theme).toBe("base");
    expect(config.themeVariables).toEqual(mermaidThemeVariables(TEST_THEME));
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart).toMatchObject({ useMaxWidth: true });
    expect(config.look).toBe("classic");
    expect(config.sequence).toMatchObject({ useMaxWidth: true, actorFontSize: 13.5, noteFontSize: 13.5, messageFontSize: 13.5 });
    expect(config.maxTextSize).toBe(50_000);
    expect(config.maxEdges).toBe(500);
    expect(config.themeCSS).toContain(TEST_THEME.border);
  });

  it("标签只留文字排版的标签：没有 img、iframe、a、style，也没有 src/href/style/on* 属性", () => {
    const { ALLOWED_TAGS, ALLOWED_ATTR } = mermaidConfig(TEST_THEME).dompurifyConfig;
    for (const tag of ["img", "image", "iframe", "object", "embed", "a", "style", "script", "svg", "use", "link"]) expect(ALLOWED_TAGS).not.toContain(tag);
    expect(ALLOWED_ATTR).toEqual(["class"]);
  });
});
