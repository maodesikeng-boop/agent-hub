// 动作队列（设计第 12.2 节）。M1 两类动作，M2 加结束会话，M3 加建 worktree。
import type { ActionId, MessageId, SessionId, WorkerId } from "./domain.ts";

/** 会扩展，数据库不加 CHECK，用 isOneOf 校验。 */
export const ACTION_TYPES = ["session.start", "session.send", "session.end", "worktree.create"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** 待执行 / 执行中 / 完成 / 失败 / 放弃。 */
export const ACTION_STATUSES = ["pending", "running", "done", "failed", "abandoned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** 启动会话。处理函数调 driver.start(sessionId)。重启恢复不再登记它：恢复说明跟着第一条重发的消息走（SessionSendParams.recovery）。 */
export interface SessionStartParams {
  sessionId: SessionId;
  generation: number;
}

/** 给会话发消息。文字执行时再从 messages 里读，不存两份。处理函数调 driver.send。 */
export interface SessionSendParams {
  /** 登记时这个对话最新一代的会话。retryMessage 重新登记时也取最新一代（同一个去重键，UPSERT 只改参数）。 */
  sessionId: SessionId;
  messageId: MessageId;
  source: "user" | "system";
  /**
   * 重启前已经写进去、但没等到 result 的消息（设计第 12.1 节“至少一次”）：
   * 驱动层在前面加“如果你已经处理过这条，忽略它”。
   */
  resend?: boolean;
  /**
   * 守护进程重启后，这个会话第一条重发的消息（设计第 5.4 节第 4 步）：驱动层在它那一行最前面加恢复说明。
   * 不单独登记 session.start 去写恢复说明：单独一行会自己占一轮，那一轮的回复（比如 Worker 的汇报）对不上任何消息。
   */
  recovery?: boolean;
}

/**
 * 结束会话。处理函数调 driver.end(sessionId)：正在跑就等这一轮回完再关，然后作废令牌。
 * M2 原来是交接后关掉旧一代用的（11-03 拿掉了交接）；M3 起 hub worker end、建 worktree 彻底失败时给 Worker 的会话登记。
 */
export interface SessionEndParams {
  sessionId: SessionId;
  /** 要结束的那个会话的第几代（agent_sessions.generation），只用来做去重键。 */
  generation: number;
}

/**
 * 给 Worker 建 git worktree（M3，m3-plan 第 3 节接口约定）。hub worker start 判断要在 worktree 里干活时登记，去重键是 Worker 编号。
 * 处理函数（W5 接到 W1 的 addWorktree）：
 * 1. ledger.getWorktreeTask(workerId) 取主文件夹、分支、目录；null 或 Worker 已 ended → done，什么也不做；
 * 2. 在主文件夹里 git worktree add -b <分支> <目录> HEAD（重复执行算成功），拿到 HEAD 的提交；
 * 3. ledger.onWorktreeCreated(workerId, 提交)：账本记下起点提交，同一个事务里登记 Worker 的 session.start 和第一条 session.send。
 * 抛错按 ACTION_RETRY 重试；次数用完 ledger.onActionFailed 在项目经理的对话里发一行 worktree_failed（原因交给它），Worker 标 ended。
 * 在主文件夹里干活的 Worker 不登记这个动作，hub worker start 直接登记那两样。
 */
export interface WorktreeCreateParams {
  workerId: WorkerId;
}

interface ActionParamsMap {
  "session.start": SessionStartParams;
  "session.send": SessionSendParams;
  "session.end": SessionEndParams;
  "worktree.create": WorktreeCreateParams;
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
    case "session.end":
      return `${action.params.sessionId}:${action.params.generation}`;
    case "worktree.create":
      return String(action.params.workerId);
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
  "session.end": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  // git 偶尔失败（锁文件、磁盘忙），隔几秒再试；3 次还不行就告诉项目经理
  "worktree.create": { baseMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
};

/** 第 attempt 次（从 1 起）失败后，隔多久再试：base × 2^(attempt-1)，不超过 maxMs。 */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
}

/** 执行器（M1 W1 实现，组装代码接线）。 */
export interface ActionExecutor {
  /** 每个类型注册一个处理函数；要在 start 之前注册。 */
  register<T extends ActionType>(type: T, handler: ActionHandler<T>): void;
  /** 启动：把上次留下的“执行中”改回“待执行”，开始取到点的动作。 */
  start(): void;
  /** 有新动作登记了，别等下一次轮询。组装代码（M2 W6）把 ledger.onActionEnqueued 接到这里。 */
  wake(): void;
  /** 停止接新动作，等正在执行的做完。 */
  stop(): Promise<void>;
}
