// 动作队列（设计第 12.2 节）。M1 只有两类动作。
import type { ActionId, MessageId, SessionId } from "./domain.ts";

/** 会扩展（M3 起有建 worktree 等），数据库不加 CHECK，用 isOneOf 校验。 */
export const ACTION_TYPES = ["session.start", "session.send"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** 待执行 / 执行中 / 完成 / 失败 / 放弃。 */
export const ACTION_STATUSES = ["pending", "running", "done", "failed", "abandoned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** 启动或恢复会话。处理函数调 driver.start(sessionId, { recovery })。 */
export interface SessionStartParams {
  sessionId: SessionId;
  generation: number;
  /** 守护进程重启后恢复被打断的会话（设计第 5.4 节第 4 步）：驱动层在下一条写进去的消息前加恢复说明。 */
  recovery?: boolean;
}

/** 给会话发消息。文字执行时再从 messages 里读，不存两份。处理函数调 driver.send。 */
export interface SessionSendParams {
  sessionId: SessionId;
  messageId: MessageId;
  source: "user" | "system";
  /**
   * 重启前已经写进去、但没等到 result 的消息（设计第 12.1 节“至少一次”）：
   * 驱动层在前面加“如果你已经处理过这条，忽略它”。
   */
  resend?: boolean;
}

export interface ActionParamsMap {
  "session.start": SessionStartParams;
  "session.send": SessionSendParams;
}

/** 动作表的一行。T 是单个类型时 params 跟着确定；要按 type 收窄请用 AnyActionRow。 */
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

/** 各类型的 ActionRow 的联合：`if (row.type === "session.send")` 之后 row.params 就是 SessionSendParams。 */
export type AnyActionRow = { [T in ActionType]: ActionRow<T> }[ActionType];

/**
 * 登记动作时给的东西。同一类型同一个 dedupeKey（见 actionDedupeKey）只有一行，重复登记时：
 * - 那一行是 pending、running：只更新参数（running 的这一次照旧跑完，下次重试用新参数）；
 * - 那一行是 done、failed、abandoned：重置成 pending，attempts 清零，lastError 清空，
 *   nextAttemptAt 设成现在，参数更新。比如失败的消息重发、重启后恢复同一代会话。
 * SQL 写法见 migrations/0001_init.sql 里 actions 表的注释。
 */
export type NewAction = {
  [T in ActionType]: { type: T; params: ActionParamsMap[T] };
}[ActionType];

/** recovery、resend 这类标记不进去重键。 */
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
 * - later：现在不行、等等就好（额度用完、会话正忙消息还在驱动层排队），不加失败次数，delayMs 后再试；
 * - 抛错：失败，按退避重试（驱动层的 spawn_failed、claude_not_found 等就走这条），
 *   每次失败执行器调 ledger.reportHealth 记下错误；次数用完状态变“失败”，再调 ledger.onActionFailed。
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
  /** 有新动作登记了，别等下一次轮询。W5 把 ledger.onActionEnqueued 接到这里。 */
  wake(): void;
  /** 停止接新动作，等正在执行的做完。 */
  stop(): Promise<void>;
}
