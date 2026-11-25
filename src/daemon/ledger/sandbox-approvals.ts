import type {
  AgentVendor,
  CapabilityKey,
  ConversationId,
  DecideSandboxApprovalRequest,
  DecideSandboxApprovalResponse,
  MessageId,
  PmId,
  SandboxApprovalId,
  SandboxApprovalRecord,
  SandboxApprovalSummary,
  WorkerId,
} from "../../shared/index.ts";
import type { Db } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";

export interface SandboxApprovalsDeps {
  ctx: LedgerContext;
  insertCardMessageIn: (
    p: Pending,
    input: {
      pmId: PmId;
      conversationId: ConversationId;
      approvalId: SandboxApprovalId;
      workerId: WorkerId;
      text: string;
    },
  ) => MessageId | null;
  settleCardMessageIn: (
    p: Pending,
    messageId: MessageId,
    outcome: { by: "answer"; chosenOption: string } | { by: "close" },
  ) => void;
  onApprovedIn: (p: Pending, approval: SandboxApprovalRecord) => void;
  onRejectedIn: (p: Pending, approval: SandboxApprovalRecord) => void;
  recheckEligible: (approval: SandboxApprovalRecord) => { ok: true } | { ok: false; message: string };
}

export interface CreateSandboxApprovalInput {
  workerId: WorkerId;
  workerTitle: string;
  pmId: PmId;
  conversationId: ConversationId;
  stepId: number | null;
  vendor: AgentVendor;
  model: string | null;
  workspace: "worktree" | "main";
  branch: string | null;
  capabilities: readonly CapabilityKey[];
  taskSummary: string;
}

export interface SandboxApprovalStore {
  /**
   * Precondition: Hard Condition 1 already validated for workerId and workerId has no existing approval row.
   * Postcondition: inserts a pending approval row, posts the human-only confirmation card in the PM conversation, and returns the created record.
   */
  createPendingIn(p: Pending, input: CreateSandboxApprovalInput): SandboxApprovalRecord;

  /**
   * Precondition: workerId is a valid WorkerId.
   * Postcondition: returns the Worker's approval record or null when the Worker uses the default outer sandbox.
   */
  getByWorkerId(workerId: WorkerId): SandboxApprovalRecord | null;

  /**
   * Precondition: approvalId is a positive integer.
   * Postcondition: returns the approval record or null if not found.
   */
  getById(approvalId: SandboxApprovalId): SandboxApprovalRecord | null;

  /**
   * Precondition: called for snapshot assembly.
   * Postcondition: returns up to PENDING_SANDBOX_APPROVALS_SNAPSHOT_MAX pending approvals for open Workers, newest first.
   */
  listPendingSummaries(): SandboxApprovalSummary[];

  /**
   * Precondition: workerId is a valid WorkerId.
   * Postcondition: returns true only while the Worker has a pending approval holding its first turn.
   */
  isPendingForWorker(workerId: WorkerId): boolean;

  /**
   * Precondition: stepId is a Task Graph step ID.
   * Postcondition: returns true while a pending sandbox approval blocks the step (so hub graph decide rejects PM override).
   */
  isPendingForStep(stepId: number): boolean;

  /**
   * Precondition: called exclusively from authenticated human UI endpoints; id names a sandbox approval row.
   * Postcondition: idempotently applies approve (re-validating policy, settling card, invoking onApprovedIn) or reject (settling card, invoking onRejectedIn) in one write transaction.
   */
  decide(id: SandboxApprovalId, input: DecideSandboxApprovalRequest): DecideSandboxApprovalResponse;

  /**
   * Precondition: called inside a write transaction whenever a Worker ends, a PM is archived, or worktree setup fails.
   * Postcondition: transitions pending or approved rows for workerId to revoked, records revoked_at, and closes any unanswered card.
   */
  revokeForWorkerIn(p: Pending, workerId: WorkerId): void;

  /**
   * Precondition: nowMs is the current epoch timestamp in milliseconds.
   * Postcondition: deletes terminal approval rows beyond SANDBOX_APPROVALS_RETENTION_MS or SANDBOX_APPROVALS_TERMINAL_MAX_ROWS while preserving pending rows and open Workers; returns deleted row count.
   */
  pruneTerminal(nowMs?: number): number;
}

/**
 * Precondition: deps supplies the ledger context and transactional callbacks for card posting, launch resumption, and rejection cleanup.
 * Postcondition: returns a SandboxApprovalStore backed by worker_sandbox_approvals.
 */
export function createSandboxApprovalStore(_deps: SandboxApprovalsDeps): SandboxApprovalStore {
  throw new Error("Not implemented");
}

/**
 * Precondition: db has migrated through 0051_worker_sandbox_approvals.sql.
 * Postcondition: returns true only when task_graph_step_sandbox stores no_outer_sandbox = 1 for stepId.
 */
export function readStepNoOuterSandbox(_db: Db, _stepId: number): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: db has migrated through 0051_worker_sandbox_approvals.sql and stepId references an existing task_graph_steps row.
 * Postcondition: deletes the side-table row when false, or upserts no_outer_sandbox = 1 when true.
 */
export function writeStepNoOuterSandbox(_db: Db, _stepId: number, _noOuterSandbox: boolean): void {
  throw new Error("Not implemented");
}
