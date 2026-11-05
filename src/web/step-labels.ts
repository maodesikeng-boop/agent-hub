// agent 在做什么的显示文案：映射表都在这里，别处不另写。
// 头像旁显示成“项目经理 · 在思考…”，省略号的动效由 AgentStatus 加，这里的文字不带省略号。
import type { AgentStep, AgentStepInput } from "../shared/index.ts";

export const STEP_TEXT = {
  /** 老服务端没带 step、或认不出来时。 */
  working: "在处理",
  thinking: "在思考",
  /** assistant 在出文字。 */
  text: "在写回复",
  stopping: "正在停止",
  preparing: "正在跑准备命令",
} as const;

const fileName = (path: string | undefined): string | null => {
  if (path === undefined) return null;
  const name = path.split(/[\\/]/).findLast((part) => part !== "");
  return name === undefined ? null : name;
};

/** “在读 a.ts”；没有文件名就只写动作。 */
const onFile = (verb: string) => (input: AgentStepInput) => {
  const name = fileName(input.file_path ?? input.notebook_path);
  return name === null ? `${verb}文件` : `${verb} ${name}`;
};

/** 工具名（claude 原样的 tool_use.name）→ 文案；mcp__ 开头的和没列出来的见 describeTool。 */
const TOOL_TEXT: Readonly<Record<string, (input: AgentStepInput) => string>> = {
  Bash: () => "在运行命令",
  bash: () => "在运行命令",
  Read: onFile("在读"),
  Edit: onFile("在改"),
  MultiEdit: onFile("在改"),
  NotebookEdit: onFile("在改"),
  Write: onFile("在写"),
  Skill: (input) => (input.skill ? `在加载 skill ${input.skill}` : "在加载 skill"),
  Grep: () => "在搜索文件",
  Glob: () => "在搜索文件",
  WebSearch: () => "在搜索网页",
  WebFetch: () => "在读网页",
  Agent: () => "派了子任务",
  Task: () => "派了子任务",
  TodoWrite: () => "在更新待办",
  ToolSearch: () => "在找工具",
};

/** `mcp__<连接器>__<工具>`：显示“在调用 连接器 的 工具”，名字照抄。 */
function describeMcpTool(name: string): string {
  const rest = name.slice("mcp__".length);
  if (rest === "") return STEP_TEXT.working;
  const separator = rest.indexOf("__");
  if (separator <= 0) return `在调用 ${rest}`;
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  return tool === "" ? `在调用 ${server}` : `在调用 ${server} 的 ${tool}`;
}

function describeTool(name: string, input: AgentStepInput): string {
  if (name === "") return STEP_TEXT.working;
  const known = TOOL_TEXT[name];
  if (known) return known(input);
  if (name.startsWith("mcp__")) return describeMcpTool(name);
  return `在用 ${name}`;
}

/** 一步 → 文案；没有（老服务端、刚开始）显示“在处理”。 */
export function describeStep(step: AgentStep | null | undefined): string {
  if (!step) return STEP_TEXT.working;
  switch (step.type) {
    case "thinking":
      return STEP_TEXT.thinking;
    case "text":
      return STEP_TEXT.text;
    case "tool_use":
      return describeTool(step.name, step.input ?? {});
    default:
      return STEP_TEXT.working;
  }
}
