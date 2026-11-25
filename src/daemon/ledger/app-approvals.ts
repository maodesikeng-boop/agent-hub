// Invariant: only allow/deny from decide() (reached solely through the ui-server route) sets decided_by = 'user';
// agent-api, hub commands, Task Graph decisions, and Feishu never transition a row out of pending except to expire or revoke it.
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
} from "../../shared/index.ts";
import type { LedgerContext, Pending } from "./context.ts";

export interface AppApprovalsDeps {
  ctx: LedgerContext;
  insertCardMessageIn: (
    p: Pending,
    input: { pmId: PmId; conversationId: ConversationId; ref: AppApprovalRef; text: string },
  ) => MessageId | null;
  settleCardMessageIn: (p: Pending, messageId: MessageId, outcome: { by: "answer"; chosenOption: string } | { by: "close" }) => void;
  /** Queues a system note to the Worker when the user allows an app after its native request already ended. */
  notifyWorkerIn: (p: Pending, workerId: WorkerId, text: string) => void;
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

export function createAppApprovalStore(_deps: AppApprovalsDeps): AppApprovalStore {
  throw new Error("Not implemented");
}
