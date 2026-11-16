import { describe, expect, it } from "vitest";
import { splitCardTitle, splitLead } from "./card-text.ts";

describe("splitCardTitle", () => {
  it("第一行是标题，空一行以后是正文", () => {
    expect(splitCardTitle("方案好了，请验收\n\n**摘要**：做完了\n\n提交 `abc`")).toEqual({ title: "方案好了，请验收", body: "**摘要**：做完了\n\n提交 `abc`" });
  });

  it("没有空行就只有标题", () => {
    expect(splitCardTitle("  方案好了，请验收  ")).toEqual({ title: "方案好了，请验收", body: "" });
    expect(splitCardTitle("第一行\n第二行")).toEqual({ title: "第一行\n第二行", body: "" });
  });
});

describe("splitLead", () => {
  it("第一段是摘要，其余是细节", () => {
    expect(splitLead("**摘要**：做完了\n\n**交棒要点**：\n- 改了 a\n\n提交 `abc` · PR https://x/1")).toEqual({
      lead: "**摘要**：做完了",
      details: "**交棒要点**：\n- 改了 a\n\n提交 `abc` · PR https://x/1",
    });
  });

  it("只有一段：整段是摘要，没有细节", () => {
    expect(splitLead("做完了\n第二行也算同一段")).toEqual({ lead: "做完了\n第二行也算同一段", details: "" });
    expect(splitLead("   ")).toEqual({ lead: "", details: "" });
  });

  it("代码块里的空行不算段落分界", () => {
    const text = "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后面";
    expect(splitLead(text)).toEqual({ lead: "```ts\nconst a = 1;\n\nconst b = 2;\n```", details: "后面" });
  });

  it("开头的空行跳过，分界处多个空行、只有空格的行都当一个分界", () => {
    expect(splitLead("\n\n摘要\n \n\t\n细节")).toEqual({ lead: "摘要", details: "细节" });
  });
});
