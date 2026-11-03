// 从 HubState 算出界面要用的东西。
import {
  isQuotaExhausted,
  type ConversationId,
  type HealthEntry,
  type Message,
  type Pm,
  type Project,
  type ProjectFolder,
  type SessionState,
} from "../shared/index.ts";
import type { HubState, PendingMessage } from "./state.ts";

/** 左栏的一行：一个项目经理和它唯一的那个对话（11-03 起不再有项目群）。 */
export interface ConversationEntry {
  id: ConversationId;
  /** 项目经理的名字；找不到项目经理（还没同步）用对话标题。 */
  name: string;
  /** 头像的颜色取自它。 */
  avatarKey: number;
  lastMessage: Message | null;
  lastAt: number;
  pm: Pm | null;
  /** 它的项目；还没有是 null。 */
  project: Project | null;
  /** 项目没移除的文件夹，主文件夹在前。没有项目是空的。 */
  folders: ProjectFolder[];
}

/** 预览用最后一条文字消息；一条文字都没有就用最后一条。 */
function previewMessage(messages: Message[]): Message | null {
  return messages.findLast((m) => m.kind === "text") ?? messages.at(-1) ?? null;
}

/** 左栏的对话，按最后一条消息的时间从新到旧；没有消息的按创建时间。 */
export function listConversations(state: HubState): ConversationEntry[] {
  return Object.values(state.conversations)
    .map((view): ConversationEntry => {
      const { conversation } = view;
      const last = view.messages.at(-1);
      const pm = conversation.pmId === null ? null : (state.pms.find((p) => p.id === conversation.pmId) ?? null);
      const project = state.projects.find((p) => p.conversationId === conversation.id) ?? null;
      return {
        id: conversation.id,
        name: pm?.name ?? conversation.title,
        avatarKey: pm?.id ?? conversation.id,
        lastMessage: previewMessage(view.messages),
        lastAt: last?.createdAt ?? conversation.createdAt,
        pm,
        project,
        folders: project
          ? state.folders.filter((f) => f.projectId === project.id).toSorted((a, b) => Number(b.isMain) - Number(a.isMain) || a.id - b.id)
          : [],
      };
    })
    .toSorted((a, b) => b.lastAt - a.lastAt || a.id - b.id);
}

/** 这个对话的当前会话：generation 最大的那一代。不按会话编号、不按推送先后。 */
export function sessionOf(state: HubState, conversationId: ConversationId): SessionState | null {
  let current: SessionState | null = null;
  for (const s of state.sessions) {
    if (s.conversationId === conversationId && (current === null || s.generation > current.generation)) current = s;
  }
  return current;
}

/** 额度用完了（只有 rejected；allowed_warning 只是快到了，照常干活）。 */
export function isWaitingForQuota(session: SessionState | null): boolean {
  return isQuotaExhausted(session?.rateLimit);
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
