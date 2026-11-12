// 从 HubState 算出界面要用的东西。提醒规则（等你、等你确定）在 shared/reminders.ts，和守护进程的推送共用，这里转出去。
export {
  askingConversations,
  pendingAsks,
  routerReminderSummary,
  runningWorkerCount,
  sessionOf,
  unreadRouterReports,
  visibleSessionOf,
  waitingConversations,
  type LastSeen,
  type RouterReminderSummary,
} from "../shared/reminders.ts";
import {
  VENDOR_LIST,
  askOf,
  DEFAULT_AGENT_VENDOR,
  QUOTA_WINDOWS,
  VENDOR_FAILURE_SIGNS,
  EMPTY_TOKEN_USAGE,
  TASK_GRAPH_SELECTOR_CACHE_MAX,
  attachmentsOf,
  exhaustRateLimitInfo,
  isHandoverTraffic,
  isRewoundMessage,
  isSilentTriggerMessage,
  isAgentVendor,
  vendorSpec,
  isQuotaExhausted,
  pendingDecisionsOf as devicePendingDecisionsOf,
  isTaskNodeWaitingPm,
  isTaskNodeWaitingUser,
  systemEventOf,
  systemNoticeText,
  workerEventOf,
  isWorkerEndLine,
  type AgentVendor,
  type ConversationId,
  type HealthEntry,
  type Message,
  type MessageId,
  type PendingDecision,
  type TokenUsage,
  type Pm,
  type PmId,
  type Project,
  type ProjectId,
  type QuotaResponse,
  type QuotaWindowKey,
  type RateLimitInfo,
  type RateLimitWindow,
  type ProjectFolder,
  type SessionId,
  type SessionState,
  type TaskGraph,
  type WorkerId,
  type WorkerMessageMeta,
} from "../shared/index.ts";
import { computeGateImpact } from "../shared/decisions.ts";
import {
  isQuietMessage,
  renewingIn,
  routerReminderSummary,
  runningWorkerCount,
  sessionOf,
  type RouterReminderSummary,
} from "../shared/reminders.ts";
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

/** 预览用最后一条文字消息；一条文字都没有就用最后一条。换新会话的那几条不算。 */
function previewMessage(messages: Message[]): Message | null {
  let fallback: Message | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isQuietMessage(m)) continue;
    fallback ??= m;
    if (m.kind === "text") return m;
  }
  return fallback;
}

/** listConversations 的结果按 conversations 这个对象记着；pms、projects、folders 也是同一份才算命中。 */
const conversationListCache = new WeakMap<
  HubState["conversations"],
  { pms: HubState["pms"]; projects: HubState["projects"]; folders: HubState["folders"]; entries: ConversationEntry[] }
>();

/**
 * 左栏的对话，按最后一条消息的时间从新到旧；没有消息的按创建时间。Worker 的对话不在左栏，点项目经理会话里那一行打开。
 * 用到的几份数据都没变时返回上次那个数组（App 每次渲染都给别的设备调一次，通知也调）。
 */
export function listConversations(state: HubState): ConversationEntry[] {
  const hit = conversationListCache.get(state.conversations);
  if (hit !== undefined && hit.pms === state.pms && hit.projects === state.projects && hit.folders === state.folders) return hit.entries;
  const entries = computeConversationList(state);
  conversationListCache.set(state.conversations, { pms: state.pms, projects: state.projects, folders: state.folders, entries });
  return entries;
}

function computeConversationList(state: HubState): ConversationEntry[] {
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

const previewTextCache = new WeakMap<Message, string>();

/** agent 的消息是 Markdown，预览去掉符号；用户和系统消息本来就是纯文本。左栏的预览和通知的正文都用它。 */
export function previewText(entry: ConversationEntry): string {
  const last = entry.lastMessage;
  if (!last) return "";
  const cached = previewTextCache.get(last);
  if (cached !== undefined) return cached;
  // 只发了文件没写字（或文字已回退）的用户消息：写文件名
  const files = attachmentsOf(last);
  let result: string;
  if ((last.text.trim() === "" || isRewoundMessage(last)) && files.length > 0) result = `[File] ${files.map((f) => f.name).join(", ")}`;
  // 系统消息和对话里显示的一样（开新会话那两条的原文是发给 agent 的全文）
  else if (last.sender === "system") result = systemNoticeText(last);
  else result = last.sender === "agent" ? stripMarkdown(last.text) : last.text;
  previewTextCache.set(last, result);
  return result;
}

/** 额度用完了（只有 rejected；allowed_warning 只是快到了，照常干活）；已经过了 resetsAt 的不算，Claude 要等下一条事件才会更新它。 */
export function isWaitingForQuota(session: SessionState | null, now: number = Date.now()): boolean {
  return isQuotaExhausted(session?.rateLimit, now);
}

/** 额度已用到这个百分比（含）就算快用完；Claude 自己报 allowed_warning 也算。 */
const QUOTA_WARNING_PERCENT = 80;

/** 有额度数据的厂商（各家 spec 的 quota）；加厂商只在那里写。 */
const QUOTA_VENDORS = VENDOR_LIST.flatMap(({ id, quota }) => (quota === undefined ? [] : [{ id, ...quota }]));

export interface QuotaWindowUsage {
  key: string;
  /** 窗口名（5h、7d），左下角按钮和浮层共用。 */
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
  /** 厂商下的模型族（按需查的 agy 分 Gemini、Claude and GPT 两组）；整家厂商一块的不写。 */
  group?: string;
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
  const { short } = QUOTA_WINDOWS[key];
  if (isReset(window.resetsAt, now)) return { key, short, percent: 0, resetsAt: null, warning: false };
  const percent = Math.round(Math.min(1, Math.max(0, window.utilization)) * 100);
  return {
    key,
    short,
    percent,
    resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
    warning: window.status === warningStatus || percent >= QUOTA_WARNING_PERCENT,
  };
}

/** Unix 秒时间戳的下界（2001-09-09），用来区分真实时间戳和单测里的 1、7、100 等小序号。 */
const REAL_EPOCH_SEC = 1_000_000_000;
/** 窗口重置时间距事件时间 / 当前时间的最大容差（1 小时，防时钟微偏）。 */
const WINDOW_DURATION_TOLERANCE_SEC = 3600;

/**
 * 校验窗口数据是否合法：
 * - utilization 必须是有限数；
 * - 当 resetsAt 与参考时间（lastEventAt 或 now）都是真实 Unix 时间戳时，resetsAt 距参考时间的跨度不能超过该窗口自身的时长
 *   （例如 PR #170 之前把 30 天窗口的 resetsAt 1796193546 误写进 five_hour，跨度达 592 小时，远超 5 小时上限）。
 */
function isValidQuotaWindow(key: QuotaWindowKey, w: RateLimitWindow | undefined, lastEventAt: number | null, nowMs: number): w is RateLimitWindow {
  if (w === undefined || !Number.isFinite(w.utilization)) return false;
  if (Number.isFinite(w.resetsAt) && w.resetsAt >= REAL_EPOCH_SEC) {
    const maxSpanSec = QUOTA_WINDOWS[key].durationMins * 60 + WINDOW_DURATION_TOLERANCE_SEC;
    if (lastEventAt !== null && lastEventAt >= REAL_EPOCH_SEC * 1000 && w.resetsAt - lastEventAt / 1000 > maxSpanSec) {
      return false;
    }
    if (nowMs >= REAL_EPOCH_SEC * 1000 && w.resetsAt - nowMs / 1000 > maxSpanSec) {
      return false;
    }
  }
  return true;
}

/**
 * 查找该会话最近一次因额度耗尽（匹配厂商 quota 特征）而 turn_failed / failed 的毫秒时间戳：
 * - 若会话所在对话的最后一条失败消息属于该会话且匹配 quota，取其 updatedAt；
 * - 若会话是 Worker 对话，且其所属项目经理对话里该 Worker 的最新一行是 turn_failed 且匹配 quota，取该行的 createdAt。
 */
function sessionQuotaFailureAt(state: HubState, session: SessionState, vendor: AgentVendor): number | null {
  if (session.conversationId === null) return null;
  const quotaPattern = VENDOR_FAILURE_SIGNS[vendor].quota;
  const convView = state.conversations[session.conversationId];
  if (convView) {
    for (let i = convView.messages.length - 1; i >= 0; i--) {
      const m = convView.messages[i]!;
      if (m.sessionId === session.sessionId && m.status === "failed" && typeof m.failureReason === "string" && quotaPattern.test(m.failureReason)) {
        return m.updatedAt;
      }
    }
    if (convView.conversation.kind === "worker" && convView.conversation.pmId !== null) {
      const latest = workerLinesOf(state, convView.conversation.pmId).latest.get(session.conversationId);
      const line = latest?.line;
      if (line?.event === "turn_failed" && typeof line.summary === "string" && quotaPattern.test(line.summary)) return latest!.at;
    }
  }
  return null;
}

/** 过滤掉跨度超出窗口自身时长的脏窗口（仅看 rateLimit 自身，O(1)）。 */
function sanitizeSessionWindows(
  session: SessionState,
  allowedKeys: readonly QuotaWindowKey[],
  now: number,
): SessionState {
  if (session.rateLimit === null) return session;
  const validWindows: Record<string, RateLimitWindow> = {};
  for (const key of allowedKeys) {
    const w = session.rateLimit.windows[key];
    if (isValidQuotaWindow(key, w, session.lastEventAt, now)) {
      validWindows[key] = w;
    }
  }
  return {
    ...session,
    rateLimit: { ...session.rateLimit, windows: validWindows },
  };
}

/** 若该会话在当前窗口周期内因额度耗尽失败（且尚未标 rejected），用 exhaustRateLimitInfo 将耗尽窗口规整为 100% rejected。 */
function applySessionQuotaFailure(state: HubState, session: SessionState, vendor: AgentVendor): SessionState {
  const rateLimit = session.rateLimit;
  if (rateLimit === null || rateLimit.status === "rejected" || Object.keys(rateLimit.windows).length === 0) return session;
  const failedAt = sessionQuotaFailureAt(state, session, vendor);
  if (failedAt === null) return session;
  const exhausted = exhaustRateLimitInfo(rateLimit);
  const targetEntry = (Object.entries(exhausted.windows) as [QuotaWindowKey, RateLimitWindow][]).find(
    ([k, w]) => w.status === "rejected" && rateLimit.windows[k]?.status !== "rejected",
  );
  if (!targetEntry) return session;
  const [targetKey, targetWin] = targetEntry;
  const durationSec = QUOTA_WINDOWS[targetKey].durationMins * 60;
  const failedSec = failedAt / 1000;
  if (targetWin.resetsAt > 0 && failedSec >= targetWin.resetsAt - durationSec && failedSec <= targetWin.resetsAt) {
    return { ...session, rateLimit: exhausted };
  }
  return session;
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

const quotaUsageCache = new WeakMap<
  HubState["conversations"],
  WeakMap<HubState["sessions"], { json: string; value: QuotaVendor[] }>
>();
/** 上一次算出的额度数组（仅保留最新 1 份）：sessions 因流式文字等无关字段换引用时，额度结果相同直接复用同一引用。 */
let lastQuotaUsage: { json: string; value: QuotaVendor[] } | null = null;

/**
 * m3-plan 2.7：每个会话每一轮都有额度事件（Claude 的 rate_limit_event、codex 的 account/rateLimits/updated）。
 * 每家厂商只看自己的会话（各家的窗口长度、重置时间不通用，混着挑会把别家的时间显示到这家头上）；
 * 窗口集合以该厂商最新一个有合法窗口的会话为准（例如从 free 套餐的 30 天切到 plus 套餐的 5 小时 + 7 天后，不再把旧套餐残留的 30 天拼进来）；
 * 每个当前有效窗口取最新的那个值（newerWindow）；没有数据的窗口、厂商不返回。
 * 值不是有限的数就当没有；超出 0 到 1 的夹到边上。
 * 过了 resetsAt 的窗口已经重置：显示 0%、没有重置时间、不标快用完（新窗口的数据要等下一条事件才来）；不是已用完。
 * now 是毫秒；网页用 useRerenderAt 在每个重置时间点重新渲染，所以页面不动也会变。
 */
export function quotaUsage(state: HubState, now: number = Date.now()): QuotaVendor[] {
  const vendors: QuotaVendor[] = [];
  for (const spec of QUOTA_VENDORS) {
    const windows: QuotaWindowUsage[] = [];
    const pickedRawWindows: RateLimitWindow[] = [];
    const sessions = state.sessions
      .filter((s) => (s.vendor ?? DEFAULT_AGENT_VENDOR) === spec.id)
      .map((s) => sanitizeSessionWindows(s, spec.windows, now));
    let latestIdx = -1;
    let latestWithWindows: SessionState | null = null;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      if (s.rateLimit !== null && Object.keys(s.rateLimit.windows).length > 0 && newerSession(s, latestWithWindows)) {
        latestWithWindows = s;
        latestIdx = i;
      }
    }
    if (latestWithWindows === null) continue;
    latestWithWindows = applySessionQuotaFailure(state, latestWithWindows, spec.id);
    sessions[latestIdx] = latestWithWindows;
    const activeKeys = spec.windows.filter((key) => latestWithWindows!.rateLimit!.windows[key] !== undefined);
    for (const key of activeKeys) {
      let best: SessionState | null = null;
      for (const s of sessions) {
        const w = s.rateLimit?.windows[key];
        if (w !== undefined && Number.isFinite(w.utilization) && newerWindow(s, best, key)) best = s;
      }
      const window = best?.rateLimit?.windows[key];
      if (window === undefined) continue;
      pickedRawWindows.push(window);
      windows.push(windowUsage(key, window, now, spec.warningStatus));
    }
    if (windows.length === 0) continue;
    let latest: SessionState | null = null;
    for (const s of sessions) if (s.rateLimit !== null && newerSession(s, latest)) latest = s;
    const exhausted =
      isQuotaExhausted(latest?.rateLimit, now) || pickedRawWindows.some((w) => !isReset(w.resetsAt, now) && w.status === "rejected");
    vendors.push({ id: spec.id, name: spec.name, windows, exhausted });
  }
  const json = JSON.stringify(vendors);
  let bySessions = quotaUsageCache.get(state.conversations);
  if (bySessions === undefined) {
    bySessions = new WeakMap();
    quotaUsageCache.set(state.conversations, bySessions);
  }
  const prev = bySessions.get(state.sessions);
  if (prev !== undefined && prev.json === json) return prev.value;
  const value = lastQuotaUsage !== null && lastQuotaUsage.json === json ? lastQuotaUsage.value : vendors;
  lastQuotaUsage = { json, value };
  bySessions.set(state.sessions, lastQuotaUsage);
  return value;
}

/** 旧后台的组不带 vendor：按组 id 找声明了它的那家，只认唯一归属的（以后两家同名组时不串额度）。 */
function legacyFetchedQuota(id: string): (typeof QUOTA_VENDORS)[number] | undefined {
  const owners = QUOTA_VENDORS.filter((v) => v.fetched?.groups.some((g) => g.key === id));
  return owners.length === 1 ? owners[0] : undefined;
}

/**
 * 服务端按需查来的额度（GET /api/quota，事件流里没有额度的厂商，各家 spec 的 quota.fetched；几家合在一个响应里，每组带 vendor）→ 浮层里的块：
 * 每一组一块（name 是厂商名，group 是组名，都按 vendor + 组的 id 从 spec 取），窗口按 QUOTA_WINDOWS 的顺序；认不出的厂商、组跳过。
 */
export function fetchedQuotaUsage(res: QuotaResponse, now: number = Date.now()): QuotaVendor[] {
  const blocks: QuotaVendor[] = [];
  for (const group of res.groups) {
    const quota = group.vendor === undefined ? legacyFetchedQuota(group.id) : isAgentVendor(group.vendor) ? vendorSpec(group.vendor).quota : undefined;
    const spec = quota?.fetched?.groups.find((g) => g.key === group.id);
    if (quota === undefined || spec === undefined) continue;
    const windows = (Object.keys(QUOTA_WINDOWS) as QuotaWindowKey[]).flatMap((key) => {
      const window = group.windows[key];
      return window === undefined || !Number.isFinite(window.utilization) ? [] : [windowUsage(key, window, now, undefined)];
    });
    if (windows.length > 0) blocks.push({ id: group.id, name: quota.name, group: spec.name, windows, exhausted: windows.some((w) => w.percent >= 100) });
  }
  return blocks;
}

/** 有会话用着“额度要按需查”的厂商：左下角的额度按钮要在，用户才打得开面板。 */
export function hasFetchedQuotaSession(state: HubState): boolean {
  return state.sessions.some((s) => {
    const vendor = s.vendor ?? DEFAULT_AGENT_VENDOR;
    return isAgentVendor(vendor) && vendorSpec(vendor).quota?.fetched !== undefined;
  });
}

const quotaResetTimesCache = new WeakMap<HubState["sessions"], number[]>();
const NO_RESET_TIMES: number[] = [];
let lastQuotaResetTimes: number[] = NO_RESET_TIMES;

/**
 * 所有会话额度里的重置时间点（毫秒，去重、从早到晚）：窗口的 resetsAt 和整体的 resetsAt。
 * 页面到了这些时间点要重新渲染一次，已重置的窗口才会变成 0%。输入结果相同时复用同一数组引用。
 */
export function quotaResetTimes(state: HubState): number[] {
  const hit = quotaResetTimesCache.get(state.sessions);
  if (hit !== undefined) return hit;
  const times = new Set<number>();
  for (const { rateLimit } of state.sessions) {
    if (rateLimit === null) continue;
    for (const w of Object.values(rateLimit.windows)) if (Number.isFinite(w.resetsAt) && w.resetsAt > 0) times.add(w.resetsAt * 1000);
    if (rateLimit.resetsAt !== null && Number.isFinite(rateLimit.resetsAt) && rateLimit.resetsAt > 0) times.add(rateLimit.resetsAt * 1000);
  }
  const sorted = times.size === 0 ? NO_RESET_TIMES : [...times].sort((a, b) => a - b);
  const value =
    sorted.length === lastQuotaResetTimes.length && sorted.every((t, i) => t === lastQuotaResetTimes[i])
      ? lastQuotaResetTimes
      : sorted;
  lastQuotaResetTimes = value;
  quotaResetTimesCache.set(state.sessions, value);
  return value;
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

interface WorkerLine {
  /** 那一行的消息编号（比新旧用）、时间、内容。 */
  id: MessageId;
  at: number;
  line: WorkerMessageMeta;
}

interface WorkerLineIndex {
  /** 每个 Worker 对话最近一行。 */
  latest: ReadonlyMap<ConversationId, WorkerLine>;
  /** 有“已收工”“建 worktree 失败”那一行的 Worker 对话，值是那一行的时间（有几行取最晚的）。 */
  endedAt: ReadonlyMap<ConversationId, number>;
}

const pmWorkerIndexCache = new WeakMap<readonly Message[], WorkerLineIndex>();

/** 一段项目经理对话里的 Worker 行（按消息数组缓存）。 */
function pmWorkerIndexOf(messages: readonly Message[]): WorkerLineIndex {
  let cached = pmWorkerIndexCache.get(messages);
  if (cached !== undefined) return cached;
  const latest = new Map<ConversationId, WorkerLine>();
  const endedAt = new Map<ConversationId, number>();
  for (const message of messages) {
    const line = workerEventOf(message);
    if (!line) continue;
    latest.set(line.workerConversationId, { id: message.id, at: message.createdAt, line });
    if (isWorkerEndLine(line)) endedAt.set(line.workerConversationId, Math.max(endedAt.get(line.workerConversationId) ?? 0, message.createdAt));
  }
  cached = { latest, endedAt };
  pmWorkerIndexCache.set(messages, cached);
  return cached;
}

const workerLinesCache = new WeakMap<HubState["conversations"], Map<PmId, WorkerLineIndex>>();

/**
 * 这个项目经理派的 Worker 各自最近一行、收工时间：初始快照只带项目经理对话最近几条，早的行在每个 Worker 对话的摘要里
 * （ConversationView.workerLine，账本按 shared/snapshot.ts 算的）；项目经理对话里带着的、实时来的行编号更大就盖掉摘要。
 * conversations 没变时返回上次那一份。
 */
function workerLinesOf(state: HubState, pmId: PmId): WorkerLineIndex {
  let byPm = workerLinesCache.get(state.conversations);
  if (byPm === undefined) {
    byPm = new Map();
    workerLinesCache.set(state.conversations, byPm);
  }
  const hit = byPm.get(pmId);
  if (hit !== undefined) return hit;
  const latest = new Map<ConversationId, WorkerLine>();
  const endedAt = new Map<ConversationId, number>();
  const views = Object.values(state.conversations).filter((v) => v.conversation.pmId === pmId);
  for (const { conversation, workerLine } of views) {
    if (conversation.kind !== "worker" || workerLine === undefined) continue;
    latest.set(conversation.id, { id: workerLine.messageId, at: workerLine.at, line: workerLine.line });
    if (workerLine.endedAt !== null) endedAt.set(conversation.id, workerLine.endedAt);
  }
  for (const { conversation, messages } of views) {
    if (conversation.kind === "worker") continue;
    const index = pmWorkerIndexOf(messages);
    for (const [id, line] of index.latest) {
      if ((latest.get(id)?.id ?? -1) <= line.id) latest.set(id, line);
    }
    for (const [id, at] of index.endedAt) endedAt.set(id, Math.max(endedAt.get(id) ?? 0, at));
  }
  const result = { latest, endedAt };
  byPm.set(pmId, result);
  return result;
}

const NO_ENDED: ReadonlyMap<ConversationId, number> = new Map();

/** 最近一行汇报的状态色（和项目经理对话里的汇报气泡同一个 workerStatusOf）；没有汇报是 neutral。 */
const toneOf = (latest: WorkerLine | undefined): WorkerTone => (latest === undefined ? "neutral" : workerStatusOf(latest.line).tone);

function phaseOf(
  state: HubState,
  workerConversationId: ConversationId,
  endedLines: ReadonlyMap<ConversationId, number>,
  session: SessionState | null = sessionOf(state, workerConversationId),
): WorkerPhase {
  const view = state.conversations[workerConversationId];
  if (endedLines.has(workerConversationId) || session?.status === "ended" || view?.conversation.purgedAt !== undefined) return "ended";
  // 正在跑项目的准备命令（PR #47，会话 activity 是 preparing）
  if (session?.activity === "preparing") return "preparing";
  // 第一条是任务说明（翻页翻掉了说明早就发过了）
  const task = view?.hasMore === false ? view.messages[0] : undefined;
  return task?.sender === "pm" && task.status === "queued" ? "preparing" : "open";
}

export function workerPhaseOf(state: HubState, workerConversationId: ConversationId): WorkerPhase {
  const pmId = state.conversations[workerConversationId]?.conversation.pmId ?? null;
  return phaseOf(state, workerConversationId, pmId === null ? NO_ENDED : workerLinesOf(state, pmId).endedAt);
}

export interface WorkerEntry {
  conversationId: ConversationId;
  /** Worker 记录编号（来自项目经理对话 Worker 汇报行）；测试直接构造简版对象时可省。 */
  workerId?: WorkerId;
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

/** workersOf 的结果：conversations → sessions → 项目经理编号。两份都没变才命中，换了的那份连同结果一起被回收。 */
const workersCache = new WeakMap<HubState["conversations"], WeakMap<HubState["sessions"], Map<PmId, WorkerEntry[]>>>();
/** 按项目经理缓存上一次的 Worker 列表（上限 MAX_CACHED_PM_WORKERS 个 PM），sessions 因流式文字更新而换引用时若 Worker 数据没变直接复用同一数组引用。 */
const MAX_CACHED_PM_WORKERS = 64;
const lastWorkersByPm = new Map<PmId, WorkerEntry[]>();

function sameWorkerEntry(a: WorkerEntry, b: WorkerEntry): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.workerId === b.workerId &&
    a.title === b.title &&
    a.activity === b.activity &&
    a.ended === b.ended &&
    a.vendor === b.vendor &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.tone === b.tone &&
    a.usage.input === b.usage.input &&
    a.usage.output === b.usage.output &&
    a.usage.cacheRead === b.usage.cacheRead &&
    a.usage.cacheWrite === b.usage.cacheWrite &&
    a.usage.context === b.usage.context
  );
}

/**
 * 这个项目经理派的 Worker：进行中的在前，收工的在后；进行中的按派出的顺序（对话编号），收工的最近收工的在前（没有收工那一行的按对话编号倒序，排在有的后面）。
 * conversations、sessions 都没变，或 Worker 字段完全没变（如仅流式文字变化）时返回上次那个数组引用。
 */
export function workersOf(state: HubState, pmId: PmId): WorkerEntry[] {
  let bySessions = workersCache.get(state.conversations);
  if (bySessions === undefined) {
    bySessions = new WeakMap();
    workersCache.set(state.conversations, bySessions);
  }
  let byPm = bySessions.get(state.sessions);
  if (byPm === undefined) {
    byPm = new Map();
    bySessions.set(state.sessions, byPm);
  }
  let entries = byPm.get(pmId);
  if (entries === undefined) {
    const computed = computeWorkers(state, pmId);
    const prev = lastWorkersByPm.get(pmId);
    if (prev !== undefined && prev.length === computed.length && computed.every((w, i) => sameWorkerEntry(w, prev[i]!))) {
      entries = prev;
    } else {
      entries = computed;
      if (!lastWorkersByPm.has(pmId) && lastWorkersByPm.size >= MAX_CACHED_PM_WORKERS) {
        const oldest = lastWorkersByPm.keys().next().value;
        if (oldest !== undefined) lastWorkersByPm.delete(oldest);
      }
      lastWorkersByPm.set(pmId, entries);
    }
    byPm.set(pmId, entries);
  }
  return entries;
}

function computeWorkers(state: HubState, pmId: PmId): WorkerEntry[] {
  const { latest, endedAt: endedLines } = workerLinesOf(state, pmId);
  return Object.values(state.conversations)
    .filter(({ conversation }) => conversation.kind === "worker" && conversation.pmId === pmId)
    .map(({ conversation, messages }) => {
      const session = sessionOf(state, conversation.id);
      const latestEntry = latest.get(conversation.id);
      const workerId = latestEntry?.line.workerId ?? messages[0]?.workerId ?? undefined;
      return {
        conversationId: conversation.id,
        ...(workerId !== undefined ? { workerId } : {}),
        title: conversation.title,
        activity: session?.activity ?? "idle",
        ended: phaseOf(state, conversation.id, endedLines, session) === "ended",
        vendor: session?.vendor,
        model: session?.model,
        effort: session?.effort,
        usage: session?.usage ?? EMPTY_TOKEN_USAGE,
        tone: toneOf(latestEntry),
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

/** 项目经理会话里指向这个 Worker 对话的那几行里最新的一行的内容（标题、只读）；还没有那一行是 null。 */
export function workerLineOf(state: HubState, workerConversationId: ConversationId): WorkerMessageMeta | null {
  const pmId = state.conversations[workerConversationId]?.conversation.pmId;
  if (pmId == null) return null;
  return workerLinesOf(state, pmId).latest.get(workerConversationId)?.line ?? null;
}

const NO_PENDING: PendingMessage[] = [];
const pendingByConversationCache = new WeakMap<readonly PendingMessage[], Map<ConversationId, PendingMessage[]>>();

export function pendingOf(state: HubState, conversationId: ConversationId): PendingMessage[] {
  if (state.pending.length === 0) return NO_PENDING;
  let byConv = pendingByConversationCache.get(state.pending);
  if (byConv === undefined) {
    byConv = new Map();
    pendingByConversationCache.set(state.pending, byConv);
  }
  let cached = byConv.get(conversationId);
  if (cached !== undefined) return cached;
  const filtered = state.pending.filter((p) => p.conversationId === conversationId);
  cached = filtered.length === 0 ? NO_PENDING : filtered;
  byConv.set(conversationId, cached);
  return cached;
}

/**
 * 这个对话在换新会话（资料页的“开新会话”按钮不能点）：交接请求还没结果（排队、已送达、处理中）。
 * 和账本的 waitsForHandover 同一个口径（ledger/handover.ts）。
 */
export function isRenewing(state: HubState, conversationId: ConversationId): boolean {
  return renewingIn(state.conversations[conversationId]?.messages ?? []);
}

/**
 * 网页显示用的消息：过滤掉静默唤醒项目经理的内部触发消息（worker.max_time_exceeded，只隐藏触发消息本身，保留项目经理随后的回复）；
 * 写交接期间压着的用户消息不显示“排队中”（马上就交给新会话），和平时一轮中途交给 agent 的一样。
 */
export function visibleMessages(messages: Message[]): Message[] {
  const filtered = messages.some(isSilentTriggerMessage) ? messages.filter((m) => !isSilentTriggerMessage(m)) : messages;
  if (!renewingIn(filtered)) return filtered;
  return filtered.map((m) => (m.sender === "user" && m.status === "queued" ? { ...m, status: "delivered" } : m));
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
  /** 静默交给 agent 的内部触发消息（如 worker.max_time_exceeded）：切开前后两轮，但自身不在网页渲染成气泡。 */
  | "silent_input"
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
  if (isSilentTriggerMessage(message) || (isRewoundMessage(message) && attachmentsOf(message).length === 0)) return "silent_input";
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
  // 用 Set 判断“是不是分隔线”“是不是被压着的”：长对话（翻过页、几千条）里换代多次时，includes 每条都扫一遍会变成 O(N×H)
  const isDivider = new Set(dividers);
  let rest = shown.filter((m) => !isDivider.has(m));
  for (const divider of dividers) {
    const { sessionId, turnStartId } = divider.meta as { sessionId: number; turnStartId?: number };
    const after = turnStartId ?? divider.id;
    const held = new Set(rest.filter((m) => m.id <= after && m.sessionId === sessionId));
    if (held.size > 0) rest = rest.filter((m) => !held.has(m));
    const at = rest.findIndex((m) => m.id > after && !isDivider.has(m));
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
    if (role === "silent_input") {
      close();
      lastInputAt = message.createdAt;
      continue;
    }
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

// ---- Router（总助）跨设备同源聚合视图（WeakMap 引用缓存） ----

export interface DeviceRouterView {
  decisions: PendingDecision[];
}

const deviceRouterViewCache = new WeakMap<readonly PendingDecision[], DeviceRouterView>();

/** 单台设备的 Router 活跃视图（待拍板项），输入切片未变时返回同一对象引用（===）。简报和指令走 router-stream.ts 的时间流。 */
export function deviceRouterView(state: HubState, deviceId = "local"): DeviceRouterView {
  const decisions = devicePendingDecisionsOf(state, deviceId);
  let cached = deviceRouterViewCache.get(decisions);
  if (!cached) {
    cached = { decisions };
    deviceRouterViewCache.set(decisions, cached);
  }
  return cached;
}

export interface FleetRouterDeviceInput {
  id: string;
  /** devices.ts 的 DeviceKey：本机传 ""（缺省按 self ? "" : id）。 */
  key?: string;
  name: string;
  self: boolean;
  online: boolean;
  state: HubState;
}

export interface FleetDecisionEntry {
  decision: PendingDecision;
  deviceKey: string;
  deviceId: string;
  deviceName: string;
  self: boolean;
  online: boolean;
  avatarKey: number;
}

export interface RouterTargetCandidate {
  key: string;
  deviceKey: string;
  deviceId: string;
  deviceName: string;
  self: boolean;
  online: boolean;
  pmId: PmId;
  pmName: string;
  projectId: ProjectId | null;
  projectName: string | null;
  conversationId: ConversationId;
  avatarKey: number;
  label: string;
}

export interface FleetRouterView {
  decisions: FleetDecisionEntry[];
  targets: RouterTargetCandidate[];
  summary: RouterReminderSummary;
  multiDevice: boolean;
}

/** 还没就绪的设备共用同一份空视图：每次给新的 [] 会让下面的指纹比较永远不等，整个舰队视图次次重算。 */
const EMPTY_DEVICE_ROUTER_VIEW: DeviceRouterView = { decisions: [] };
const pmConversationSigCache = new WeakMap<HubState["conversations"], string>();

function pmConversationSignature(conversations: HubState["conversations"]): string {
  const hit = pmConversationSigCache.get(conversations);
  if (hit !== undefined) return hit;
  const parts: string[] = [];
  for (const { conversation } of Object.values(conversations)) {
    if (conversation.kind === "worker") continue;
    parts.push(`${conversation.id}:${conversation.pmId ?? ""}:${conversation.projectId ?? ""}`);
  }
  parts.sort();
  const sig = parts.join("|");
  pmConversationSigCache.set(conversations, sig);
  return sig;
}

interface FleetDeviceFingerprint {
  id: string;
  key: string;
  name: string;
  self: boolean;
  online: boolean;
  phase: HubState["phase"];
  decisions: readonly PendingDecision[];
  /** 左栏摘要要数未读简报，router.items 变了才重算。 */
  items: HubState["router"]["items"];
  pms: readonly Pm[];
  projects: readonly Project[];
  pmConvSig: string;
}

let lastFleetMemo: { deps: FleetDeviceFingerprint[]; value: FleetRouterView } | null = null;

/**
 * 汇总全舰队（本机 + 全部已配对远端设备）的待决拍板、未读汇报、本机最近发令回执与 `@` 目标候选。
 * 流式文字推送与 Worker 历史消息滚动均不会击穿缓存，输入等价时返回完全相同的 `FleetRouterView` 引用（===）。
 */
export function fleetRouterView(devices: readonly FleetRouterDeviceInput[]): FleetRouterView {
  const deps: FleetDeviceFingerprint[] = devices.map((d) => {
    const logicalId = d.self ? "local" : d.id;
    const view = d.state.phase === "ready" ? deviceRouterView(d.state, logicalId) : EMPTY_DEVICE_ROUTER_VIEW;
    return {
      id: d.id,
      key: d.key ?? (d.self ? "" : d.id),
      name: d.name,
      self: d.self,
      online: d.online,
      phase: d.state.phase,
      decisions: view.decisions,
      items: d.state.router.items,
      pms: d.state.pms,
      projects: d.state.projects,
      pmConvSig: pmConversationSignature(d.state.conversations),
    };
  });

  if (
    lastFleetMemo !== null &&
    lastFleetMemo.deps.length === deps.length &&
    deps.every((cur, idx) => {
      const prev = lastFleetMemo!.deps[idx]!;
      return (
        prev.id === cur.id &&
        prev.key === cur.key &&
        prev.name === cur.name &&
        prev.self === cur.self &&
        prev.online === cur.online &&
        prev.phase === cur.phase &&
        prev.decisions === cur.decisions &&
        prev.items === cur.items &&
        prev.pms === cur.pms &&
        prev.projects === cur.projects &&
        prev.pmConvSig === cur.pmConvSig
      );
    })
  ) {
    return lastFleetMemo.value;
  }

  const decisions: FleetDecisionEntry[] = [];
  const targets: RouterTargetCandidate[] = [];

  for (let i = 0; i < devices.length; i++) {
    const d = devices[i]!;
    const fp = deps[i]!;
    if (d.state.phase !== "ready") continue;

    const pmById = new Map<PmId, Pm>();
    for (const pm of d.state.pms) pmById.set(pm.id, pm);
    for (const dec of fp.decisions) {
      decisions.push({
        decision: dec,
        deviceKey: fp.key,
        deviceId: d.self ? "local" : d.id,
        deviceName: d.name,
        self: d.self,
        online: d.online,
        avatarKey: dec.pmId,
      });
    }

    for (const { conversation } of Object.values(d.state.conversations)) {
      if (conversation.kind === "worker" || conversation.pmId === null) continue;
      const pm = pmById.get(conversation.pmId);
      if (!pm || pm.archivedAt != null) continue;
      const proj = d.state.projects.find((p) => p.conversationId === conversation.id) ?? null;
      targets.push({
        key: `${fp.key || "local"}:${conversation.id}`,
        deviceKey: fp.key,
        deviceId: d.self ? "local" : d.id,
        deviceName: d.name,
        self: d.self,
        online: d.online,
        pmId: pm.id,
        pmName: pm.name,
        projectId: proj?.id ?? null,
        projectName: proj?.name ?? null,
        conversationId: conversation.id,
        avatarKey: pm.id,
        label: proj?.name ?? pm.name,
      });
    }
  }

  decisions.sort((a, b) => b.decision.createdAt - a.decision.createdAt || a.decision.key.localeCompare(b.decision.key));

  const summary = routerReminderSummary(
    devices
      .filter((d) => d.state.phase === "ready")
      .map((d) => ({ deviceId: d.self ? "local" : d.id, state: d.state })),
  );

  const value: FleetRouterView = {
    decisions,
    targets,
    summary,
    multiDevice: devices.length > 1,
  };
  lastFleetMemo = { deps, value };
  return value;
}

// ---- 任务流图（Task Graph）与同源拍板（PendingDecision）选择器 ----

const NO_TASK_GRAPHS: TaskGraph[] = [];
const NO_WORKERS: WorkerEntry[] = [];
const NO_DECISIONS: PendingDecision[] = [];
const NO_CONV_MESSAGES: readonly Message[] = [];

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (!map.has(key) && map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** 任务图紧急度排序权重：有步骤等用户拍板（0）> 有步骤等项目经理（1）> 其余后台进行中（2）。 */
export function taskGraphPriority(graph: TaskGraph): number {
  let hasWaitingPm = false;
  for (const node of graph.nodes) {
    if (isTaskNodeWaitingUser(node)) return 0;
    if (isTaskNodeWaitingPm(node)) hasWaitingPm = true;
  }
  return hasWaitingPm ? 1 : 2;
}

/** 按紧急度（等用户、等项目经理的置顶）与最近更新时间排好活跃任务图。 */
export function sortActiveGraphs(graphs: readonly TaskGraph[]): TaskGraph[] {
  if (graphs.length === 0) return NO_TASK_GRAPHS;
  return graphs.toSorted((a, b) => {
    const pa = taskGraphPriority(a);
    const pb = taskGraphPriority(b);
    if (pa !== pb) return pa - pb;
    return b.updatedAt - a.updatedAt || b.id - a.id;
  });
}

const activeGraphsCache = new WeakMap<HubState["activeTaskGraphs"], Map<ProjectId, TaskGraph[]>>();
const lastActiveGraphsByProject = new Map<ProjectId, TaskGraph[]>();

/**
 * 指定项目的活跃任务图（status === 'active'）：有步骤等用户、等项目经理的排在最前。
 * 按 activeTaskGraphs WeakMap 缓存，并在跨项目图变更时复用未变项目的数组引用（===）。
 */
export function activeGraphsOf(state: HubState, projectId: ProjectId | null): TaskGraph[] {
  if (projectId === null) return NO_TASK_GRAPHS;
  let byProject = activeGraphsCache.get(state.activeTaskGraphs);
  if (byProject === undefined) {
    byProject = new Map();
    activeGraphsCache.set(state.activeTaskGraphs, byProject);
  }
  const hit = byProject.get(projectId);
  if (hit !== undefined) return hit;

  const filtered = state.activeTaskGraphs.filter((g) => g.projectId === projectId && g.status === "active");
  if (filtered.length === 0) {
    byProject.set(projectId, NO_TASK_GRAPHS);
    return NO_TASK_GRAPHS;
  }
  const sorted = sortActiveGraphs(filtered);
  const prev = lastActiveGraphsByProject.get(projectId);
  const resolved =
    prev !== undefined && prev.length === sorted.length && sorted.every((g, i) => g === prev[i]) ? prev : sorted;
  if (resolved !== prev) setBoundedMap(lastActiveGraphsByProject, projectId, resolved, TASK_GRAPH_SELECTOR_CACHE_MAX);
  byProject.set(projectId, resolved);
  return resolved;
}

const boundWorkerIdsCache = new WeakMap<readonly TaskGraph[], ReadonlySet<WorkerId>>();

/**
 * Worker 是否绑在给定的 Worker 编号集合里。只认 WorkerEntry.workerId（Worker 记录编号）：
 * 拿不到编号的不算绑定，绝不拿 conversationId 顶替（两套编号各自自增，会撞号误吞零散 Worker）。
 */
export function isWorkerBound(worker: WorkerEntry, boundIds: ReadonlySet<WorkerId>): boolean {
  return worker.workerId !== undefined && boundIds.has(worker.workerId);
}

/** 按 Worker 记录编号索引 Worker（任务图节点按 workerId 找对应对话）；没有编号的不进索引。 */
export function workersByWorkerId(workers: readonly WorkerEntry[]): ReadonlyMap<WorkerId, WorkerEntry> {
  const map = new Map<WorkerId, WorkerEntry>();
  for (const w of workers) {
    if (w.workerId !== undefined) map.set(w.workerId, w);
  }
  return map;
}

/** 汇总一组任务图全部节点已绑定的 Worker 编号集合（含 activeWorkerId 与历史 workerIds）。 */
export function boundWorkerIdsOf(graphs: readonly TaskGraph[]): ReadonlySet<WorkerId> {
  const hit = boundWorkerIdsCache.get(graphs);
  if (hit !== undefined) return hit;
  const ids = new Set<WorkerId>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.activeWorkerId !== null) ids.add(node.activeWorkerId);
      for (const wid of node.workerIds) ids.add(wid);
    }
  }
  boundWorkerIdsCache.set(graphs, ids);
  return ids;
}

const unboundWorkersCache = new WeakMap<readonly WorkerEntry[], WeakMap<readonly TaskGraph[], WorkerEntry[]>>();
const lastUnboundByProject = new Map<ProjectId, WorkerEntry[]>();

/**
 * 未绑定到当前项目任何活跃任务图节点的独立 Worker 列表：
 * 复用 workersOf 与 activeGraphsOf 的稳定引用做二级 WeakMap 缓存，流式文字更新期间零重算且严格 ===。
 */
export function unboundWorkersOf(state: HubState, projectId: ProjectId | null): WorkerEntry[] {
  if (projectId === null) return NO_WORKERS;
  const project = state.projects.find((p) => p.id === projectId);
  if (project === undefined) return NO_WORKERS;
  const allWorkers = workersOf(state, project.pmId);
  const graphs = activeGraphsOf(state, projectId);
  if (graphs.length === 0 || allWorkers.length === 0) return allWorkers;

  let byGraphs = unboundWorkersCache.get(allWorkers);
  if (byGraphs === undefined) {
    byGraphs = new WeakMap();
    unboundWorkersCache.set(allWorkers, byGraphs);
  }
  const hit = byGraphs.get(graphs);
  if (hit !== undefined) return hit;

  const boundIds = boundWorkerIdsOf(graphs);
  if (boundIds.size === 0) {
    byGraphs.set(graphs, allWorkers);
    return allWorkers;
  }
  const filtered = allWorkers.filter((w) => !isWorkerBound(w, boundIds));
  if (filtered.length === 0) {
    byGraphs.set(graphs, NO_WORKERS);
    return NO_WORKERS;
  }
  const prev = lastUnboundByProject.get(projectId);
  const resolved =
    prev !== undefined && prev.length === filtered.length && filtered.every((w, i) => w === prev[i]) ? prev : filtered;
  if (resolved !== prev) setBoundedMap(lastUnboundByProject, projectId, resolved, TASK_GRAPH_SELECTOR_CACHE_MAX);
  byGraphs.set(graphs, resolved);
  return resolved;
}

const gateMessageIdsByMessages = new WeakMap<readonly Message[], ReadonlySet<MessageId>>();

function gateMessageIdsIn(messages: readonly Message[]): ReadonlySet<MessageId> {
  const hit = gateMessageIdsByMessages.get(messages);
  if (hit !== undefined) return hit;
  const set = new Set<MessageId>();
  for (const msg of messages) {
    if (askOf(msg)?.gateRef !== undefined) set.add(msg.id);
  }
  gateMessageIdsByMessages.set(messages, set);
  return set;
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function samePendingDecision(a: PendingDecision, b: PendingDecision): boolean {
  if (
    a.key !== b.key ||
    a.pmId !== b.pmId ||
    a.pmName !== b.pmName ||
    a.projectId !== b.projectId ||
    a.projectName !== b.projectName ||
    a.conversationId !== b.conversationId ||
    a.question !== b.question ||
    a.context !== b.context ||
    a.askMessageId !== b.askMessageId ||
    a.createdAt !== b.createdAt ||
    a.updatedAt !== b.updatedAt ||
    !sameStringList(a.options, b.options) ||
    a.source.kind !== b.source.kind
  ) {
    return false;
  }
  if (a.source.kind === "gate" && b.source.kind === "gate") {
    return (
      a.source.graphId === b.source.graphId &&
      a.source.graphTitle === b.source.graphTitle &&
      a.source.nodeKey === b.source.nodeKey &&
      a.source.nodeTitle === b.source.nodeTitle &&
      a.source.blockedNodeCount === b.source.blockedNodeCount &&
      a.source.recommended === b.source.recommended &&
      sameStringList(a.source.nextNodeTitles, b.source.nextNodeTitles)
    );
  }
  return a.source.kind === "router_item" && b.source.kind === "router_item" && a.source.itemId === b.source.itemId;
}

interface DecisionCacheValue {
  messages: readonly Message[];
  pms: HubState["pms"];
  projects: HubState["projects"];
  list: PendingDecision[];
}

const convDecisionsCache = new WeakMap<
  HubState["activeTaskGraphs"],
  WeakMap<HubState["router"]["items"], Map<string, DecisionCacheValue>>
>();
const lastDecisionsByScope = new Map<string, PendingDecision[]>();

/**
 * 指定对话（PM 对话）当前待拍板事项（任务图里挂卡等用户的步骤 + 去重后的 Router 待决项）：
 * 只扫描该对话自身的消息与归属它的任务图/待决项（绝不扫 300 个 Worker 对话），WeakMap 多级缓存保证 < 2 ms 与 === 引用稳定。
 */
export function pendingDecisionsOf(
  state: HubState,
  conversationId: ConversationId,
  deviceId = "local",
): PendingDecision[] {
  const scopeKey = `${deviceId}:${conversationId}`;
  const convMessages = state.conversations[conversationId]?.messages ?? NO_CONV_MESSAGES;

  let byRouterItems = convDecisionsCache.get(state.activeTaskGraphs);
  if (byRouterItems === undefined) {
    byRouterItems = new WeakMap();
    convDecisionsCache.set(state.activeTaskGraphs, byRouterItems);
  }
  let byScope = byRouterItems.get(state.router.items);
  if (byScope === undefined) {
    byScope = new Map();
    byRouterItems.set(state.router.items, byScope);
  }
  const hit = byScope.get(scopeKey);
  if (
    hit !== undefined &&
    hit.messages === convMessages &&
    hit.pms === state.pms &&
    hit.projects === state.projects
  ) {
    return hit.list;
  }

  const msgGateIds = gateMessageIdsIn(convMessages);
  const graphGateIds = new Set<MessageId>();
  const result: PendingDecision[] = [];

  const pmNameOf = (pmId: PmId) => state.pms.find((p) => p.id === pmId)?.name ?? `#${pmId}`;
  const projectNameOf = (projectId: ProjectId | null) =>
    projectId === null ? null : (state.projects.find((p) => p.id === projectId)?.name ?? null);

  for (const graph of state.activeTaskGraphs) {
    if (graph.status !== "active" || graph.conversationId !== conversationId) continue;
    for (const node of graph.nodes) {
      if (node.gateAskMessageId !== null) graphGateIds.add(node.gateAskMessageId);
      if (!isTaskNodeWaitingUser(node)) continue;
      const { blockedNodeCount, nextNodeTitles } = computeGateImpact(graph, node.key);
      result.push({
        key: `gate:${deviceId}:${graph.id}:${node.key}`,
        deviceId,
        pmId: graph.pmId,
        pmName: pmNameOf(graph.pmId),
        projectId: graph.projectId,
        projectName: projectNameOf(graph.projectId),
        conversationId: graph.conversationId,
        question: node.gateQuestion ?? node.title,
        context: node.gateSummaryMd ?? "",
        options: node.gateOptions,
        askMessageId: node.gateAskMessageId,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        source: {
          kind: "gate",
          graphId: graph.id,
          graphTitle: graph.title,
          nodeKey: node.key,
          nodeTitle: node.title,
          blockedNodeCount,
          nextNodeTitles,
          recommended: node.gateRecommended,
        },
      });
    }
  }

  for (const item of state.router.items) {
    if (item.conversationId !== conversationId || item.kind !== "decision" || item.status !== "pending") continue;
    if (item.askMessageId !== null && (msgGateIds.has(item.askMessageId) || graphGateIds.has(item.askMessageId))) {
      continue;
    }
    result.push({
      key: `item:${deviceId}:${item.id}`,
      deviceId,
      pmId: item.pmId,
      pmName: pmNameOf(item.pmId),
      projectId: item.projectId,
      projectName: projectNameOf(item.projectId),
      conversationId: item.conversationId,
      question: item.question,
      context: item.context,
      options: item.options,
      askMessageId: item.askMessageId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      source: {
        kind: "router_item",
        itemId: item.id,
      },
    });
  }

  if (result.length === 0) {
    byScope.set(scopeKey, { messages: convMessages, pms: state.pms, projects: state.projects, list: NO_DECISIONS });
    return NO_DECISIONS;
  }

  result.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
  const prev = lastDecisionsByScope.get(scopeKey);
  const resolved =
    prev !== undefined && prev.length === result.length && result.every((d, i) => samePendingDecision(d, prev[i]!))
      ? prev
      : result;
  if (resolved !== prev) setBoundedMap(lastDecisionsByScope, scopeKey, resolved, TASK_GRAPH_SELECTOR_CACHE_MAX);
  byScope.set(scopeKey, { messages: convMessages, pms: state.pms, projects: state.projects, list: resolved });
  return resolved;
}
