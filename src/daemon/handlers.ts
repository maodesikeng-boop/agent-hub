// 四类动作的处理函数（m1-plan 第 3 节接口约定第 3、6 条；m2-plan 第 3 节接口约定第 6 条；m3-plan 第 3 节接口约定）。
// - session.start → driver.start(sessionId)；
// - session.send → 读出消息，调 driver.send：written / rejected → done；queued（会话正忙）→ later；
//   额度用完 → later，到额度恢复再试；可重试的 DriverError 直接抛给执行器退避；
// - session.end → driver.end，等会话 ended 之后作废它的令牌、推一次会话状态（Worker 收工也走这里）；
// - worktree.create（M3）→ 账本取任务，git worktree add，再把起点提交交给账本（它登记 Worker 的第一轮）。
// session_ended（会话已经 end 过）不是故障，不抛给执行器（执行器就不会记 driver 的 health），怎么接见 Driver.end 的注释。
import {
  DriverError,
  QUEUED_RECHECK_MS,
  RATE_LIMIT_RECHECK_MAX_MS,
  RATE_LIMIT_RECHECK_PAD_MS,
  SessionTokenRevokedError,
  isQuotaExhausted,
  type ActionHandler,
  type ActionResult,
  type Driver,
  type Ledger,
  type SessionStore,
  type SessionTokens,
} from "../shared/index.ts";
import type { AddWorktreeOptions, AddWorktreeResult } from "./git/index.ts";


export interface HandlerDeps {
  driver: Pick<Driver, "start" | "send" | "end">;
  ledger: Pick<Ledger, "getMessage" | "onActionFailed" | "refreshSessionState" | "stopMessage">;
  sessions: Pick<SessionStore, "get">;
  /** 和 agent 接口、prepareLaunch 用的是同一个实例。 */
  tokens: Pick<SessionTokens, "revoke">;
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
export function rateLimitWaitMs(deps: Pick<HandlerDeps, "sessions" | "now">, sessionId: number): number | null {
  const info = deps.sessions.get(sessionId)?.rateLimit;
  if (!info || !isQuotaExhausted(info) || info.resetsAt === null) return null;
  const wait = info.resetsAt * 1000 - (deps.now ?? Date.now)();
  return wait > 0 ? wait : null;
}

export function createSessionSendHandler(deps: HandlerDeps): ActionHandler<"session.send"> {
  return async (action): Promise<ActionResult> => {
    const { sessionId, messageId, source, resend, recovery } = action.params;
    const message = deps.ledger.getMessage(messageId);
    // 消息没了，或者已经有结果（已回复、已停止）：没什么可发的
    if (message === null || message.status === "replied" || message.status === "stopped") return { kind: "done" };
    const wait = rateLimitWaitMs(deps, sessionId);
    if (wait !== null) return { kind: "later", delayMs: Math.min(wait + RATE_LIMIT_RECHECK_PAD_MS, RATE_LIMIT_RECHECK_MAX_MS), reason: "rate_limited" };
    let result;
    try {
      result = await deps.driver.send(sessionId, {
        messageIds: [messageId],
        source,
        text: message.text,
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
    return { kind: "done" };
  };
}

export function createSessionEndHandler(deps: Pick<HandlerDeps, "driver" | "ledger" | "tokens">): ActionHandler<"session.end"> {
  return async (action) => {
    const { sessionId } = action.params;
    // 正在跑就等这一轮回完：这一轮里 agent 可能还要用 hub，令牌等会话 ended 之后才作废
    await deps.driver.end(sessionId);
    deps.tokens.revoke(sessionId);
    // 驱动层直接把那一行写成 ended，没有对应的事件：推一次，网页才看得到
    deps.ledger.refreshSessionState(sessionId);
    return { kind: "done" };
  };
}

export interface WorktreeHandlerDeps {
  ledger: Pick<Ledger, "getWorktreeTask" | "onWorktreeCreated">;
  /** daemon/git 的 addWorktree（重复执行算成功）；测试换成假的。 */
  addWorktree: (options: AddWorktreeOptions) => Promise<AddWorktreeResult>;
}

/**
 * 给 Worker 建 worktree（shared/actions.ts 的 WorktreeCreateParams）。Worker 不在了、不用 worktree、已经收工：什么也不做。
 * git 出错原样抛给执行器，按 ACTION_RETRY 重试；次数用完执行器调 onActionFailed（项目经理收到一行 worktree_failed）。
 */
export function createWorktreeCreateHandler(deps: WorktreeHandlerDeps): ActionHandler<"worktree.create"> {
  return async (action) => {
    const { workerId } = action.params;
    const task = deps.ledger.getWorktreeTask(workerId);
    if (task === null || task.status === "ended") return { kind: "done" };
    const { baseCommit } = await deps.addWorktree({ repoFolder: task.repo, worktreePath: task.worktreePath, branch: task.branch });
    deps.ledger.onWorktreeCreated(workerId, baseCommit);
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
