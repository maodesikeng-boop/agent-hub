// agent 在做什么的状态词：全部在这里，别处不另写（网页和 hub worker show / log 共用，所以放 shared，web/step-labels.ts 原样转出）。照 Claude Code、t3code 的习惯用英文（docs/ui-standard.md 第 17 条）。
// 消息流里显示成一行“Running command…”，省略号的动效由 AgentStatus 加，这里的文字不带省略号；跑完是“Worked for 23s”。
// 工具的文案、分类只按通用动作（ToolAction）出；各家工具名到动作的翻译在各自 spec 的 tools.actions（docs/vendor-plugin-design.md 的 A16）。
import { VENDOR_LIST } from "../vendors/registry.ts";
import type { ToolAction } from "../vendors/types.ts";
import type { AgentStep, AgentStepInput } from "./domain.ts";

export const STEP_TEXT = {
  /** 老服务端没带 step、或认不出来时。 */
  working: "Working",
  thinking: "Thinking",
  /** assistant 在出文字。 */
  text: "Writing",
  stopping: "Stopping",
  /** Worker 开工前在跑项目的准备命令。 */
  preparing: "Running setup",
  /** Worker 一轮做完了，在等它放到后台的命令跑完（跑完它接着做、再汇报）。 */
  background: "Waiting for background command",
  rateLimited: "Usage limit reached",
} as const;

/** tool_use 的 input 里“在做什么”状态文案要用的字段名（文件路径与 skill 名）。 */
export const STEP_INPUT_KEYS = [
  "skill",
  "file_path",
  "notebook_path",
  "AbsolutePath",
  "TargetFile",
  "Path",
  "path",
] as const;

const fileName = (path: string | undefined): string | null => {
  if (path === undefined) return null;
  const name = path.split(/[\\/]/).findLast((part) => part !== "");
  return name === undefined ? null : name;
};

/** “Reading a.ts”；没有文件名就写“Reading file”。 */
const onFile = (verb: string) => (input: AgentStepInput) => {
  const name = fileName(
    input.file_path ?? input.notebook_path ?? input.AbsolutePath ?? input.TargetFile ?? input.Path ?? input.path,
  );
  return name === null ? `${verb} file` : `${verb} ${name}`;
};

/** 通用动作 → 文案。 */
const ACTION_TEXT: Readonly<Record<ToolAction, (input: AgentStepInput) => string>> = {
  command: () => "Running command",
  read: onFile("Reading"),
  edit: onFile("Editing"),
  write: onFile("Writing"),
  search: () => "Searching files",
  web_search: () => "Searching the web",
  web_fetch: () => "Reading web page",
  skill: (input) => (input.skill ? `Loading skill ${input.skill}` : "Loading skill"),
  subagent: () => "Running subagent",
  todo: () => "Updating todos",
  tool_search: () => "Finding tools",
  connector: () => "Calling tool",
};

/** 各家的工具名 → 通用动作，合成一张（同名的在各家是同一个动作，契约测试查）。 */
const TOOL_ACTIONS: Readonly<Record<string, ToolAction>> = Object.assign({}, ...VENDOR_LIST.map((spec) => spec.tools?.actions ?? {}));

/** 工具名对应的通用动作；没列的是 undefined。 */
function toolAction(name: string): ToolAction | undefined {
  return Object.hasOwn(TOOL_ACTIONS, name) ? TOOL_ACTIONS[name] : undefined;
}

/** 动作类别：跟厂商无关，hub worker log --stats 按它计数。 */
export type ToolCategory = "read" | "search" | "command" | "edit" | "web" | "other";
export const TOOL_CATEGORIES: readonly ToolCategory[] = ["read", "search", "command", "edit", "web", "other"];

/** 通用动作 → 类别：技能、子代理、待办、找工具、连接器这些认得但不属于前五类的算“其它”。 */
const ACTION_CATEGORY: Readonly<Record<ToolAction, ToolCategory>> = {
  command: "command",
  read: "read",
  edit: "edit",
  write: "edit",
  search: "search",
  web_search: "web",
  web_fetch: "web",
  skill: "other",
  subagent: "other",
  todo: "other",
  tool_search: "other",
  connector: "other",
};

/** MCP 工具的通用写法 mcp__<连接器>__<工具>（MCP 客户端的惯例，不是哪一家的）。 */
const MCP_PREFIX = "mcp__";

/** 工具名属于哪一类；null：认不出（统计里按原工具名单独计数）。连接器工具算“其它”。 */
export function toolCategory(name: string): ToolCategory | null {
  const action = toolAction(name);
  if (action !== undefined) return ACTION_CATEGORY[action];
  return name.startsWith(MCP_PREFIX) ? "other" : null;
}

/** `mcp__<连接器>__<工具>`：显示“Calling 连接器 工具”，名字照抄。 */
function describeMcpTool(name: string): string {
  const rest = name.slice(MCP_PREFIX.length);
  if (rest === "") return STEP_TEXT.working;
  const separator = rest.indexOf("__");
  if (separator <= 0) return `Calling ${rest}`;
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  return tool === "" ? `Calling ${server}` : `Calling ${server} ${tool}`;
}

function describeTool(name: string, input: AgentStepInput): string {
  if (name === "") return STEP_TEXT.working;
  const action = toolAction(name);
  if (action !== undefined) return ACTION_TEXT[action](input);
  if (name.startsWith(MCP_PREFIX)) return describeMcpTool(name);
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
