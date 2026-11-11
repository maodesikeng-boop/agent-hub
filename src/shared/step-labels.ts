// agent 在做什么的状态词：全部在这里，别处不另写（网页和 hub worker show / log 共用，所以放 shared，web/step-labels.ts 原样转出）。照 Claude Code、t3code 的习惯用英文（docs/ui-standard.md 第 17 条）。
// 消息流里显示成一行“Running command…”，省略号的动效由 AgentStatus 加，这里的文字不带省略号；跑完是“Worked for 23s”。
// 工具的文案、分类只按通用动作（ToolAction）出；各家工具名到动作的翻译在各自 spec 的 tools.actions（docs/vendor-plugin-design.md 的 A16）。
import { VENDOR_LIST } from "../vendors/registry.ts";
import type { ToolAction } from "../vendors/types.ts";
import type { AgentStep, AgentStepInput } from "./domain.ts";
import { MAX_STEP_ARG_CHARS } from "./limits.ts";

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

/**
 * tool_use 的 input 里“在做什么”状态文案要用的字段名：skill 名、文件路径、连接器（MCP）的服务名与动作名。
 * 只推名字和路径，不推正文、命令、搜索词（这些可能很长或带隐私）。
 */
export const STEP_INPUT_KEYS = [
  "skill",
  "file_path",
  "notebook_path",
  "AbsolutePath",
  "TargetFile",
  "Path",
  "path",
  "server",
  "ServerName",
  "tool",
  "ToolName",
] as const;

/** 从任意 input 里挑出 STEP_INPUT_KEYS 的非空字符串，每个最多 MAX_STEP_ARG_CHARS 个字符（账本 stepOfTool 与驱动流式预览共用）。 */
export function pickStepInput(input: unknown): AgentStepInput {
  const kept: AgentStepInput = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return kept;
  const args = input as Record<string, unknown>;
  for (const key of STEP_INPUT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") kept[key] = [...value].slice(0, MAX_STEP_ARG_CHARS).join("");
  }
  return kept;
}

const fileName = (path: string | undefined): string | null => {
  if (path === undefined) return null;
  const name = path.split(/[\\/]/).findLast((part) => part !== "");
  return name === undefined ? null : name;
};

const filePathOf = (input: AgentStepInput): string | undefined =>
  input.file_path ?? input.notebook_path ?? input.AbsolutePath ?? input.TargetFile ?? input.Path ?? input.path;

/** “Reading a.ts”；没有文件名就写“Reading file”。 */
const onFile = (verb: string) => (input: AgentStepInput) => {
  const name = fileName(filePathOf(input));
  return name === null ? `${verb} file` : `${verb} ${name}`;
};

/** 读 `…/skills/<名字>/SKILL.md` 就是在加载这个技能（codex、agy、pi、cursor 都这样激活技能）。 */
const SKILL_FILE_RE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

/** 技能名：去掉插件命名空间（`superpowers:brainstorming` → `brainstorming`），名字本身照抄（用户打 `/名字` 用的就是它）。 */
function skillName(raw: string | undefined): string | null {
  const name = raw?.trim().split(":").findLast((part) => part.trim() !== "")?.trim();
  return name === undefined || name === "" ? null : name;
}

const loadingSkill = (raw: string | undefined): string => {
  const name = skillName(raw);
  return name === null ? "Loading skill" : `Loading skill ${name}`;
};

const reading = onFile("Reading");

/**
 * 连接器、工具名里常见品牌和缩写的写法（小写 → 写法）。服务名里没列的词首字母大写，动作名里没列的词小写。
 * 照 Codex 的习惯只做一件事：机器名变成人读的词，不翻译、不加解释。
 */
const DISPLAY_WORDS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  aws: "AWS",
  cli: "CLI",
  crm: "CRM",
  csv: "CSV",
  db: "DB",
  devtools: "DevTools",
  github: "GitHub",
  gitlab: "GitLab",
  hubspot: "HubSpot",
  clickup: "ClickUp",
  clickhouse: "ClickHouse",
  html: "HTML",
  http: "HTTP",
  id: "ID",
  ids: "IDs",
  jql: "JQL",
  json: "JSON",
  linkedin: "LinkedIn",
  mcp: "MCP",
  openai: "OpenAI",
  pdf: "PDF",
  sdk: "SDK",
  sql: "SQL",
  ui: "UI",
  url: "URL",
  urls: "URLs",
  youtube: "YouTube",
};

/** 机器名拆成词：下划线、连字符、点、空白，以及驼峰（`listIssues`、`getURLPath`）。 */
function splitWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.\-]+/)
    .filter((w) => w !== "");
}

/** 全大写的缩写（`URL`、`PR`）原样留着。 */
const isAcronym = (w: string): boolean => w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w);

/** 动作名：`list_issues` → `list issues`，`searchJiraIssuesUsingJql` → `search jira issues using JQL`。 */
function actionWords(raw: string): string {
  return splitWords(raw)
    .map((w) => DISPLAY_WORDS[w.toLowerCase()] ?? (isAcronym(w) ? w : w.toLowerCase()))
    .join(" ");
}

/**
 * 连接器服务名：去掉 Claude 的内部前缀（`claude_ai_Google_Drive` → `Google Drive`、`plugin_github_github` → `GitHub`），
 * 词首字母大写、常见品牌照官方写法。
 */
function connectorName(raw: string): string {
  let name = raw.trim().replace(/^claude_ai_/i, "");
  const plugin = /^plugin_[^_]+_(.+)$/i.exec(name);
  if (plugin?.[1] !== undefined) name = plugin[1];
  return splitWords(name)
    .map((w) => DISPLAY_WORDS[w.toLowerCase()] ?? (isAcronym(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

/** “Calling Linear: list issues”；只有服务名“Calling Linear”；只有动作“Calling list issues”；都没有“Calling tool”。 */
function callingText(server: string | undefined, tool: string | undefined): string {
  const s = server === undefined ? "" : connectorName(server);
  const t = tool === undefined ? "" : actionWords(tool);
  if (s !== "" && t !== "") return `Calling ${s}: ${t}`;
  if (s !== "") return `Calling ${s}`;
  if (t !== "") return `Calling ${t}`;
  return "Calling tool";
}

/** 通用动作 → 文案。 */
const ACTION_TEXT: Readonly<Record<ToolAction, (input: AgentStepInput) => string>> = {
  command: () => "Running command",
  read: (input) => {
    const skill = SKILL_FILE_RE.exec(filePathOf(input) ?? "")?.[1];
    return skill === undefined ? reading(input) : loadingSkill(skill);
  },
  edit: onFile("Editing"),
  write: onFile("Writing"),
  search: () => "Searching files",
  web_search: () => "Searching the web",
  web_fetch: () => "Reading web page",
  skill: (input) => loadingSkill(input.skill),
  subagent: () => "Running subagent",
  todo: () => "Updating todos",
  tool_search: () => "Finding tools",
  connector: (input) => callingText(input.server ?? input.ServerName, input.tool ?? input.ToolName),
  connector_resource: (input) => {
    const server = input.server ?? input.ServerName;
    const name = server === undefined ? "" : connectorName(server);
    return name === "" ? "Reading resources" : `Reading ${name} resources`;
  },
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
  connector_resource: "other",
};

/** MCP 工具的通用写法 mcp__<连接器>__<工具>（MCP 客户端的惯例，不是哪一家的）。 */
const MCP_PREFIX = "mcp__";
/** agy 把连接器工具直接露出来时的扁平写法 mcp_<连接器>_<工具>（拆不开哪段是服务名，docs/readonly-worker-design.md）。 */
const MCP_FLAT_PREFIX = "mcp_";

/** 工具名属于哪一类；null：认不出（统计里按原工具名单独计数）。连接器工具算“其它”。 */
export function toolCategory(name: string): ToolCategory | null {
  const action = toolAction(name);
  if (action !== undefined) return ACTION_CATEGORY[action];
  return name.startsWith(MCP_FLAT_PREFIX) ? "other" : null;
}

/** `mcp__<连接器>__<工具>`：“Calling Linear: list issues”（服务名、动作名见 connectorName、actionWords）。 */
function describeMcpTool(name: string): string {
  const rest = name.slice(MCP_PREFIX.length);
  if (rest === "") return STEP_TEXT.working;
  const separator = rest.indexOf("__");
  if (separator <= 0) return callingText(rest, undefined);
  const tool = rest.slice(separator + 2);
  return callingText(rest.slice(0, separator), tool === "" ? undefined : tool);
}

/** 没列的工具：“Using Monitor”；蛇形、连字符、小写开头驼峰的机器名拆成词（`generate_image` → `generate image`）。 */
function usingText(name: string): string {
  const machine = /[_-]/.test(name) || /^[a-z]+[A-Z]/.test(name);
  return `Using ${machine ? actionWords(name) || name : name}`;
}

function describeTool(name: string, input: AgentStepInput): string {
  if (name === "") return STEP_TEXT.working;
  const action = toolAction(name);
  if (action !== undefined) return ACTION_TEXT[action](input);
  if (name.startsWith(MCP_PREFIX)) return describeMcpTool(name);
  if (name.startsWith(MCP_FLAT_PREFIX) && name.length > MCP_FLAT_PREFIX.length) return callingText(undefined, name.slice(MCP_FLAT_PREFIX.length));
  return usingText(name);
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
