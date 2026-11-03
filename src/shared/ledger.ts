// 账本（W1 实现）对界面服务、执行器、驱动层和组装代码开放的接口。
// 数据库是同步接口，账本方法也都是同步的；调用方想 await 也行。
import type { Change, MessagesPage, StateSnapshot } from "./api.ts";
import type { DriverEvent } from "./driver.ts";
import type { AnyActionRow } from "./actions.ts";
import type {
  Conversation,
  ConversationId,
  HealthModule,
  Message,
  MessageId,
  Pm,
  SessionId,
  Unsubscribe,
} from "./domain.ts";

/** postUserMessage、requestStop 遇到对话不存在时抛它；界面服务映射成 404。 */
export class ConversationNotFoundError extends Error {
  readonly code = "conversation_not_found";
  readonly conversationId: ConversationId;
  constructor(conversationId: ConversationId) {
    super(`conversation ${conversationId} not found`);
    this.name = "ConversationNotFoundError";
    this.conversationId = conversationId;
  }
}

export interface PostUserMessageInput {
  conversationId: ConversationId;
  /** 网页生成；同一个对话里同一个 clientId 只会有一条消息、一个动作（去重键见 userMessageDedupeKey）。 */
  clientId: string;
  text: string;
}

export interface PostUserMessageResult {
  messageId: MessageId;
}

/**
 * 补齐结果。since 就是网页最后收到的 seq（拿的是 /api/state 的 seq 或最后一条变化的 seq）。
 * 下面任何一条成立就 resync，否则返回 since 之后的全部变化（可能是空的）：
 * - since 小于本次启动的初始 seq（上次运行留下的，或者乱填的）；
 * - since 大于当前 seq；
 * - since 小于缓冲区里最早一条的 seq 减 1（中间有变化已经被挤出缓冲区，补不齐）。
 * 本次启动的初始 seq 要比上次运行用过的都大（比如取启动时刻的毫秒时间戳），
 * 这样带着旧 seq 重连的网页一定走第一条。
 */
export type ChangesSince = { kind: "ok"; changes: Change[] } | { kind: "resync" };

export interface CreatePmInput {
  name: string;
  personaFile?: string;
  defaultModel?: string;
  /** pm-home/ 的根目录；项目经理的工作目录是 <pmHomeRoot>/<项目经理编号>/，账本负责建。 */
  pmHomeRoot: string;
}

export interface CreatePmResult {
  pm: Pm;
  conversation: Conversation;
  sessionId: SessionId;
}

export interface Ledger {
  // ---- 界面服务用 ----
  /**
   * 同一个事务里：写一条“排队中”的用户消息 + 登记一个 session.send 动作。clientId 重复时返回已有的编号。
   * 对话不存在抛 ConversationNotFoundError。
   */
  postUserMessage(input: PostUserMessageInput): PostUserMessageResult;
  /**
   * 用户点“停止”。账本记下，并通知 onStopRequested 的监听者；对话没有在跑的会话时什么也不做。
   * 对话不存在抛 ConversationNotFoundError。
   */
  requestStop(conversationId: ConversationId): void;
  snapshot(): StateSnapshot;
  /** 更早的 100 条（before 之前，从小到大）。 */
  messagesBefore(conversationId: ConversationId, before: MessageId): MessagesPage;
  changesSince(seq: number): ChangesSince;
  /** 每产生一条变化调用一次监听者。 */
  onChange(listener: (change: Change) => void): Unsubscribe;

  // ---- 组装代码用（W5 接线）----
  /** W5 把它接到 driver.interrupt。 */
  onStopRequested(listener: (event: { conversationId: ConversationId; sessionId: SessionId }) => void): Unsubscribe;
  /**
   * 有新动作登记（包括重复登记把已结束的动作重置成 pending）时调用，在事务提交之后。
   * W5 把它接到 executor.wake()。
   */
  onActionEnqueued(listener: (action: AnyActionRow) => void): Unsubscribe;
  /**
   * 驱动层 → 账本：W5 把 driver.onEvent 接到这里。agent 输出按 agentMessageDedupeKey 去重；
   * 消息状态只按 MESSAGE_STATUS_TRANSITIONS 改，不合法的忽略。各事件怎么标见 driver.ts 的注释。
   */
  applyDriverEvent(sessionId: SessionId, event: DriverEvent): void;
  /**
   * 守护进程启动时调一次，在 executor.start() 之前（设计第 5.4 节第 3、4 步的账本部分）。
   * 找出状态是 queued、delivered、processing 而且没有 pending、running 的 session.send 动作的用户消息，
   * 重新登记 session.send：delivered、processing 的带 resend: true，queued 的不带。
   * 这些消息所在的会话里，有 delivered、processing 消息的（上次一轮被打断了），
   * 再登记一个 session.start（当前这一代，recovery: true）。
   * 重复登记按 NewAction 的规则重置已结束的动作。返回登记了什么，方便日志和测试。
   */
  recoverAfterRestart(): { resentMessageIds: MessageId[]; requeuedMessageIds: MessageId[]; recoveredSessionIds: SessionId[] };
  /** 第一次启动没有项目经理时建一个：项目经理、它的私聊、一个会话。 */
  createPm(input: CreatePmInput): CreatePmResult;
  /** 给执行器处理函数用：读动作要发的消息。找不到返回 null。 */
  getMessage(id: MessageId): Message | null;
  /**
   * 执行器：动作彻底失败（次数用完）时调用。session.send → 那条消息标 failed，failureReason = error；
   * session.start → 不碰消息（每条消息由它自己的 session.send 失败时标），只记 health。
   */
  onActionFailed(action: AnyActionRow, error: string): void;
  /**
   * 各模块报健康状态：error 为 null 表示成功一次（连续失败次数清零），否则次数加一、记下错误。
   * 有变化就推一条 health.updated。执行器每次处理函数抛错都调它（模块按错误来源：DriverError → "driver"）。
   */
  reportHealth(module: HealthModule, error: string | null): void;
}
