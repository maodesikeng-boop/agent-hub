import {
  isTaskNodeWaitingDecision,
  type TaskArtifact,
  type TaskDecision,
  type TaskNode,
  type TaskNodeStatus,
  type TaskNodeWaitingFor,
  type WorkerId,
} from "../../../shared/domain.ts";
import type { UserBlocker } from "../../../shared/user-blockers.ts";
import type { StepSlotView } from "./slots.ts";
import type { TaskNodeDbRow } from "./types.ts";

export function parseJsonOr<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const workerIdsOf = (row: Pick<TaskNodeDbRow, "worker_ids_json">): WorkerId[] =>
  parseJsonOr<WorkerId[]>(row.worker_ids_json, []);

export const lastWorkerIdOf = (row: Pick<TaskNodeDbRow, "worker_ids_json">): WorkerId | null =>
  workerIdsOf(row).at(-1) ?? null;

export const decisionOf = (row: Pick<TaskNodeDbRow, "decision_json">): TaskDecision | null =>
  parseJsonOr<TaskDecision | null>(row.decision_json, null);

export const gateOptionsOf = (row: Pick<TaskNodeDbRow, "gate_options_json">): string[] =>
  parseJsonOr<string[]>(row.gate_options_json, []);

export const hasText = (s: string | null | undefined): s is string => s !== null && s !== undefined && s.trim() !== "";

/**
 * What a ready step does once admitted: run its brief, settle a decided brief-less step nobody worked on, or ask the PM.
 * A step waiting in a slot queue is promised the same outcome it gets when it leaves the queue.
 */
export function readyOutcomeOf(row: Pick<TaskNodeDbRow, "brief" | "decision_json" | "worker_ids_json">): "start" | "settle" | "pm" {
  if (hasText(row.brief)) return "start";
  return row.decision_json !== null && workerIdsOf(row).length === 0 ? "settle" : "pm";
}

type StoredTaskArtifact = TaskArtifact & { checkpointPending?: boolean; checkpointRejectionClientId?: string; reviewStamp?: unknown };

export function readStoredArtifact(raw: string | null): {
  artifact: TaskArtifact | null;
  checkpointPending: boolean;
  checkpointRejectionClientId?: string;
} {
  const parsed = parseJsonOr<StoredTaskArtifact | null>(raw, null);
  if (parsed === null) return { artifact: null, checkpointPending: false };
  const { checkpointPending, checkpointRejectionClientId, reviewStamp: _legacyReviewStamp, ...rest } = parsed;
  return {
    artifact: Object.keys(rest).length > 0 ? rest : null,
    checkpointPending: checkpointPending === true,
    ...(checkpointRejectionClientId !== undefined ? { checkpointRejectionClientId } : {}),
  };
}

export function serializeArtifact(artifact: TaskArtifact | null | undefined, checkpointPending: boolean, checkpointRejectionClientId?: string): string | null {
  const clean: StoredTaskArtifact = { ...(artifact ?? {}) };
  delete clean.checkpointPending;
  delete clean.checkpointRejectionClientId;
  if (checkpointPending) clean.checkpointPending = true;
  if (checkpointRejectionClientId !== undefined) clean.checkpointRejectionClientId = checkpointRejectionClientId;
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
}

export const decisionWakeupClientIdOf = (row: Pick<TaskNodeDbRow, "decision_json" | "artifact_json">): string | undefined =>
  decisionOf(row)?.clientId ?? readStoredArtifact(row.artifact_json).checkpointRejectionClientId;

export const artifactWithoutCheckpoint = (row: Pick<TaskNodeDbRow, "artifact_json">): string | null =>
  serializeArtifact(readStoredArtifact(row.artifact_json).artifact, false);

export function isStoredCheckpoint(node: Pick<TaskNodeDbRow, "artifact_json">): boolean {
  return readStoredArtifact(node.artifact_json).checkpointPending;
}

/** Slim snapshots keep deliverables only on steps waiting for a user decision, to bound snapshot size. */
function artifactForView(artifact: TaskArtifact | null, waitingDecision: boolean, includeDetails: boolean): TaskArtifact | null {
  if (artifact?.deliverables === undefined || waitingDecision || includeDetails) return artifact;
  const { deliverables: _omitted, ...rest } = artifact;
  return Object.keys(rest).length > 0 ? rest : null;
}

export function toTaskNode(row: TaskNodeDbRow, includeDetails = false, waiting?: {
  userBlocker?: UserBlocker;
  sandboxApproval?: TaskNode["sandboxApproval"];
  gateAskPending?: boolean;
  slot?: StepSlotView;
}): TaskNode {
  const { artifact, checkpointPending } = readStoredArtifact(row.artifact_json);
  const status = row.status as TaskNodeStatus;
  const waitingFor = status === "waiting" ? ((row.waiting_for ?? "pm") as TaskNodeWaitingFor) : null;
  const userBlocker = waiting?.userBlocker ?? null;
  const { sandboxApproval, gateAskPending } = waiting ?? {};
  const waitingDecision = isTaskNodeWaitingDecision({ status, waitingFor, userBlocker, sandboxApproval, gateAskPending });
  const base: TaskNode = {
    key: row.node_key,
    title: row.title,
    status,
    waitingFor,
    skipped: row.status === "done" && row.skipped === 1,
    sortOrder: row.sort_order,
    activeWorkerId: row.active_worker_id,
    workerIds: workerIdsOf(row),
    artifact: artifactForView(artifact, waitingDecision, includeDetails),
    gateQuestion: row.gate_question,
    gateOptions: gateOptionsOf(row),
    gateSummaryMd: row.gate_summary_md,
    gateRecommended: row.gate_recommended,
    gateAskMessageId: row.gate_ask_message_id,
    ...(gateAskPending !== undefined ? { gateAskPending } : {}),
    ...(waitingDecision && checkpointPending ? { gateCheckpoint: true } : {}),
    userBlocker,
    ...(sandboxApproval !== undefined ? { sandboxApproval } : {}),
    ...(waiting?.slot === undefined ? {} : { slot: waiting.slot.slot }),
    ...(waiting?.slot?.queue === undefined ? {} : { slotQueue: waiting.slot.queue }),
    decision: decisionOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!includeDetails) return base;
  return {
    ...base,
    brief: row.brief,
    vendor: row.vendor,
    model: row.model,
    effort: row.effort,
    readonly: row.readonly === 1,
    maxTimeMs: row.max_time_ms,
    confirm: row.confirm === 1,
    review: row.review === 1,
    base: row.base,
  };
}
