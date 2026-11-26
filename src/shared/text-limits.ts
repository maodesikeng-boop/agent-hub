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
  target?: string;
  actualChars: number;
  maxChars: number;
}

export function checkTextLimit(id: TextLimitId, text: string, target?: string): TextLimitViolation | null {
  const actualChars = [...text].length;
  const { maxChars } = TEXT_LIMITS[id];
  return actualChars <= maxChars ? null : { id, target, actualChars, maxChars };
}

export function formatTextLimitViolations(violations: readonly TextLimitViolation[], options?: { noEffect?: boolean }): string {
  const lines = violations.map(({ id, target, actualChars, maxChars }) => {
    const { label, tip } = TEXT_LIMITS[id];
    const field = target === undefined ? label : `步骤「${target}」的 ${label.replace(/^步骤 /u, "")}`;
    return `${field}有 ${actualChars} 字，上限 ${maxChars} 字${tip === undefined ? "" : `；${tip}`}`;
  });
  if (options?.noEffect === true) lines.push("这次改图没有生效");
  return lines.join("\n");
}

export function formatGraphLimitsHelp(): string {
  const fields: TextLimitId[] = ["graph.title", "graph.goal", "step.title", "step.brief", "graph.finishSummary"];
  return fields.map((id) => `${TEXT_LIMITS[id].label}最多 ${TEXT_LIMITS[id].maxChars} 字`).join("；");
}
