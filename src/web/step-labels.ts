// agent 在做什么的状态词：全部在这里，别处不另写。照 Claude Code、t3code 的习惯用英文（docs/ui-standard.md 第 15 条）。
// 消息流里显示成一行“Running command…”，省略号的动效由 AgentStatus 加，这里的文字不带省略号；跑完是“Worked for 23s”。
//
// 注意：TOOL_TEXT 按 claude 的工具名（Bash、Read…）对应文案、describeMcpTool 认 claude 的 mcp__ 前缀，这是写死了厂商的。
// 以后由驱动层把工具名翻成通用动作（跑命令、读文件、改文件、搜文件、搜网页、调用连接器…），这里只按通用动作出文案。
import type { AgentStep, AgentStepInput } from "../shared/index.ts";

export const STEP_TEXT = {
  /** 老服务端没带 step、或认不出来时。 */
  working: "Working",
  thinking: "Thinking",
  /** assistant 在出文字。 */
  text: "Writing",
  stopping: "Stopping",
  /** Worker 开工前在跑项目的准备命令。 */
  preparing: "Running setup",
  rateLimited: "Usage limit reached",
} as const;

const fileName = (path: string | undefined): string | null => {
  if (path === undefined) return null;
  const name = path.split(/[\\/]/).findLast((part) => part !== "");
  return name === undefined ? null : name;
};

/** “Reading a.ts”；没有文件名就写“Reading file”。 */
const onFile = (verb: string) => (input: AgentStepInput) => {
  const name = fileName(input.file_path ?? input.notebook_path);
  return name === null ? `${verb} file` : `${verb} ${name}`;
};

/** 工具名（claude 原样的 tool_use.name）→ 文案；mcp__ 开头的和没列出来的见 describeTool。 */
const TOOL_TEXT: Readonly<Record<string, (input: AgentStepInput) => string>> = {
  Bash: () => "Running command",
  bash: () => "Running command",
  Read: onFile("Reading"),
  Edit: onFile("Editing"),
  MultiEdit: onFile("Editing"),
  NotebookEdit: onFile("Editing"),
  Write: onFile("Writing"),
  Skill: (input) => (input.skill ? `Loading skill ${input.skill}` : "Loading skill"),
  Grep: () => "Searching files",
  Glob: () => "Searching files",
  WebSearch: () => "Searching the web",
  WebFetch: () => "Reading web page",
  Agent: () => "Running subagent",
  Task: () => "Running subagent",
  TodoWrite: () => "Updating todos",
  ToolSearch: () => "Finding tools",
};

/** `mcp__<连接器>__<工具>`：显示“Calling 连接器 工具”，名字照抄。 */
function describeMcpTool(name: string): string {
  const rest = name.slice("mcp__".length);
  if (rest === "") return STEP_TEXT.working;
  const separator = rest.indexOf("__");
  if (separator <= 0) return `Calling ${rest}`;
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  return tool === "" ? `Calling ${server}` : `Calling ${server} ${tool}`;
}

function describeTool(name: string, input: AgentStepInput): string {
  if (name === "") return STEP_TEXT.working;
  const known = TOOL_TEXT[name];
  if (known) return known(input);
  if (name.startsWith("mcp__")) return describeMcpTool(name);
  return `Using ${name}`;
}

/** 一步 → 文案；没有（老服务端、刚开始）显示“Working”。 */
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

/** 额度用完在等：有恢复时间写“Usage limit reached, resets 14:30”。 */
export function rateLimitedText(resetsAt: string | null): string {
  return resetsAt === null ? STEP_TEXT.rateLimited : `${STEP_TEXT.rateLimited}, resets ${resetsAt}`;
}

/** 出错在自动重试：“Retrying 3/10”，倒计时另写（retryCountdownText）。 */
export function retryText(attempt: number, maxRetries: number): string {
  return `Retrying ${attempt}/${maxRetries}`;
}

export function retryCountdownText(seconds: number): string {
  return `in ${seconds}s`;
}

/** 用时：不到 10 秒带一位小数（8.3s，整数不带 .0），之后 23s、1m 5s、1h 2m。 */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 9_950) return `${Number((safe / 1000).toFixed(1))}s`;
  const total = Math.round(safe / 1000);
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const s = total % 60;
    return s === 0 ? `${Math.floor(total / 60)}m` : `${Math.floor(total / 60)}m ${s}s`;
  }
  const m = Math.floor((total % 3600) / 60);
  return m === 0 ? `${Math.floor(total / 3600)}h` : `${Math.floor(total / 3600)}h ${m}m`;
}

/** 一轮跑完后那一行：“Worked for 23s”。 */
export function workedFor(ms: number): string {
  return `Worked for ${formatDuration(ms)}`;
}
