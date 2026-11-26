import { describe, expect, it } from "vitest";
import { splitCardTitle } from "./card-text.ts";

describe("splitCardTitle", () => {
  it("第一行是标题，空一行以后是正文", () => {
    expect(splitCardTitle("方案好了，请验收\n\n**摘要**：做完了\n\n提交 `abc`")).toEqual({ title: "方案好了，请验收", body: "**摘要**：做完了\n\n提交 `abc`" });
  });

  it("没有空行就只有标题", () => {
    expect(splitCardTitle("  方案好了，请验收  ")).toEqual({ title: "方案好了，请验收", body: "" });
    expect(splitCardTitle("第一行\n第二行")).toEqual({ title: "第一行\n第二行", body: "" });
  });
});

