// 测试用的内存假账本：只实现界面服务用到的那几个方法，记下每次调用；其余方法调了就抛错。
import {
  CHANGE_BUFFER_SIZE,
  ConversationNotFoundError,
  defaultRouterSettings,
  emptyRouterSlice,
  findRewindableMessage,
  MESSAGE_PAGE_SIZE,
  userMessageDedupeKey,
  type ArchiveAllReportsResponse,
  type CancelTaskGraphRequest,
  type CancelTaskGraphResponse,
  type Change,
  type ChangeDataMap,
  type ChangesSince,
  type ConversationId,
  type CreatePmInput,
  type CreatePmResult,
  type DecideTaskNodeRequest,
  type DecideTaskNodeResponse,
  type DeviceRouterDigest,
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
  type Pm,
  type PmId,
  type PostUserMessageInput,
  type PostUserMessageResult,
  type ProjectId,
  type ResolveRouterItemRequest,
  type ResolveRouterItemResponse,
  type RouterItemId,
  type RouterItemsPage,
  type RouterSettings,
  type ScheduleRecord,
  type SessionId,
  type SkipTaskNodeRequest,
  type SkipTaskNodeResponse,
  type LedgerSnapshot,
  type TaskGraph,
  type TaskGraphId,
  type TaskGraphsPage,
  type TaskNodeKey,
  type Unsubscribe,
  type UpdateRouterSettingsRequest,
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

function makePersonaChange(id = 1, pmId = 1): PersonaChange {
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

function makePersonaView(pmId: PmId, changes: PersonaChange[] = []): PersonaView {
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
  readonly rewoundConversations: ConversationId[] = [];
  readonly messagesBeforeCalls: Array<{ conversationId: ConversationId; before: MessageId }> = [];
  readonly changesSinceCalls: number[] = [];
  readonly createdPms: CreatePmInput[] = [];
  readonly personaReads: PmId[] = [];
  readonly personaEdits: Array<{ pmId: PmId; input: EditPersonaInput; actor: LedgerActor }> = [];
  readonly reverted: PersonaChangeId[] = [];
  readonly retried: MessageId[] = [];
  /** 定时任务三个方法的调用（addSchedule / setScheduleEnabled / removeSchedule）。 */
  readonly scheduleCalls: Array<{ call: "add" | "enable" | "remove"; args: unknown[] }> = [];
  readonly routerCalls: Array<{ call: string; args: unknown[] }> = [];
  readonly taskGraphCalls: Array<{ call: string; args: unknown[] }> = [];
  readonly renewed: PmId[] = [];
  readonly archived: PmId[] = [];
  readonly unarchived: PmId[] = [];
  /** editPersona、revertPersonaChange 返回的修改记录；null 表示“没改动”。 */
  personaChange: PersonaChange | null = makePersonaChange();
  snapshotValue: LedgerSnapshot = {
    seq: 0,
    pms: [],
    projects: [],
    folders: [],
    conversations: [],
    sessions: [],
    health: [],
    schedules: [],
    router: emptyRouterSlice(),
    activeTaskGraphs: [],
  };
  routerDigestValue: DeviceRouterDigest = { generatedAt: 1, pms: [] };
  routerItemsPageValue: RouterItemsPage = { items: [], nextCursor: null, hasMore: false };
  taskGraphsPageValue: TaskGraphsPage = { graphs: [], hasMore: false };
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

  rewindLastUserMessage(conversationId: ConversationId): Message | null {
    this.check();
    this.requireConversation(conversationId);
    this.rewoundConversations.push(conversationId);
    const convMessages = this.messages.filter((m) => m.conversationId === conversationId);
    const target = findRewindableMessage(convMessages);
    if (target === null) return null;
    const updated: Message = { ...target, meta: { ...target.meta, rewound: true } };
    const idx = this.messages.findIndex((m) => m.id === target.id);
    if (idx !== -1) this.messages[idx] = updated;
    this.emitChange("message.updated", { message: updated });
    return updated;
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

  archivePm(pmId: PmId): Pm {
    this.check();
    this.archived.push(pmId);
    return {
      id: pmId,
      name: `pm-${pmId}`,
      avatarFile: null,
      mode: "manage_only",
      vendor: "claude",
      defaultModel: null,
      effort: null,
      personaFile: null,
      createdAt: 1,
      archivedAt: 1_000,
    };
  }

  unarchivePm(pmId: PmId): Pm {
    this.check();
    this.unarchived.push(pmId);
    return {
      id: pmId,
      name: `pm-${pmId}`,
      avatarFile: null,
      mode: "manage_only",
      vendor: "claude",
      defaultModel: null,
      effort: null,
      personaFile: null,
      createdAt: 1,
      archivedAt: null,
    };
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

  getRouterDigest(): DeviceRouterDigest {
    this.check();
    this.routerCalls.push({ call: "digest", args: [] });
    return this.routerDigestValue;
  }

  listRouterItems(beforeCursor?: string, limit?: number): RouterItemsPage {
    this.check();
    this.routerCalls.push({ call: "listItems", args: [beforeCursor, limit] });
    return this.routerItemsPageValue;
  }

  resolveRouterItem(itemId: RouterItemId, input: ResolveRouterItemRequest): ResolveRouterItemResponse {
    this.check();
    this.routerCalls.push({ call: "resolveItem", args: [itemId, input] });
    if ("action" in input) {
      return {
        item: {
          id: itemId,
          kind: "report",
          status: "archived",
          pmId: 1,
          projectId: null,
          conversationId: 1,
          summary: "已归档",
          links: [],
          createdAt: 1,
          updatedAt: 2,
        },
      };
    }
    return {
      item: {
        id: itemId,
        kind: "decision",
        status: "resolved",
        pmId: 1,
        projectId: null,
        conversationId: 1,
        question: "q",
        context: "",
        options: ["A", "B"],
        askMessageId: null,
        resolution: {
          chosenIndex: input.optionIndex ?? null,
          chosenOption: (input.optionIndex ?? null) === null ? (input.choice ?? null) : "A",
          note: input.note ?? "",
          actor: "router",
          resolvedAt: 2,
          clientId: input.clientId,
        },
        createdAt: 1,
        updatedAt: 2,
      },
      messageId: 99,
    };
  }

  archiveAllRouterReports(): ArchiveAllReportsResponse {
    this.check();
    this.routerCalls.push({ call: "archiveAllReports", args: [] });
    return { archivedIds: [1], updatedAt: 2 };
  }

  updateRouterSettings(input: UpdateRouterSettingsRequest): RouterSettings {
    this.check();
    this.routerCalls.push({ call: "updateSettings", args: [input] });
    return { ...defaultRouterSettings(), ...input, updatedAt: 2 };
  }

  listRouterCommands(beforeCursor?: string, limit?: number): import("../../shared/index.ts").RouterCommandsPage {
    this.check();
    this.routerCalls.push({ call: "listCommands", args: [beforeCursor, limit] });
    return { commands: [], nextCursor: null, hasMore: false };
  }

  listProjectTaskGraphs(projectId: ProjectId, beforeId?: TaskGraphId, limit?: number): TaskGraphsPage {
    this.check();
    this.taskGraphCalls.push({ call: "listHistory", args: [projectId, beforeId, limit] });
    return this.taskGraphsPageValue;
  }

  private makeTaskGraph(graphId: TaskGraphId, status: TaskGraph["status"] = "active"): TaskGraph {
    return {
      id: graphId,
      projectId: 1,
      pmId: 1,
      conversationId: 1,
      title: `g-${graphId}`,
      status,
      originMsgId: null,
      nodes: [],
      edges: [],
      createdAt: 1,
      updatedAt: 2,
      completedAt: status === "active" ? null : 2,
    };
  }

  decideTaskNode(graphId: TaskGraphId, nodeKey: TaskNodeKey, input: DecideTaskNodeRequest): DecideTaskNodeResponse {
    this.check();
    this.taskGraphCalls.push({ call: "decideNode", args: [graphId, nodeKey, input] });
    return { graph: this.makeTaskGraph(graphId), messageId: 101 };
  }

  skipTaskNode(graphId: TaskGraphId, nodeKey: TaskNodeKey, input: SkipTaskNodeRequest): SkipTaskNodeResponse {
    this.check();
    this.taskGraphCalls.push({ call: "skipNode", args: [graphId, nodeKey, input] });
    return { graph: this.makeTaskGraph(graphId), messageId: 102 };
  }

  cancelTaskGraph(graphId: TaskGraphId, input: CancelTaskGraphRequest): CancelTaskGraphResponse {
    this.check();
    this.taskGraphCalls.push({ call: "cancelGraph", args: [graphId, nodeKeyOrReason(input)] });
    return { graph: this.makeTaskGraph(graphId, "cancelled"), messageId: 103 };
  }

  /** 转成完整的 Ledger 类型传给 createUiServer；界面服务不该碰的方法调了就抛错。 */
  asLedger(): Ledger {
    const unused = (name: string) => () => {
      throw new Error(`FakeLedger.${name} is not used by ui-server`);
    };
    return {
      postUserMessage: (i) => this.postUserMessage(i),
      requestStop: (c) => this.requestStop(c),
      rewindLastUserMessage: (c) => this.rewindLastUserMessage(c),
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
      archivePm: (p) => this.archivePm(p),
      unarchivePm: (p) => this.unarchivePm(p),
      purgeExpiredArchivedPms: unused("purgeExpiredArchivedPms"),
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
      getRouterDigest: () => this.getRouterDigest(),
      listRouterItems: (c, l) => this.listRouterItems(c, l),
      resolveRouterItem: (id, i) => this.resolveRouterItem(id, i),
      archiveAllRouterReports: () => this.archiveAllRouterReports(),
      updateRouterSettings: (i) => this.updateRouterSettings(i),
      listRouterCommands: (c, l) => this.listRouterCommands(c, l),
      listProjectTaskGraphs: (p, b, l) => this.listProjectTaskGraphs(p, b, l),
      decideTaskNode: (g, k, i) => this.decideTaskNode(g, k, i),
      skipTaskNode: (g, k, i) => this.skipTaskNode(g, k, i),
      cancelTaskGraph: (g, i) => this.cancelTaskGraph(g, i),
      hubCall: unused("hubCall"),
      sessionRole: unused("sessionRole"),
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

function nodeKeyOrReason(input: CancelTaskGraphRequest): CancelTaskGraphRequest {
  return input;
}
