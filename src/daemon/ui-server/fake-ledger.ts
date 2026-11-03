// 测试用的内存假账本：只实现界面服务用到的那几个方法，记下每次调用；其余方法调了就抛错。
import {
  CHANGE_BUFFER_SIZE,
  ConversationNotFoundError,
  MESSAGE_PAGE_SIZE,
  userMessageDedupeKey,
  type Change,
  type ChangesSince,
  type ConversationId,
  type Ledger,
  type Message,
  type MessageId,
  type MessagesPage,
  type PostUserMessageInput,
  type PostUserMessageResult,
  type StateSnapshot,
  type Unsubscribe,
} from "../../shared/index.ts";

export function makeMessage(id: number, conversationId: number, text = `m${id}`): Message {
  return {
    id,
    conversationId,
    sessionId: null,
    ticketId: null,
    sender: "user",
    kind: "text",
    text,
    meta: null,
    collapsed: false,
    dedupeKey: userMessageDedupeKey(conversationId, `c${id}`),
    status: "queued",
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

export class FakeLedger {
  /** 存在的对话编号；别的编号抛 ConversationNotFoundError。 */
  conversations = new Set<ConversationId>([1]);
  messages: Message[] = [];
  readonly posted: PostUserMessageInput[] = [];
  readonly stopped: ConversationId[] = [];
  readonly messagesBeforeCalls: Array<{ conversationId: ConversationId; before: MessageId }> = [];
  readonly changesSinceCalls: number[] = [];
  snapshotValue: StateSnapshot = { seq: 0, pms: [], conversations: [], sessions: [], health: [] };
  /** 抛出它来模拟账本内部出错。 */
  failWith: Error | null = null;

  // 变化缓冲区：按 ChangesSince 的注释规则补齐。
  readonly initialSeq: number;
  private seq: number;
  private buffer: Change[] = [];
  private listeners = new Set<(change: Change) => void>();
  private clientIds = new Map<string, MessageId>();
  private nextMessageId = 1;

  constructor(initialSeq = 100) {
    this.initialSeq = initialSeq;
    this.seq = initialSeq;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** 产生一条变化：seq 加一，进缓冲区，通知监听者。 */
  emitHealthChange(lastError: string | null = null): Change {
    const change: Change = {
      seq: ++this.seq,
      type: "health.updated",
      data: { health: { module: "driver", consecutiveFailures: lastError === null ? 0 : 1, lastError, updatedAt: this.seq } },
    };
    this.buffer.push(change);
    if (this.buffer.length > CHANGE_BUFFER_SIZE) this.buffer.shift();
    for (const listener of [...this.listeners]) listener(change);
    return change;
  }

  private check(): void {
    if (this.failWith !== null) throw this.failWith;
  }

  private requireConversation(id: ConversationId): void {
    if (!this.conversations.has(id)) throw new ConversationNotFoundError(id);
  }

  postUserMessage(input: PostUserMessageInput): PostUserMessageResult {
    this.check();
    this.requireConversation(input.conversationId);
    this.posted.push(input);
    const key = userMessageDedupeKey(input.conversationId, input.clientId);
    const existing = this.clientIds.get(key);
    if (existing !== undefined) return { messageId: existing };
    const messageId = this.nextMessageId++;
    this.clientIds.set(key, messageId);
    this.messages.push(makeMessage(messageId, input.conversationId, input.text));
    return { messageId };
  }

  requestStop(conversationId: ConversationId): void {
    this.check();
    this.requireConversation(conversationId);
    this.stopped.push(conversationId);
  }

  snapshot(): StateSnapshot {
    this.check();
    return { ...this.snapshotValue, seq: this.seq };
  }

  messagesBefore(conversationId: ConversationId, before: MessageId): MessagesPage {
    this.check();
    this.messagesBeforeCalls.push({ conversationId, before });
    this.requireConversation(conversationId);
    const older = this.messages.filter((m) => m.conversationId === conversationId && m.id < before);
    return { messages: older.slice(-MESSAGE_PAGE_SIZE), hasMore: older.length > MESSAGE_PAGE_SIZE };
  }

  changesSince(seq: number): ChangesSince {
    this.check();
    this.changesSinceCalls.push(seq);
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (seq < this.initialSeq || seq > this.seq || seq < oldest - 1) return { kind: "resync" };
    return { kind: "ok", changes: this.buffer.filter((c) => c.seq > seq) };
  }

  onChange(listener: (change: Change) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 转成完整的 Ledger 类型传给 createUiServer；界面服务不该碰的方法调了就抛错。 */
  asLedger(): Ledger {
    const unused = (name: string) => () => {
      throw new Error(`FakeLedger.${name} is not used by ui-server`);
    };
    return {
      postUserMessage: (i) => this.postUserMessage(i),
      requestStop: (c) => this.requestStop(c),
      snapshot: () => this.snapshot(),
      messagesBefore: (c, b) => this.messagesBefore(c, b),
      changesSince: (s) => this.changesSince(s),
      onChange: (l) => this.onChange(l),
      onStopRequested: unused("onStopRequested"),
      onActionEnqueued: unused("onActionEnqueued"),
      applyDriverEvent: unused("applyDriverEvent"),
      recoverAfterRestart: unused("recoverAfterRestart"),
      createPm: unused("createPm"),
      getMessage: unused("getMessage"),
      onActionFailed: unused("onActionFailed"),
      reportHealth: unused("reportHealth"),
    };
  }
}
