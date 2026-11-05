// 网页的数据：/api/state 的快照 + WebSocket 推来的变化，合成一份界面要用的状态。
// 全是纯函数，方便测试；网络和定时器在 useHub.ts。
import {
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
  type ScheduleRecord,
  type SessionState,
  type StateSnapshot,
} from "../shared/index.ts";
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
  /** failure 是 rejected 时服务端给的原因（中文，原样显示）。 */
  reason?: string;
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
}

export type Phase = "loading" | "ready" | "error" | "unauthorized";

export interface HubState {
  phase: Phase;
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
  pending: PendingMessage[];
  older: Record<ConversationId, OlderState | undefined>;
  /** 点过“重试”的失败消息；消息不再是失败就清掉。 */
  retry: Record<MessageId, RetryPhase | undefined>;
}

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
  pending: [],
  older: {},
  retry: {},
};

export type HubAction =
  | { type: "loading" }
  | { type: "loaded"; snapshot: StateSnapshot }
  | { type: "loadFailed"; unauthorized: boolean }
  | { type: "change"; change: Change }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "olderStart"; conversationId: ConversationId }
  | { type: "olderDone"; conversationId: ConversationId; messages: Message[]; hasMore: boolean }
  | { type: "olderFailed"; conversationId: ConversationId }
  | { type: "pendingAdd"; pending: PendingMessage }
  | { type: "pendingPhase"; clientId: string; phase: PendingMessage["phase"]; failure?: PendingMessage["failure"]; reason?: string }
  | { type: "retryStart"; messageId: MessageId }
  | { type: "retryFailed"; messageId: MessageId };

/** 按编号插入或替换一条消息，保持从小到大。 */
export function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((m) => m.id >= message.id);
  if (index === -1) return [...messages, message];
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
      if (!view) return next; // 不认识的对话，useHub 会重新拉快照
      return {
        ...next,
        conversations: {
          ...state.conversations,
          [message.conversationId]: { ...view, messages: upsertMessage(view.messages, message) },
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

function fromSnapshot(state: HubState, snapshot: StateSnapshot): HubState {
  const conversations: Record<ConversationId, ConversationView> = {};
  for (const c of snapshot.conversations) {
    conversations[c.conversation.id] = { conversation: c.conversation, messages: c.messages, hasMore: c.hasMore };
  }
  const all = snapshot.conversations.flatMap((c) => c.messages);
  return {
    ...state,
    phase: "ready",
    seq: snapshot.seq,
    pms: snapshot.pms,
    projects: snapshot.projects,
    folders: snapshot.folders,
    conversations,
    sessions: snapshot.sessions,
    health: snapshot.health,
    schedules: snapshot.schedules,
    pending: dropConfirmed(state.pending, all),
    older: {},
    retry: keepStillFailed(state.retry, all),
  };
}

export function reducer(state: HubState, action: HubAction): HubState {
  switch (action.type) {
    case "loading":
      return { ...state, phase: "loading" };
    case "loaded":
      return fromSnapshot(state, action.snapshot);
    case "loadFailed":
      return { ...state, phase: action.unauthorized ? "unauthorized" : state.phase === "ready" ? "ready" : "error" };
    case "change":
      return applyChange(state, action.change);
    case "connection":
      return { ...state, connection: action.status };
    case "olderStart":
      return { ...state, older: { ...state.older, [action.conversationId]: "loading" } };
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
