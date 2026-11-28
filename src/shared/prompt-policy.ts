// Invariant: shipped Bellwood prompts, skills, help text, and notices describe platform mechanics only and never impose a repository-specific workflow.

export const WORKFLOW_OVERFIT_RULE_IDS = [
  "unrequested-review-trigger",
  "fixed-dev-pipeline",
  "forced-cross-vendor-review",
  "unrequested-memory-nomination",
  "fixed-acceptance-ceremony",
] as const;

export type WorkflowOverfitRuleId = (typeof WORKFLOW_OVERFIT_RULE_IDS)[number];

export interface WorkflowOverfitRule {
  readonly id: WorkflowOverfitRuleId;
  readonly why: string;
  readonly pattern: RegExp;
  readonly allowWhen?: RegExp;
}

export interface WorkflowOverfitViolation {
  readonly rule: WorkflowOverfitRule;
  readonly index: number;
  readonly match: string;
}

export interface ShippedPromptSurface {
  readonly name: string;
  readonly text: string;
}

const WORKFLOW_OVERFIT_RULES: readonly WorkflowOverfitRule[] = [
  {
    id: "unrequested-review-trigger",
    why: "reviews are opt-in and must not trigger automatically on perceived risk, diff bans, or unrequested delivery nudges",
    pattern: /改动风险较高[^。；！？\n]{0,20}审查|不读代码\s*diff|代码质量由审查负责|[（(]比如审查[）)]|缺审查或证据|审子代理\s*diff|不要派普通\s*Worker\s*审/gu,
  },
  {
    id: "fixed-dev-pipeline",
    why: "shipped prompts must not prescribe a fixed plan-code-review pipeline or ban parallel and module splits",
    pattern: /写方案\s*(?:→|->)\s*写代码\s*(?:→|->)\s*审查|不要把同一个单元内的工作拆成两路去并行|不要把一个需求切成前端、后端各一个\s*Worker|只在三种时候另起一步|不要自己写详细方案|让\s*Worker\s*自己去做方案/gu,
  },
  {
    id: "forced-cross-vendor-review",
    why: "cross-vendor review is optional and must not scold same-vendor reviews",
    pattern: /提醒：审查步骤[^。；！？\n]{0,40}同一家模型|审查步骤[^。；！？\n]{0,40}是同一家模型/gu,
  },
  {
    id: "unrequested-memory-nomination",
    why: "Worker report templates must not prompt every Worker to nominate memory file edits",
    pattern: /(?:或者)?建议改哪个记忆文件/gu,
  },
  {
    id: "fixed-acceptance-ceremony",
    why: "delivery wording and evidence guidance must stay natural without fixed acceptance prefixes or boss-convincing ceremony",
    pattern: /说服你的领导|以[“"「]请验收[”"」]开头|也不贴到\s*PR\s*评论里代替|方案、验收结论、截图、录屏/gu,
  },
];

const SENTENCE_DELIMITERS = new Set(["。", "；", "！", "？", "\n", "\r"]);

function sentenceAround(text: string, index: number, length: number): string {
  let start = index;
  while (start > 0 && !SENTENCE_DELIMITERS.has(text[start - 1]!)) start--;
  let end = Math.min(text.length, index + length);
  while (end < text.length && !SENTENCE_DELIMITERS.has(text[end]!)) end++;
  return text.slice(start, end);
}

/**
 * Precondition: `text` is any string (including empty or malformed input).
 * Postcondition: returns at most one violation per rule in `WORKFLOW_OVERFIT_RULE_IDS` where `text` matches a
 * workflow-overfitting pattern outside an allowed opt-in context, in rule order, without throwing or backtracking.
 */
export function workflowOverfitViolationsIn(text: string): WorkflowOverfitViolation[] {
  if (text.length === 0) return [];
  const out: WorkflowOverfitViolation[] = [];
  for (const rule of WORKFLOW_OVERFIT_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const index = match.index;
      if (rule.allowWhen !== undefined && rule.allowWhen.test(sentenceAround(text, index, match[0].length))) continue;
      out.push({ rule, index, match: match[0] });
      break;
    }
  }
  return out;
}

/**
 * Precondition: `violation.index` lies within `text`.
 * Postcondition: returns a single-line human-readable diagnostic containing `[<rule.id>]`, a bounded snippet from
 * `text`, and `violation.rule.why`.
 */
export function describeWorkflowOverfitViolation(text: string, violation: WorkflowOverfitViolation): string {
  const safeIndex = Math.max(0, Math.min(text.length, violation.index));
  const snippet = text
    .slice(Math.max(0, safeIndex - 30), Math.min(text.length, safeIndex + 50))
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  return `[${violation.rule.id}] ${snippet} -- ${violation.rule.why}`;
}

/**
 * Precondition: `surfaces` lists rendered shipped agent-facing texts as `{ name, text }` pairs.
 * Postcondition: returns one formatted finding per distinct violation across `surfaces` (grouping duplicate findings
 * by diagnostic key with surface count), or an empty array when every surface is workflow-neutral.
 */
export function auditShippedPromptSurfaces(surfaces: readonly ShippedPromptSurface[]): string[] {
  const surfacesByHit = new Map<string, string[]>();
  for (const { name, text } of surfaces) {
    for (const violation of workflowOverfitViolationsIn(text)) {
      const key = describeWorkflowOverfitViolation(text, violation);
      surfacesByHit.set(key, [...(surfacesByHit.get(key) ?? []), name]);
    }
  }
  return [...surfacesByHit].map(([key, names]) => `${names[0]}${names.length > 1 ? ` (+${names.length - 1} more)` : ""} ${key}`);
}
