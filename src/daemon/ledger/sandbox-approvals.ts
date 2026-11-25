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
  TaskNode,
  WorkerId,
  WorkerStatus,
} from "../../shared/index.ts";
import type { Db } from "../store/index.ts";
import { z } from "zod";
import {
  PENDING_SANDBOX_APPROVALS_SNAPSHOT_MAX,
  SANDBOX_APPROVAL_TASK_SUMMARY_MAX_CHARS,
  SANDBOX_APPROVALS_RETENTION_MS,
  SANDBOX_APPROVALS_TERMINAL_MAX_ROWS,
  formatSandboxApprovalCardText,
} from "../../shared/index.ts";
import { fail, type LedgerContext, type Pending } from "./context.ts";

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
  maxTimeMs: number;
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

}

type ApprovalRow = Omit<SandboxApprovalRecord, "capabilities"> & { capabilitiesJson: string; workerStatus: WorkerStatus };

const APPROVAL_SELECT = `SELECT a.id, a.worker_id AS workerId, w.title AS workerTitle, a.pm_id AS pmId,
  a.conversation_id AS conversationId, a.message_id AS messageId, a.step_id AS stepId,
  a.vendor, w.model, w.workspace, w.branch, w.status AS workerStatus,
  a.capabilities_json AS capabilitiesJson, a.task_summary AS taskSummary, a.status,
  a.decided_by AS decidedBy, a.decision_client_id AS decisionClientId, a.created_at AS createdAt,
  a.decided_at AS decidedAt, a.revoked_at AS revokedAt, a.updated_at AS updatedAt
  FROM worker_sandbox_approvals a JOIN workers w ON w.id = a.worker_id`;

const capabilitiesSchema = z.array(z.string());
function toApproval({ capabilitiesJson, workerStatus: _workerStatus, ...row }: ApprovalRow): SandboxApprovalRecord {
  return { ...row, capabilities: capabilitiesSchema.parse(JSON.parse(capabilitiesJson)) };
}

const APPROVED_LABEL = "Approved";
const REJECTED_LABEL = "Rejected";

export function createSandboxApprovalStore(deps: SandboxApprovalsDeps): SandboxApprovalStore {
  const { db, now, write } = deps.ctx;
  const byId = (id: SandboxApprovalId) => db.get<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.id = ?`, id);
  const byWorker = (id: WorkerId) => db.get<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.worker_id = ?`, id);
  const read = (row: ApprovalRow | undefined) => row === undefined ? null : toApproval(row);
  const getById = (id: SandboxApprovalId) => read(byId(id));
  return {
    createPendingIn(p, input) {
      const t = now();
      const taskSummary = [...input.taskSummary].slice(0, SANDBOX_APPROVAL_TASK_SUMMARY_MAX_CHARS).join("");
      const created = db.get<{ id: SandboxApprovalId }>(
        `INSERT INTO worker_sandbox_approvals
         (worker_id, pm_id, conversation_id, step_id, vendor, capabilities_json, task_summary, max_time_ms, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING id`,
        input.workerId, input.pmId, input.conversationId, input.stepId, input.vendor, JSON.stringify(input.capabilities), taskSummary, input.maxTimeMs, t, t,
      );
      if (created === undefined) throw new Error("Sandbox approval was not inserted");
      const messageId = deps.insertCardMessageIn(p, {
        ...input, approvalId: created.id, text: formatSandboxApprovalCardText({ ...input, taskSummary }),
      });
      if (messageId === null) throw fail("conflict", "无法在项目经理会话创建沙箱确认卡");
      db.run("UPDATE worker_sandbox_approvals SET message_id = ? WHERE id = ?", messageId, created.id);
      return getById(created.id)!;
    },
    getByWorkerId: (id) => read(byWorker(id)),
    getById,
    listPendingSummaries() {
      return db.all<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.status = 'pending' AND w.status = 'open' ORDER BY a.id DESC LIMIT ?`, PENDING_SANDBOX_APPROVALS_SNAPSHOT_MAX)
        .map((row) => {
          const { decidedBy: _by, decisionClientId: _client, decidedAt: _decided, revokedAt: _revoked, updatedAt: _updated, stepId: _step, ...summary } = toApproval(row);
          return summary;
        });
    },
    isPendingForWorker: (id) => sandboxApprovalPending(db, id),
    isPendingForStep: (id) => sandboxApprovalPendingForStep(db, id),
    decide(id, input) {
      return write((p) => {
        const row = byId(id);
        if (row === undefined) throw fail("not_found", "找不到这张沙箱确认卡");
        const approve = input.decision === "approve";
        const status = approve ? "approved" : "rejected";
        if (row.status === status && row.decisionClientId === input.clientId) return { approval: toApproval(row), workerStatus: row.workerStatus };
        if (row.status !== "pending" || row.workerStatus !== "open") throw fail("conflict", "这张沙箱确认卡已经结束");
        if (approve) {
          const result = deps.recheckEligible(toApproval(row));
          if (!result.ok) throw fail("conflict", result.message);
        }
        const t = now();
        db.run("UPDATE worker_sandbox_approvals SET status = ?, decided_by = 'user', decision_client_id = ?, decided_at = ?, updated_at = ? WHERE id = ?",
          status, input.clientId, t, t, id);
        if (row.messageId !== null) deps.settleCardMessageIn(p, row.messageId, { by: "answer", chosenOption: approve ? APPROVED_LABEL : REJECTED_LABEL });
        const next = byId(id)!;
        if (approve) deps.onApprovedIn(p, toApproval(next));
        else deps.onRejectedIn(p, toApproval(next));
        const final = byId(id)!;
        return { approval: toApproval(final), workerStatus: final.workerStatus };
      });
    },
    revokeForWorkerIn(p, id) {
      const row = byWorker(id);
      if (row === undefined || (row.status !== "pending" && row.status !== "approved")) return;
      const t = now();
      db.run("UPDATE worker_sandbox_approvals SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?", t, t, row.id);
      if (row.status === "pending" && row.messageId !== null) deps.settleCardMessageIn(p, row.messageId, { by: "close" });
    },
  };
}

export function sandboxApprovalPending(db: Db, workerId: WorkerId): boolean {
  return db.get("SELECT id FROM worker_sandbox_approvals WHERE worker_id = ? AND status = 'pending'", workerId) !== undefined;
}

export function sandboxApprovalPendingForStep(db: Db, stepId: number): boolean {
  return db.get("SELECT id FROM worker_sandbox_approvals WHERE step_id = ? AND status = 'pending'", stepId) !== undefined;
}

export function pendingSandboxCardsForSteps(db: Db, stepIds: readonly number[]): ReadonlyMap<number, NonNullable<TaskNode["sandboxApproval"]>> {
  if (stepIds.length === 0) return new Map();
  const rows = db.all<ApprovalRow>(`${APPROVAL_SELECT}
    JOIN task_graph_steps n ON n.id = a.step_id AND n.active_worker_id = a.worker_id
    WHERE a.status = 'pending' AND a.step_id IN (SELECT value FROM json_each(?))`, JSON.stringify(stepIds));
  const cards = new Map<number, NonNullable<TaskNode["sandboxApproval"]>>();
  for (const row of rows) {
    if (row.stepId !== null) cards.set(row.stepId, { id: row.id, text: formatSandboxApprovalCardText(toApproval(row)) });
  }
  return cards;
}

export function readStepNoOuterSandbox(db: Db, stepId: number): boolean {
  return db.get("SELECT 1 FROM task_graph_step_sandbox WHERE step_id = ? AND no_outer_sandbox = 1", stepId) !== undefined;
}

export function writeStepNoOuterSandbox(db: Db, stepId: number, noOuterSandbox: boolean): void {
  if (noOuterSandbox) db.run("INSERT OR IGNORE INTO task_graph_step_sandbox (step_id, no_outer_sandbox) VALUES (?, 1)", stepId);
  else db.run("DELETE FROM task_graph_step_sandbox WHERE step_id = ?", stepId);
}

export function pruneSandboxApprovalsIn(db: Db, nowMs: number, budget: number): number {
  return db.run(`DELETE FROM worker_sandbox_approvals WHERE id IN (
    SELECT id FROM (
      SELECT a.id FROM worker_sandbox_approvals a JOIN workers w ON a.worker_id = w.id
      WHERE w.status = 'ended' AND a.status IN ('rejected', 'revoked') AND a.updated_at < ?
      UNION
      SELECT id FROM (SELECT a.id FROM worker_sandbox_approvals a JOIN workers w ON a.worker_id = w.id
        WHERE w.status = 'ended' AND a.status IN ('rejected', 'revoked') ORDER BY a.updated_at DESC, a.id DESC LIMIT -1 OFFSET ?)
    ) ORDER BY id LIMIT ?
  )`, nowMs - SANDBOX_APPROVALS_RETENTION_MS, SANDBOX_APPROVALS_TERMINAL_MAX_ROWS, budget).changes;
}
