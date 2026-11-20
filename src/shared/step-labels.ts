import { VENDOR_LIST } from "../vendors/registry.ts";
import type { ToolAction } from "../vendors/types.ts";
import type { AgentStep, AgentStepInput } from "./domain.ts";
import { MAX_STEP_ARG_CHARS } from "./limits.ts";
import { skillNameOf, skillNameOfFile } from "./skill-names.ts";

export const STEP_TEXT = {
  working: "Working",
  thinking: "Thinking",
  text: "Writing",
  stopping: "Stopping",
  preparing: "Running setup",
  background: "Waiting for background command",
  rateLimited: "Usage limit reached",
} as const;

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

export const filePathOf = (input: AgentStepInput): string | undefined =>
  input.file_path ?? input.notebook_path ?? input.AbsolutePath ?? input.TargetFile ?? input.Path ?? input.path;

const onFile = (verb: string) => (input: AgentStepInput) => {
  const name = fileName(filePathOf(input));
  return name === null ? `${verb} file` : `${verb} ${name}`;
};

const loadingSkill = (raw: string | undefined): string => {
  const name = skillNameOf(raw);
  return name === null ? "Loading skill" : `Loading skill ${name}`;
};

const reading = onFile("Reading");

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

function splitWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.\-]+/)
    .filter((w) => w !== "");
}

const isAcronym = (w: string): boolean => w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w);

function actionWords(raw: string): string {
  return splitWords(raw)
    .map((w) => DISPLAY_WORDS[w.toLowerCase()] ?? (isAcronym(w) ? w : w.toLowerCase()))
    .join(" ");
}

function connectorName(raw: string): string {
  let name = raw.trim().replace(/^claude_ai_/i, "");
  const plugin = /^plugin_[^_]+_(.+)$/i.exec(name);
  if (plugin?.[1] !== undefined) name = plugin[1];
  return splitWords(name)
    .map((w) => DISPLAY_WORDS[w.toLowerCase()] ?? (isAcronym(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

function callingText(server: string | undefined, tool: string | undefined): string {
  const s = server === undefined ? "" : connectorName(server);
  const t = tool === undefined ? "" : actionWords(tool);
  if (s !== "" && t !== "") return `Calling ${s}: ${t}`;
  if (s !== "") return `Calling ${s}`;
  if (t !== "") return `Calling ${t}`;
  return "Calling tool";
}

const ACTION_TEXT: Readonly<Record<ToolAction, (input: AgentStepInput) => string>> = {
  command: () => "Running command",
  read: (input) => {
    const skill = skillNameOfFile(filePathOf(input) ?? "");
    return skill === null ? reading(input) : loadingSkill(skill);
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

const TOOL_ACTIONS: Readonly<Record<string, ToolAction>> = Object.assign({}, ...VENDOR_LIST.map((spec) => spec.tools?.actions ?? {}));

function toolAction(name: string): ToolAction | undefined {
  return Object.hasOwn(TOOL_ACTIONS, name) ? TOOL_ACTIONS[name] : undefined;
}

export type ToolCategory = "read" | "search" | "command" | "edit" | "web" | "other";
export const TOOL_CATEGORIES: readonly ToolCategory[] = ["read", "search", "command", "edit", "web", "other"];

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

const MCP_PREFIX = "mcp__";
const MCP_FLAT_PREFIX = "mcp_";

export function toolCategory(name: string): ToolCategory | null {
  const action = toolAction(name);
  if (action !== undefined) return ACTION_CATEGORY[action];
  return name.startsWith(MCP_FLAT_PREFIX) ? "other" : null;
}

function describeMcpTool(name: string): string {
  const rest = name.slice(MCP_PREFIX.length);
  if (rest === "") return STEP_TEXT.working;
  const separator = rest.indexOf("__");
  if (separator <= 0) return callingText(rest, undefined);
  const tool = rest.slice(separator + 2);
  return callingText(rest.slice(0, separator), tool === "" ? undefined : tool);
}

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

export function rateLimitedText(resetsAt: string | null): string {
  return resetsAt === null ? STEP_TEXT.rateLimited : `${STEP_TEXT.rateLimited}, resets ${resetsAt}`;
}

export function retryText(attempt: number, maxRetries: number): string {
  return `Retrying ${attempt}/${maxRetries}`;
}

export function retryCountdownText(seconds: number): string {
  return `in ${seconds}s`;
}

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

export function workedFor(ms: number): string {
  return `Worked for ${formatDuration(ms)}`;
}
