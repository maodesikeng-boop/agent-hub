// 从 HubState 算出界面要用的东西。
import {
  askOf,
  EMPTY_TOKEN_USAGE,
  attachmentsOf,
  isQuotaExhausted,
  systemEventOf,
  systemNoticeText,
  workerEventOf,
  type ConversationId,
  type HealthEntry,
  type Message,
  type TokenUsage,
  type Pm,
  type PmId,
  type Project,
  type ProjectFolder,
  type SessionState,
  type WorkerMessageMeta,
} from "../shared/index.ts";
import { stripMarkdown } from "./plainText.ts";
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

/** agent 的消息是 Markdown，预览去掉符号；用户和系统消息本来就是纯文本。左栏的预览和通知的正文都用它。 */
export function previewText(entry: ConversationEntry): string {
  const last = entry.lastMessage;
  if (!last) return "";
  // 只发了文件没写字的用户消息：写文件名
  const files = attachmentsOf(last);
  if (last.text.trim() === "" && files.length > 0) return `[文件] ${files.map((f) => f.name).join("、")}`;
  // 系统消息和对话里显示的一样（开新会话那两条的原文是发给 agent 的全文）
  if (last.sender === "system") return systemNoticeText(last);
  return last.sender === "agent" ? stripMarkdown(last.text) : last.text;
}

/** 这个对话的当前会话：generation 最大的那一代。不按会话编号、不按推送先后。 */
export function sessionOf(state: HubState, conversationId: ConversationId): SessionState | null {
  let current: SessionState | null = null;
  for (const s of state.sessions) {
    if (s.conversationId === conversationId && (current === null || s.generation > current.generation)) current = s;
  }
  return current;
}

/** 额度用完了（只有 rejected；allowed_warning 只是快到了，照常干活）；已经过了 resetsAt 的不算，Claude 要等下一条事件才会更新它。 */
export function isWaitingForQuota(session: SessionState | null, now: number = Date.now()): boolean {
  return isQuotaExhausted(session?.rateLimit, now);
}

/** 额度已用到这个百分比（含）就算快用完；Claude 自己报 allowed_warning 也算。 */
export const QUOTA_WARNING_PERCENT = 80;
const QUOTA_WARNING_STATUS = "allowed_warning";

/** 一个厂商的额度窗口：窗口键（RateLimitInfo.windows 里的键）→ 中文名，顺序就是显示顺序。 */
interface QuotaVendorSpec {
  id: string;
  name: string;
  windows: readonly { key: string; label: string }[];
}

/**
 * 有额度数据的厂商。会话还没有“哪家厂商”这个字段，现在的额度都是 Claude 的（rate_limit_event）；
 * 以后加厂商：在这里加一项，并让 quotaUsage 按会话的厂商分开取。
 */
const QUOTA_VENDORS: readonly QuotaVendorSpec[] = [
  {
    id: "claude",
    name: "Claude",
    windows: [
      { key: "five_hour", label: "5 小时" },
      { key: "seven_day", label: "7 天" },
    ],
  },
];

export interface QuotaWindowUsage {
  key: string;
  label: string;
  /** 已用的百分比，四舍五入的整数，夹在 0 到 100 之间。 */
  percent: number;
  /** 重置时间，Unix 秒；没有是 null。 */
  resetsAt: number | null;
  /** 快用完了。 */
  warning: boolean;
}

export interface QuotaVendor {
  id: string;
  name: string;
  /** 有数据的窗口，按 QUOTA_VENDORS 里的顺序。 */
  windows: QuotaWindowUsage[];
  /** 额度用完了（isQuotaExhausted，取最近一次事件的那个会话）。 */
  exhausted: boolean;
}

/** a 的事件比 b 新（lastEventAt 大；一样大取会话编号大的）。 */
const newerSession = (a: SessionState, b: SessionState | null): boolean =>
  b === null || (a.lastEventAt ?? -1) > (b.lastEventAt ?? -1) || ((a.lastEventAt ?? -1) === (b.lastEventAt ?? -1) && a.sessionId > b.sessionId);

/** resetsAt（Unix 秒）已经到了或过了；不是正的有限数（脏数据）当没到。 */
const isReset = (resetsAt: number, now: number): boolean => Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt * 1000 <= now;

/**
 * 同一个窗口里 a 的值比 b 新。不能看会话的 lastEventAt：网页里它只在会话状态变了才跟着推过来，旧会话收尾也会把它刷新，
 * 会让重置前的旧值盖住重置后的新值。所以：重置时间晚的是新窗口；同一个窗口里用量只增不减，高的是新的；都一样才看 lastEventAt。
 */
const newerWindow = (a: SessionState, b: SessionState | null, key: string): boolean => {
  if (b === null) return true;
  const wa = a.rateLimit!.windows[key]!;
  const wb = b.rateLimit!.windows[key]!;
  if (wa.resetsAt !== wb.resetsAt) return wa.resetsAt > wb.resetsAt;
  if (wa.utilization !== wb.utilization) return wa.utilization > wb.utilization;
  return newerSession(a, b);
};

/**
 * m3-plan 2.7：每个会话每一轮都有 rate_limit_event。每个窗口取最新的那个值（newerWindow）；没有数据的窗口、厂商不返回。
 * 值不是有限的数就当没有；超出 0 到 1 的夹到边上。
 * 过了 resetsAt 的窗口已经重置：显示 0%、没有重置时间、不标快用完（新窗口的数据要等下一条事件才来）；不是已用完。
 * now 是毫秒；网页用 useRerenderAt 在每个重置时间点重新渲染，所以页面不动也会变。
 */
export function quotaUsage(state: HubState, now: number = Date.now()): QuotaVendor[] {
  const vendors: QuotaVendor[] = [];
  for (const spec of QUOTA_VENDORS) {
    const windows: QuotaWindowUsage[] = [];
    for (const { key, label } of spec.windows) {
      let best: SessionState | null = null;
      for (const s of state.sessions) {
        const w = s.rateLimit?.windows[key];
        if (w !== undefined && Number.isFinite(w.utilization) && newerWindow(s, best, key)) best = s;
      }
      const window = best?.rateLimit?.windows[key];
      if (window === undefined) continue;
      if (isReset(window.resetsAt, now)) {
        windows.push({ key, label, percent: 0, resetsAt: null, warning: false });
        continue;
      }
      const percent = Math.round(Math.min(1, Math.max(0, window.utilization)) * 100);
      windows.push({
        key,
        label,
        percent,
        resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
        warning: window.status === QUOTA_WARNING_STATUS || percent >= QUOTA_WARNING_PERCENT,
      });
    }
    if (windows.length === 0) continue;
    let latest: SessionState | null = null;
    for (const s of state.sessions) if (s.rateLimit !== null && newerSession(s, latest)) latest = s;
    vendors.push({ id: spec.id, name: spec.name, windows, exhausted: isQuotaExhausted(latest?.rateLimit, now) });
  }
  return vendors;
}

/**
 * 所有会话额度里的重置时间点（毫秒，去重、从早到晚）：窗口的 resetsAt 和整体的 resetsAt。
 * 页面到了这些时间点要重新渲染一次，已重置的窗口才会变成 0%。
 */
export function quotaResetTimes(state: HubState): number[] {
  const times = new Set<number>();
  for (const { rateLimit } of state.sessions) {
    if (rateLimit === null) continue;
    for (const w of Object.values(rateLimit.windows)) if (Number.isFinite(w.resetsAt) && w.resetsAt > 0) times.add(w.resetsAt * 1000);
    if (rateLimit.resetsAt !== null && Number.isFinite(rateLimit.resetsAt) && rateLimit.resetsAt > 0) times.add(rateLimit.resetsAt * 1000);
  }
  return [...times].sort((a, b) => a - b);
}

/** 这个项目经理派的 Worker 里在跑的个数：Worker 对话的当前会话不是 idle（api.ts StateSnapshot 的注释）。 */
export function runningWorkerCount(state: HubState, pmId: PmId): number {
  return Object.values(state.conversations).filter(
    ({ conversation }) =>
      conversation.kind === "worker" && conversation.pmId === pmId && (sessionOf(state, conversation.id)?.activity ?? "idle") !== "idle",
  ).length;
}

/**
 * Worker 现在能不能接用户的话（右边栏和 Worker 页面共用，和账本 workers.ts 的 assertWorkerOpenForUser 同一个意思）：
 * - ended：收工了：项目经理的会话里有 ended / worktree_failed 那一行（项目经理 worker end 后会话要等这一轮跑完才 ended），
 *   或者它的会话结束了；
 * - preparing：还在准备：会话在跑准备命令（activity preparing），或者任务说明还在排队、没发给它（worktree 还没建好）。比账本严一点：建好之后、
 *   任务说明送达之前的一小会儿也算；
 * - open：能接话。
 */
export type WorkerPhase = "preparing" | "open" | "ended";

/** 这个项目经理的会话里有“已收工”“建 worktree 失败”那一行的 Worker 对话。 */
function endedByLine(state: HubState, pmId: PmId | null): Set<ConversationId> {
  const ended = new Set<ConversationId>();
  for (const { conversation, messages } of Object.values(state.conversations)) {
    if (conversation.kind === "worker" || conversation.pmId !== pmId) continue;
    for (const message of messages) {
      const meta = workerEventOf(message);
      if (meta && (meta.event === "ended" || meta.event === "worktree_failed")) ended.add(meta.workerConversationId);
    }
  }
  return ended;
}

function phaseOf(state: HubState, workerConversationId: ConversationId, endedLines: Set<ConversationId>): WorkerPhase {
  const session = sessionOf(state, workerConversationId);
  if (endedLines.has(workerConversationId) || session?.status === "ended") return "ended";
  // 正在跑项目的准备命令（PR #47，会话 activity 是 preparing）
  if (session?.activity === "preparing") return "preparing";
  const view = state.conversations[workerConversationId];
  // 第一条是任务说明（翻页翻掉了说明早就发过了）
  const task = view?.hasMore === false ? view.messages[0] : undefined;
  return task?.sender === "pm" && task.status === "queued" ? "preparing" : "open";
}

export function workerPhaseOf(state: HubState, workerConversationId: ConversationId): WorkerPhase {
  const pmId = state.conversations[workerConversationId]?.conversation.pmId ?? null;
  return phaseOf(state, workerConversationId, endedByLine(state, pmId));
}

export interface WorkerEntry {
  conversationId: ConversationId;
  title: string;
  /** 会话的 activity；没有会话当 idle。不一定是 SessionActivity 里的值（以后会加），显示的地方要有兜底。 */
  activity: string;
  /** 收工了（workerPhaseOf 是 ended）。 */
  ended: boolean;
  /** 会话的厂商、模型、思考程度（null = 默认）；没有会话、老服务端没带就是 undefined。 */
  vendor?: string;
  model?: string | null;
  effort?: string | null;
  /** 累计用量（老服务端没带当 0）。 */
  usage: TokenUsage;
}

/** 这个项目经理派的 Worker：进行中的在前，收工的在后，同一组里按派出的顺序（对话编号）。 */
export function workersOf(state: HubState, pmId: PmId): WorkerEntry[] {
  const endedLines = endedByLine(state, pmId);
  return Object.values(state.conversations)
    .filter(({ conversation }) => conversation.kind === "worker" && conversation.pmId === pmId)
    .map(({ conversation }) => {
      const session = sessionOf(state, conversation.id);
      return {
        conversationId: conversation.id,
        title: conversation.title,
        activity: session?.activity ?? "idle",
        ended: phaseOf(state, conversation.id, endedLines) === "ended",
        vendor: session?.vendor,
        model: session?.model,
        effort: session?.effort,
        usage: session?.usage ?? EMPTY_TOKEN_USAGE,
      };
    })
    .toSorted((a, b) => Number(a.ended) - Number(b.ended) || a.conversationId - b.conversationId);
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

/** 每个对话用户上次看的时间（毫秒）；没看过的没有。存在 localStorage，见 notify.ts。 */
export type LastSeen = Record<ConversationId, number | undefined>;

/** 还没处理完的消息状态：排队中、已送达、处理中。 */
const IN_FLIGHT = new Set(["queued", "delivered", "processing"]);

/**
 * 在“等你”的对话（m4-plan 2.2，不含“停稳 3 秒”，那个在 notify.ts）：对话自己和它派的 Worker 的会话都是 idle，
 * 没有排队、已送达、处理中的消息，最后一条不是用户发的，并且用户上次看之后又有了新消息。Worker 自己的对话不算。
 */
export function waitingConversations(state: HubState, lastSeen: LastSeen): ConversationId[] {
  return Object.values(state.conversations)
    .filter(({ conversation, messages }) => {
      if (conversation.kind === "worker") return false;
      const last = messages.at(-1);
      if (!last || last.sender === "user" || last.createdAt <= (lastSeen[conversation.id] ?? 0)) return false;
      if (messages.some((m) => m.status !== null && IN_FLIGHT.has(m.status))) return false;
      if (pendingOf(state, conversation.id).some((p) => p.phase === "sending")) return false;
      if ((sessionOf(state, conversation.id)?.activity ?? "idle") !== "idle") return false;
      return conversation.pmId === null || runningWorkerCount(state, conversation.pmId) === 0;
    })
    .map(({ conversation }) => conversation.id);
}

/**
 * 对话里还在等用户确定的 hub ask（M5）：没点“知道了”（meta.dismissed），并且这条之后用户没发过消息
 * （包括刚发出、服务端还没确认的）。从老到新。
 */
export function pendingAsks(state: HubState, conversationId: ConversationId): Message[] {
  const view = state.conversations[conversationId];
  if (!view || pendingOf(state, conversationId).some((p) => p.phase !== "failed")) return [];
  const lastUserId = view.messages.findLast((m) => m.sender === "user")?.id ?? 0;
  return view.messages.filter((m) => {
    const meta = askOf(m);
    return meta !== null && meta.dismissed !== true && m.id > lastUserId;
  });
}

export function pendingOf(state: HubState, conversationId: ConversationId): PendingMessage[] {
  return state.pending.filter((p) => p.conversationId === conversationId);
}

/**
 * 这个对话在换新会话（资料页的“开新会话”按钮不能点）：交接请求还没结果，或者新会话的第一条（交接）还在排队。
 * 和账本的 waitsForHandover 同一个口径（ledger/handover.ts）。
 */
export function isRenewing(state: HubState, conversationId: ConversationId): boolean {
  return (state.conversations[conversationId]?.messages ?? []).some((m) => {
    const event = systemEventOf(m)?.event;
    return (event === "handover.requested" && m.status !== null && IN_FLIGHT.has(m.status)) || (event === "session.renewed" && m.status === "queued");
  });
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
