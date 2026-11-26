// Invariant: only allow/deny from decide() (reached solely through the ui-server route) sets decided_by = 'user';
// agent-api, hub commands, Task Graph decisions, and Feishu never transition a row out of pending except to expire or revoke it.
import {
  APP_APPROVAL_CARDS_PER_WORKER_MAX, APP_APPROVAL_PENDING_PER_WORKER_MAX, APP_APPROVAL_SETTLED_LABELS,
  APP_APPROVAL_WAIT_MAX_MS, APP_APPROVALS_RETENTION_MS, APP_APPROVALS_TERMINAL_MAX_ROWS, PENDING_APP_APPROVALS_SNAPSHOT_MAX,
  appIdAlwaysDenied, formatAppApprovalCardText, vendorSpec,
} from "../../shared/index.ts";
import type { Db } from "../store/index.ts";
import { readWorkerCapabilities } from "./capability-rows.ts";
import { fail } from "./context.ts";
import type {
  AppApprovalEndReason,
  AppApprovalId,
  AppApprovalRecord,
  AppApprovalRef,
  AppApprovalRequest,
  AppApprovalSummary,
  ConversationId,
  DecideAppApprovalRequest,
  DecideAppApprovalResponse,
  MessageId,
  PmId,
  SessionId,
  WorkerId,
  WorkerStatus,
} from "../../shared/index.ts";
import type { LedgerContext, Pending } from "./context.ts";

export interface AppApprovalsDeps {
  ctx: LedgerContext;
  hasLiveRequests?: (id: AppApprovalId) => boolean;
  onRowChangedIn?: (p: Pending, id: AppApprovalId) => void;
  insertCardMessageIn: (
    p: Pending,
    input: { pmId: PmId; conversationId: ConversationId; ref: AppApprovalRef; text: string },
  ) => MessageId | null;
  settleCardMessageIn: (p: Pending, messageId: MessageId, outcome: { by: "answer"; chosenOption: string } | { by: "close" }) => void;
  /** Queues a system note to the Worker when the user allows an app after its native request already ended. */
  notifyWorkerIn: (p: Pending, workerId: WorkerId, text: string, approvalId: AppApprovalId) => void;
}

/** Result of matching a native request against stored rows; the broker waits only on "pending". */
export type AppApprovalLookup =
  | { kind: "allowed"; approvalId: AppApprovalId }
  | { kind: "denied"; approvalId: AppApprovalId }
  | { kind: "pending"; approvalId: AppApprovalId; expiresAt: number }
  | { kind: "ineligible"; reason: string };

export interface AppApprovalStore {
  /**
   * Precondition: request passed the driver's vendor checks.
   * Postcondition: re-checks that sessionId belongs to an open Worker whose sandbox approval is approved and whose mounted
   * capabilities include request.capability, and that appIdAlwaysDenied(appId) is false; otherwise returns ineligible.
   * Returns the newest allowed, denied, or pending row for (worker, appId), bumping request_count on pending;
   * otherwise inserts a pending row with expires_at = now + APP_APPROVAL_WAIT_MAX_MS and posts the card in the PM conversation.
   * Returns ineligible without a new card past APP_APPROVAL_PENDING_PER_WORKER_MAX pending or APP_APPROVAL_CARDS_PER_WORKER_MAX rows.
   */
  openOrAttach(request: AppApprovalRequest): AppApprovalLookup;

  getById(id: AppApprovalId): AppApprovalRecord | null;

  /** Postcondition: returns up to PENDING_APP_APPROVALS_SNAPSHOT_MAX pending rows for open Workers, newest first. */
  listPendingSummaries(): AppApprovalSummary[];

  /**
   * Precondition: called only from the authenticated ui-server route.
   * Postcondition: pending -> allowed or denied with decided_by 'user' in one write transaction, settling the card.
   * Repeating the same clientId returns the stored result; a different decision on a decided row throws conflict;
   * an expired or revoked row throws conflict; allow on a row whose native requests all ended queues a Worker note.
   */
  decide(id: AppApprovalId, input: DecideAppApprovalRequest): DecideAppApprovalResponse;

  /** Postcondition: pending -> expired for every row raised by (sessionId, processKey) and closes those cards; decided rows stay. */
  endProcess(sessionId: SessionId, processKey: string, reason: AppApprovalEndReason): void;

  /** Precondition: inside the write transaction that ends the Worker. Postcondition: pending -> expired and allowed or denied -> revoked for workerId. */
  revokeForWorkerIn(p: Pending, workerId: WorkerId): void;

  /** Postcondition: expires pending rows whose expires_at <= now; returns the ids it expired. */
  expireDue(now: number): AppApprovalId[];

  /** Postcondition: at daemon start, ends every pending or decided row with reason daemon_restart, since no vendor process survives a restart. */
  endAllAtStartup(): void;

  /** Postcondition: deletes terminal rows older than APP_APPROVALS_RETENTION_MS and beyond APP_APPROVALS_TERMINAL_MAX_ROWS, oldest first. */
  pruneTerminal(now: number): number;
}

type ApprovalRow = AppApprovalRecord & { workerStatus: WorkerStatus };

const SELECT = `SELECT a.id, a.worker_id AS workerId, w.title AS workerTitle, w.status AS workerStatus,
  a.session_id AS sessionId, a.sandbox_approval_id AS sandboxApprovalId, a.pm_id AS pmId, a.conversation_id AS conversationId,
  a.message_id AS messageId, a.vendor, a.process_key AS processKey, a.app_id AS appId, a.app_name AS appName,
  a.risk_level AS riskLevel, a.warning, a.status, a.decided_by AS decidedBy, a.decision_client_id AS decisionClientId,
  a.request_count AS requestCount, a.created_at AS createdAt, a.expires_at AS expiresAt, a.decided_at AS decidedAt,
  a.ended_at AS endedAt, a.updated_at AS updatedAt
  FROM worker_app_approvals a JOIN workers w ON w.id = a.worker_id`;

type RequestWorker = Pick<AppApprovalRecord, "workerId" | "workerTitle" | "pmId" | "conversationId" | "sandboxApprovalId">;

function eligibleWorker(db: Db, request: AppApprovalRequest): RequestWorker | undefined {
  if (appIdAlwaysDenied(request.appId) ||
      vendorSpec(request.vendor).capabilities.builtInSandbox?.computerUseCapabilities.includes(request.capability) !== true) return undefined;
  const worker = db.get<RequestWorker>(`SELECT w.id AS workerId, w.title AS workerTitle, w.pm_id AS pmId,
      w.pm_conversation_id AS conversationId, sa.id AS sandboxApprovalId
    FROM agent_sessions s JOIN workers w ON w.id = s.worker_id JOIN worker_sandbox_approvals sa ON sa.worker_id = w.id
    WHERE s.id = ? AND s.role = 'worker' AND s.vendor = ? AND sa.vendor = s.vendor
      AND s.id = (SELECT id FROM agent_sessions WHERE conversation_id = s.conversation_id ORDER BY generation DESC LIMIT 1)
      AND w.status = 'open' AND sa.status = 'approved' AND sa.decided_by = 'user'
      AND EXISTS (SELECT 1 FROM json_each(sa.capabilities_json) WHERE value = ?)`,
  request.sessionId, request.vendor, request.capability);
  if (worker === undefined) return undefined;
  const configured = readWorkerCapabilities(db, { table: "worker_capabilities", workerId: worker.workerId });
  return configured.mode === "custom" && configured.allow.includes(request.capability) ? worker : undefined;
}

function summaryOf(row: AppApprovalRecord): AppApprovalSummary {
  const { id, workerId, workerTitle, pmId, conversationId, messageId, vendor, appId, appName, riskLevel, warning, status, createdAt, expiresAt } = row;
  return { id, workerId, workerTitle, pmId, conversationId, messageId, vendor, appId, appName, riskLevel, warning, status, createdAt, expiresAt };
}

function recordOf(row: ApprovalRow): AppApprovalRecord {
  const { workerStatus: _, ...record } = row;
  return record;
}

export function createAppApprovalStore(deps: AppApprovalsDeps): AppApprovalStore {
  const { db, now, write } = deps.ctx;
  const byId = (id: AppApprovalId) => db.get<ApprovalRow>(`${SELECT} WHERE a.id = ?`, id);

  const endIn = (p: Pending, rows: readonly Pick<ApprovalRow, "id" | "status" | "messageId">[], at: number) => {
    for (const row of rows) {
      const status = row.status === "pending" ? "expired" : "revoked";
      db.run(`UPDATE worker_app_approvals SET status = ?, decided_by = COALESCE(decided_by, 'system'),
              ended_at = ?, updated_at = ? WHERE id = ?`, status, at, at, row.id);
      if (row.messageId !== null) deps.settleCardMessageIn(p, row.messageId, { by: "close" });
      deps.onRowChangedIn?.(p, row.id);
    }
  };

  return {
    getById(id) {
      const row = byId(id);
      return row === undefined ? null : recordOf(row);
    },
    openOrAttach(request) {
      const worker = eligibleWorker(db, request);
      if (worker === undefined) return { kind: "ineligible", reason: "App approval is unavailable for this Worker" };
      const at = now();
      const matching = db.get<ApprovalRow>(`${SELECT} WHERE a.worker_id = ? AND a.sandbox_approval_id = ? AND a.app_id = ?
        AND a.status IN ('pending', 'allowed', 'denied') ORDER BY a.id DESC LIMIT 1`, worker.workerId, worker.sandboxApprovalId, request.appId);
      if (matching?.status === "allowed" || matching?.status === "denied") {
        return { kind: matching.status, approvalId: matching.id };
      }
      return write((p) => {
        if (matching?.status === "pending") {
          if (matching.expiresAt > at && matching.sessionId === request.sessionId && matching.processKey === request.processKey) {
            db.run("UPDATE worker_app_approvals SET request_count = request_count + 1, updated_at = ? WHERE id = ?", at, matching.id);
            return { kind: "pending", approvalId: matching.id, expiresAt: matching.expiresAt };
          }
          endIn(p, [matching], at);
        }
        const counts = db.get<{ total: number; pending: number }>(`SELECT COUNT(*) AS total,
            COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending FROM worker_app_approvals WHERE worker_id = ?`, worker.workerId);
        if (counts !== undefined && (counts.pending >= APP_APPROVAL_PENDING_PER_WORKER_MAX || counts.total >= APP_APPROVAL_CARDS_PER_WORKER_MAX)) {
          return { kind: "ineligible", reason: "App approval card limit reached" };
        }
        const { workerId, pmId, conversationId, sandboxApprovalId } = worker;
        const expiresAt = at + APP_APPROVAL_WAIT_MAX_MS;
        const { appId, appName, riskLevel, warning, sessionId, vendor, processKey } = request;
        const { lastInsertRowid: approvalId } = db.run(`INSERT INTO worker_app_approvals (
          worker_id, session_id, sandbox_approval_id, pm_id, conversation_id, vendor, process_key,
          app_id, app_name, risk_level, warning, status, created_at, expires_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        workerId, sessionId, sandboxApprovalId, pmId, conversationId, vendor, processKey, appId, appName, riskLevel, warning, at, expiresAt, at);
        const ref = { approvalId, workerId, appId, appName, riskLevel, warning, workerTitle: worker.workerTitle, expiresAt };
        const messageId = deps.insertCardMessageIn(p, { pmId, conversationId, ref, text: formatAppApprovalCardText({ ...worker, ...ref }) });
        if (messageId !== null) db.run("UPDATE worker_app_approvals SET message_id = ? WHERE id = ?", messageId, approvalId);
        return { kind: "pending", approvalId, expiresAt };
      });
    },
    listPendingSummaries() {
      return db.all<ApprovalRow>(`${SELECT} WHERE a.status = 'pending' AND w.status = 'open' AND a.expires_at > ?
        ORDER BY a.id DESC LIMIT ?`, now(), PENDING_APP_APPROVALS_SNAPSHOT_MAX).map(summaryOf);
    },
    decide(id, input) {
      return write((p) => {
        const row = byId(id);
        if (row === undefined) throw fail("not_found", "App approval card not found");
        const status = input.decision === "allow" ? "allowed" : "denied";
        if (row.status === status && row.decisionClientId === input.clientId) {
          return { approval: recordOf(row), workerStatus: row.workerStatus };
        }
        const at = now();
        const sandbox = db.get("SELECT 1 FROM worker_sandbox_approvals WHERE id = ? AND status = 'approved' AND decided_by = 'user'", row.sandboxApprovalId);
        if (row.status !== "pending" || row.workerStatus !== "open" || row.expiresAt <= at || sandbox === undefined) {
          throw fail("conflict", "This app approval card has already ended");
        }
        db.run(`UPDATE worker_app_approvals SET status = ?, decided_by = 'user', decision_client_id = ?,
          decided_at = ?, updated_at = ? WHERE id = ?`, status, input.clientId, at, at, id);
        if (row.messageId !== null) deps.settleCardMessageIn(p, row.messageId, { by: "answer", chosenOption: APP_APPROVAL_SETTLED_LABELS[status] });
        if (status === "allowed" && deps.hasLiveRequests?.(id) !== true) {
          deps.notifyWorkerIn(p, row.workerId, `【系统】用户已允许 Computer Use 控制 ${row.appName}（${row.appId}），本次运行内有效，可以重试。`, id);
        }
        deps.onRowChangedIn?.(p, id);
        return { approval: recordOf(byId(id)!), workerStatus: row.workerStatus };
      });
    },
    endProcess(sessionId, processKey, _reason) {
      const rows = db.all<ApprovalRow>(`${SELECT} WHERE a.session_id = ? AND a.process_key = ? AND a.status = 'pending'`, sessionId, processKey);
      if (rows.length > 0) write((p) => endIn(p, rows, now()));
    },
    revokeForWorkerIn(p, workerId) {
      endIn(p, db.all<ApprovalRow>(`${SELECT} WHERE a.worker_id = ? AND a.status IN ('pending', 'allowed', 'denied')`, workerId), now());
    },
    expireDue(at) {
      const rows = db.all<ApprovalRow>(`${SELECT} WHERE a.status = 'pending' AND a.expires_at <= ?`, at);
      if (rows.length > 0) write((p) => endIn(p, rows, at));
      return rows.map((row) => row.id);
    },
    endAllAtStartup() {
      const rows = db.all<ApprovalRow>(`${SELECT} WHERE a.status IN ('pending', 'allowed', 'denied')`);
      if (rows.length > 0) write((p) => endIn(p, rows, now()));
    },
    pruneTerminal(at) {
      return db.transaction(() => pruneAppApprovalsIn(db, at, APP_APPROVALS_TERMINAL_MAX_ROWS));
    },
  };
}

export function pruneAppApprovalsIn(db: Db, now: number, maxRows: number): number {
  return db.run(`DELETE FROM worker_app_approvals WHERE id IN (
    SELECT id FROM worker_app_approvals WHERE status IN ('expired', 'revoked')
      AND (updated_at < ? OR (updated_at, id) <= (
        SELECT updated_at, id FROM worker_app_approvals WHERE status IN ('expired', 'revoked')
        ORDER BY updated_at DESC, id DESC LIMIT 1 OFFSET ?
      ))
    ORDER BY updated_at, id LIMIT ?)`, now - APP_APPROVALS_RETENTION_MS, APP_APPROVALS_TERMINAL_MAX_ROWS, maxRows).changes;
}
