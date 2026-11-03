// 从 HubState 算出界面要用的东西。
import {
  isQuotaExhausted,
  type ConversationId,
  type ConversationKind,
  type HealthEntry,
  type Message,
  type Pm,
  type PmId,
  type Project,
  type ProjectFolder,
  type SessionState,
} from "../shared/index.ts";
import type { HubState, PendingMessage } from "./state.ts";

export interface ConversationEntry {
  id: ConversationId;
  kind: ConversationKind;
  /** 私聊是项目经理的名字，群是项目名。 */
  name: string;
  /** 头像的颜色取自它。 */
  avatarKey: number;
  lastMessage: Message | null;
  lastAt: number;
  /** 私聊是对方；群是项目现在的项目经理（换过人就是新的）。找不到是 null。 */
  pm: Pm | null;
  /** 只有群有。 */
  project: Project | null;
  /** 群里项目没移除的文件夹，主文件夹在前。私聊是空的。 */
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
      const project =
        conversation.kind === "project_group"
          ? (state.projects.find((p) => p.id === conversation.projectId) ?? null)
          : null;
      const pm = findPm(state.pms, project?.pmId ?? conversation.pmId);
      const isGroup = conversation.kind === "project_group";
      return {
        id: conversation.id,
        kind: conversation.kind,
        name: isGroup ? (project?.name ?? conversation.title) : (pm?.name ?? conversation.title),
        avatarKey: isGroup ? (project?.id ?? conversation.id) : (pm?.id ?? conversation.id),
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

function findPm(pms: Pm[], id: PmId | null): Pm | null {
  return id === null ? null : (pms.find((p) => p.id === id) ?? null);
}

/** 一个项目经理现在管着的项目。 */
export function projectsOf(state: HubState, pmId: PmId): Project[] {
  return state.projects.filter((p) => p.pmId === pmId);
}

/**
 * 这个对话的当前会话：generation 最大的那一代（换项目经理后旧一代还会回完最后一轮，不拿它显示）。
 * 不按会话编号、不按推送先后。
 */
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
