import {
  DriverError,
  QUEUED_RECHECK_MS,
  RATE_LIMIT_RECHECK_MAX_MS,
  RATE_LIMIT_RECHECK_PAD_MS,
  SessionTokenRevokedError,
  WORKER_FIRST_TURN_RECHECK_MS,
  diffReviewSnapshot,
  isChecklistReminder,
  isQuotaExhausted,
  type ActionHandler,
  type ActionResult,
  type ActionRow,
  type Driver,
  type Ledger,
  type Message,
  type ReviewObservation,
  type ReviewSnapshot,
  type SessionStore,
  type SessionTokens,
  type WorkerId,
  type WorkerPr,
  type WorkerPrProbeResult,
  type WorktreeTask,
} from "../shared/index.ts";
import type { AddWorktreeOptions, AddWorktreeResult, BranchTip, DiffFileStat, ResolveBranchTip, WorktreeSyncResult } from "./git/index.ts";
import type { SqliteLedger } from "./ledger/index.ts";
import type { SessionTmpStore } from "./session-tmp.ts";
import type { SetupRunner } from "./setup/index.ts";


export interface HandlerDeps {
  driver: Pick<Driver, "start" | "send" | "end">;
  ledger: Pick<
    Ledger,
    | "getMessage"
    | "isSystemMessageCurrent"
    | "retireStaleSystemMessage"
    | "reconcileWorktreeBranches"
    | "onActionFailed"
    | "refreshSessionState"
    | "stopMessage"
    | "waitsForTurnCompletion"
    | "waitsForFirstTurn"
    | "waitsForHandover"
    | "graphDeliveryProbeTarget"
    | "enrichDeliveryNoteMessage"
    | "deliveryOf"
  >;
  sessions: Pick<SessionStore, "get">;
  tokens: Pick<SessionTokens, "revoke">;
  probeDiffNumstat?: (repoFolder: string, branch: string, options?: { baseCommit?: string | null }) => Promise<readonly DiffFileStat[] | null>;
  probePr?: (cwd: string, branch: string) => Promise<WorkerPrProbeResult>;
  now?: () => number;
}

const isSessionEnded = (error: unknown): error is DriverError => error instanceof DriverError && error.code === "session_ended";

export function createSessionStartHandler(deps: Pick<HandlerDeps, "driver">): ActionHandler<"session.start"> {
  return async (action) => {
    const { sessionId } = action.params;
    try {
      await deps.driver.start(sessionId);
    } catch (error) {
      if (isSessionEnded(error)) return { kind: "done" };
      throw error;
    }
    return { kind: "done" };
  };
}

function rateLimitWaitMs(deps: Pick<HandlerDeps, "sessions" | "now">, sessionId: number): number | null {
  const info = deps.sessions.get(sessionId)?.rateLimit;
  if (!info || !isQuotaExhausted(info) || info.resetsAt === null) return null;
  const wait = info.resetsAt * 1000 - (deps.now ?? Date.now)();
  return wait > 0 ? wait : null;
}

function waitsForRateLimitReset(
  action: ActionRow<"session.send">,
  message: Pick<Message, "sender">,
): boolean {
  const { source, resend, recovery } = action.params;
  return source === "system" || message.sender === "system" || resend === true || recovery === true || action.attempts > 0;
}

function canSendTo(message: Message | null, sessionId: number): message is Message {
  return message !== null && message.sessionId === sessionId &&
    (message.status === "queued" || message.status === "delivered" || message.status === "processing");
}

type NoticeLedger = Pick<HandlerDeps["ledger"], "isSystemMessageCurrent" | "retireStaleSystemMessage">;

function stopStaleNotice(ledger: NoticeLedger, message: Message): boolean {
  if (message.sender !== "system" || ledger.isSystemMessageCurrent?.(message.id) !== false) return false;
  ledger.retireStaleSystemMessage?.(message.id);
  return true;
}

export function canDeliverSystemMessage(
  ledger: Pick<HandlerDeps["ledger"], "getMessage"> & NoticeLedger, sessionId: number, messageId: number,
): boolean {
  const message = ledger.getMessage(messageId);
  return canSendTo(message, sessionId) && !stopStaleNotice(ledger, message);
}

export function createSessionSendHandler(deps: HandlerDeps): ActionHandler<"session.send"> {
  return async (action): Promise<ActionResult> => {
    const { sessionId, messageId, source, resend, recovery } = action.params;
    let message = deps.ledger.getMessage(messageId);
    if (!canSendTo(message, sessionId)) return { kind: "done" };
    if (stopStaleNotice(deps.ledger, message)) return { kind: "done" };
    if (deps.ledger.waitsForTurnCompletion(sessionId)) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "turn_completion" };
    // Hold until the Worker has started and its brief is written, so the session does not start early.
    if (deps.ledger.waitsForFirstTurn(sessionId, messageId)) return { kind: "later", delayMs: WORKER_FIRST_TURN_RECHECK_MS, reason: "worker_not_started" };
    // Hold while the PM writes a handover or the new session has not received it yet.
    if (deps.ledger.waitsForHandover(messageId)) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "handover" };
    if (waitsForRateLimitReset(action, message)) {
      const wait = rateLimitWaitMs(deps, sessionId);
      if (wait !== null) return { kind: "later", delayMs: Math.min(wait + RATE_LIMIT_RECHECK_PAD_MS, RATE_LIMIT_RECHECK_MAX_MS), reason: "rate_limited" };
    }
    let probeTarget = deps.ledger.graphDeliveryProbeTarget?.(messageId) ?? null;
    if (probeTarget !== null && deps.ledger.reconcileWorktreeBranches) {
      await deps.ledger.reconcileWorktreeBranches({ graphId: probeTarget.graphId });
      probeTarget = deps.ledger.graphDeliveryProbeTarget?.(messageId) ?? null;
      const refreshed = deps.ledger.getMessage(messageId);
      if (!canSendTo(refreshed, sessionId)) return { kind: "done" };
      if (deps.ledger.waitsForTurnCompletion(sessionId)) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "turn_completion" };
      if (deps.ledger.waitsForHandover(messageId)) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "handover" };
      message = refreshed;
    }
    if (probeTarget !== null && (deps.probeDiffNumstat || deps.probePr)) {
      const fileMap = new Map<string, DiffFileStat>();
      let probedAnyDiff = false;
      const prs: Record<string, WorkerPr> = {};
      await Promise.all(
        probeTarget.branches.map(async (b) => {
          const [diffStats, prRes] = await Promise.all([
            probeTarget.repoFolder !== null && deps.probeDiffNumstat
              ? deps.probeDiffNumstat(probeTarget.repoFolder, b.branch, { baseCommit: b.baseCommit }).catch(() => null)
              : Promise.resolve(null),
            deps.probePr ? deps.probePr(b.cwd, b.branch).catch(() => null) : Promise.resolve(null),
          ]);
          if (diffStats !== null) {
            probedAnyDiff = true;
            for (const item of diffStats) {
              const prev = fileMap.get(item.file);
              if (!prev) {
                fileMap.set(item.file, { ...item });
              } else {
                fileMap.set(item.file, {
                  file: item.file,
                  added: prev.added === null || item.added === null ? null : prev.added + item.added,
                  deleted: prev.deleted === null || item.deleted === null ? null : prev.deleted + item.deleted,
                });
              }
            }
          }
          if (prRes !== null && !("unavailable" in prRes)) {
            prs[b.branch] = prRes;
          }
        }),
      );
      deps.ledger.enrichDeliveryNoteMessage?.(messageId, {
        ...(probedAnyDiff ? { files: [...fileMap.values()] } : {}),
        prs,
      });
      const refreshed = deps.ledger.getMessage(messageId);
      if (!canSendTo(refreshed, sessionId)) return { kind: "done" };
      if (deps.ledger.waitsForTurnCompletion(sessionId)) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "turn_completion" };
      if (deps.ledger.waitsForHandover(messageId)) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "handover" };
      message = refreshed;
    }
    if (stopStaleNotice(deps.ledger, message)) return { kind: "done" };
    let result;
    const rider = isChecklistReminder(message);
    const { prefixes, text } = deps.ledger.deliveryOf(message);
    try {
      result = await deps.driver.send(sessionId, {
        messageIds: [messageId],
        source,
        text,
        ...(prefixes.length > 0 ? { prefixes } : {}),
        ...(resend ? { resend: true } : {}),
        ...(recovery ? { recovery: true } : {}),
        ...(rider ? { rider: true } : {}),
      });
    } catch (error) {
      if (!isSessionEnded(error)) throw error;
      const now = deps.ledger.getMessage(messageId);
      if (now === null || now.sessionId !== sessionId) return { kind: "done" };
      if (now.status === "queued") deps.ledger.onActionFailed(action, "这个会话已经结束，发不出去了");
      else deps.ledger.stopMessage(messageId, sessionId);
      return { kind: "done" };
    }
    if (result.kind === "queued") return rider ? { kind: "done" } : { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "session_busy" };
    // The message was reclaimed while send was in flight, so its result is ignored.
    if (result.kind === "written") {
      const after = deps.ledger.getMessage(messageId);
      if (after?.sessionId === sessionId && after.status === "queued") return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "requeued" };
    }
    return { kind: "done" };
  };
}

export function createSessionEndHandler(
  deps: Pick<HandlerDeps, "driver" | "tokens"> & {
    ledger: Pick<Ledger, "refreshSessionState"> & Partial<Pick<SqliteLedger, "trimEndedWorkerSteps">>;
    setup?: Pick<SetupRunner, "cancel">;
    sessionTmp?: Pick<SessionTmpStore, "remove">;
    reapSessionProcesses?: (sessionId: number) => Promise<unknown>;
  },
): ActionHandler<"session.end"> {
  return async (action) => {
    const { sessionId } = action.params;
    deps.setup?.cancel(sessionId);
    // Wait for the current turn because the agent may still call hub; the token is revoked only after the session ends.
    await deps.driver.end(sessionId);
    deps.tokens.revoke(sessionId);
    await deps.reapSessionProcesses?.(sessionId).catch(() => {});
    if (deps.sessionTmp !== undefined) {
      await deps.sessionTmp.remove(sessionId).catch(() => {});
    }
    deps.ledger.trimEndedWorkerSteps?.(sessionId);
    // The driver writes ended directly with no event, so push it for the UI.
    deps.ledger.refreshSessionState(sessionId);
    return { kind: "done" };
  };
}

export type ObserveReview = (repo: string, branch: string, before: ReviewSnapshot) => Promise<ReviewObservation>;

/** Only the remote recorded at review start is probed; a review that started without a reachable remote is checked locally, so going offline cannot fail it. */
export function createReviewObserver(deps: {
  resolveCommit: (folder: string, ref: string) => Promise<string | null>;
  remoteBranchHead: (repo: string, branch: string, remote?: string) => Promise<{ name: string; sha: string | null } | undefined>;
  probePr: (cwd: string, branch: string) => Promise<WorkerPrProbeResult>;
}): ObserveReview {
  return async (repo, branch, before) => {
    const [sha, remote, pr] = await Promise.all([
      deps.resolveCommit(repo, `refs/heads/${branch}`),
      before.remote === null ? null : deps.remoteBranchHead(repo, branch, before.remote.name),
      before.pr === null ? null : deps.probePr(repo, branch),
    ]);
    return { sha, remote: remote ?? null, pr };
  };
}

export interface WorktreeHandlerDeps {
  ledger: Pick<Ledger, "reconcileWorkerGraph" | "getWorktreeTask" | "onSetupStarted" | "onWorktreeCreated" | "recordReviewSnapshot" | "noteWorkspaceCheckout">;
  resolveTip: ResolveBranchTip;
  probePr: (cwd: string, branch: string) => Promise<WorkerPrProbeResult>;
  addWorktree: (options: AddWorktreeOptions) => Promise<AddWorktreeResult>;
  setup: Pick<SetupRunner, "start">;
  setupLogPath: (workerId: WorkerId) => string;
  sessionTmp?: Pick<SessionTmpStore, "allocate">;
  sessionTagEnv?: (sessionId: number) => string;
  resolveWorktreePlacement?: (task: {
    workerId: WorkerId;
    sessionId: number;
    repo: string;
    worktreePath: string;
  }) => Promise<{
    worktreePath: string;
    prepareDir?: (worktreePath: string) => Promise<void> | void;
  }>;
}

/** Review and fork checkouts start from the branch's delivered tip (local or remote, cross-checked with the upstream report), never a stale local ref. */
async function startingTip(deps: WorktreeHandlerDeps, repo: string, checkout: WorktreeTask["checkout"]): Promise<{ branch: string; tip: BranchTip } | null> {
  const branch = checkout.kind === "review" ? checkout.branch : checkout.base;
  if (branch === undefined) return null;
  return { branch, tip: await deps.resolveTip(repo, branch, checkout.expected ?? null) };
}

async function recordReviewStart(deps: WorktreeHandlerDeps, workerId: WorkerId, repo: string, branch: string, sha: string, tip: BranchTip): Promise<void> {
  const seen = await deps.probePr(repo, branch);
  const pr = seen !== null && !("unavailable" in seen) ? seen : null;
  deps.ledger.recordReviewSnapshot(workerId, { sha, local: tip.local, remote: tip.remote, pr });
}

export function createWorktreeCreateHandler(deps: WorktreeHandlerDeps): ActionHandler<"worktree.create"> {
  return async (action) => {
    const { workerId } = action.params;
    await deps.ledger.reconcileWorkerGraph?.(workerId);
    const task = deps.ledger.getWorktreeTask(workerId);
    if (task === null || task.status === "ended") return { kind: "done" };
    const placement = deps.resolveWorktreePlacement
      ? await deps.resolveWorktreePlacement({
          workerId,
          sessionId: task.sessionId,
          repo: task.repo,
          worktreePath: task.worktreePath,
        })
      : { worktreePath: task.worktreePath };
    const effectiveWorktreePath = placement.worktreePath;
    const { checkout } = task;
    const start = await startingTip(deps, task.repo, checkout);
    const { baseCommit } = await deps.addWorktree({
      repoFolder: task.repo,
      worktreePath: effectiveWorktreePath,
      branch: checkout.kind === "review" ? null : checkout.branch,
      ...(start === null ? {} : { base: start.tip.commit }),
      ...(placement.prepareDir ? { prepareDir: placement.prepareDir } : {}),
    });
    if (start !== null) {
      if (checkout.kind === "review") await recordReviewStart(deps, workerId, task.repo, start.branch, baseCommit, start.tip);
      deps.ledger.noteWorkspaceCheckout(workerId, { branch: start.branch, commit: baseCommit, findings: start.tip.findings });
    }
    if (task.setupCommand === null) {
      deps.ledger.onWorktreeCreated(workerId, baseCommit);
      return { kind: "done" };
    }
    // The Worker may have ended while the worktree was being created; onSetupStarted checks again.
    if (!deps.ledger.onSetupStarted(workerId)) return { kind: "done" };
    const tmpDir = deps.sessionTmp?.allocate(task.sessionId);
    const sessionTagEnv = deps.sessionTagEnv?.(task.sessionId);
    deps.setup.start({
      workerId,
      sessionId: task.sessionId,
      command: task.setupCommand,
      cwd: effectiveWorktreePath,
      rootPath: task.repo,
      logPath: deps.setupLogPath(workerId),
      ...(tmpDir === undefined ? {} : { tmpDir }),
      ...(sessionTagEnv === undefined ? {} : { sessionTagEnv }),
      onDone: (outcome) => deps.ledger.onWorktreeCreated(workerId, baseCommit, outcome),
    });
    return { kind: "done" };
  };
}

export interface WorktreeSyncHandlerDeps {
  ledger: Pick<Ledger, "reconcileWorkerGraph" | "getWorktreeSyncTask" | "onWorktreeSynced">;
  syncWorktree: (repo: string, worktreePath: string, branch: string, expected: string | null) => Promise<WorktreeSyncResult>;
}

export function createWorktreeSyncHandler(deps: WorktreeSyncHandlerDeps): ActionHandler<"worktree.sync"> {
  return async (action) => {
    const { workerId } = action.params;
    await deps.ledger.reconcileWorkerGraph?.(workerId);
    const task = deps.ledger.getWorktreeSyncTask(workerId);
    if (task?.kind === "wait") return { kind: "later", delayMs: WORKER_FIRST_TURN_RECHECK_MS, reason: "worktree_busy" };
    if (task === null) {
      deps.ledger.onWorktreeSynced(workerId, null);
      return { kind: "done" };
    }
    const { tip, outcome } = await deps.syncWorktree(task.repo, task.worktreePath, task.branch, task.expected);
    if (tip === null || outcome.kind === "not_on_branch") {
      deps.ledger.onWorktreeSynced(workerId, null);
      return { kind: "done" };
    }
    const commit = outcome.kind === "fast_forwarded" ? outcome.to : (tip.local ?? tip.commit);
    deps.ledger.onWorktreeSynced(workerId, { branch: task.branch, commit, findings: tip.findings, sync: outcome });
    return { kind: "done" };
  };
}

export interface ReviewVerifyHandlerDeps {
  ledger: Pick<Ledger, "getReviewVerifyTask" | "onReviewVerified">;
  observeReview: ObserveReview;
}

export function createReviewVerifyHandler(deps: ReviewVerifyHandlerDeps): ActionHandler<"review.verify"> {
  return async (action) => {
    const task = deps.ledger.getReviewVerifyTask(action.params.workerId);
    if (task === null) return { kind: "done" };
    const now = await deps.observeReview(task.repo, task.branch, task.snapshot);
    deps.ledger.onReviewVerified(action.params, { problems: diffReviewSnapshot(task.branch, task.snapshot, now) });
    return { kind: "done" };
  };
}

/** Issuing for a revoked session throws SessionTokenRevokedError, which the driver turns into a non-retryable error. */
export function endedOnRevokedTokens(tokens: Pick<SessionTokens, "issue">): Pick<SessionTokens, "issue"> {
  return {
    issue(sessionId) {
      try {
        return tokens.issue(sessionId);
      } catch (error) {
        if (error instanceof SessionTokenRevokedError) throw new DriverError("session_ended", `session ${sessionId}: ${error.message}`);
        throw error;
      }
    },
  };
}
