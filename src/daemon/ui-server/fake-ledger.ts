// 测试用的内存假账本：只实现界面服务用到的那几个方法，记下每次调用；其余方法调了就抛错。
import {
  CHANGE_BUFFER_SIZE,
  ConversationNotFoundError,
  MESSAGE_PAGE_SIZE,
  userMessageDedupeKey,
  type Change,
  type ChangeDataMap,
  type ChangesSince,
  type ConversationId,
  type CreatePmInput,
  type CreatePmResult,
  type EditPersonaInput,
  type EditPersonaResult,
  type Ledger,
  type LedgerActor,
  type Message,
  type MessageId,
  type MessagesPage,
  type PersonaChange,
  type PersonaChangeId,
  type PersonaView,
  type PmId,
  type PostUserMessageInput,
  type PostUserMessageResult,
  type ScheduleRecord,
  type SessionId,
  type LedgerSnapshot,
  type Unsubscribe,
} from "../../shared/index.ts";

function makeSchedule(over: Partial<ScheduleRecord>): ScheduleRecord {
  return {
    id: 1,
    pmId: 1,
    name: "晨报",
    kind: "daily",
    atTime: "09:00",
    everyMinutes: null,
    prompt: "x",
    enabled: true,
    nextRunAt: 1,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastMessageId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

export function makeMessage(id: number, conversationId: number, text = `m${id}`): Message {
  return {
    id,
    conversationId,
    sessionId: null,
    workerId: null,
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

export function makePersonaChange(id = 1, pmId = 1): PersonaChange {
  return {
    id,
    pmId,
    actor: "user",
    sessionId: null,
    textBefore: "旧",
    textAfter: "新",
    modeBefore: "manage_only",
    modeAfter: "manage_only",
    vendorBefore: "claude",
    vendorAfter: "claude",
    modelBefore: null,
    modelAfter: null,
    effortBefore: null,
    effortAfter: null,
    reason: null,
    revertOf: null,
    createdAt: 1,
  };
}

export function makePersonaView(pmId: PmId, changes: PersonaChange[] = []): PersonaView {
  return {
    pmId,
    text: "性格设定正文",
    mode: "manage_only",
    vendor: "claude",
    model: null,
    effort: null,
    changes,
    revertableChangeId: changes[0]?.id ?? null,
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
  readonly createdPms: CreatePmInput[] = [];
  readonly personaReads: PmId[] = [];
  readonly personaEdits: Array<{ pmId: PmId; input: EditPersonaInput; actor: LedgerActor }> = [];
  readonly reverted: PersonaChangeId[] = [];
  readonly retried: MessageId[] = [];
  /** 定时任务三个方法的调用（addSchedule / setScheduleEnabled / removeSchedule）。 */
  readonly scheduleCalls: Array<{ call: "add" | "enable" | "remove"; args: unknown[] }> = [];
  readonly renewed: PmId[] = [];
  /** editPersona、revertPersonaChange 返回的修改记录；null 表示“没改动”。 */
  personaChange: PersonaChange | null = makePersonaChange();
  snapshotValue: LedgerSnapshot = { seq: 0, pms: [], projects: [], folders: [], conversations: [], sessions: [], health: [], schedules: [] };
  /** getMessage 能取到的消息（测试自己放）。 */
  readonly storedMessages = new Map<MessageId, Message>();
  /** sentFileAllows 的判断，默认都允许。 */
  sentFileAllows: (sessionId: SessionId, realPath: string) => boolean = () => true;
  /** 抛出它来模拟账本出错（普通 Error 是内部出错，LedgerRequestError 是被拒绝）；所有方法都抛。 */
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
    const seq = this.seq + 1;
    return this.emitChange("health.updated", {
      health: { module: "driver", consecutiveFailures: lastError === null ? 0 : 1, lastError, updatedAt: seq },
    });
  }

  emitChange<T extends Change["type"]>(type: T, data: ChangeDataMap[T]): Change {
    const change = { seq: ++this.seq, type, data } as Change;
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

  createPm(input: CreatePmInput): CreatePmResult {
    this.check();
    this.createdPms.push(input);
    return {
      pm: {
        id: 7,
        name: input.name,
        avatarFile: null,
        mode: input.mode,
        vendor: input.vendor ?? "claude",
        defaultModel: input.defaultModel ?? null,
        effort: input.effort ?? null,
        personaFile: null,
        createdAt: 1,
      },
      conversation: { id: 70, kind: "pm", pmId: 7, projectId: null, title: input.name, createdAt: 1 },
      sessionId: 700,
      project:
        input.folder === undefined
          ? null
          : { id: 8, name: "foo", description: null, status: "active", pmId: 7, conversationId: 70, createdAt: 1, updatedAt: 1 },
    };
  }

  getPersona(pmId: PmId): PersonaView {
    this.check();
    this.personaReads.push(pmId);
    return makePersonaView(pmId, this.personaChange === null ? [] : [this.personaChange]);
  }

  editPersona(pmId: PmId, input: EditPersonaInput, actor: LedgerActor): EditPersonaResult {
    this.check();
    this.personaEdits.push({ pmId, input, actor });
    return { change: this.personaChange, persona: makePersonaView(pmId, this.personaChange === null ? [] : [this.personaChange]) };
  }

  revertPersonaChange(changeId: PersonaChangeId): EditPersonaResult {
    this.check();
    this.reverted.push(changeId);
    const pmId = this.personaChange?.pmId ?? 1;
    return { change: this.personaChange, persona: makePersonaView(pmId, this.personaChange === null ? [] : [this.personaChange]) };
  }

  retryMessage(messageId: MessageId): { messageId: MessageId } {
    this.check();
    this.retried.push(messageId);
    return { messageId };
  }

  renewSession(pmId: PmId): { handoverId: number } {
    this.check();
    this.renewed.push(pmId);
    return { handoverId: 50 };
  }

  snapshot(): LedgerSnapshot {
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
      // 输入框的 commands、files 接口走 UiServerOptions.composer（daemon/composer.ts），界面服务自己不调
      composerTarget: unused("composerTarget"),
      snapshot: () => this.snapshot(),
      messagesBefore: (c, b) => this.messagesBefore(c, b),
      changesSince: (s) => this.changesSince(s),
      onChange: (l) => this.onChange(l),
      onStopRequested: unused("onStopRequested"),
      onActionEnqueued: unused("onActionEnqueued"),
      applyDriverEvent: unused("applyDriverEvent"),
      refreshSessionState: unused("refreshSessionState"),
      recoverAfterRestart: unused("recoverAfterRestart"),
      createPm: (i) => this.createPm(i),
      getMessage: (id) => this.storedMessages.get(id) ?? null,
      sentFileAllows: (s, p) => this.sentFileAllows(s, p),
      onActionFailed: unused("onActionFailed"),
      stopMessage: unused("stopMessage"),
      reportHealth: unused("reportHealth"),
      getPersona: (p) => this.getPersona(p),
      editPersona: (p, i, a) => this.editPersona(p, i, a),
      revertPersonaChange: (c) => this.revertPersonaChange(c),
      retryMessage: (m) => this.retryMessage(m),
      renewSession: (p) => this.renewSession(p),
      waitsForHandover: unused("waitsForHandover"),
      runAutoRenew: unused("runAutoRenew"),
      sessionPreamble: unused("sessionPreamble"),
      claimHandover: unused("claimHandover"),
      handoverForked: unused("handoverForked"),
      handoverWritten: unused("handoverWritten"),
      handoverFailed: unused("handoverFailed"),
      handoverCleaned: unused("handoverCleaned"),
      uncleanedHandovers: unused("uncleanedHandovers"),
      runDueSchedules: unused("runDueSchedules"),
      addSchedule: (pmId, args) => {
        this.check();
        this.scheduleCalls.push({ call: "add", args: [pmId, args] });
        return makeSchedule({ id: 5, pmId, name: args.name, prompt: args.prompt });
      },
      setScheduleEnabled: (id, enabled) => {
        this.check();
        this.scheduleCalls.push({ call: "enable", args: [id, enabled] });
        return makeSchedule({ id, enabled });
      },
      removeSchedule: (id) => {
        this.check();
        this.scheduleCalls.push({ call: "remove", args: [id] });
      },
      hubCall: unused("hubCall"),
      workerStartFolder: unused("workerStartFolder"),
      workerPrTarget: unused("workerPrTarget"),
      workerTranscriptTarget: unused("workerTranscriptTarget"),
      getLaunchContext: unused("getLaunchContext"),
      personaUpdate: unused("personaUpdate"),
      getWorktreeTask: unused("getWorktreeTask"),
      onSetupStarted: unused("onSetupStarted"),
      waitsForFirstTurn: unused("waitsForFirstTurn"),
      onWorktreeCreated: unused("onWorktreeCreated"),
      syncPersonaFiles: unused("syncPersonaFiles"),
    };
  }
}
