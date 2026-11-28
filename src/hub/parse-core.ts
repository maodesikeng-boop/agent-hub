import { PM_MODES, type PmMode } from "../shared/domain.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { CAPABILITY_KINDS, type CapabilityKind } from "../shared/pm-capabilities.ts";
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
  if (group === "caps") {
    allowOnly(values, ["kind", "vendor"], "caps");
    expectPositionals(positionals.slice(1), 0, "caps");
    if (values.kind !== undefined && !(CAPABILITY_KINDS as readonly string[]).includes(values.kind)) {
      throw new UsageError(`--kind 只能是 ${CAPABILITY_KINDS.join("、")}`);
    }
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    const body: Record<string, unknown> = {};
    if (values.kind !== undefined) body.kind = values.kind as CapabilityKind;
    if (values.vendor !== undefined) body.vendor = values.vendor;
    return { command: "caps", body, textSource: null };
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

function parseScheduleFrequencyFlags(
  values: GroupArgs["values"],
  body: Record<string, unknown>,
  what: string,
  required: boolean,
): void {
  const hasDaily = values.daily !== undefined;
  const hasEvery = values.every !== undefined;
  if (hasDaily && hasEvery) {
    throw new UsageError(`${hub} ${what} 的频率要写 --daily HH:MM 或 --every 30m|2h，二选一`);
  }
  if (!hasDaily && !hasEvery) {
    if (required) throw new UsageError(`${hub} ${what} 的频率要写 --daily HH:MM 或 --every 30m|2h，二选一`);
    return;
  }
  if (hasDaily) {
    if (parseDailyTime(values.daily!) === null) throw new UsageError("--daily 要写成 HH:MM（24 小时制，如 09:00）");
    body.daily = values.daily;
    return;
  }
  const minutes = parseEvery(values.every!);
  if (minutes === null) throw new UsageError("--every 要写成 30m（分钟）或 2h（小时）");
  const bad = checkEveryMinutes(minutes);
  if (bad !== null) throw new UsageError(`--every：${bad}`);
  body.everyMinutes = minutes;
}

export function parseScheduleCommand({ group, action, rest, values }: GroupArgs): Parsed | undefined {
  if (group === "schedule" && action === "add") {
    allowOnly(values, ["name", "daily", "every", "stdin"], "schedule add");
    expectPositionals(rest, 0, "schedule add");
    if (values.name === undefined) throw new UsageError(`${hub} schedule add 要 --name <名>`);
    const body: Record<string, unknown> = { name: values.name };
    parseScheduleFrequencyFlags(values, body, "schedule add", true);
    return { command: "schedule.add", body, textSource: requireStdin(values, "schedule add"), textField: "prompt" };
  }
  if (group === "schedule" && action === "edit") {
    allowOnly(values, ["name", "daily", "every", "stdin"], "schedule edit");
    expectPositionals(rest, 1, "schedule edit");
    const scheduleId = idOf(rest[0], "schedule edit", "定时任务");
    const body: Record<string, unknown> = { scheduleId };
    if (values.name !== undefined) body.name = values.name;
    parseScheduleFrequencyFlags(values, body, "schedule edit", false);
    const hasStdin = values.stdin === true;
    if (values.name === undefined && values.daily === undefined && values.every === undefined && !hasStdin) {
      throw new UsageError(`${hub} schedule edit 至少要给一项要改的字段：--name、--daily、--every 或 --stdin`);
    }
    return hasStdin
      ? { command: "schedule.edit", body, textSource: { kind: "stdin" }, textField: "prompt" }
      : { command: "schedule.edit", body, textSource: null };
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
