// 网页的数据：/api/state 的快照 + WebSocket 推来的变化，合成一份界面要用的状态。
// 全是纯函数，方便测试；网络和定时器在 useHub.ts。
import {
  userMessageDedupeKey,
  type Change,
  type ConversationId,
  type ConversationSnapshot,
  type HealthEntry,
  type Message,
  type MessageId,
  type Pm,
  type SessionState,
  type StateSnapshot,
} from "../shared/index.ts";
import type { ConnectionStatus } from "./connection.ts";

/** 网页自己先显示出来、服务端还没回真消息的用户消息。 */
export interface PendingMessage {
  clientId: string;
  conversationId: ConversationId;
  text: string;
  /** sending：POST 在路上或已成功等服务端推回；failed：POST 失败，可以重试。 */
  phase: "sending" | "failed";
  createdAt: number;
}

export type OlderState = "loading" | "error";

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
  conversations: Record<ConversationId, ConversationView>;
  sessions: SessionState[];
  health: HealthEntry[];
  pending: PendingMessage[];
  older: Record<ConversationId, OlderState | undefined>;
}

export const initialState: HubState = {
  phase: "loading",
  connection: "connecting",
  seq: 0,
  pms: [],
  conversations: {},
  sessions: [],
  health: [],
  pending: [],
  older: {},
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
  | { type: "pendingPhase"; clientId: string; phase: PendingMessage["phase"] };

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
      };
    }
    case "session.status":
      return { ...next, sessions: upsertBy(state.sessions, change.data.session, (a, b) => a.sessionId === b.sessionId) };
    case "health.updated":
      return { ...next, health: upsertBy(state.health, change.data.health, (a, b) => a.module === b.module) };
    // M2 W0 占位：下面这些新变化由 M2 W5 处理。每种都写成显式的 case、不用 default，以后加了新类型漏处理时编译器会报错
    case "pm.created":
    case "pm.updated":
    case "project.created":
    case "project.updated":
    case "folders.updated":
    case "conversation.created":
    case "session.created":
      return next;
  }
}

/** 这条变化引用了网页还不认识的对话吗？ */
export function referencesUnknownConversation(state: HubState, change: Change): boolean {
  return (
    (change.type === "message.created" || change.type === "message.updated") &&
    !state.conversations[change.data.message.conversationId]
  );
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
    conversations,
    sessions: snapshot.sessions,
    health: snapshot.health,
    pending: dropConfirmed(state.pending, all),
    older: {},
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
    case "pendingPhase":
      return {
        ...state,
        pending: state.pending.map((p) => (p.clientId === action.clientId ? { ...p, phase: action.phase } : p)),
      };
  }
}

export function oldestMessageId(view: ConversationView): MessageId | null {
  return view.messages[0]?.id ?? null;
}
