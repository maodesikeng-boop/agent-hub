import type { HubCommand } from "./hub.ts";
import { HUB_COMMAND } from "./names.ts";
import {
  ASK_BODY_MAX_CHARS,
  ASK_MAX_OPTION_CHARS,
  ASK_MAX_OPTIONS,
  CAPABILITY_KEY_MAX_CODE_UNITS,
  CHECKLIST_MAX_ITEMS,
  CHECKLIST_TITLE_MAX_CHARS,
  DELIVERABLE_LABEL_MAX_CHARS,
  HUB_FILE_ARGS_MAX,
  HUB_MAX_BODY_BYTES,
  MAX_ACTIVE_GRAPHS_PER_PROJECT,
  MAX_DECISION_CHOICE_CHARS,
  MAX_DECISION_NOTE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_GATE_OPTIONS,
  MAX_GATE_QUESTION_CHARS,
  MAX_GATE_SUMMARY_CHARS,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_GOAL_CHARS,
  MAX_GRAPH_NODES,
  MAX_GRAPH_SPEC_BYTES,
  MAX_GRAPH_TITLE_CHARS,
  MAX_MODEL_CHARS,
  MAX_NAME_CHARS,
  MAX_NODE_ARTIFACT_SUMMARY_CHARS,
  MAX_NODE_KEY_CHARS,
  MAX_NODE_TITLE_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULES_PER_PM,
  MAX_SETUP_COMMAND_BYTES,
  MAX_SENT_FILE_BYTES,
  MAX_SENT_FILES_TOTAL_BYTES,
  MAX_STEP_BASE_CHARS,
  MAX_STEP_BRIEF_CHARS,
  MAX_TASK_BYTES,
  MAX_WORKER_TITLE_CHARS,
  ROUTER_QUESTION_MAX_CHARS,
  ROUTER_OPTION_MAX_COUNT,
  ROUTER_PENDING_DECISIONS_PER_PM_MAX,
  ROUTER_REPORT_SUMMARY_MAX_CHARS,
  ROUTER_REPORT_LINK_LABEL_MAX_CHARS,
  ROUTER_REPORT_LINK_TARGET_MAX_CHARS,
  ROUTER_REPORT_LINKS_MAX,
  WORKER_LOG_MAX_STEPS,
  WORKER_CAPABILITY_ALLOW_MAX,
  WORKER_SEARCH_MAX_KEYWORD_CHARS,
  WORKER_SEARCH_MAX_KEYWORDS,
  WORKER_SEARCH_MAX_LIMIT,
} from "./limits.ts";

// Invariant: every length, size, or count limit an agent can hit through a hub command is one rule here,
// and hub help lines and rejection messages are rendered from these rules only.

export type HubLimitUnit = "chars" | "bytes" | "items";

export interface HubLimitRule {
  label: string;
  unit: HubLimitUnit;
  max: number;
  /** Commands whose usage lists this rule; empty for rules shown in the shared stdin footer. */
  commands: readonly HubCommand[];
  tip?: string;
}

const LONG_TEXT_TIP = "长材料存成文件，正文里写路径";
const ASK_TIP = "长材料存成文件，用 --file 挂在卡上";
const ASK_SPLIT_TIP = "第一行写问题，空一行再写背景";

export const HUB_LIMITS = {
  stdin: { label: "标准输入", unit: "bytes", max: HUB_MAX_BODY_BYTES, commands: [] },
  request: { label: "请求体", unit: "bytes", max: HUB_MAX_BODY_BYTES, commands: [] },
  cliRequest: { label: "请求体", unit: "bytes", max: 4 * HUB_MAX_BODY_BYTES, commands: [] },
  "project.name": { label: "项目名", unit: "chars", max: MAX_NAME_CHARS, commands: ["project.create"] },
  "project.description": { label: "项目说明", unit: "chars", max: MAX_DESCRIPTION_CHARS, commands: ["project.create"] },
  "project.folder": { label: "文件夹路径", unit: "bytes", max: MAX_PATH_BYTES, commands: ["project.create", "project.attach", "project.detach"] },
  "project.setup": { label: "准备命令", unit: "bytes", max: MAX_SETUP_COMMAND_BYTES, commands: ["project.setup"] },
  "persona.text": { label: "性格设定", unit: "bytes", max: MAX_PERSONA_BYTES, commands: ["persona.edit"] },
  "persona.reason": { label: "理由", unit: "chars", max: MAX_REASON_CHARS, commands: ["persona.edit"] },
  "worker.title": { label: "Worker 标题", unit: "chars", max: MAX_WORKER_TITLE_CHARS, commands: ["worker.start"] },
  "worker.task": { label: "任务说明", unit: "bytes", max: MAX_TASK_BYTES, commands: ["worker.start", "worker.send"], tip: LONG_TEXT_TIP },
  "worker.model": { label: "模型名", unit: "chars", max: MAX_MODEL_CHARS, commands: ["worker.start", "graph.create", "graph.patch"] },
  "worker.allow": { label: "点名的外接能力", unit: "items", max: WORKER_CAPABILITY_ALLOW_MAX, commands: ["worker.start", "graph.create", "graph.patch"] },
  "worker.allowKey": { label: "外接能力标识（UTF-16）", unit: "chars", max: CAPABILITY_KEY_MAX_CODE_UNITS, commands: ["worker.start", "graph.create", "graph.patch"] },
  "worker.searchKeywords": { label: "关键词", unit: "items", max: WORKER_SEARCH_MAX_KEYWORDS, commands: ["worker.search"] },
  "worker.searchKeyword": { label: "每个关键词", unit: "chars", max: WORKER_SEARCH_MAX_KEYWORD_CHARS, commands: ["worker.search"] },
  "worker.searchLimit": { label: "--limit", unit: "items", max: WORKER_SEARCH_MAX_LIMIT, commands: ["worker.search"] },
  "worker.logSteps": { label: "--last", unit: "items", max: WORKER_LOG_MAX_STEPS, commands: ["worker.log"] },
  "ask.question": { label: "问题第一行", unit: "chars", max: ROUTER_QUESTION_MAX_CHARS, commands: ["ask"], tip: ASK_SPLIT_TIP },
  "ask.body": { label: "提问背景", unit: "chars", max: ASK_BODY_MAX_CHARS, commands: ["ask"], tip: ASK_TIP },
  "ask.stepQuestion": { label: "步骤拍板卡问题", unit: "chars", max: MAX_GATE_QUESTION_CHARS, commands: ["ask"], tip: ASK_SPLIT_TIP },
  "ask.stepBody": { label: "步骤拍板卡背景", unit: "chars", max: MAX_GATE_SUMMARY_CHARS, commands: ["ask"], tip: ASK_TIP },
  "ask.options": { label: "选项", unit: "items", max: ASK_MAX_OPTIONS, commands: ["ask"] },
  "ask.stepOptions": { label: "步骤拍板卡选项", unit: "items", max: MAX_GATE_OPTIONS, commands: ["ask"] },
  "ask.legacyRouterOptions": { label: "旧用法 router ask 的选项", unit: "items", max: ROUTER_OPTION_MAX_COUNT, commands: ["ask"] },
  "ask.option": { label: "每个选项", unit: "chars", max: ASK_MAX_OPTION_CHARS, commands: ["ask"] },
  files: { label: "--file", unit: "items", max: HUB_FILE_ARGS_MAX, commands: ["ask", "router.report"] },
  fileLabel: { label: "文件标签", unit: "chars", max: DELIVERABLE_LABEL_MAX_CHARS, commands: ["ask", "router.report"] },
  filePath: { label: "文件路径", unit: "bytes", max: MAX_PATH_BYTES, commands: ["ask", "router.report"] },
  fileSize: { label: "每个文件", unit: "bytes", max: MAX_SENT_FILE_BYTES, commands: ["ask", "router.report"] },
  fileTotalSize: { label: "文件合计", unit: "bytes", max: MAX_SENT_FILES_TOTAL_BYTES, commands: ["ask", "router.report"] },
  "ask.pending": { label: "未决拍板卡", unit: "items", max: ROUTER_PENDING_DECISIONS_PER_PM_MAX, commands: ["ask"], tip: "等用户拍板，或用 --replace <旧卡编号> 替换旧卡" },
  "schedule.name": { label: "定时任务名称", unit: "chars", max: MAX_SCHEDULE_NAME_CHARS, commands: ["schedule.add"] },
  "schedule.prompt": { label: "任务说明", unit: "bytes", max: MAX_TASK_BYTES, commands: ["schedule.add"], tip: LONG_TEXT_TIP },
  "schedule.count": { label: "定时任务", unit: "items", max: MAX_SCHEDULES_PER_PM, commands: ["schedule.add"], tip: `用 ${HUB_COMMAND} schedule remove <编号> 删掉不要的定时任务` },
  "router.reportSummary": { label: "汇报摘要", unit: "chars", max: ROUTER_REPORT_SUMMARY_MAX_CHARS, commands: ["router.report"], tip: "细节放进 --file 或 --link" },
  "router.links": { label: "--link", unit: "items", max: ROUTER_REPORT_LINKS_MAX, commands: ["router.report"] },
  "router.linkLabel": { label: "链接标题", unit: "chars", max: ROUTER_REPORT_LINK_LABEL_MAX_CHARS, commands: ["router.report"] },
  "router.linkTarget": { label: "链接地址", unit: "chars", max: ROUTER_REPORT_LINK_TARGET_MAX_CHARS, commands: ["router.report"] },
  "graph.spec": { label: "JSON 正文", unit: "bytes", max: MAX_GRAPH_SPEC_BYTES, commands: ["graph.create", "graph.patch"] },
  "graph.title": { label: "任务图标题", unit: "chars", max: MAX_GRAPH_TITLE_CHARS, commands: ["graph.create", "graph.patch"] },
  "graph.activeCount": { label: "项目内活跃任务图", unit: "items", max: MAX_ACTIVE_GRAPHS_PER_PROJECT, commands: ["graph.create"], tip: `先完结或用 ${HUB_COMMAND} graph cancel 取消不再需要的图` },
  "graph.goal": { label: "任务图目标", unit: "chars", max: MAX_GRAPH_GOAL_CHARS, commands: ["graph.create", "graph.patch"], tip: "长材料存成文件，目标里写路径" },
  "graph.steps": { label: "步骤", unit: "items", max: MAX_GRAPH_NODES, commands: ["graph.create", "graph.patch"] },
  "graph.edges": { label: "依赖边", unit: "items", max: MAX_GRAPH_EDGES, commands: ["graph.create", "graph.patch"] },
  "step.key": { label: "步骤标识", unit: "chars", max: MAX_NODE_KEY_CHARS, commands: ["graph.create", "graph.patch", "worker.start", "ask", "graph.done", "graph.decide", "graph.skip"] },
  "step.title": { label: "步骤标题", unit: "chars", max: MAX_NODE_TITLE_CHARS, commands: ["graph.create", "graph.patch"] },
  "step.brief": { label: "步骤 brief", unit: "chars", max: MAX_STEP_BRIEF_CHARS, commands: ["graph.create", "graph.patch"], tip: "长材料存成文件，brief 里写路径" },
  "step.base": { label: "审查分支名", unit: "chars", max: MAX_STEP_BASE_CHARS, commands: ["graph.create", "graph.patch"] },
  "step.artifactSummary": { label: "步骤产物摘要", unit: "chars", max: MAX_NODE_ARTIFACT_SUMMARY_CHARS, commands: ["graph.done"] },
  "step.doneNote": { label: "放行说明", unit: "bytes", max: MAX_TASK_BYTES, commands: ["graph.done"], tip: LONG_TEXT_TIP },
  "decide.choice": { label: "所选方案", unit: "chars", max: MAX_DECISION_CHOICE_CHARS, commands: ["graph.decide"] },
  "decide.note": { label: "补充说明", unit: "chars", max: MAX_DECISION_NOTE_CHARS, commands: ["graph.decide"] },
  "graph.reason": { label: "原因", unit: "chars", max: MAX_REASON_CHARS, commands: ["graph.skip", "graph.cancel"] },
  "graph.finishSummary": { label: "交付摘要", unit: "chars", max: ROUTER_REPORT_SUMMARY_MAX_CHARS, commands: ["graph.finish"], tip: "细节写进各步骤的汇报或文件" },
  "checklist.items": { label: "步骤", unit: "items", max: CHECKLIST_MAX_ITEMS, commands: ["checklist"] },
  "checklist.title": { label: "每个步骤", unit: "chars", max: CHECKLIST_TITLE_MAX_CHARS, commands: ["checklist"] },
} as const satisfies Record<string, HubLimitRule>;

export type HubLimitId = keyof typeof HUB_LIMITS;

export interface HubLimitViolation {
  id: HubLimitId;
  /** Names the offending entry when one input holds several, such as a step key. */
  target?: string;
  actual: number;
  max: number;
}

/**
 * Postcondition: chars counts Unicode code points, bytes counts UTF-8 bytes, items counts array entries.
 * A string measured as items, or an array measured as chars or bytes, throws TypeError.
 */
export function measureHubLimit(unit: HubLimitUnit, value: string | readonly unknown[]): number {
  if (typeof value === "string") {
    if (unit === "chars") return [...value].length;
    if (unit === "bytes") return new TextEncoder().encode(value).length;
  } else if (unit === "items") {
    return value.length;
  }
  throw new TypeError(`Cannot measure this value in ${unit}`);
}

/**
 * Postcondition: returns null when the measured value is at most HUB_LIMITS[id].max (the limit itself passes);
 * otherwise a violation carrying the measured value, the rule's max, and target.
 */
export function checkHubLimit(id: HubLimitId, value: string | readonly unknown[], target?: string): HubLimitViolation | null {
  return checkHubLimitAmount(id, measureHubLimit(HUB_LIMITS[id].unit, value), target);
}

export function checkHubLimitAmount(id: HubLimitId, actual: number, target?: string): HubLimitViolation | null {
  const { max } = HUB_LIMITS[id];
  return actual <= max ? null : { id, actual, max, ...(target === undefined ? {} : { target }) };
}

function formatAmount(unit: HubLimitUnit, value: number): string {
  if (unit === "chars") return `${value} 字`;
  if (unit === "items") return `${value} 个`;
  return value % 1024 === 0 ? `${value / 1024} KB` : `${value} 字节`;
}

export function hubLimitMaximum(id: HubLimitId): string {
  const { unit, max } = HUB_LIMITS[id];
  return formatAmount(unit, max);
}

export function formatGraphLimitsHelp(): string {
  const fields = ["graph.title", "graph.goal", "step.title", "step.brief", "graph.finishSummary"] satisfies HubLimitId[];
  return fields.map((id) => `${HUB_LIMITS[id].label}最多 ${hubLimitMaximum(id)}`).join("；");
}

/**
 * Precondition: violations is non-empty.
 * Postcondition: one line per violation naming the rule label, the measured size, the limit, and the rule's tip,
 * with the step key in front when target is set. Characters, items, and bytes use Chinese units; bytes show
 * as KB when the value is a whole multiple of 1024. options.noEffect, when set, becomes the final line.
 */
export function formatHubLimitViolations(violations: readonly HubLimitViolation[], options?: { noEffect?: string }): string {
  const lines = violations.map(({ id, target, actual, max }) => {
    const { label, unit, tip }: HubLimitRule = HUB_LIMITS[id];
    const field = target === undefined ? label : `步骤「${target}」的 ${label.replace(/^步骤 /u, "")}`;
    return `${field}有 ${formatAmount(unit, actual)}，上限 ${formatAmount(unit, max)}${tip === undefined ? "" : `；${tip}`}`;
  });
  if (options?.noEffect !== undefined) lines.push(options.noEffect);
  return lines.join("\n");
}

/**
 * Postcondition: returns null when no rule lists command; otherwise one help line, indented to the usage text column,
 * that names every rule for command with its limit in HUB_LIMITS order.
 */
export function hubLimitsHelpLine(command: HubCommand): string | null {
  const rules: HubLimitRule[] = Object.values(HUB_LIMITS);
  const fields = rules.filter((rule) => rule.commands.includes(command));
  if (fields.length === 0) return null;
  return `                                                          上限：${fields.map(({ label, unit, max }) => `${label} ${formatAmount(unit, max)}`).join("；")}`;
}

export interface AskCardText {
  question: string;
  /** Background after the first line, trimmed; null when the ask is a single line. */
  body: string | null;
}

/**
 * Splits the ask text at its first line break into a question and a background, checking the plain-card rules
 * (`ask.question`, `ask.body`) or, when step is true, the step-card rules (`ask.stepQuestion`, `ask.stepBody`).
 * Postcondition: on success the returned question and body together hold every non-whitespace character of text,
 * never shortened; a single line longer than the question limit is a violation, never split.
 * Throws RangeError when text is blank.
 */
export function splitAskCardText(
  text: string,
  step: boolean,
): { ok: true; card: AskCardText } | { ok: false; violations: HubLimitViolation[] } {
  const raw = text.trim();
  if (raw === "") throw new RangeError("要问用户的话不能是空的");
  const lineEnd = raw.search(/[\r\n]/u);
  const question = lineEnd === -1 ? raw : raw.slice(0, lineEnd).trimEnd();
  const body = lineEnd === -1 ? null : raw.slice(lineEnd).trim() || null;
  const violations = [
    checkHubLimit(step ? "ask.stepQuestion" : "ask.question", question),
    checkHubLimit(step ? "ask.stepBody" : "ask.body", body ?? ""),
  ].filter((violation) => violation !== null);
  return violations.length === 0 ? { ok: true, card: { question, body } } : { ok: false, violations };
}
