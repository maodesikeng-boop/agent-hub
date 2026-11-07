// 从 HubState 算出界面要用的东西。
import {
  AGENT_VENDORS,
  askOf,
  DEFAULT_AGENT_VENDOR,
  QUOTA_WINDOWS,
  VENDOR_SPECS,
  EMPTY_TOKEN_USAGE,
  attachmentsOf,
  isHandoverTraffic,
  isAgentVendor,
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
  type QuotaResponse,
  type QuotaWindowKey,
  type RateLimitWindow,
  type ProjectFolder,
  type SessionId,
  type SessionState,
  type WorkerMessageMeta,
} from "../shared/index.ts";
import { stripMarkdown } from "./plainText.ts";
import { workerStatusOf, type WorkerTone } from "./worker-status.ts";
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

/**
 * 换新会话的那几条（写交接的来往、换代那条分隔线）：用户没说话、项目经理也没对用户说话，不进左栏预览、不改排序、不算未读。
 * 见 shared/domain.ts 的 isHandoverTraffic。
 */
export function isQuietMessage(message: Message): boolean {
  return isHandoverTraffic(message) || systemEventOf(message)?.event === "session.renewed";
}

/** 预览用最后一条文字消息；一条文字都没有就用最后一条。换新会话的那几条不算。 */
function previewMessage(messages: Message[]): Message | null {
  const shown = messages.filter((m) => !isQuietMessage(m));
  return shown.findLast((m) => m.kind === "text") ?? shown.at(-1) ?? null;
}

/** 左栏的对话，按最后一条消息的时间从新到旧；没有消息的按创建时间。Worker 的对话不在左栏，点项目经理会话里那一行打开。 */
export function listConversations(state: HubState): ConversationEntry[] {
  return Object.values(state.conversations)
    .filter((view) => view.conversation.kind !== "worker")
    .map((view): ConversationEntry => {
      const { conversation } = view;
      const last = view.messages.findLast((m) => !isQuietMessage(m));
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

/** 有额度数据的厂商（shared/vendors.ts 的 VendorSpec.quota）；加厂商只在那里写。 */
const QUOTA_VENDORS = AGENT_VENDORS.flatMap((id) => {
  const quota = VENDOR_SPECS[id].quota;
  return quota === undefined ? [] : [{ id, ...quota }];
});

export interface QuotaWindowUsage {
  key: string;
  label: string;
  /** 左下角按钮上的简写（5h、7d）。 */
  short: string;
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
  /** 有数据的窗口，按厂商 quota.windows 里的顺序。 */
  windows: QuotaWindowUsage[];
  /** 额度用完了（isQuotaExhausted，取最近一次事件的那个会话）。 */
  exhausted: boolean;
}

/** a 的事件比 b 新（lastEventAt 大；一样大取会话编号大的）。 */
const newerSession = (a: SessionState, b: SessionState | null): boolean =>
  b === null || (a.lastEventAt ?? -1) > (b.lastEventAt ?? -1) || ((a.lastEventAt ?? -1) === (b.lastEventAt ?? -1) && a.sessionId > b.sessionId);

/** resetsAt（Unix 秒）已经到了或过了；不是正的有限数（脏数据）当没到。 */
const isReset = (resetsAt: number, now: number): boolean => Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt * 1000 <= now;

/** 一个窗口的显示数据。过了 resetsAt 的窗口已经重置：0%、没有重置时间、不标快用完。 */
function windowUsage(key: QuotaWindowKey, window: RateLimitWindow, now: number, warningStatus: string | undefined): QuotaWindowUsage {
  const { label, short } = QUOTA_WINDOWS[key];
  if (isReset(window.resetsAt, now)) return { key, label, short, percent: 0, resetsAt: null, warning: false };
  const percent = Math.round(Math.min(1, Math.max(0, window.utilization)) * 100);
  return {
    key,
    label,
    short,
    percent,
    resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
    warning: window.status === warningStatus || percent >= QUOTA_WARNING_PERCENT,
  };
}

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
 * m3-plan 2.7：每个会话每一轮都有额度事件（Claude 的 rate_limit_event、codex 的 account/rateLimits/updated）。
 * 每家厂商只看自己的会话（各家的窗口长度、重置时间不通用，混着挑会把别家的时间显示到这家头上）；每个窗口取最新的那个值（newerWindow）；没有数据的窗口、厂商不返回。
 * 值不是有限的数就当没有；超出 0 到 1 的夹到边上。
 * 过了 resetsAt 的窗口已经重置：显示 0%、没有重置时间、不标快用完（新窗口的数据要等下一条事件才来）；不是已用完。
 * now 是毫秒；网页用 useRerenderAt 在每个重置时间点重新渲染，所以页面不动也会变。
 */
export function quotaUsage(state: HubState, now: number = Date.now()): QuotaVendor[] {
  const vendors: QuotaVendor[] = [];
  for (const spec of QUOTA_VENDORS) {
    const windows: QuotaWindowUsage[] = [];
    const sessions = state.sessions.filter((s) => (s.vendor ?? DEFAULT_AGENT_VENDOR) === spec.id);
    for (const key of spec.windows) {
      const { label, short } = QUOTA_WINDOWS[key];
      let best: SessionState | null = null;
      for (const s of sessions) {
        const w = s.rateLimit?.windows[key];
        if (w !== undefined && Number.isFinite(w.utilization) && newerWindow(s, best, key)) best = s;
      }
      const window = best?.rateLimit?.windows[key];
      if (window === undefined) continue;
      windows.push(windowUsage(key, window, now, spec.warningStatus));
    }
    if (windows.length === 0) continue;
    let latest: SessionState | null = null;
    for (const s of sessions) if (s.rateLimit !== null && newerSession(s, latest)) latest = s;
    vendors.push({ id: spec.id, name: spec.name, windows, exhausted: isQuotaExhausted(latest?.rateLimit, now) });
  }
  return vendors;
}

/**
 * 服务端按需查来的额度（GET /api/quota，事件流里没有额度的厂商，shared/vendors.ts 的 quota.fetched）→ 浮层里的块：
 * 每一组一块（“厂商名 · 组名”），窗口按 QUOTA_WINDOWS 的顺序；认不出的组跳过。
 */
export function fetchedQuotaUsage(res: QuotaResponse, now: number = Date.now()): QuotaVendor[] {
  const blocks: QuotaVendor[] = [];
  for (const id of AGENT_VENDORS) {
    const quota = VENDOR_SPECS[id].quota;
    if (quota?.fetched === undefined) continue;
    for (const group of res.groups) {
      if (!quota.fetched.groups.some((g) => g.key === group.id)) continue;
      const windows = (Object.keys(QUOTA_WINDOWS) as QuotaWindowKey[]).flatMap((key) => {
        const window = group.windows[key];
        return window === undefined || !Number.isFinite(window.utilization) ? [] : [windowUsage(key, window, now, undefined)];
      });
      if (windows.length > 0) blocks.push({ id: group.id, name: `${quota.name} · ${group.name}`, windows, exhausted: false });
    }
  }
  return blocks;
}

/** 有会话用着“额度要按需查”的厂商：左下角的额度按钮要在，用户才打得开面板。 */
export function hasFetchedQuotaSession(state: HubState): boolean {
  return state.sessions.some((s) => {
    const vendor = s.vendor ?? DEFAULT_AGENT_VENDOR;
    return isAgentVendor(vendor) && VENDOR_SPECS[vendor].quota?.fetched !== undefined;
  });
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

/** 这个项目经理的会话里有“已收工”“建 worktree 失败”那一行的 Worker 对话，值是那一行的时间（有几行取最晚的）。 */
function endedByLine(state: HubState, pmId: PmId | null): Map<ConversationId, number> {
  const ended = new Map<ConversationId, number>();
  for (const { conversation, messages } of Object.values(state.conversations)) {
    if (conversation.kind === "worker" || conversation.pmId !== pmId) continue;
    for (const message of messages) {
      const meta = workerEventOf(message);
      if (meta && (meta.event === "ended" || meta.event === "worktree_failed")) {
        ended.set(meta.workerConversationId, Math.max(ended.get(meta.workerConversationId) ?? 0, message.createdAt));
      }
    }
  }
  return ended;
}

function phaseOf(state: HubState, workerConversationId: ConversationId, endedLines: Map<ConversationId, number>): WorkerPhase {
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
  /** 累计用量和当前对话长度（context，老服务端没带当 0）。 */
  usage: TokenUsage;
  /** 项目经理会话里这个 Worker 最近一行汇报的状态色（worker-status.ts）；没有汇报是 neutral。 */
  tone: WorkerTone;
}

/** 每个 Worker 最近一行汇报的状态色（和项目经理对话里的汇报气泡同一个 workerStatusOf）。 */
function latestTones(state: HubState, pmId: PmId): Map<ConversationId, WorkerTone> {
  const tones = new Map<ConversationId, WorkerTone>();
  for (const { conversation, messages } of Object.values(state.conversations)) {
    if (conversation.kind === "worker" || conversation.pmId !== pmId) continue;
    for (const message of messages) {
      const meta = workerEventOf(message);
      if (meta) tones.set(meta.workerConversationId, workerStatusOf(meta).tone);
    }
  }
  return tones;
}

/** 这个项目经理派的 Worker：进行中的在前，收工的在后；进行中的按派出的顺序（对话编号），收工的最近收工的在前（没有收工那一行的按对话编号倒序，排在有的后面）。 */
export function workersOf(state: HubState, pmId: PmId): WorkerEntry[] {
  const endedLines = endedByLine(state, pmId);
  const tones = latestTones(state, pmId);
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
        tone: tones.get(conversation.id) ?? "neutral",
      };
    })
    .toSorted((a, b) => {
      if (a.ended !== b.ended) return Number(a.ended) - Number(b.ended);
      if (!a.ended) return a.conversationId - b.conversationId;
      const at = endedLines.get(a.conversationId);
      const bt = endedLines.get(b.conversationId);
      if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
      if ((at === undefined) !== (bt === undefined)) return at === undefined ? 1 : -1;
      return b.conversationId - a.conversationId;
    });
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
 * 换新会话那一轮不算（交接请求在路上、写交接时会话在忙，按 visibleSessionOf 的口径）：不然换一次会话，
 * 对话会先退出“等你”再回来，同一条没看的回复又弹一次通知。
 */
export function waitingConversations(state: HubState, lastSeen: LastSeen): ConversationId[] {
  return Object.values(state.conversations)
    .filter(({ conversation, messages }) => {
      if (conversation.kind === "worker") return false;
      const last = messages.findLast((m) => !isQuietMessage(m));
      if (!last || last.sender === "user" || last.createdAt <= (lastSeen[conversation.id] ?? 0)) return false;
      if (messages.some((m) => m.status !== null && IN_FLIGHT.has(m.status) && !isHandoverTraffic(m))) return false;
      if (pendingOf(state, conversation.id).some((p) => p.phase === "sending")) return false;
      if ((visibleSessionOf(state, conversation.id)?.activity ?? "idle") !== "idle") return false;
      return conversation.pmId === null || runningWorkerCount(state, conversation.pmId) === 0;
    })
    .map(({ conversation }) => conversation.id);
}

/**
 * 对话里还在等用户确定的 hub ask（M5）：守护进程还没标成已回答（meta.answered，用户在这个对话里发了消息就标上，
 * 见 ledger/messages.ts）。用户刚发出、服务端还没确认的消息也先当回答了，不等推送。从老到新。
 */
export function pendingAsks(state: HubState, conversationId: ConversationId): Message[] {
  const view = state.conversations[conversationId];
  if (!view || pendingOf(state, conversationId).some((p) => p.phase !== "failed")) return [];
  return view.messages.filter((m) => {
    const meta = askOf(m);
    return meta !== null && meta.answered !== true;
  });
}

export function pendingOf(state: HubState, conversationId: ConversationId): PendingMessage[] {
  return state.pending.filter((p) => p.conversationId === conversationId);
}

/**
 * 这个对话在换新会话（资料页的“开新会话”按钮不能点）：交接请求还没结果（排队、已送达、处理中）。
 * 和账本的 waitsForHandover 同一个口径（ledger/handover.ts）。
 */
export function isRenewing(state: HubState, conversationId: ConversationId): boolean {
  return renewingIn(state.conversations[conversationId]?.messages ?? []);
}

function renewingIn(messages: Message[]): boolean {
  return messages.some((m) => systemEventOf(m)?.event === "handover.requested" && m.status !== null && IN_FLIGHT.has(m.status));
}

/**
 * 网页显示用的会话状态（状态行、停止键）：写交接那一轮不给用户看，当空闲；那期间有交给项目经理的话在等（用户的、Worker 汇报），
 * 显示成在想（Thinking…），和平时它马上开始处理一样，换完代就真的开始处理。
 */
export function visibleSessionOf(state: HubState, conversationId: ConversationId): SessionState | null {
  const session = sessionOf(state, conversationId);
  const messages = state.conversations[conversationId]?.messages ?? [];
  if (session === null || !inHandoverTurn(messages, session.sessionId)) return session;
  const waiting =
    messages.some((m) => m.status === "queued" && !isHandoverTraffic(m)) || pendingOf(state, conversationId).some((p) => p.phase === "sending");
  const quiet = { currentTool: null, apiRetry: null };
  return waiting ? { ...session, ...quiet, activity: "working", step: { type: "thinking" } } : { ...session, ...quiet, activity: "idle", step: null };
}

/**
 * 会话现在的状态属于写交接那一轮：交接请求还没结果；或者交给这个会话的最后一条就是交接请求（那一轮刚结束，
 * 账本一条一条推变化，交接请求先变成已回复、会话后变空闲，中间这一下也算）。
 */
function inHandoverTurn(messages: Message[], sessionId: SessionId): boolean {
  if (renewingIn(messages)) return true;
  const last = messages.findLast((m) => m.sessionId === sessionId && m.status !== null);
  return last !== undefined && systemEventOf(last)?.event === "handover.requested";
}

/** 网页显示用的消息：写交接期间压着的用户消息不显示“排队中”（马上就交给新会话），和平时一轮中途交给 agent 的一样。 */
export function visibleMessages(messages: Message[]): Message[] {
  if (!renewingIn(messages)) return messages;
  return messages.map((m) => (m.sender === "user" && m.status === "queued" ? { ...m, status: "delivered" } : m));
}

/** 有错误的健康项（成功一次后 lastError 会被清成 null）。 */
export function failingHealth(state: HubState): HealthEntry[] {
  return state.health.filter((h) => h.lastError !== null);
}

/**
 * 消息流里的一项（docs/ui-standard.md 第 17 条）：
 * - message：单独显示的一条：用户的话、Worker 对话里项目经理的话、Worker 的汇报、到点的定时任务、很淡的系统行；
 * - turn：agent 的一轮回复，只出一个头像。work 是这一轮的操作（工具调用、派出 / 收工 Worker、建删定时任务），合成一行
 *   “Worked for …”；parts 是按顺序要显示的文字和夹在中间的系统行。startedAt / endedAt 算用时，都是已有的时间戳。
 */
export type RenderItem =
  | { kind: "message"; message: Message }
  | { kind: "turn"; key: string; work: Message[]; parts: Message[]; startedAt: number; endedAt: number };

/** 一条消息在消息流里算什么。 */
type FlowRole =
  /** 交给 agent 的一句（一轮的开头）：用户、项目经理（Worker 对话里）、Worker 的汇报和用户对它说的话、到点的定时任务。 */
  | "input"
  /** 换新会话的分隔线：前后的回合各归各的，单独一行；不算交给 agent 的话。 */
  | "divider"
  /** agent 自己说的、调的工具：在一轮里。 */
  | "agent"
  /** agent 这一轮的操作结果（派出 / 收工 Worker、建删定时任务）：在一轮里就收进 Worked for，不在就单独显示。 */
  | "work"
  /** 别的系统行：在一轮中间就留在原位置，不另起头像。 */
  | "notice";

const INPUT_WORKER_EVENTS: ReadonlySet<WorkerMessageMeta["event"]> = new Set(["report", "turn_failed", "worktree_failed", "user_message"]);
const INPUT_SYSTEM_EVENTS: ReadonlySet<string> = new Set(["schedule.run"]);
const WORK_SYSTEM_EVENTS: ReadonlySet<string> = new Set(["schedule.created", "schedule.removed"]);

function flowRole(message: Message): FlowRole {
  const line = workerEventOf(message);
  if (line) return INPUT_WORKER_EVENTS.has(line.event) ? "input" : "work";
  if (message.sender === "user" || message.sender === "pm") return "input";
  if (message.sender === "agent") return "agent";
  const event = systemEventOf(message)?.event;
  if (event === "session.renewed") return "divider";
  if (event !== undefined && INPUT_SYSTEM_EVENTS.has(event)) return "input";
  if (event !== undefined && WORK_SYSTEM_EVENTS.has(event)) return "work";
  return "notice";
}

/**
 * 换新会话：写交接的来往不显示；分隔线挪到写交接开始的地方（turnStartId 之后第一条的前面），换代期间来的话排在它下面。
 * 交接请求还在排队时就来了、压着等到换代才交给新会话的（Worker 汇报、用户的话），编号比 turnStartId 小，也挪到分隔线下面，
 * 和实际处理它的会话对上。
 */
function placeHandovers(all: Message[]): Message[] {
  const shown = all.filter((m) => !isHandoverTraffic(m));
  const dividers = shown.filter((m) => systemEventOf(m)?.event === "session.renewed");
  if (dividers.length === 0) return shown;
  let rest = shown.filter((m) => !dividers.includes(m));
  for (const divider of dividers) {
    const { sessionId, turnStartId } = divider.meta as { sessionId: number; turnStartId?: number };
    const after = turnStartId ?? divider.id;
    const held = rest.filter((m) => m.id <= after && m.sessionId === sessionId);
    rest = rest.filter((m) => !held.includes(m));
    const at = rest.findIndex((m) => m.id > after && systemEventOf(m)?.event !== "session.renewed");
    rest.splice(at === -1 ? rest.length : at, 0, divider, ...held);
  }
  return rest;
}

/** 把消息分成一轮一轮：一轮从 agent 的第一条说的或调的工具开始，到下一句交给它的话为止。 */
export function groupMessages(all: Message[]): RenderItem[] {
  const messages = placeHandovers(all);
  const items: RenderItem[] = [];
  let turn: Extract<RenderItem, { kind: "turn" }> | null = null;
  /** 上一句交给 agent 的话、上一条 agent 的东西的时间：新一轮从两者里晚的那个算起。 */
  let lastInputAt: number | null = null;
  let lastAgentAt: number | null = null;

  /** 一轮结束：末尾的系统行不算这一轮的，挪到它后面单独显示。 */
  const close = () => {
    if (turn === null) return;
    const trailing: Message[] = [];
    while (turn.parts.length > 0 && turn.parts.at(-1)!.sender !== "agent") trailing.unshift(turn.parts.pop()!);
    for (const message of trailing) items.push({ kind: "message", message });
    turn = null;
  };

  for (const message of messages) {
    const role = flowRole(message);
    if (role === "divider") {
      close();
      items.push({ kind: "message", message });
      continue;
    }
    if (role === "input") {
      close();
      items.push({ kind: "message", message });
      lastInputAt = message.createdAt;
      continue;
    }
    if (role === "agent" && turn === null) {
      const starts = [lastInputAt, lastAgentAt].filter((t): t is number => t !== null);
      turn = { kind: "turn", key: `turn-${message.id}`, work: [], parts: [], startedAt: starts.length > 0 ? Math.max(...starts) : message.createdAt, endedAt: message.createdAt };
      items.push(turn);
    }
    if (turn === null) {
      items.push({ kind: "message", message });
      continue;
    }
    if (role === "notice") {
      turn.parts.push(message);
      continue;
    }
    if (message.kind === "tool" || role === "work") turn.work.push(message);
    else turn.parts.push(message);
    turn.endedAt = message.createdAt;
    lastAgentAt = message.createdAt;
  }
  close();
  return items;
}
