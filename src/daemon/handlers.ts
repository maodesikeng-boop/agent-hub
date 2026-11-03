// 三类动作的处理函数（m1-plan 第 3 节接口约定第 3、6 条；m2-plan 第 3 节接口约定第 6 条）。
// - session.start → driver.start(sessionId, { recovery })；
// - session.send → 读出消息，调 driver.send：written / rejected → done；queued（会话正忙）→ later；
//   额度用完 → later，到额度恢复再试；可重试的 DriverError 直接抛给执行器退避；
// - session.end → driver.end，等会话 ended 之后作废它的令牌、推一次会话状态。
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
    const { sessionId, recovery } = action.params;
    try {
      await deps.driver.start(sessionId, recovery ? { recovery: true } : {});
    } catch (error) {
      // 会话已经结束（交接后的旧一代）：没什么可起的
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
    const { sessionId, messageId, source, resend } = action.params;
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
      });
    } catch (error) {
      if (!isSessionEnded(error)) throw error;
      // 交接的事务里账本把排队的消息（messages.session_id 和这个动作的参数）一起改指了新一代：later，下次执行用新参数
      const now = deps.ledger.getMessage(messageId);
      if (now === null) return { kind: "done" };
      if (now.sessionId !== sessionId) return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "session_ended" };
      // 还指着这个已结束的会话：重启恢复时会发生——交接那一轮（旧项目经理跑了 hub project assign，这一轮还没结束）被重启打断，
      // 重启后 session.end 先结束旧会话，恢复登记的 session.send 随后撞上 session_ended。交接已经做过了，按“这一轮被重启打断”处理，
      // 标已停止（和关机打断一轮一样），不标失败：失败的话用户点重试会把同一句话再发给新项目经理。
      // 排队中的消息没有这一轮可停（不该走到这里）：标失败，用户点重试会发给现在的项目经理。
      if (now.status === "queued") deps.ledger.onActionFailed(action, "这条消息发给的项目经理已经换人，请重发");
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
