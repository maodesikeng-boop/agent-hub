import {
  ASK_MAX_OPTION_CHARS,
  MAX_GATE_QUESTION_CHARS,
  MAX_GATE_SUMMARY_CHARS,
  MAX_GRAPH_GOAL_CHARS,
  MAX_GRAPH_TITLE_CHARS,
  MAX_NODE_ARTIFACT_SUMMARY_CHARS,
  MAX_NODE_KEY_CHARS,
  MAX_NODE_TITLE_CHARS,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_STEP_BASE_CHARS,
  MAX_STEP_BRIEF_CHARS,
  ROUTER_CONTEXT_MAX_CHARS,
} from "./limits.ts";

// Invariant: every user-facing text limit in validation errors, hub help, and the Task Graph manual derives from TEXT_LIMITS.

export type TextLimitId =
  | "graph.title"
  | "graph.goal"
  | "step.key"
  | "step.title"
  | "step.brief"
  | "step.base"
  | "step.artifactSummary"
  | "gate.question"
  | "gate.summary"
  | "graph.finishSummary"
  | "router.reportSummary"
  | "ask.option"
  | "schedule.name";

export interface TextLimitRule {
  id: TextLimitId;
  label: string;
  maxChars: number;
  tip?: string;
}

export const TEXT_LIMITS: Readonly<Record<TextLimitId, TextLimitRule>> = {
  "graph.title": { id: "graph.title", label: "任务图标题", maxChars: MAX_GRAPH_TITLE_CHARS },
  "graph.goal": { id: "graph.goal", label: "任务图目标", maxChars: MAX_GRAPH_GOAL_CHARS, tip: "长材料存成文件，目标里写路径" },
  "step.key": { id: "step.key", label: "步骤标识", maxChars: MAX_NODE_KEY_CHARS },
  "step.title": { id: "step.title", label: "步骤标题", maxChars: MAX_NODE_TITLE_CHARS },
  "step.brief": { id: "step.brief", label: "步骤 brief", maxChars: MAX_STEP_BRIEF_CHARS, tip: "长材料存成文件，brief 里写路径" },
  "step.base": { id: "step.base", label: "审查分支名", maxChars: MAX_STEP_BASE_CHARS },
  "step.artifactSummary": { id: "step.artifactSummary", label: "步骤产物摘要", maxChars: MAX_NODE_ARTIFACT_SUMMARY_CHARS },
  "gate.question": { id: "gate.question", label: "拍板卡问题", maxChars: MAX_GATE_QUESTION_CHARS },
  "gate.summary": { id: "gate.summary", label: "拍板卡背景摘要", maxChars: MAX_GATE_SUMMARY_CHARS },
  "graph.finishSummary": { id: "graph.finishSummary", label: "交付摘要", maxChars: ROUTER_CONTEXT_MAX_CHARS },
  "router.reportSummary": { id: "router.reportSummary", label: "汇报摘要", maxChars: ROUTER_CONTEXT_MAX_CHARS },
  "ask.option": { id: "ask.option", label: "选项", maxChars: ASK_MAX_OPTION_CHARS },
  "schedule.name": { id: "schedule.name", label: "定时任务名称", maxChars: MAX_SCHEDULE_NAME_CHARS },
};

export interface TextLimitViolation {
  id: TextLimitId;
  /** Optional step key or item identifier for pinpointing the offending entry. */
  target?: string;
  actualChars: number;
  maxChars: number;
}

/**
 * Postcondition: returns null when the Unicode code-point count of text is within TEXT_LIMITS[id].maxChars;
 * otherwise returns a TextLimitViolation recording actualChars, maxChars, and target.
 */
export function checkTextLimit(_id: TextLimitId, _text: string, _target?: string): TextLimitViolation | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: violations is non-empty.
 * Postcondition: formats every violation in one Chinese error message naming each target, actual count, limit, and tip;
 * when options.noEffect is true, states that the graph mutation did not take effect.
 */
export function formatTextLimitViolations(_violations: readonly TextLimitViolation[], _options?: { noEffect?: boolean }): string {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns a concise Chinese summary listing the graph title, goal, step brief, and finish summary limits
 * directly from TEXT_LIMITS for embedding in `hub help` and the Task Graph manual.
 */
export function formatGraphLimitsHelp(): string {
  throw new Error("Not implemented");
}
