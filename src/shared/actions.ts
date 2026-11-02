// 动作队列（设计第 12.2 节）。M1 只有两类动作。
import type { ActionId, MessageId, SessionId } from "./domain.ts";

export const ACTION_TYPES = ["session.start", "session.send"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** 待执行 / 执行中 / 完成 / 失败 / 放弃。 */
export const ACTION_STATUSES = ["pending", "running", "done", "failed", "abandoned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** 启动或恢复会话。 */
export interface SessionStartParams {
  sessionId: SessionId;
  generation: number;
}

/** 给会话发消息。文字执行时再从 messages 里读，不存两份。 */
export interface SessionSendParams {
  sessionId: SessionId;
  messageId: MessageId;
  source: "user" | "system";
}

export interface ActionParamsMap {
  "session.start": SessionStartParams;
  "session.send": SessionSendParams;
}

export interface ActionRow<T extends ActionType = ActionType> {
  id: ActionId;
  type: T;
  dedupeKey: string;
  params: ActionParamsMap[T];
  status: ActionStatus;
  /** 已经试过几次。 */
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 登记动作时给的东西；同一类型同一个 dedupeKey 只有一行，重复登记只更新参数。 */
export type NewAction = {
  [T in ActionType]: { type: T; params: ActionParamsMap[T] };
}[ActionType];

export function actionDedupeKey(action: NewAction): string {
  switch (action.type) {
    case "session.start":
      return `${action.params.sessionId}:${action.params.generation}`;
    case "session.send":
      return String(action.params.messageId);
  }
}

/**
 * 处理函数的返回：
 * - done：做完了（做过了也算）；
 * - later：现在不行、等等就好（额度用完、会话还没起来），不加失败次数，delayMs 后再试；
 * - 抛错：失败，按退避重试，次数用完状态变“失败”，health 记下错误。
 */
export type ActionResult = { kind: "done" } | { kind: "later"; delayMs: number; reason?: string };

export type ActionHandler<T extends ActionType = ActionType> = (action: ActionRow<T>) => Promise<ActionResult> | ActionResult;

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** 总共试几次（含第一次）。 */
  maxAttempts: number;
}

export const ACTION_RETRY: Record<ActionType, RetryPolicy> = {
  // 5 秒起翻倍，到 5 分钟，3 次
  "session.start": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  // 会话起不来时跟着上一条重试，节奏一样
  "session.send": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
};

/** 第 attempt 次（从 1 起）失败后，隔多久再试：base × 2^(attempt-1)，不超过 maxMs。 */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
}

/** 执行器（W1 实现，W5 组装）。 */
export interface ActionExecutor {
  /** 每个类型注册一个处理函数；要在 start 之前注册。 */
  register<T extends ActionType>(type: T, handler: ActionHandler<T>): void;
  /** 启动：把上次留下的“执行中”改回“待执行”，开始取到点的动作。 */
  start(): void;
  /** 有新动作登记了，别等下一次轮询。 */
  wake(): void;
  /** 停止接新动作，等正在执行的做完。 */
  stop(): Promise<void>;
}
