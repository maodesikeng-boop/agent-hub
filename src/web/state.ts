// 网页的数据：/api/state 的快照 + WebSocket 推来的变化，合成一份界面要用的状态。
// 全是纯函数，方便测试；网络和定时器在 device-hub.ts。
import {
  serverInfoFor,
  userMessageDedupeKey,
  type Attachment,
  type Change,
  type ConversationId,
  type ConversationSnapshot,
  type HealthEntry,
  type Message,
  type MessageId,
  type Pm,
  type PmId,
  type Project,
  type ProjectFolder,
  type PublicEntryStatus,
  type ScheduleRecord,
  type ServerInfo,
  type SessionState,
  type StateSnapshot,
  type TunnelStatus,
} from "../shared/index.ts";
import type { ErrorInfo } from "./format.ts";
import type { ConnectionStatus } from "./connection.ts";

/** 网页自己先显示出来、服务端还没回真消息的用户消息。 */
export interface PendingMessage {
  clientId: string;
  conversationId: ConversationId;
  text: string;
  /** 已经传上去的文件（上传接口的响应）；没有文件是空数组。 */
  attachments: Attachment[];
  /** sending：POST 在路上或已成功等服务端推回；failed：POST 失败，可以重试。 */
  phase: "sending" | "failed";
  /**
   * phase 是 failed 时的原因，都是重试也没用的：attachments_missing 带的文件已经不在服务端（要重新添加）；
   * rejected 服务端拒绝了这条消息（400），原因在 reason，同一条重发还是会被拦。其他失败（断网、5xx）不写，可以重试。
   */
  failure?: "attachments_missing" | "rejected";
  /** failure 是 rejected 时服务端给的原因（中文）；hint 接在后面，raw 放 title。 */
  reason?: ErrorInfo;
  createdAt: number;
}

export type OlderState = "loading" | "error";

/** 服务端标了失败的用户消息点“重试”之后：请求在路上 / 请求失败。 */
export type RetryPhase = "retrying" | "error";

export interface ConversationView {
  conversation: ConversationSnapshot["conversation"];
  /** 按编号从小到大。 */
  messages: Message[];
  hasMore: boolean;
  /** Worker 对话：快照时刻项目经理对话里指向它的最近一行（selectors.ts 再拿项目经理对话里实时来的新行比）。 */
  workerLine?: ConversationSnapshot["workerLine"];
}

type Phase = "loading" | "ready" | "error" | "unauthorized";

export interface HubState {
  phase: Phase;
  /** phase 是 error 时拉快照为什么失败（显示“连不上守护进程”和怎么办）；别的时候没有。 */
  loadError?: ErrorInfo;
  connection: ConnectionStatus;
  /** 已经处理到的最后一个 seq。 */
  seq: number;
  pms: Pm[];
  projects: Project[];
  /** 所有项目没移除的文件夹。 */
  folders: ProjectFolder[];
  /** 项目经理收到 pm.updated 的次数；资料页据此重新拉性格设定。 */
  personaRev: Record<PmId, number | undefined>;
  conversations: Record<ConversationId, ConversationView>;
  sessions: SessionState[];
  health: HealthEntry[];
  /** 所有项目经理的定时任务（ScheduleRecord.pmId 认是谁的）；资料页的定时任务卡片用。 */
  schedules: ScheduleRecord[];
  /** 服务端所在机器能做什么（界面按它显示控件，见 server-info.tsx）；还没加载时是 macOS 的占位，加载完才会显示界面。 */
  server: ServerInfo;
  /** 连入方 ssh 隧道状态（来自 /api/state 的 tunnel）。 */
  tunnel?: TunnelStatus | null;
  /** 公网入口状态（来自 /api/state 的 publicEntry）。 */
  publicEntry?: PublicEntryStatus;
  pending: PendingMessage[];
  older: Record<ConversationId, OlderState | undefined>;
  /** 用户主动翻过页（olderStart / olderDone）的对话：不再按 MAX_LIVE_MESSAGES 自动截断顶部旧消息；重拉快照时重置。 */
  olderLoaded?: Record<ConversationId, boolean | undefined>;
  /** 点过“重试”的失败消息；消息不再是失败就清掉。 */
  retry: Record<MessageId, RetryPhase | undefined>;
}

/** 未主动翻页的对话在内存中保留的最近消息上限（与 shared/reminders.ts 的 MIRROR_MESSAGES_PER_CONVERSATION 对齐），超出后标记 hasMore 供向上翻页，防止长时间运行无限膨胀。 */
export const MAX_LIVE_MESSAGES = 200;

export const initialState: HubState = {
  phase: "loading",
  connection: "connecting",
  seq: 0,
  pms: [],
  projects: [],
  folders: [],
  personaRev: {},
  conversations: {},
  sessions: [],
  health: [],
  schedules: [],
  server: serverInfoFor("darwin"),
  pending: [],
  older: {},
  retry: {},
};

export type HubAction =
  | { type: "loading" }
  | { type: "loaded"; snapshot: StateSnapshot }
  | { type: "loadFailed"; unauthorized: boolean; error?: ErrorInfo }
  | { type: "change"; change: Change }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "olderStart"; conversationId: ConversationId }
  | { type: "olderDone"; conversationId: ConversationId; messages: Message[]; hasMore: boolean }
  | { type: "olderFailed"; conversationId: ConversationId }
  | { type: "pendingAdd"; pending: PendingMessage }
  | { type: "pendingPhase"; clientId: string; phase: PendingMessage["phase"]; failure?: PendingMessage["failure"]; reason?: ErrorInfo }
  | { type: "retryStart"; messageId: MessageId }
  | { type: "retryFailed"; messageId: MessageId };

/** 按编号插入或替换一条消息，保持从小到大。 */
export function upsertMessage(messages: Message[], message: Message): Message[] {
  const last = messages.at(-1);
  if (last === undefined || message.id > last.id) return [...messages, message];
  if (message.id === last.id) return messages.with(messages.length - 1, message);
  const index = messages.findIndex((m) => m.id >= message.id);
  if (messages[index]?.id === message.id) return messages.with(index, message);
  return messages.toSpliced(index, 0, message);
}

function dropConfirmed(pending: PendingMessage[], messages: Message[]): PendingMessage[] {
  if (pending.length === 0) return pending;
  const keys = new Set(messages.filter((m) => m.sender === "user").map((m) => m.dedupeKey));
  const rest = pending.filter((p) => !keys.has(userMessageDedupeKey(p.conversationId, p.clientId)));
  return rest.length === pending.length ? pending : rest;
}

function upsertBy<T>(list: T[], item: T, same: (a: T, b: T) => boolean): T[] {
  const index = list.findIndex((x) => same(x, item));
  return index === -1 ? [...list, item] : list.with(index, item);
}

/** 消息不再是失败了（重试成功排进队了），就不用再记它的重试状态。 */
function dropRetryIfSettled(retry: HubState["retry"], message: Message): HubState["retry"] {
  if (message.status === "failed" || retry[message.id] === undefined) return retry;
  const { [message.id]: _settled, ...rest } = retry;
  return rest;
}

export function applyChange(state: HubState, change: Change): HubState {
  if (change.seq <= state.seq) return state;
  const next = { ...state, seq: change.seq };
  switch (change.type) {
    case "message.created":
    case "message.updated": {
      const { message } = change.data;
      const view = state.conversations[message.conversationId];
      if (!view) return next; // 不认识的对话，device-hub.ts 会重新拉快照
      // 初始快照未加载消息的 Worker 对话（messages 为空且 hasMore 为 true）：没点开加载前不往空列表里塞单条实时消息，等点开时一次拉齐最新一页
      if (
        view.conversation.kind === "worker" &&
        view.messages.length === 0 &&
        view.hasMore &&
        state.older[message.conversationId] !== "loading"
      ) {
        return {
          ...next,
          pending: dropConfirmed(state.pending, [message]),
          retry: dropRetryIfSettled(state.retry, message),
        };
      }
      // 比已带的最早一条还早（快照、实时只带最近一段）：插进来会和往上翻页拉的那一段接不上，留给翻页时拉
      if (view.hasMore && view.messages.length > 0 && message.id < view.messages[0]!.id) {
        return { ...next, pending: dropConfirmed(state.pending, [message]), retry: dropRetryIfSettled(state.retry, message) };
      }
      const updated = upsertMessage(view.messages, message);
      const trim =
        !state.olderLoaded?.[message.conversationId] &&
        state.older[message.conversationId] !== "loading" &&
        updated.length > MAX_LIVE_MESSAGES;
      const messages = trim ? updated.slice(-MAX_LIVE_MESSAGES) : updated;
      return {
        ...next,
        conversations: {
          ...state.conversations,
          [message.conversationId]: { ...view, messages, hasMore: view.hasMore || trim },
        },
        pending: dropConfirmed(state.pending, [message]),
        retry: dropRetryIfSettled(state.retry, message),
      };
    }
    case "session.status":
      return { ...next, sessions: upsertBy(state.sessions, change.data.session, (a, b) => a.sessionId === b.sessionId) };
    case "health.updated":
      return { ...next, health: upsertBy(state.health, change.data.health, (a, b) => a.module === b.module) };
    case "schedule.updated":
      return { ...next, schedules: upsertBy(state.schedules, change.data.schedule, (a, b) => a.id === b.id) };
    case "schedule.removed":
      return { ...next, schedules: state.schedules.filter((x) => x.id !== change.data.scheduleId) };
    case "pm.created":
      return { ...next, pms: upsertBy(state.pms, change.data.pm, (a, b) => a.id === b.id) };
    case "pm.updated": {
      const { pm } = change.data;
      return {
        ...next,
        pms: upsertBy(state.pms, pm, (a, b) => a.id === b.id),
        personaRev: { ...state.personaRev, [pm.id]: (state.personaRev[pm.id] ?? 0) + 1 },
      };
    }
    case "pm.removed": {
      const { pmId } = change.data;
      const removedProjectIds = new Set(state.projects.filter((p) => p.pmId === pmId).map((p) => p.id));
      const conversations = Object.fromEntries(
        Object.entries(state.conversations).filter(([, view]) => view.conversation.pmId !== pmId),
      );
      return {
        ...next,
        pms: state.pms.filter((p) => p.id !== pmId),
        projects: state.projects.filter((p) => p.pmId !== pmId),
        folders: state.folders.filter((f) => !removedProjectIds.has(f.projectId)),
        conversations,
        schedules: state.schedules.filter((s) => s.pmId !== pmId),
      };
    }
    case "project.created":
      return { ...next, projects: upsertBy(state.projects, change.data.project, (a, b) => a.id === b.id) };
    case "folders.updated": {
      const { projectId, folders } = change.data;
      return { ...next, folders: [...state.folders.filter((f) => f.projectId !== projectId), ...folders] };
    }
    case "conversation.created": {
      const { conversation } = change.data;
      if (state.conversations[conversation.id]) return next;
      return {
        ...next,
        conversations: { ...state.conversations, [conversation.id]: { conversation, messages: [], hasMore: false } },
      };
    }
    case "session.created":
      return { ...next, sessions: upsertBy(state.sessions, change.data.session, (a, b) => a.sessionId === b.sessionId) };
  }
}

/** 这条变化引用了网页还不认识的对话吗？ */
export function referencesUnknownConversation(state: HubState, change: Change): boolean {
  return (
    (change.type === "message.created" || change.type === "message.updated") &&
    !state.conversations[change.data.message.conversationId]
  );
}

function keepStillFailed(retry: HubState["retry"], messages: Message[]): HubState["retry"] {
  const failed = new Set(messages.filter((m) => m.status === "failed").map((m) => m.id));
  return Object.fromEntries(Object.entries(retry).filter(([id]) => failed.has(Number(id))));
}

function withoutLoadError(state: HubState): HubState {
  const { loadError: _loadError, ...rest } = state;
  return rest;
}

/**
 * 旧状态里这个对话已经收工了吗（至少有一个会话，且全部 ended）？
 * 已收工的 Worker 不会再出新消息，网页手里的消息就是全的；还在跑的，断线期间可能又出了消息（比如最终回复）。
 */
function endedBefore(state: HubState, conversationId: ConversationId): boolean {
  const sessions = state.sessions.filter((s) => s.conversationId === conversationId);
  return sessions.length > 0 && sessions.every((s) => s.status === "ended");
}

function fromSnapshot(state: HubState, snapshot: StateSnapshot): HubState {
  const conversations: Record<ConversationId, ConversationView> = {};
  for (const c of snapshot.conversations) {
    const prev = state.conversations[c.conversation.id];
    // 快照省略了消息（已收工的 Worker 只带 hasMore）：只有旧状态里就已收工、按需加载过的消息才保留；
    // 断线前还在跑、断线期间收工的，旧消息可能缺最终回复，换成快照的空列表 + hasMore，让 MessageList 重新拉最新一页。
    const keepLoaded =
      c.messages.length === 0 && c.hasMore && prev !== undefined && prev.messages.length > 0 && endedBefore(state, c.conversation.id);
    const workerLine = c.workerLine !== undefined ? { workerLine: c.workerLine } : {};
    conversations[c.conversation.id] = keepLoaded
      ? { conversation: c.conversation, messages: prev.messages, hasMore: prev.hasMore, ...workerLine }
      : { conversation: c.conversation, messages: c.messages, hasMore: c.hasMore, ...workerLine };
  }
  const all = snapshot.conversations.flatMap((c) => c.messages);
  const { tunnel: _oldTunnel, publicEntry: _oldPublicEntry, ...base } = withoutLoadError(state);
  return {
    ...base,
    phase: "ready",
    seq: snapshot.seq,
    pms: snapshot.pms,
    projects: snapshot.projects,
    folders: snapshot.folders,
    conversations,
    sessions: snapshot.sessions,
    health: snapshot.health,
    schedules: snapshot.schedules,
    server: snapshot.server,
    ...(snapshot.tunnel !== undefined ? { tunnel: snapshot.tunnel } : {}),
    ...(snapshot.publicEntry !== undefined ? { publicEntry: snapshot.publicEntry } : {}),
    pending: dropConfirmed(state.pending, all),
    older: {},
    olderLoaded: {},
    retry: keepStillFailed(state.retry, all),
  };
}

export function reducer(state: HubState, action: HubAction): HubState {
  switch (action.type) {
    case "loading":
      return { ...state, phase: "loading" };
    case "loaded":
      return fromSnapshot(state, action.snapshot);
    case "loadFailed": {
      const { loadError: _old, ...rest } = state;
      const phase = action.unauthorized ? "unauthorized" : state.phase === "ready" ? "ready" : "error";
      return { ...rest, phase, ...(phase === "error" && action.error ? { loadError: action.error } : {}) };
    }
    case "change":
      return applyChange(state, action.change);
    case "connection":
      return { ...state, connection: action.status };
    case "olderStart":
      return {
        ...state,
        older: { ...state.older, [action.conversationId]: "loading" },
        olderLoaded: { ...state.olderLoaded, [action.conversationId]: true },
      };
    case "olderFailed":
      return { ...state, older: { ...state.older, [action.conversationId]: "error" } };
    case "olderDone": {
      const view = state.conversations[action.conversationId];
      if (!view) return state;
      const known = new Set(view.messages.map((m) => m.id));
      const earlier = action.messages.filter((m) => !known.has(m.id));
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [action.conversationId]: {
            ...view,
            messages: [...earlier, ...view.messages].toSorted((a, b) => a.id - b.id),
            hasMore: action.hasMore,
          },
        },
        older: { ...state.older, [action.conversationId]: undefined },
        olderLoaded: { ...state.olderLoaded, [action.conversationId]: true },
      };
    }
    case "pendingAdd":
      return { ...state, pending: [...state.pending, action.pending] };
    case "retryStart":
      return { ...state, retry: { ...state.retry, [action.messageId]: "retrying" } };
    case "retryFailed":
      return { ...state, retry: { ...state.retry, [action.messageId]: "error" } };
    case "pendingPhase":
      return {
        ...state,
        pending: state.pending.map((p) => {
          if (p.clientId !== action.clientId) return p;
          const { failure: _old, reason: _oldReason, ...rest } = p;
          return { ...rest, phase: action.phase, ...(action.failure ? { failure: action.failure } : {}), ...(action.reason ? { reason: action.reason } : {}) };
        }),
      };
  }
}

export function oldestMessageId(view: ConversationView): MessageId | null {
  return view.messages[0]?.id ?? null;
}
