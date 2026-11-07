import { describe, expect, it } from "vitest";
import { mermaidConfig, mermaidThemeVariables } from "./mermaid-theme.ts";
import { TEST_THEME } from "./test-theme.ts";

describe("mermaid 主题：白底节点、1px 描边、前景色字，连线灰；不用默认的紫色", () => {
  it("节点底 = background，描边 = border，字 = foreground，连线 = muted-foreground，字号 13.5px", () => {
    expect(mermaidThemeVariables(TEST_THEME)).toMatchObject({
      background: "#ffffff",
      primaryColor: "#ffffff",
      primaryBorderColor: "#ececef",
      primaryTextColor: "#18181b",
      lineColor: "#71717a",
      textColor: "#18181b",
      fontFamily: "sans-serif",
      fontSize: "13.5px",
    });
  });

  it("所有颜色值都来自主题（不含 mermaid 默认的紫色 #ECECFF 一类）", () => {
    const allowed = new Set([TEST_THEME.foreground, TEST_THEME.mutedForeground, TEST_THEME.border, TEST_THEME.muted, TEST_THEME.background]);
    for (const [key, value] of Object.entries(mermaidThemeVariables(TEST_THEME))) {
      if (key === "fontSize" || key === "fontFamily") continue;
      expect(allowed.has(value), `${key}=${value}`).toBe(true);
    }
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
    expect(config.sequence).toMatchObject({ useMaxWidth: true });
    expect(config.maxTextSize).toBe(50_000);
    expect(config.maxEdges).toBe(500);
  });

  it("标签只留文字排版的标签：没有 img、iframe、a、style，也没有 src/href/style/on* 属性", () => {
    const { ALLOWED_TAGS, ALLOWED_ATTR } = mermaidConfig(TEST_THEME).dompurifyConfig;
    for (const tag of ["img", "image", "iframe", "object", "embed", "a", "style", "script", "svg", "use", "link"]) expect(ALLOWED_TAGS).not.toContain(tag);
    expect(ALLOWED_ATTR).toEqual(["class"]);
  });
});
