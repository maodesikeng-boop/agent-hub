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

/**
 * Precondition: `text` is any string (including empty or malformed input).
 * Postcondition: returns at most one violation per rule in `WORKFLOW_OVERFIT_RULE_IDS` where `text` matches a
 * workflow-overfitting pattern outside an allowed opt-in context, in rule order, without throwing or backtracking.
 */
export function workflowOverfitViolationsIn(text: string): WorkflowOverfitViolation[] {
  void text;
  throw new Error("Not implemented");
}

/**
 * Precondition: `violation.index` lies within `text`.
 * Postcondition: returns a single-line human-readable diagnostic containing `[<rule.id>]`, a bounded snippet from
 * `text`, and `violation.rule.why`.
 */
export function describeWorkflowOverfitViolation(text: string, violation: WorkflowOverfitViolation): string {
  void text;
  void violation;
  throw new Error("Not implemented");
}

/**
 * Precondition: `surfaces` lists rendered shipped agent-facing texts as `{ name, text }` pairs.
 * Postcondition: returns one formatted finding per distinct violation across `surfaces` (grouping duplicate findings
 * by diagnostic key with surface count), or an empty array when every surface is workflow-neutral.
 */
export function auditShippedPromptSurfaces(surfaces: readonly ShippedPromptSurface[]): string[] {
  void surfaces;
  throw new Error("Not implemented");
}
