import { describe, expect, it } from "vitest";
import type { AgentStep } from "../shared/index.ts";
import { describeStep } from "./step-labels.ts";

const tool = (name: string, input: Record<string, string> = {}): AgentStep => ({ type: "tool_use", name, input });

describe("describeStep：状态文案映射", () => {
  it("思考、写回复", () => {
    expect(describeStep({ type: "thinking" })).toBe("在思考");
    expect(describeStep({ type: "text" })).toBe("在写回复");
  });

  it("运行命令、搜索、网页、子任务", () => {
    expect(describeStep(tool("Bash"))).toBe("在运行命令");
    expect(describeStep(tool("Grep"))).toBe("在搜索文件");
    expect(describeStep(tool("Glob"))).toBe("在搜索文件");
    expect(describeStep(tool("WebSearch"))).toBe("在搜索网页");
    expect(describeStep(tool("WebFetch"))).toBe("在读网页");
    expect(describeStep(tool("Agent"))).toBe("派了子任务");
    expect(describeStep(tool("Task"))).toBe("派了子任务");
  });

  it("读、改、写文件只显示文件名（不显示路径）", () => {
    expect(describeStep(tool("Read", { file_path: "/Users/a/src/web/App.tsx" }))).toBe("在读 App.tsx");
    expect(describeStep(tool("Edit", { file_path: "/x/y/z.ts" }))).toBe("在改 z.ts");
    expect(describeStep(tool("MultiEdit", { file_path: "/x/y/z.ts" }))).toBe("在改 z.ts");
    expect(describeStep(tool("Write", { file_path: "C:\\proj\\notes.md" }))).toBe("在写 notes.md");
    expect(describeStep(tool("NotebookEdit", { notebook_path: "/n/analysis.ipynb" }))).toBe("在改 analysis.ipynb");
  });

  it("没有文件名（或路径是空的）：只写动作", () => {
    expect(describeStep(tool("Read"))).toBe("在读文件");
    expect(describeStep(tool("Edit", { file_path: "/" }))).toBe("在改文件");
  });

  it("Skill 显示 skill 名，没有名字只写“在加载 skill”", () => {
    expect(describeStep(tool("Skill", { skill: "frontend-rules" }))).toBe("在加载 skill frontend-rules");
    expect(describeStep(tool("Skill"))).toBe("在加载 skill");
  });

  it("MCP 工具：连接器 · 工具名，原样显示；连接器名里有下划线、有连字符都行", () => {
    expect(describeStep(tool("mcp__slack__search_messages"))).toBe("在调用 slack 的 search_messages");
    expect(describeStep(tool("mcp__chrome-devtools__take_screenshot"))).toBe("在调用 chrome-devtools 的 take_screenshot");
    expect(describeStep(tool("mcp__plugin_parallel_parallel-search__web_search"))).toBe("在调用 plugin_parallel_parallel-search 的 web_search");
  });

  it("残缺的 MCP 名：显示剩下的，不崩", () => {
    expect(describeStep(tool("mcp__"))).toBe("在处理");
    expect(describeStep(tool("mcp__slack"))).toBe("在调用 slack");
    expect(describeStep(tool("mcp__slack__"))).toBe("在调用 slack");
    expect(describeStep(tool("mcp____x"))).toBe("在调用 __x");
  });

  it("没列出来的工具：在用 <工具名>；工具名是空的：在处理", () => {
    expect(describeStep(tool("Monitor"))).toBe("在用 Monitor");
    expect(describeStep(tool(""))).toBe("在处理");
  });

  it("没有 step（老服务端、刚开始）、脏的 step：在处理", () => {
    expect(describeStep(undefined)).toBe("在处理");
    expect(describeStep(null)).toBe("在处理");
    expect(describeStep({ type: "bogus" } as unknown as AgentStep)).toBe("在处理");
    expect(describeStep({ type: "tool_use", name: "Read" } as unknown as AgentStep)).toBe("在读文件");
  });
});
