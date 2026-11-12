// 四类动作的处理函数（m1-plan 第 3 节接口约定第 3、6 条；m2-plan 第 3 节接口约定第 6 条；m3-plan 第 3 节接口约定）。
// - session.start → driver.start(sessionId)；
// - session.send → 读出消息（写给 agent 的文字和标签用 deliveryParts），调 driver.send：written（含忙时中途交给 agent 的）/ cancelled / rejected → done；
//   queued（会话正忙、驱动层自己排着）→ later；written 了但账本那边又回到排队中（send 期间被收回）→ later；
//   额度用完 → later，到额度恢复再试；可重试的 DriverError 直接抛给执行器退避；
// - session.end → driver.end，等会话 ended 之后作废它的令牌、推一次会话状态（Worker 收工也走这里）；
// - worktree.create（M3）→ 账本取任务，git worktree add，再把起点提交交给账本（它登记 Worker 的第一轮）；
//   项目配了准备命令的，先交给 setup runner 在后台跑，跑完再交给账本（daemon/setup/setup.ts）。
// session_ended（会话已经 end 过）不是故障，不抛给执行器（执行器就不会记 driver 的 health），怎么接见 Driver.end 的注释。
import {
  DriverError,
  QUEUED_RECHECK_MS,
  RATE_LIMIT_RECHECK_MAX_MS,
  RATE_LIMIT_RECHECK_PAD_MS,
  SessionTokenRevokedError,
  WORKER_FIRST_TURN_RECHECK_MS,
  deliveryParts,
  isQuotaExhausted,
  type ActionHandler,
  type ActionResult,
  type Driver,
  type Ledger,
  type SessionStore,
  type SessionTokens,
  type WorkerId,
  type WorkerPr,
  type WorkerPrProbeResult,
} from "../shared/index.ts";
import type { AddWorktreeOptions, AddWorktreeResult, DiffFileStat } from "./git/index.ts";
import type { SetupRunner } from "./setup/index.ts";


export interface HandlerDeps {
  driver: Pick<Driver, "start" | "send" | "end">;
  ledger: Pick<
    Ledger,
    | "getMessage"
    | "onActionFailed"
    | "refreshSessionState"
    | "stopMessage"
    | "waitsForFirstTurn"
    | "waitsForHandover"
    | "graphDeliveryProbeTarget"
    | "enrichDeliveryNoteMessage"
  >;
  sessions: Pick<SessionStore, "get">;
  /** 和 agent 接口、prepareLaunch 用的是同一个实例。 */
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
      // 会话已经结束：没什么可起的
      if (isSessionEnded(error)) return { kind: "done" };
      throw error;
    }
    return { kind: "done" };
  };
}

/** 额度用完（isQuotaExhausted）、而且知道什么时候恢复：返回还要等多久；否则 null。 */
function rateLimitWaitMs(deps: Pick<HandlerDeps, "sessions" | "now">, sessionId: number): number | null {
  const info = deps.sessions.get(sessionId)?.rateLimit;
  if (!info || !isQuotaExhausted(info) || info.resetsAt === null) return null;
  const wait = info.resetsAt * 1000 - (deps.now ?? Date.now)();
  return wait > 0 ? wait : null;
}

export function createSessionSendHandler(deps: HandlerDeps): ActionHandler<"session.send"> {
  return async (action): Promise<ActionResult> => {
    const { sessionId, messageId, source, resend, recovery } = action.params;
    let message = deps.ledger.getMessage(messageId);
    // 消息没了，或者已经有结果（已回复、已停止、已取消）：没什么可发的
    if (message === null || message.status === "replied" || message.status === "stopped" || message.status === "cancelled") return { kind: "done" };
    // Worker 还没开工（建 worktree、跑准备命令）或任务说明还没写进去：先等，别让这条把会话提前拉起来（第一轮要是任务说明）
    if (deps.ledger.waitsForFirstTurn(sessionId, messageId)) return { kind: "later", delayMs: WORKER_FIRST_TURN_RECHECK_MS, reason: "worker_not_started" };
    // 项目经理在写交接、或者新会话的第一条（交接）还没发：先压着，换代后账本把它改发给新会话（ledger/handover.ts）
    if (deps.ledger.waitsForHandover(messageId)) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "handover" };
    const wait = rateLimitWaitMs(deps, sessionId);
    if (wait !== null) return { kind: "later", delayMs: Math.min(wait + RATE_LIMIT_RECHECK_PAD_MS, RATE_LIMIT_RECHECK_MAX_MS), reason: "rate_limited" };
    // 任务图待交付通知（task_graph.ready_to_finish）真正送入 PM 前，在事务外补探一次 git diff --numstat 与 PR 状态（探测失败不阻断）
    const probeTarget = deps.ledger.graphDeliveryProbeTarget?.(messageId) ?? null;
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
      if (refreshed === null || refreshed.status === "replied" || refreshed.status === "stopped" || refreshed.status === "cancelled") {
        return { kind: "done" };
      }
      message = refreshed;
    }
    let result;
    // 用户写的字 + 附件的完整路径；Worker 对话里用户直接说的话另带标签，驱动层放在原文前面单独一块（shared/worker.ts）
    const { prefixes, text } = deliveryParts(message);
    try {
      result = await deps.driver.send(sessionId, {
        messageIds: [messageId],
        source,
        text,
        ...(prefixes.length > 0 ? { prefixes } : {}),
        ...(resend ? { resend: true } : {}),
        ...(recovery ? { recovery: true } : {}),
      });
    } catch (error) {
      if (!isSessionEnded(error)) throw error;
      // 会话已经结束（迁移 0003 结束了老项目群的会话；Worker 收工了），这条消息发不出去了。
      // 已经写进去一半的（已送达、处理中：重启恢复时会遇到）按“这一轮被重启打断”处理，标已停止（和关机打断一轮一样）；
      // 还在排队的没有这一轮可停，标失败。
      const now = deps.ledger.getMessage(messageId);
      if (now === null) return { kind: "done" };
      if (now.status === "queued") deps.ledger.onActionFailed(action, "这个会话已经结束，发不出去了");
      else deps.ledger.stopMessage(messageId);
      return { kind: "done" };
    }
    if (result.kind === "queued") return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "session_busy" };
    // send 还没返回时这条被收回了（message.requeued：进程没了、停止时收回的系统消息）：账本放回排队中、重新登记的 session.send
    // 撞上这次还在跑的同一个动作，只改了参数；这里返回 done 它就一直停在排队中，所以过一会儿再发一次
    if (result.kind === "written" && deps.ledger.getMessage(messageId)?.status === "queued") return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "requeued" };
    return { kind: "done" };
  };
}

export function createSessionEndHandler(
  deps: Pick<HandlerDeps, "driver" | "ledger" | "tokens"> & { setup?: Pick<SetupRunner, "cancel"> },
): ActionHandler<"session.end"> {
  return async (action) => {
    const { sessionId } = action.params;
    // Worker 收工时准备命令还在跑：先停掉它（Worker 已经 ended，跑完账本也不会让它开工）
    deps.setup?.cancel(sessionId);
    // 正在跑就等这一轮回完：这一轮里 agent 可能还要用 hub，令牌等会话 ended 之后才作废
    await deps.driver.end(sessionId);
    deps.tokens.revoke(sessionId);
    // 驱动层直接把那一行写成 ended，没有对应的事件：推一次，网页才看得到
    deps.ledger.refreshSessionState(sessionId);
    return { kind: "done" };
  };
}

export interface WorktreeHandlerDeps {
  ledger: Pick<Ledger, "getWorktreeTask" | "onSetupStarted" | "onWorktreeCreated">;
  /** daemon/git 的 addWorktree（重复执行算成功）；测试换成假的。 */
  addWorktree: (options: AddWorktreeOptions) => Promise<AddWorktreeResult>;
  /** 跑准备命令的（daemon/setup 的 createSetupRunner）。 */
  setup: Pick<SetupRunner, "start">;
  /** 这个 Worker 的准备命令日志（paths.ts 的 workerSetupLogPath）。 */
  setupLogPath: (workerId: WorkerId) => string;
}

/**
 * 给 Worker 建 worktree（shared/actions.ts 的 WorktreeCreateParams）。Worker 不在了、不用 worktree、已经收工：什么也不做。
 * git 出错原样抛给执行器，按 ACTION_RETRY 重试；次数用完执行器调 onActionFailed（项目经理收到一行 worktree_failed）。
 * 项目配了准备命令：建好后交给 setup runner 在后台跑，这个动作马上做完（不占执行器：准备命令最长要跑 SETUP_TIMEOUT_MS），
 * 跑完 runner 再调 onWorktreeCreated 带上结果。关机打断的不交给账本，重启后 recoverAfterRestart 重新登记这个动作。
 */
export function createWorktreeCreateHandler(deps: WorktreeHandlerDeps): ActionHandler<"worktree.create"> {
  return async (action) => {
    const { workerId } = action.params;
    const task = deps.ledger.getWorktreeTask(workerId);
    if (task === null || task.status === "ended") return { kind: "done" };
    const { baseCommit } = await deps.addWorktree({ repoFolder: task.repo, worktreePath: task.worktreePath, branch: task.branch });
    if (task.setupCommand === null) {
      deps.ledger.onWorktreeCreated(workerId, baseCommit);
      return { kind: "done" };
    }
    // 建 worktree 的时候 Worker 可能已经收工了：onSetupStarted 再确认一次，没进准备中就不跑
    if (!deps.ledger.onSetupStarted(workerId)) return { kind: "done" };
    deps.setup.start({
      workerId,
      sessionId: task.sessionId,
      command: task.setupCommand,
      cwd: task.worktreePath,
      rootPath: task.repo,
      logPath: deps.setupLogPath(workerId),
      onDone: (outcome) => deps.ledger.onWorktreeCreated(workerId, baseCommit, outcome),
    });
    return { kind: "done" };
  };
}

/**
 * 给 prepareLaunch 的令牌：revoke 过的会话 issue 抛 SessionTokenRevokedError，驱动层会把它当可重试的 spawn_failed 一直重试。
 * 只把这一种换成 DriverError("session_ended")：驱动层原样抛出，处理函数按 session_ended 接；issue 的其他错照常抛出。
 */
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
