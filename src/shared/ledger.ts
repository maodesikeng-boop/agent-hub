// 账本（W1 实现）对界面服务、执行器、驱动层和组装代码开放的接口。
// 数据库是同步接口，账本方法也都是同步的；调用方想 await 也行。
import type { Change, MessagesPage, StateSnapshot } from "./api.ts";
import type { DriverEvent } from "./driver.ts";
import type { ActionRow } from "./actions.ts";
import type { Conversation, ConversationId, Message, MessageId, Pm, SessionId, Unsubscribe } from "./domain.ts";

export interface PostUserMessageInput {
  conversationId: ConversationId;
  /** 网页生成；同一个 clientId 只会有一条消息、一个动作。 */
  clientId: string;
  text: string;
}

export interface PostUserMessageResult {
  messageId: MessageId;
}

/**
 * 补齐结果。since 就是网页最后收到的 seq。
 * resync：since 比保留的最早一条还早，或者比当前序号还大。
 * 守护进程每次启动，seq 的起点要保证上次运行留下的 seq 一定落在 resync 里
 * （比如从启动时刻的毫秒时间戳起算）。
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
  /** 同一个事务里：写一条“排队中”的用户消息 + 登记一个 session.send 动作。clientId 重复时返回已有的编号。 */
  postUserMessage(input: PostUserMessageInput): PostUserMessageResult;
  /** 用户点“停止”。账本记下，并通知 onStopRequested 的监听者；对话没有在跑的会话时什么也不做。 */
  requestStop(conversationId: ConversationId): void;
  snapshot(): StateSnapshot;
  /** 更早的 100 条（before 之前，从小到大）。 */
  messagesBefore(conversationId: ConversationId, before: MessageId): MessagesPage;
  changesSince(seq: number): ChangesSince;
  /** 每产生一条变化调用一次监听者。 */
  onChange(listener: (change: Change) => void): Unsubscribe;

  // ---- 组装代码用 ----
  /** 把 requestStop 接到 driver.interrupt。 */
  onStopRequested(listener: (event: { conversationId: ConversationId; sessionId: SessionId }) => void): Unsubscribe;
  /** 驱动层 → 账本：driver.onEvent 的监听者。按（会话，uuid）去重。 */
  applyDriverEvent(sessionId: SessionId, event: DriverEvent): void;
  /** 第一次启动没有项目经理时建一个：项目经理、它的私聊、一个会话。 */
  createPm(input: CreatePmInput): CreatePmResult;
  /** 给执行器处理函数用：读动作要发的消息。找不到返回 null。 */
  getMessage(id: MessageId): Message | null;
  /** 执行器：动作彻底失败（次数用完）时，账本把对应的消息标“失败”。 */
  onActionFailed(action: ActionRow, error: string): void;
}
