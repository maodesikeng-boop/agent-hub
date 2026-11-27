import { posix, resolve } from "node:path";
import type { ParseArgsConfig } from "node:util";
import type { HubCommand } from "../shared/hub.ts";
import { checkHubLimit, formatHubLimitViolations } from "../shared/hub-limits.ts";
import { parseHubFileArg, type HubFileArg } from "../shared/deliverables.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { parseWorkerMaxTime } from "../shared/schedule.ts";
import { ALL_EFFORTS, isAgentVendor, normalizeEffortInput } from "../shared/vendors.ts";

const hub = HUB_COMMAND;

export type HubEnv = Record<string, string | undefined>;

export class UsageError extends Error {}

export function describeParseError(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : "";
  const quoted = /'(-[^'\s<]+)/.exec(message)?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `不认识的参数 ${quoted}`;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return message.includes("does not take an argument") ? `${quoted} 不带值` : `${quoted} 后面要跟一个值`;
  }
  if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") return "多了不认识的参数";
  return "参数的写法不对";
}

export type Options = {
  name?: string;
  folder?: string;
  description?: string;
  text?: string;
  stdin?: boolean;
  mode?: string;
  reason?: string;
  title?: string;
  vendor?: string;
  refresh?: boolean;
  model?: string;
  effort?: string;
  "clear-effort"?: boolean;
  "max-time"?: string;
  readonly?: boolean;
  caps?: string;
  allow?: string[];
  "no-outer-sandbox"?: boolean;
  "no-worktree"?: boolean;
  node?: string;
  graph?: string;
  "unmerged-ok"?: boolean;
  question?: string;
  context?: string;
  replace?: string;
  message?: string;
  summary?: string;
  pr?: string;
  worker?: string;
  file?: string[];
  link?: string[];
  all?: boolean;
  status?: string;
  recommended?: string;
  commit?: string;
  branch?: string;
  choice?: string;
  note?: string;
  clear?: boolean;
  daily?: string;
  every?: string;
  last?: string;
  stats?: boolean;
  limit?: string;
  task?: boolean;
  report?: boolean;
  option?: string[];
  device?: string;
  pm?: string;
  project?: string;
  verbatim?: boolean;
  "pm-name"?: string;
  build?: boolean;
  window?: string;
  since?: string;
  until?: string;
  scope?: string;
  sections?: string;
  format?: string;
  backlog?: string[];
  state?: string;
  "dry-run"?: boolean;
  help?: boolean;
};

export interface Parsed {
  command: HubCommand | "router.dispatch" | "self.reload";
  body: Record<string, unknown>;
  textSource: { kind: "stdin" } | { kind: "inline"; value: string } | null;
  textField?: "text" | "task" | "command" | "prompt" | "context" | "summary" | "note" | "specJson" | "summaryMd" | "question";
  textOptional?: boolean;
  textPrefix?: string;
}

export const HUB_ARG_OPTIONS = {
  name: { type: "string" },
  folder: { type: "string" },
  description: { type: "string" },
  text: { type: "string" },
  stdin: { type: "boolean" },
  mode: { type: "string" },
  reason: { type: "string" },
  title: { type: "string" },
  vendor: { type: "string" },
  refresh: { type: "boolean" },
  model: { type: "string" },
  effort: { type: "string" },
  "clear-effort": { type: "boolean" },
  "max-time": { type: "string" },
  readonly: { type: "boolean" },
  caps: { type: "string" },
  allow: { type: "string", multiple: true },
  "no-outer-sandbox": { type: "boolean" },
  "no-worktree": { type: "boolean" },
  node: { type: "string" },
  graph: { type: "string" },
  "unmerged-ok": { type: "boolean" },
  question: { type: "string" },
  context: { type: "string" },
  replace: { type: "string" },
  message: { type: "string" },
  summary: { type: "string" },
  pr: { type: "string" },
  worker: { type: "string" },
  file: { type: "string", multiple: true },
  link: { type: "string", multiple: true },
  all: { type: "boolean" },
  status: { type: "string" },
  recommended: { type: "string" },
  commit: { type: "string" },
  branch: { type: "string" },
  choice: { type: "string" },
  note: { type: "string" },
  clear: { type: "boolean" },
  daily: { type: "string" },
  every: { type: "string" },
  last: { type: "string" },
  stats: { type: "boolean" },
  limit: { type: "string" },
  task: { type: "boolean" },
  report: { type: "boolean" },
  option: { type: "string", multiple: true },
  device: { type: "string" },
  pm: { type: "string" },
  project: { type: "string" },
  verbatim: { type: "boolean" },
  "pm-name": { type: "string" },
  build: { type: "boolean" },
  window: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  scope: { type: "string" },
  sections: { type: "string" },
  format: { type: "string" },
  backlog: { type: "string", multiple: true },
  state: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

export interface GroupArgs {
  group: string;
  action: string | undefined;
  rest: string[];
  positionals: string[];
  values: Options;
  env: HubEnv;
  cwd: string;
}

export function expandPath(raw: string, env: HubEnv, cwd: string): string {
  const resolveFn =
    /^[A-Za-z]:/.test(cwd) || cwd.startsWith("\\\\") || cwd.includes("\\") || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\") || raw.includes("\\")
      ? resolve
      : posix.resolve;
  if (raw === "") throw new UsageError("路径不能是空的");
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    const home = env.HOME || env.USERPROFILE;
    if (home === undefined || home === "") throw new UsageError("路径以 ~ 开头，但没有设 HOME");
    const resolveHome =
      /^[A-Za-z]:/.test(home) || home.startsWith("\\\\") || home.includes("\\") ? resolve : posix.resolve;
    return resolveHome(home, raw.slice(2));
  }
  return resolveFn(cwd, raw);
}

export function fileArgsOf(raw: string[] | undefined, env: HubEnv, cwd: string): HubFileArg[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const violation = checkHubLimit("files", raw);
  if (violation !== null) throw new UsageError(formatHubLimitViolations([violation]));
  return raw.map((item) => {
    let arg: HubFileArg;
    try {
      arg = parseHubFileArg(item);
    } catch (error) {
      if (error instanceof RangeError) throw new UsageError(error.message);
      throw error;
    }
    return { label: arg.label, path: expandPath(arg.path, env, cwd) };
  });
}

export function allowOnly(values: Options, allowed: (keyof Options)[], what: string): void {
  for (const key of Object.keys(values) as (keyof Options)[]) {
    if (values[key] !== undefined && !allowed.includes(key)) throw new UsageError(`${hub} ${what} 不认 --${key}`);
  }
}

export function expectPositionals(positionals: string[], count: number, what: string): void {
  if (positionals.length !== count) throw new UsageError(`${hub} ${what} 的参数个数不对`);
}

export function idOf(raw: string | undefined, what: string, label: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new UsageError(`${hub} ${what} 要一个${label}编号（正整数）`);
  }
  return Number(raw);
}
export const workerIdOf = (raw: string | undefined, what: string) => idOf(raw, what, " Worker ");

export function maxTimeMsOf(raw: string): number {
  const parsed = parseWorkerMaxTime(raw);
  if (!parsed.ok) throw new UsageError(parsed.error);
  return parsed.maxTimeMs;
}

export function effortOf(vendor: string | undefined, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const candidate = normalizeEffortInput(isAgentVendor(vendor) ? vendor : undefined, raw);
  if (candidate === null || !ALL_EFFORTS.includes(candidate)) {
    throw new UsageError(`--effort 只能是 ${ALL_EFFORTS.join("、")}`);
  }
  return candidate;
}

export function requireStdin(values: Options, what: string): Parsed["textSource"] {
  if (values.stdin !== true) throw new UsageError(`${hub} ${what} 要 --stdin，正文从标准输入读`);
  return { kind: "stdin" };
}

export function textSourceOf(values: Options): Parsed["textSource"] {
  if (values.stdin === true && values.text !== undefined) throw new UsageError("--stdin 和 --text 只能用一个");
  if (values.stdin === true) return { kind: "stdin" };
  if (values.text !== undefined) return { kind: "inline", value: values.text };
  return null;
}

export function findGitBashMangledArg(argv: readonly string[], env: HubEnv): string | null {
  const msystem = env.MSYSTEM?.trim();
  if (!msystem) return null;
  const prefixes: string[] = [];
  const rawExePath = env.EXEPATH?.trim();
  if (rawExePath) {
    const normalizedExe = rawExePath.replace(/\\/g, "/").replace(/\/+$/, "");
    const gitRoot = normalizedExe.replace(/\/(?:mingw64|mingw32|ucrt64|clang64|usr)(?:\/bin)?$/i, "");
    if (gitRoot) prefixes.push(`${gitRoot.toLowerCase()}/`);
    prefixes.push(`${normalizedExe.toLowerCase()}/`);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const prev = i > 0 ? argv[i - 1] : undefined;
    if (prev === "--folder") continue;
    const normalized = arg.replace(/\\/g, "/");
    const lower = normalized.toLowerCase();
    const matchedExeRoot = prefixes.some((p) => lower.startsWith(p));
    const matchedDefaultGitRoot = /^[a-z]:\/(?:program files(?: \(x86\))?\/git|git)\/.+/i.test(normalized);
    if (matchedExeRoot || matchedDefaultGitRoot) {
      return arg;
    }
  }
  return null;
}

export function requireDevice(values: Options, what: string): string {
  const dev = values.device?.trim() ?? "";
  if (dev === "") throw new UsageError(`${hub} ${what} 要 --device <self|deviceId>`);
  return dev;
}

export function requireVerbatimOrStdin(values: Options, what: string): boolean {
  if (values.verbatim === true && values.stdin === true) {
    throw new UsageError("--verbatim 和 --stdin 只能用一个");
  }
  if (values.verbatim !== true && values.stdin !== true) {
    throw new UsageError(`${hub} ${what} 要 --verbatim 或 --stdin`);
  }
  return values.verbatim === true;
}
