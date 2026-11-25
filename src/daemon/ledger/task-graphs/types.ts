import type {
  AgentSessionRow,
  MessageId,
  PmId,
  ProjectId,
  SessionId,
  TaskEdge,
  TaskGraphId,
  TaskNodeKey,
  TaskNodeWaitingFor,
  WorkerId,
  WorkerRecord,
} from "../../../shared/domain.ts";
import type { ProjectCard } from "../../../shared/hub.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import type { WorkerCapabilities } from "../../../shared/pm-capabilities.ts";
import type { AgentVendor } from "../../../shared/vendors.ts";
import type { LedgerContext, Pending } from "../context.ts";
import type { LedgerMessages } from "../messages.ts";
import type { LedgerPersona } from "../persona.ts";
import type { LedgerProjects } from "../projects.ts";
import type { LedgerRouter } from "../router.ts";
import type { LedgerSessions } from "../sessions.ts";
import type { LedgerUserBlockers } from "../user-blockers.ts";

export interface TaskGraphDbRow {
  id: number;
  project_id: number;
  pm_id: number;
  conversation_id: number;
  title: string;
  goal: string | null;
  status: string;
  origin_msg_id: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface TaskNodeDbRow {
  id: number;
  graph_id: number;
  node_key: string;
  title: string;
  brief: string | null;
  vendor: string | null;
  model: string | null;
  effort: string | null;
  readonly: number;
  max_time_ms: number | null;
  confirm: number;
  review: number;
  base: string | null;
  pm_note: string | null;
  status: string;
  waiting_for: string | null;
  skipped: number;
  sort_order: number;
  active_worker_id: number | null;
  worker_ids_json: string;
  artifact_json: string | null;
  gate_question: string | null;
  gate_options_json: string | null;
  gate_summary_md: string | null;
  gate_recommended: string | null;
  gate_ask_message_id: number | null;
  decision_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskEdgeDbRow {
  graph_id: number;
  from_key: string;
  to_key: string;
}

export type KeyAdjacency = ReadonlyMap<TaskNodeKey, readonly TaskNodeKey[]>;

export interface GraphMaps {
  nodeRows: TaskNodeDbRow[];
  edges: TaskEdge[];
  byKey: Map<TaskNodeKey, TaskNodeDbRow>;
  incoming: Map<TaskNodeKey, TaskNodeKey[]>;
  outgoing: Map<TaskNodeKey, TaskNodeKey[]>;
}

export type PmCaller = AgentSessionRow & { pmId: PmId };

export interface TurnedStep {
  key: TaskNodeKey;
  title: string;
  waitingFor: TaskNodeWaitingFor;
}

export interface ProgressResult {
  turned: TurnedStep[];
  dispatched: Array<{ key: TaskNodeKey; title: string; workerId: WorkerId }>;
  dispatchFailed: Array<{ key: TaskNodeKey; title: string; index: number; total: number; reason: string }>;
  userBlocked: Array<{ key: TaskNodeKey; note: string }>;
}

export const emptyProgress = (): ProgressResult => ({ turned: [], dispatched: [], dispatchFailed: [], userBlocked: [] });

export type StepWorkspacePlan =
  | { kind: "inherit"; fromWorkerId: WorkerId; worktreePath: string; branch: string; baseCommit: string }
  | { kind: "fork"; baseBranch: string }
  | { kind: "fresh" }
  | { kind: "review"; branch: string; implWorktreePath: string | null };

export interface WorkerBindTarget {
  graphId: TaskGraphId;
  nodeKey: TaskNodeKey;
  graphTitle: string;
  graphGoal: string | null;
  nodeTitle: string;
  brief: string | null;
  vendor: string | null;
  model: string | null;
  effort: string | null;
  readonly: boolean;
  capabilities: WorkerCapabilities;
  maxTimeMs: number | null;
  review: boolean;
  base: string | null;
  /** 1-based position in step order. */
  index: number;
  total: number;
  activeWorkerId: WorkerId | null;
  workerIds: WorkerId[];
  workspacePlan: StepWorkspacePlan;
  buildFirstMessage: (
    sessionId: SessionId,
    opts: {
      inheritedFromWorkerId: WorkerId | null;
      worker: WorkerRecord;
      project: ProjectCard;
      task: string;
    },
  ) => string;
  buildUpstreamHandoff: (sessionId: SessionId, inheritedFromWorkerId: WorkerId | null) => string | null;
}

export interface TaskGraphWorkersBridge {
  dispatchStepWorkerIn(
    p: Pending,
    input: {
      pmId: PmId;
      pmVendor: AgentVendor;
      pmModel: string | null;
      pmEffort: string | null;
      title: string;
      task: string;
      vendor: AgentVendor | null;
      model: string | null;
      effort: string | null;
      readonly: boolean;
      capabilities: WorkerCapabilities;
      maxTimeMs: number | null;
      workspacePlan: StepWorkspacePlan;
      buildFirstMessage: (
        sessionId: SessionId,
        inheritedFromWorkerId: WorkerId | null,
        worker: WorkerRecord,
        project: ProjectCard,
      ) => string;
      context?: HubCallContext;
    },
  ): WorkerRecord;
  stopWorkersIn(p: Pending, workerIds: readonly WorkerId[]): WorkerId[];
  deliverToWorkerIn(
    p: Pending,
    input: { workerId: WorkerId; text: string; dedupeKey: string; maxTimeMs?: number | null },
  ): MessageId | null;
}

export interface TaskGraphOptions {
  launchDir: string;
  workers?: () => TaskGraphWorkersBridge | undefined;
  userBlockers?: Pick<LedgerUserBlockers, "raiseIn" | "blockStep" | "ofSteps">;
  onGraphFinishedIn?: (p: Pending, projectId: ProjectId) => void;
}

export interface TaskGraphCtx extends Pick<LedgerContext, "db" | "now" | "write" | "enqueue" | "modelCatalog" | "modelShortLabel"> {
  sessions: LedgerSessions;
  messages: LedgerMessages;
  persona: LedgerPersona;
  projects: LedgerProjects;
  router: Pick<LedgerRouter, "reportIn">;
  options: TaskGraphOptions;
}
