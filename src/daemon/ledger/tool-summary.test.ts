import { describe, expect, it } from "vitest";
import { stepOfTool } from "./tool-summary.ts";

describe("stepOfTool：tool_use 变成“在做什么”", () => {
  it("名字照抄；Skill 带 skill 名，读写文件带 file_path，笔记本带 notebook_path", () => {
    expect(stepOfTool("Skill", { skill: "frontend-rules" })).toEqual({ type: "tool_use", name: "Skill", input: { skill: "frontend-rules" } });
    expect(stepOfTool("Read", { file_path: "/a/b/c.ts", offset: 3 })).toEqual({ type: "tool_use", name: "Read", input: { file_path: "/a/b/c.ts" } });
    expect(stepOfTool("NotebookEdit", { notebook_path: "/n.ipynb", new_source: "x" })).toEqual({
      type: "tool_use",
      name: "NotebookEdit",
      input: { notebook_path: "/n.ipynb" },
    });
  });

  it("其他参数（命令、网址、提示词）不带，免得把长内容推给网页", () => {
    expect(stepOfTool("Bash", { command: "rm -rf /" })).toEqual({ type: "tool_use", name: "Bash", input: {} });
    expect(stepOfTool("mcp__slack__search", { query: "secret" })).toEqual({ type: "tool_use", name: "mcp__slack__search", input: {} });
  });

  it("脏 input（null、字符串、数组、字段类型不对、空串）：只剩名字", () => {
    for (const input of [null, undefined, "x", 3, ["file_path"], { file_path: 5 }, { skill: "" }, { file_path: "  " }]) {
      expect(stepOfTool("Read", input)).toEqual({ type: "tool_use", name: "Read", input: {} });
    }
  });

  it("连接器调用：只留服务名、动作名（codex server / tool、agy ServerName / ToolName），参数正文不推", () => {
    expect(stepOfTool("call_mcp_tool", { ServerName: "linear", ToolName: "list_issues", Arguments: { query: "secret" } })).toEqual({
      type: "tool_use",
      name: "call_mcp_tool",
      input: { ServerName: "linear", ToolName: "list_issues" },
    });
    expect(stepOfTool("mcpToolCall", { server: "github", tool: "get_issue", arguments: { body: "x" } })).toEqual({
      type: "tool_use",
      name: "mcpToolCall",
      input: { server: "github", tool: "get_issue" },
    });
  });

  it("太长的参数截断", () => {
    const step = stepOfTool("Read", { file_path: `/${"a".repeat(1000)}` });
    expect(step.type === "tool_use" && step.input.file_path).toHaveLength(300);
  });
});
