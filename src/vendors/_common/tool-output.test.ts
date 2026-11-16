// 工具返回原文摊平成文字（tool-output.ts）：各家结果字段的形状都走这一个函数，到 SKILL_LOAD_SCAN_MAX_CHARS 就停。
import { describe, expect, it } from "vitest";
import { SKILL_LOAD_SCAN_MAX_CHARS } from "../../shared/limits.ts";
import { toolOutputText } from "./tool-output.ts";

describe("toolOutputText", () => {
  it("各家的形状", () => {
    // claude tool_result 的 content：字符串，或文字块数组（图片块没有文字）
    expect(toolOutputText("1\t---\n2\tname: x")).toBe("1\t---\n2\tname: x");
    expect(toolOutputText([{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }])).toBe("a\n\nb");
    // pi 的 tool_execution_end.result
    expect(toolOutputText({ content: [{ type: "text", text: "pi 输出" }], details: {} })).toBe("pi 输出");
    // ACP（deepseek）tool_call_update 的 content
    expect(toolOutputText([{ type: "content", content: { type: "text", text: "dsh 输出" } }])).toBe("dsh 输出");
    // cursor 的 rawOutput：读文件 {content}，shell {exitCode, stdout, stderr}
    expect(toolOutputText({ content: "cursor 读到的" })).toBe("cursor 读到的");
    expect(toolOutputText({ exitCode: 0, stdout: "cursor 输出", stderr: "" })).toBe("cursor 输出");
  });

  it("没有文字：空串", () => {
    expect(toolOutputText(undefined)).toBe("");
    expect(toolOutputText(null)).toBe("");
    expect(toolOutputText(42)).toBe("");
    expect(toolOutputText({ exitCode: 1 })).toBe("");
  });

  it(`最多 ${SKILL_LOAD_SCAN_MAX_CHARS} 字，数组到上限就不再往后接`, () => {
    expect(toolOutputText("x".repeat(SKILL_LOAD_SCAN_MAX_CHARS + 10))).toHaveLength(SKILL_LOAD_SCAN_MAX_CHARS);
    const many = Array.from({ length: 10 }, () => ({ type: "text", text: "y".repeat(SKILL_LOAD_SCAN_MAX_CHARS / 2) }));
    expect(toolOutputText(many)).toHaveLength(SKILL_LOAD_SCAN_MAX_CHARS);
  });

  it("套娃再深也不爆栈", () => {
    let deep: unknown = { text: "底" };
    for (let i = 0; i < 100_000; i++) deep = { content: [deep] };
    expect(toolOutputText(deep)).toBe("底");
  });
});
