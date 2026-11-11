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

  it("读、改、写文件：只写文件名（兼容 claude / agy / codex 各种路径字段名）", () => {
    expect(describeStep(tool("Read", { file_path: "/Users/a/src/web/App.tsx" }))).toBe("Reading App.tsx");
    expect(describeStep(tool("Edit", { file_path: "/x/y/z.ts" }))).toBe("Editing z.ts");
    expect(describeStep(tool("MultiEdit", { file_path: "/x/y/z.ts" }))).toBe("Editing z.ts");
    expect(describeStep(tool("Write", { file_path: "C:\\proj\\notes.md" }))).toBe("Writing notes.md");
    expect(describeStep(tool("NotebookEdit", { notebook_path: "/n/analysis.ipynb" }))).toBe("Editing analysis.ipynb");
    expect(describeStep(tool("read_file", { Path: "/Users/a/src/main.ts" }))).toBe("Reading main.ts");
    expect(describeStep(tool("view_file", { AbsolutePath: "/Users/a/src/view.ts" }))).toBe("Reading view.ts");
    expect(describeStep(tool("view_file_outline", { AbsolutePath: "/Users/a/src/outline.ts" }))).toBe("Reading outline.ts");
    expect(describeStep(tool("view_code_item", { path: "/Users/a/src/item.ts" }))).toBe("Reading item.ts");
    expect(describeStep(tool("write_to_file", { TargetFile: "/Users/a/src/new.ts" }))).toBe("Writing new.ts");
    expect(describeStep(tool("edit_file", { Path: "/Users/a/src/edit.ts" }))).toBe("Editing edit.ts");
    expect(describeStep(tool("replace_file_content", { TargetFile: "/Users/a/src/rep.ts" }))).toBe("Editing rep.ts");
    expect(describeStep(tool("multi_replace_file_content", { TargetFile: "/Users/a/src/mrep.ts" }))).toBe("Editing mrep.ts");
    expect(describeStep(tool("fileChange", { path: "/Users/a/src/codex.ts" }))).toBe("Editing codex.ts");
    expect(describeStep(tool("apply_patch", { file_path: "/Users/a/src/patch.ts" }))).toBe("Editing patch.ts");
  });

  it("agy 与 codex 常见工具：跑命令、搜文件、搜网页、读网页、子代理、MCP", () => {
    expect(describeStep(tool("run_command"))).toBe("Running command");
    expect(describeStep(tool("grep_search"))).toBe("Searching files");
    expect(describeStep(tool("find_by_name"))).toBe("Searching files");
    expect(describeStep(tool("list_dir"))).toBe("Searching files");
    expect(describeStep(tool("search_web"))).toBe("Searching the web");
    expect(describeStep(tool("read_url_content"))).toBe("Reading web page");
    expect(describeStep(tool("invoke_subagent"))).toBe("Running subagent");

    expect(describeStep(tool("commandExecution"))).toBe("Running command");
    expect(describeStep(tool("exec_command"))).toBe("Running command");
    expect(describeStep(tool("webSearch"))).toBe("Searching the web");
    expect(describeStep(tool("web_search"))).toBe("Searching the web");
    expect(describeStep(tool("mcpToolCall"))).toBe("Calling tool");
  });

  it("没有文件名：只写动作", () => {
    expect(describeStep(tool("Read"))).toBe("Reading file");
    expect(describeStep(tool("Edit", { file_path: "/" }))).toBe("Editing file");
  });

  it("MCP 工具：Calling 服务: 动作（服务名去内部前缀、品牌大小写，动作名拆成小写词）", () => {
    expect(describeStep(tool("mcp__slack__search"))).toBe("Calling Slack: search");
    expect(describeStep(tool("mcp__chrome-devtools__take_screenshot"))).toBe("Calling Chrome DevTools: take screenshot");
    expect(describeStep(tool("mcp__shadcn__view_items_in_registries"))).toBe("Calling Shadcn: view items in registries");
    // claude.ai 连接器：去掉 claude_ai_
    expect(describeStep(tool("mcp__claude_ai_Linear__list_issues"))).toBe("Calling Linear: list issues");
    expect(describeStep(tool("mcp__claude_ai_Google_Drive__search"))).toBe("Calling Google Drive: search");
    expect(describeStep(tool("mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql"))).toBe("Calling Atlassian Rovo: search jira issues using JQL");
    // 插件带的：去掉 plugin_<插件名>_
    expect(describeStep(tool("mcp__plugin_github_github__get_issue"))).toBe("Calling GitHub: get issue");
    expect(describeStep(tool("mcp__plugin_parallel_parallel-search__web_search"))).toBe("Calling Parallel Search: web search");
    expect(describeStep(tool("mcp__plugin_pdf-viewer_pdf__display_pdf"))).toBe("Calling PDF: display PDF");
    // 缩写原样
    expect(describeStep(tool("mcp__rea__getURLPath"))).toBe("Calling Rea: get URL path");
    expect(describeStep(tool("mcp__"))).toBe("Working");
    expect(describeStep(tool("mcp__slack"))).toBe("Calling Slack");
    expect(describeStep(tool("mcp__slack__"))).toBe("Calling Slack");
  });

  it("不带 mcp__ 前缀的连接器调用：按参数里的服务名、动作名（codex mcpToolCall、agy call_mcp_tool），拿不到才 Calling tool", () => {
    expect(describeStep(tool("mcpToolCall", { server: "linear", tool: "list_issues" }))).toBe("Calling Linear: list issues");
    expect(describeStep(tool("mcpToolCall", { server: "Google Drive", tool: "search" }))).toBe("Calling Google Drive: search");
    expect(describeStep(tool("mcpToolCall", { server: "github" }))).toBe("Calling GitHub");
    expect(describeStep(tool("mcpToolCall", { tool: "listIssues" }))).toBe("Calling list issues");
    expect(describeStep(tool("mcpToolCall"))).toBe("Calling tool");
    expect(describeStep(tool("call_mcp_tool", { ServerName: "notion", ToolName: "notion-search" }))).toBe("Calling Notion: notion search");
    expect(describeStep(tool("call_mcp_tool"))).toBe("Calling tool");
    // agy 直接露出的扁平名 mcp_<服务>_<工具>：拆不开服务名，整段拆成词
    expect(describeStep(tool("mcp_linear_list_issues"))).toBe("Calling linear list issues");
  });

  it("连接器资源：Reading 服务 resources", () => {
    expect(describeStep(tool("list_resources", { ServerName: "linear" }))).toBe("Reading Linear resources");
    expect(describeStep(tool("read_resource", { ServerName: "claude_ai_Google_Drive" }))).toBe("Reading Google Drive resources");
    expect(describeStep(tool("read_mcp_resource", { server: "github" }))).toBe("Reading GitHub resources");
    expect(describeStep(tool("list_mcp_resources"))).toBe("Reading resources");
  });

  it("技能：读 …/skills/<名字>/SKILL.md 就是加载技能（正反斜杠都认），Skill 的命名空间前缀去掉", () => {
    expect(describeStep(tool("Read", { file_path: "/repo/.agents/skills/setup-pstack/SKILL.md" }))).toBe("Loading skill setup-pstack");
    expect(describeStep(tool("read_file", { Path: "C:\\Users\\a\\.codex\\skills\\frontend-rules\\SKILL.md" }))).toBe("Loading skill frontend-rules");
    expect(describeStep(tool("view_file", { AbsolutePath: "/Users/a/.gemini/skills/pdf/skill.md" }))).toBe("Loading skill pdf");
    expect(describeStep(tool("read", { path: "skills/brainstorm/SKILL.md" }))).toBe("Loading skill brainstorm");
    // 不是技能目录里的 SKILL.md、改 SKILL.md：照常
    expect(describeStep(tool("Read", { file_path: "/repo/docs/SKILL.md" }))).toBe("Reading SKILL.md");
    expect(describeStep(tool("Read", { file_path: "/repo/skills/a/b/SKILL.md" }))).toBe("Reading SKILL.md");
    expect(describeStep(tool("Edit", { file_path: "/repo/.agents/skills/setup-pstack/SKILL.md" }))).toBe("Editing SKILL.md");
    expect(describeStep(tool("Skill", { skill: "superpowers:brainstorming" }))).toBe("Loading skill brainstorming");
    expect(describeStep(tool("Skill", { skill: "a:b:c" }))).toBe("Loading skill c");
    expect(describeStep(tool("Skill", { skill: "plugin:" }))).toBe("Loading skill plugin");
    expect(describeStep(tool("Skill", { skill: ":" }))).toBe("Loading skill");
  });

  it("没列出来的工具：Using 工具名（蛇形、连字符、小写开头驼峰拆成词，大写开头照抄）；工具名是空的：Working", () => {
    expect(describeStep(tool("Monitor"))).toBe("Using Monitor");
    expect(describeStep(tool("TaskOutput"))).toBe("Using TaskOutput");
    expect(describeStep(tool("generate_image"))).toBe("Using generate image");
    expect(describeStep(tool("browser-open"))).toBe("Using browser open");
    expect(describeStep(tool("dynamicToolCall"))).toBe("Using dynamic tool call");
    expect(describeStep(tool("__"))).toBe("Using __");
    expect(describeStep(tool(""))).toBe("Working");
  });

  it("codex 子 agent 协作条目：Running subagent", () => {
    expect(describeStep(tool("collabAgentToolCall", { tool: "spawnAgent" }))).toBe("Running subagent");
    expect(describeStep(tool("collabToolCall"))).toBe("Running subagent");
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
