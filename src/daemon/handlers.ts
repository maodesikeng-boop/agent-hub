// 两类动作的处理函数（m1-plan 第 3 节接口约定第 3、6 条）。
// - session.start → driver.start(sessionId, { recovery })；
// - session.send → 读出消息，调 driver.send：written / rejected → done；queued（会话正忙）→ later；
//   额度用完 → later，到额度恢复再试；可重试的 DriverError 直接抛给执行器退避。
import type { ActionHandler, ActionResult, Driver, Ledger, SessionStore } from "../shared/index.ts";

/** 会话正忙、消息在驱动层排队时，隔多久再问一次（这一轮结束后驱动层会自己写，再问只是为了把动作标完成）。 */
export const QUEUED_RECHECK_MS = 1_000;
/** 额度用完时最多推迟多久再看一次。 */
export const RATE_LIMIT_RECHECK_MAX_MS = 5 * 60_000;
/**
 * rate_limit_event 的 status：Claude 用 "allowed"、"allowed_warning"、"rejected"。
 * 只有 rejected 算“用完了”，allowed_warning 只是快到了，照常发。
 */
const RATE_LIMIT_REJECTED = "rejected";

export interface HandlerDeps {
  driver: Pick<Driver, "start" | "send">;
  ledger: Pick<Ledger, "getMessage">;
  sessions: Pick<SessionStore, "get">;
  now?: () => number;
}

export function createSessionStartHandler(deps: HandlerDeps): ActionHandler<"session.start"> {
  return async (action) => {
    const { sessionId, recovery } = action.params;
    await deps.driver.start(sessionId, recovery ? { recovery: true } : {});
    return { kind: "done" };
  };
}

/** 额度用完、而且知道什么时候恢复：返回还要等多久；否则 null。 */
export function rateLimitWaitMs(deps: Pick<HandlerDeps, "sessions" | "now">, sessionId: number): number | null {
  const info = deps.sessions.get(sessionId)?.rateLimit;
  if (!info || info.status !== RATE_LIMIT_REJECTED || info.resetsAt === null) return null;
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
    if (wait !== null) return { kind: "later", delayMs: Math.min(wait + 1_000, RATE_LIMIT_RECHECK_MAX_MS), reason: "rate_limited" };
    const result = await deps.driver.send(sessionId, {
      messageIds: [messageId],
      source,
      text: message.text,
      ...(resend ? { resend: true } : {}),
    });
    if (result.kind === "queued") return { kind: "later", delayMs: QUEUED_RECHECK_MS, reason: "session_busy" };
    return { kind: "done" };
  };
}
