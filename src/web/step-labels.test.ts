import { describe, expect, it } from "vitest";
import type { AgentStep } from "../shared/index.ts";
import { describeStep, formatDuration, rateLimitedText, retryCountdownText, retryText, workedFor } from "./step-labels.ts";

const tool = (name: string, input: Record<string, string> = {}): AgentStep => ({ type: "tool_use", name, input });

describe("describeStep：状态词（英文）", () => {
  it("思考、写回复", () => {
    expect(describeStep({ type: "thinking" })).toBe("Thinking");
    expect(describeStep({ type: "text" })).toBe("Writing");
  });

  it("常见工具：跑命令、搜文件、搜网页、读网页、子任务、待办、找工具", () => {
    expect(describeStep(tool("Bash"))).toBe("Running command");
    expect(describeStep(tool("Grep"))).toBe("Searching files");
    expect(describeStep(tool("Glob"))).toBe("Searching files");
    expect(describeStep(tool("WebSearch"))).toBe("Searching the web");
    expect(describeStep(tool("WebFetch"))).toBe("Reading web page");
    expect(describeStep(tool("Agent"))).toBe("Running subagent");
    expect(describeStep(tool("TodoWrite"))).toBe("Updating todos");
    expect(describeStep(tool("ToolSearch"))).toBe("Finding tools");
    expect(describeStep(tool("Skill", { skill: "frontend-rules" }))).toBe("Loading skill frontend-rules");
    expect(describeStep(tool("Skill"))).toBe("Loading skill");
  });

  it("读、改、写文件：只写文件名", () => {
    expect(describeStep(tool("Read", { file_path: "/Users/a/src/web/App.tsx" }))).toBe("Reading App.tsx");
    expect(describeStep(tool("Edit", { file_path: "/x/y/z.ts" }))).toBe("Editing z.ts");
    expect(describeStep(tool("MultiEdit", { file_path: "/x/y/z.ts" }))).toBe("Editing z.ts");
    expect(describeStep(tool("Write", { file_path: "C:\\proj\\notes.md" }))).toBe("Writing notes.md");
    expect(describeStep(tool("NotebookEdit", { notebook_path: "/n/analysis.ipynb" }))).toBe("Editing analysis.ipynb");
  });

  it("没有文件名：只写动作", () => {
    expect(describeStep(tool("Read"))).toBe("Reading file");
    expect(describeStep(tool("Edit", { file_path: "/" }))).toBe("Editing file");
  });

  it("MCP 工具：Calling 连接器 工具", () => {
    expect(describeStep(tool("mcp__slack__search"))).toBe("Calling slack search");
    expect(describeStep(tool("mcp__chrome-devtools__take_screenshot"))).toBe("Calling chrome-devtools take_screenshot");
    expect(describeStep(tool("mcp__"))).toBe("Working");
    expect(describeStep(tool("mcp__slack"))).toBe("Calling slack");
    expect(describeStep(tool("mcp__slack__"))).toBe("Calling slack");
  });

  it("没列出来的工具：Using 工具名；工具名是空的：Working", () => {
    expect(describeStep(tool("Monitor"))).toBe("Using Monitor");
    expect(describeStep(tool(""))).toBe("Working");
  });

  it("没有 step（老服务端、刚开始）、脏的 step：Working", () => {
    expect(describeStep(undefined)).toBe("Working");
    expect(describeStep(null)).toBe("Working");
    expect(describeStep({ type: "bogus" } as unknown as AgentStep)).toBe("Working");
    expect(describeStep({ type: "tool_use", name: "Read" } as unknown as AgentStep)).toBe("Reading file");
  });
});

describe("用时", () => {
  it("不到 10 秒一位小数，之后整秒、分秒、时分", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(8_300)).toBe("8.3s");
    expect(formatDuration(23_400)).toBe("23s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("Worked for …", () => {
    expect(workedFor(23_000)).toBe("Worked for 23s");
  });
});

describe("等额度、重试", () => {
  it("等额度有恢复时间就写上", () => {
    expect(rateLimitedText("14:30")).toBe("Usage limit reached, resets 14:30");
    expect(rateLimitedText(null)).toBe("Usage limit reached");
  });

  it("重试第几次、倒计时", () => {
    expect(retryText(3, 10)).toBe("Retrying 3/10");
    expect(retryCountdownText(5)).toBe("in 5s");
  });
});
