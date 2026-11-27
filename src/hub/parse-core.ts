import { PM_MODES, type PmMode } from "../shared/domain.ts";
import {
  DAILY_TELEMETRY_FORMATS,
  DAILY_TELEMETRY_SCOPES,
  DAILY_TELEMETRY_SECTIONS,
  type DailyTelemetryFormat,
  type DailyTelemetryScope,
  type DailyTelemetrySection,
} from "../shared/daily-telemetry.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { checkEveryMinutes, parseDailyTime, parseEvery } from "../shared/schedule.ts";
import { AGENT_VENDORS, isAgentVendor } from "../shared/vendors.ts";
import {
  UsageError,
  type Parsed,
  type GroupArgs,
  expandPath,
  allowOnly,
  expectPositionals,
  idOf,
  requireStdin,
  textSourceOf,
} from "./args.ts";

const hub = HUB_COMMAND;

export function parseCoreCommand({ group, action, rest, positionals, values, env, cwd }: GroupArgs): Parsed | undefined {
  if (group === "status") {
    allowOnly(values, [], "status");
    expectPositionals(positionals.slice(1), 0, "status");
    return { command: "status", body: {}, textSource: null };
  }
  if (group === "self-reload") {
    allowOnly(values, ["build"], "self-reload");
    expectPositionals(positionals.slice(1), 0, "self-reload");
    return { command: "self.reload", body: values.build === true ? { build: true } : {}, textSource: null };
  }
  if (group === "models") {
    allowOnly(values, ["vendor", "refresh"], "models");
    expectPositionals(positionals.slice(1), 0, "models");
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    const body: Record<string, unknown> = {};
    if (values.vendor !== undefined) body.vendor = values.vendor;
    if (values.refresh === true) body.refresh = true;
    return { command: "models", body, textSource: null };
  }
  if (group === "project" && action === "create") {
    allowOnly(values, ["name", "folder", "description"], "project create");
    expectPositionals(rest, 0, "project create");
    if (values.folder === undefined) throw new UsageError(`${hub} project create 要 --folder <主文件夹>`);
    const body: Record<string, unknown> = { folder: expandPath(values.folder, env, cwd) };
    if (values.name !== undefined) body.name = values.name;
    if (values.description !== undefined) body.description = values.description;
    return { command: "project.create", body, textSource: null };
  }
  if (group === "project" && (action === "attach" || action === "detach")) {
    allowOnly(values, [], `project ${action}`);
    expectPositionals(rest, 1, `project ${action}`);
    return { command: `project.${action}`, body: { folder: expandPath(rest[0] as string, env, cwd) }, textSource: null };
  }
  if (group === "project" && action === "setup") {
    allowOnly(values, ["stdin", "clear"], "project setup");
    expectPositionals(rest, 0, "project setup");
    if (values.stdin === true && values.clear === true) throw new UsageError("--stdin 和 --clear 只能用一个");
    if (values.clear === true) return { command: "project.setup", body: { command: null }, textSource: null };
    if (values.stdin !== true) throw new UsageError(`${hub} project setup 要 --stdin（准备命令从标准输入读）或 --clear（清除）`);
    return { command: "project.setup", body: {}, textSource: { kind: "stdin" }, textField: "command" };
  }
  if (group === "persona" && action === "show") {
    allowOnly(values, [], "persona show");
    expectPositionals(rest, 0, "persona show");
    return { command: "persona.show", body: {}, textSource: null };
  }
  if (group === "persona" && action === "edit") {
    allowOnly(values, ["mode", "reason", "text", "stdin"], "persona edit");
    expectPositionals(rest, 0, "persona edit");
    if (values.mode !== undefined && !(PM_MODES as readonly string[]).includes(values.mode)) {
      throw new UsageError(`--mode 只能是 ${PM_MODES.join(" 或 ")}`);
    }
    const textSource = textSourceOf(values);
    if (textSource === null && values.mode === undefined) {
      throw new UsageError(`${hub} persona edit 要新的性格设定（--stdin 或 --text）或者 --mode，至少一样`);
    }
    const body: Record<string, unknown> = {};
    if (values.mode !== undefined) body.mode = values.mode as PmMode;
    if (values.reason !== undefined) body.reason = values.reason;
    return { command: "persona.edit", body, textSource, textField: "text" };
  }
  return undefined;
}

export function parseScheduleCommand({ group, action, rest, values }: GroupArgs): Parsed | undefined {
  if (group === "schedule" && action === "add") {
    allowOnly(values, ["name", "daily", "every", "stdin"], "schedule add");
    expectPositionals(rest, 0, "schedule add");
    if (values.name === undefined) throw new UsageError(`${hub} schedule add 要 --name <名>`);
    if ((values.daily === undefined) === (values.every === undefined)) {
      throw new UsageError(`${hub} schedule add 的频率要写 --daily HH:MM 或 --every 30m|2h，二选一`);
    }
    const body: Record<string, unknown> = { name: values.name };
    if (values.daily !== undefined) {
      if (parseDailyTime(values.daily) === null) throw new UsageError("--daily 要写成 HH:MM（24 小时制，如 09:00）");
      body.daily = values.daily;
    } else {
      const minutes = parseEvery(values.every!);
      if (minutes === null) throw new UsageError("--every 要写成 30m（分钟）或 2h（小时）");
      const bad = checkEveryMinutes(minutes);
      if (bad !== null) throw new UsageError(`--every：${bad}`);
      body.everyMinutes = minutes;
    }
    return { command: "schedule.add", body, textSource: requireStdin(values, "schedule add"), textField: "prompt" };
  }
  if (group === "schedule" && action === "list") {
    allowOnly(values, [], "schedule list");
    expectPositionals(rest, 0, "schedule list");
    return { command: "schedule.list", body: {}, textSource: null };
  }
  if (group === "schedule" && (action === "show" || action === "pause" || action === "resume" || action === "remove")) {
    allowOnly(values, [], `schedule ${action}`);
    expectPositionals(rest, 1, `schedule ${action}`);
    return { command: `schedule.${action}`, body: { scheduleId: idOf(rest[0], `schedule ${action}`, "定时任务") }, textSource: null };
  }
  return undefined;
}

function parseTelemetryWindowMs(raw: string): number {
  const match = /^([1-9]\d*)([hd])$/i.exec(raw.trim());
  if (match === null) throw new UsageError("--window 要写成 24h（小时）或 7d（天）");
  const count = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  return unit === "h" ? count * 60 * 60 * 1000 : count * 24 * 60 * 60 * 1000;
}

function parseTelemetryTimestamp(raw: string, flag: "--since" | "--until"): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (Number.isSafeInteger(ms) && ms >= 0) return ms;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  throw new UsageError(`${flag} 要写毫秒时间戳或 ISO 时间（如 2026-11-28T00:00:00Z）`);
}

function parseTelemetryCommon(values: GroupArgs["values"]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (values.window !== undefined) body.windowMs = parseTelemetryWindowMs(values.window);
  if (values.since !== undefined) body.sinceMs = parseTelemetryTimestamp(values.since, "--since");
  if (values.until !== undefined) body.untilMs = parseTelemetryTimestamp(values.until, "--until");
  if (values.scope !== undefined) {
    if (!(DAILY_TELEMETRY_SCOPES as readonly string[]).includes(values.scope)) {
      throw new UsageError(`--scope 只能是 ${DAILY_TELEMETRY_SCOPES.join(" 或 ")}`);
    }
    body.scope = values.scope as DailyTelemetryScope;
  }
  return body;
}

export function parseTelemetryCommand({ group, action, rest, values, env, cwd }: GroupArgs): Parsed | undefined {
  if (group !== "telemetry") return undefined;
  if (action === "export") {
    allowOnly(values, ["window", "since", "until", "scope", "sections", "format"], "telemetry export");
    expectPositionals(rest, 0, "telemetry export");
    const body = parseTelemetryCommon(values);
    if (values.sections !== undefined) {
      const list = values.sections.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length === 0 || list.some((s) => !(DAILY_TELEMETRY_SECTIONS as readonly string[]).includes(s))) {
        throw new UsageError(`--sections 只能从 ${DAILY_TELEMETRY_SECTIONS.join(",")} 里选`);
      }
      body.sections = list as DailyTelemetrySection[];
    }
    if (values.format !== undefined) {
      if (!(DAILY_TELEMETRY_FORMATS as readonly string[]).includes(values.format)) {
        throw new UsageError(`--format 只能是 ${DAILY_TELEMETRY_FORMATS.join(" 或 ")}`);
      }
      body.format = values.format as DailyTelemetryFormat;
    }
    return { command: "telemetry.export", body, textSource: null };
  }
  if (action === "mine") {
    allowOnly(values, ["window", "since", "until", "scope", "backlog", "state", "dry-run"], "telemetry mine");
    expectPositionals(rest, 0, "telemetry mine");
    const body = parseTelemetryCommon(values);
    if (values.backlog !== undefined && values.backlog.length > 0) {
      body.backlogPaths = values.backlog.map((p) => expandPath(p, env, cwd));
    }
    if (values.state !== undefined) body.statePath = expandPath(values.state, env, cwd);
    if (values["dry-run"] === true) body.dryRun = true;
    return { command: "telemetry.mine", body, textSource: null };
  }
  return undefined;
}
