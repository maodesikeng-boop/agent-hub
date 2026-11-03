// 从 HubState 算出界面要用的东西。
import {
  RATE_LIMIT_ALLOWED,
  type ConversationId,
  type HealthEntry,
  type Message,
  type SessionState,
} from "../shared/index.ts";
import type { HubState, PendingMessage } from "./state.ts";

export interface ConversationEntry {
  id: ConversationId;
  name: string;
  /** 头像的颜色和首字取自它。 */
  avatarKey: number;
  lastMessage: Message | null;
  lastAt: number;
}

/** 预览用最后一条文字消息；一条文字都没有就用最后一条。 */
function previewMessage(messages: Message[]): Message | null {
  return messages.findLast((m) => m.kind === "text") ?? messages.at(-1) ?? null;
}

/** 左栏的对话，按最后一条消息的时间从新到旧；没有消息的按创建时间。 */
export function listConversations(state: HubState): ConversationEntry[] {
  return Object.values(state.conversations)
    .map((view): ConversationEntry => {
      const pm = state.pms.find((p) => p.id === view.conversation.pmId);
      const last = view.messages.at(-1);
      return {
        id: view.conversation.id,
        name: pm?.name ?? view.conversation.title,
        avatarKey: pm?.id ?? view.conversation.id,
        lastMessage: previewMessage(view.messages),
        lastAt: last?.createdAt ?? view.conversation.createdAt,
      };
    })
    .toSorted((a, b) => b.lastAt - a.lastAt || a.id - b.id);
}

export function sessionOf(state: HubState, conversationId: ConversationId): SessionState | null {
  return state.sessions.find((s) => s.conversationId === conversationId) ?? null;
}

export function isWaitingForQuota(session: SessionState | null): boolean {
  return session?.rateLimit != null && session.rateLimit.status !== RATE_LIMIT_ALLOWED;
}

export function pendingOf(state: HubState, conversationId: ConversationId): PendingMessage[] {
  return state.pending.filter((p) => p.conversationId === conversationId);
}

/** 有错误的健康项（成功一次后 lastError 会被清成 null）。 */
export function failingHealth(state: HubState): HealthEntry[] {
  return state.health.filter((h) => h.lastError !== null);
}

export type RenderItem =
  | { kind: "message"; message: Message }
  | { kind: "tools"; key: string; messages: Message[] };

/** 连续的工具调用合成一组，界面折叠成“执行了 N 个操作”。 */
export function groupMessages(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  for (const message of messages) {
    const last = items.at(-1);
    if (message.kind === "tool") {
      if (last?.kind === "tools") last.messages.push(message);
      else items.push({ kind: "tools", key: `tools-${message.id}`, messages: [message] });
    } else {
      items.push({ kind: "message", message });
    }
  }
  return items;
}
