import type { createWorkerAppApprovals } from "./app-approvals.ts";
import type { AgentSessionRow, ConversationId, Message, MessageId, PmId, SessionId, WorkerId } from "../../../shared/domain.ts";
import type { WorkerHubStatus } from "../../../shared/hub.ts";
import type { ReviewTarget, ReviewVerifyResult } from "../../../shared/review.ts";
import type { UserBlocker } from "../../../shared/user-blockers.ts";
import type { ParsedWorkerReport } from "../../../shared/worker.ts";
import type { LedgerContext, Pending } from "../context.ts";
import type { LedgerMessages } from "../messages.ts";
import type { LedgerPersona } from "../persona.ts";
import type { LedgerProjects } from "../projects.ts";
import type { SandboxApprovalStore } from "../sandbox-approvals.ts";
import type { LedgerSessions } from "../sessions.ts";
import type { StepWorkspacePlan, WorkerBindTarget } from "../task-graphs.ts";
import type { LedgerTakeover } from "../takeover.ts";
import type { LedgerTurnBackgroundWaits } from "../turn-background-waits.ts";
import type { LedgerTurns } from "../turns.ts";
import type { LedgerUserBlockers } from "../user-blockers.ts";

export interface LedgerWorkersTaskGraphHooks {
  prepareWorkerBind: (pmId: PmId, nodeKey: string, graphId?: number) => WorkerBindTarget;
  bindWorkerStartedIn: (
    p: Pending,
    target: WorkerBindTarget,
    workerId: WorkerId,
    agent?: { vendor: string; model: string | null; effort: string | null },
  ) => void;
  onWorkerTurnReportIn: (
    p: Pending,
    worker: { id: WorkerId; branch: string | null; review: ReviewTarget | null },
    parsed: ParsedWorkerReport,
    rawBody: string,
    forcedNote: string | null,
    opts?: { hasPendingFollowup?: boolean; reviewVerified?: ReviewVerifyResult; reportMessage?: ReportMessage | null },
  ) =>
    | { handled: false }
    | { handled: true; outcome: "verify" }
    | { handled: true; outcome: "completed"; wakePmWithReport: boolean; completeStep: () => void }
    | { handled: true; outcome: "waiting_user" }
    | { handled: true; outcome: "waiting_pm"; pmDeliverBody: string };
  onWorkerFailedIn: (
    p: Pending,
    workerId: WorkerId,
    opts: { clearActiveWorker: boolean; reasonLabel: string; detailBody: string; stoppedByUser?: boolean },
  ) => string | null;
  onWorkerUserBlockedIn: (p: Pending, workerId: WorkerId, blocker: UserBlocker) => string | null;
  onWorkerResumedIn: (p: Pending, workerId: WorkerId) => void;
  onWorkerEndedIn: (p: Pending, workerId: WorkerId) => string | null;
  workerGraphWorkspacePlan: (workerId: WorkerId) => StepWorkspacePlan | undefined;
  workerGraphUpstreamCommit: (workerId: WorkerId) => string | null;
  workerGraphStatus: (workerId: WorkerId, sessionId: SessionId) => WorkerHubStatus["taskGraph"] | undefined;
}

export interface LedgerWorkersOptions {
  worktreesDir: string;
  platform?: NodeJS.Platform;
  extraWorktreeRoots?: () => readonly string[];
  taskGraphs?: LedgerWorkersTaskGraphHooks;
  userBlockers?: Pick<LedgerUserBlockers, "raiseIn" | "attachWorkerIn">;
  takeover?: LedgerTakeover;
  turns: Pick<LedgerTurns, "turnOf" | "publishTurnIn">;
}

export type MaxTimeTimer = { timer: ReturnType<typeof setTimeout>; maxTimeMs: number; startedAt: number };

export interface WorkersCtx {
  ctx: LedgerContext;
  db: LedgerContext["db"];
  now: LedgerContext["now"];
  write: LedgerContext["write"];
  enqueue: LedgerContext["enqueue"];
  sessions: LedgerSessions;
  messages: LedgerMessages;
  persona: LedgerPersona;
  projects: LedgerProjects;
  options: LedgerWorkersOptions;
  sandboxApprovals: SandboxApprovalStore;
  appApprovals: ReturnType<typeof createWorkerAppApprovals>;
  /** Max message id at turn start, in memory only, so a PM message sent mid-turn cannot make the last reply look older than the previous turn's text. */
  turnStarts: Map<SessionId, MessageId>;
  /** Turns interrupted by endIn are not reported back because the PM stopped them itself. */
  /** Only the timers live in memory; duration, deadline and reminder state persist in worker_turn_timeouts for restart recovery. */
  maxTimeTimers: Map<ConversationId, MaxTimeTimer>;
  backgroundWaits: LedgerTurnBackgroundWaits;
}

export type EndedWorktreeCandidate = {
  workerId: WorkerId;
  projectId: number;
  projectName?: string;
  title?: string;
  repoFolder: string;
  worktreePath: string;
  baseCommit: string | null;
  endedAt: number;
} & ({ review: false; branch: string } | { review: true; branch: null });

export type ReportMessage = Pick<Message, "id" | "text" | "meta">;
export type ReportMessageRow = { id: number; text: string; meta: string | null };

export type PmCaller = AgentSessionRow & { pmId: PmId };
