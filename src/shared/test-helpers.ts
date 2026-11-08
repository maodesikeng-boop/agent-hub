// 测试用的数据构造（不碰 DOM，node 和 jsdom 两边的测试都能用）。网页测试另有 web/test-utils.ts（带假 fetch、假 WebSocket）。
import { serverInfoFor } from "./server-info.ts";
import type { ConversationSnapshot, StateSnapshot } from "./api.ts";
import type { Conversation, Message, Pm, SessionState } from "./domain.ts";

export function makePm(over: Partial<Pm> = {}): Pm {
  return { id: 1, name: "项目经理", avatarFile: null, mode: "manage_only", vendor: "claude", defaultModel: null, effort: null, personaFile: null, createdAt: 1_000, ...over };
}

export function makeConversation(over: Partial<Conversation> = {}): Conversation {
  return { id: 1, kind: "pm", pmId: 1, projectId: null, title: "项目经理", createdAt: 1_000, ...over };
}

export function makeWorkerConversation(over: Partial<Conversation> = {}): Conversation {
  return { id: 30, kind: "worker", pmId: 1, projectId: 1, title: "修 X", createdAt: 1_000, ...over };
}

export function makeMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  const conversationId = over.conversationId ?? 1;
  return {
    conversationId,
    sessionId: 1,
    workerId: null,
    sender: "agent",
    kind: "text",
    text: `消息 ${over.id}`,
    meta: null,
    collapsed: false,
    dedupeKey: `session:1:u${over.id}`,
    status: null,
    failureReason: null,
    createdAt: 10_000 + over.id * 1_000,
    updatedAt: 10_000 + over.id * 1_000,
    ...over,
  };
}

export function makeUserMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  return makeMessage({ sender: "user", sessionId: null, status: "replied", dedupeKey: `client:${over.conversationId ?? 1}:c${over.id}`, ...over });
}

export function makeSession(over: Partial<SessionState> = {}): SessionState {
  return { sessionId: 1, conversationId: 1, pmId: null, generation: 1, status: "idle", activity: "idle", currentTool: null, rateLimit: null, lastEventAt: null, ...over };
}

export function makeConvSnapshot(messages: Message[], over: { conversation?: Partial<Conversation>; hasMore?: boolean } = {}): ConversationSnapshot {
  return { conversation: makeConversation(over.conversation), messages, hasMore: over.hasMore ?? false };
}

export function makeSnapshot(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return { seq: 10, pms: [makePm()], projects: [], folders: [], conversations: [makeConvSnapshot([])], sessions: [], health: [], schedules: [], server: serverInfoFor("darwin"), ...over };
}
