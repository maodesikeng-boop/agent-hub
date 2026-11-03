// 从 HubState 算出界面要用的东西。
import {
  isQuotaExhausted,
  workerEventOf,
  type ConversationId,
  type HealthEntry,
  type Message,
  type Pm,
  type PmId,
  type Project,
  type ProjectFolder,
  type SessionState,
  type WorkerMessageMeta,
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

/** 左栏的对话，按最后一条消息的时间从新到旧；没有消息的按创建时间。Worker 的对话不在左栏，点项目经理会话里那一行打开。 */
export function listConversations(state: HubState): ConversationEntry[] {
  return Object.values(state.conversations)
    .filter((view) => view.conversation.kind !== "worker")
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

/** 额度窗口在 RateLimitInfo.windows 里的键（Claude 的 rate_limit_event）。 */
const FIVE_HOUR_WINDOW = "five_hour";
const SEVEN_DAY_WINDOW = "seven_day";

/** 5 小时、7 天额度已用的百分比（四舍五入的整数）；还没有数据是 null。 */
export interface QuotaUsage {
  fiveHour: number | null;
  sevenDay: number | null;
}

/** m3-plan 2.7：每个会话每一轮都有 rate_limit_event。每个窗口取最近一次事件（lastEventAt 最大，同时间取会话编号大的）那个会话的值。 */
export function quotaUsage(state: HubState): QuotaUsage {
  const latest = (key: string): number | null => {
    let best: SessionState | null = null;
    for (const s of state.sessions) {
      if (s.rateLimit?.windows[key] === undefined) continue;
      const at = s.lastEventAt ?? -1;
      const bestAt = best?.lastEventAt ?? -1;
      if (best === null || at > bestAt || (at === bestAt && s.sessionId > best.sessionId)) best = s;
    }
    const window = best?.rateLimit?.windows[key];
    return window === undefined ? null : Math.round(window.utilization * 100);
  };
  return { fiveHour: latest(FIVE_HOUR_WINDOW), sevenDay: latest(SEVEN_DAY_WINDOW) };
}

/** 这个项目经理派的 Worker 里在跑的个数：Worker 对话的当前会话不是 idle（api.ts StateSnapshot 的注释）。 */
export function runningWorkerCount(state: HubState, pmId: PmId): number {
  return Object.values(state.conversations).filter(
    ({ conversation }) =>
      conversation.kind === "worker" && conversation.pmId === pmId && (sessionOf(state, conversation.id)?.activity ?? "idle") !== "idle",
  ).length;
}

/** 项目经理会话里指向这个 Worker 对话的那几行里最新的一行的内容（标题、只读）；翻页翻掉了、找不到是 null。 */
export function workerLineOf(state: HubState, workerConversationId: ConversationId): WorkerMessageMeta | null {
  const pmId = state.conversations[workerConversationId]?.conversation.pmId;
  for (const view of Object.values(state.conversations)) {
    if (view.conversation.kind === "worker" || (pmId != null && view.conversation.pmId !== pmId)) continue;
    for (const message of view.messages.toReversed()) {
      const meta = workerEventOf(message);
      if (meta?.workerConversationId === workerConversationId) return meta;
    }
  }
  return null;
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
