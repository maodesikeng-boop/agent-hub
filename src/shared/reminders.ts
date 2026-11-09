// 提醒规则（m4-plan、M5；联机 P4 从 web/selectors.ts、web/notify.ts 搬来，docs/multi-device-design.md 第 6.2 节）：
// “等你”（对话停稳 3 秒）、“等你确定”（hub ask 一来就提醒）、通知的 tag。网页（标签页标题、左栏、浏览器通知）和
// 守护进程（Web Push）用同一份，规则只改这里。
import { DEVICE_PROXY_PREFIX, type Change, type DeviceId, type LedgerSnapshot, type PushPayload } from "./api.ts";
import { askOf, isHandoverTraffic, systemEventOf, type Conversation, type ConversationId, type Message, type MessageId, type Pm, type PmId, type SessionId, type SessionState } from "./domain.ts";

/** 对话要持续满足“等你”的条件这么久才算，避开 Worker 刚汇报、项目经理还没开始处理的那一瞬间。 */
export const WAITING_SETTLE_MS = 3_000;

/** 守护进程那份状态里每个对话留多少条最近的消息（/api/state 给 100 条，多留一些）。 */
const MIRROR_MESSAGES_PER_CONVERSATION = 200;

/** 算提醒要的状态。网页的 HubState 直接就是它；守护进程用 reminderStateFrom + applyReminderChange 维护一份。 */
export interface ReminderState {
  seq: number;
  pms: Pm[];
  conversations: Record<ConversationId, { conversation: Conversation; messages: Message[] }>;
  sessions: SessionState[];
  /** 网页自己先显示出来、服务端还没回真消息的用户消息（web/state.ts 的 PendingMessage）；守护进程没有，是空的。 */
  pending: readonly { conversationId: ConversationId; phase: "sending" | "failed" }[];
}

/** 每个对话用户上次看的时间（毫秒）；没看过的没有。网页存在 localStorage（notify.ts），守护进程按前台上报记。 */
export type LastSeen = Record<ConversationId, number | undefined>;

/** 还没处理完的消息状态：排队中、已送达、处理中。 */
const IN_FLIGHT = new Set(["queued", "delivered", "processing"]);

/**
 * 换新会话的那几条（写交接的来往、换代那条分隔线）：用户没说话、项目经理也没对用户说话，不进左栏预览、不改排序、不算未读。
 * 见 shared/domain.ts 的 isHandoverTraffic。
 */
export function isQuietMessage(message: Message): boolean {
  return isHandoverTraffic(message) || systemEventOf(message)?.event === "session.renewed";
}

const sessionByConversationCache = new WeakMap<
  readonly SessionState[],
  { length: number; map: Map<ConversationId, SessionState> }
>();

/** 这个对话的当前会话：generation 最大的那一代。不按会话编号、不按推送先后。按 sessions 数组引用缓存 Map，避免 O(C × S) 反复线性扫描。 */
export function sessionOf(state: Pick<ReminderState, "sessions">, conversationId: ConversationId): SessionState | null {
  let cached = sessionByConversationCache.get(state.sessions);
  if (!cached || cached.length !== state.sessions.length) {
    const map = new Map<ConversationId, SessionState>();
    for (const s of state.sessions) {
      if (s.conversationId === null) continue;
      const prev = map.get(s.conversationId);
      if (prev === undefined || s.generation > prev.generation) map.set(s.conversationId, s);
    }
    cached = { length: state.sessions.length, map };
    sessionByConversationCache.set(state.sessions, cached);
  }
  return cached.map.get(conversationId) ?? null;
}

/** 这个项目经理派的 Worker 里在跑的个数：Worker 对话的当前会话不是 idle（api.ts StateSnapshot 的注释）。 */
export function runningWorkerCount(state: Pick<ReminderState, "sessions" | "conversations">, pmId: PmId): number {
  return Object.values(state.conversations).filter(
    ({ conversation }) =>
      conversation.kind === "worker" && conversation.pmId === pmId && (sessionOf(state, conversation.id)?.activity ?? "idle") !== "idle",
  ).length;
}

function pendingIn(state: Pick<ReminderState, "pending">, conversationId: ConversationId) {
  return state.pending.filter((p) => p.conversationId === conversationId);
}

function isPmArchived(state: Pick<ReminderState, "pms">, pmId: PmId | null): boolean {
  if (pmId === null) return false;
  const pm = state.pms.find((p) => p.id === pmId);
  return pm?.archivedAt != null;
}

/**
 * 在“等你”的对话（m4-plan 2.2，不含“停稳 3 秒”，那个在 ReminderTracker）：对话自己和它派的 Worker 的会话都是 idle，
 * 没有排队、已送达、处理中的消息，最后一条不是用户发的，并且用户上次看之后又有了新消息。Worker 自己的对话不算。
 * 换新会话那一轮不算（交接请求在路上、写交接时会话在忙，按 visibleSessionOf 的口径）：不然换一次会话，
 * 对话会先退出“等你”再回来，同一条没看的回复又弹一次通知。
 */
export function waitingConversations(state: ReminderState, lastSeen: LastSeen): ConversationId[] {
  return Object.values(state.conversations)
    .filter(({ conversation, messages }) => {
      if (conversation.kind === "worker") return false;
      if (isPmArchived(state, conversation.pmId)) return false;
      const last = messages.findLast((m) => !isQuietMessage(m));
      if (!last || last.sender === "user" || last.createdAt <= (lastSeen[conversation.id] ?? 0)) return false;
      if (messages.some((m) => m.status !== null && IN_FLIGHT.has(m.status) && !isHandoverTraffic(m))) return false;
      if (pendingIn(state, conversation.id).some((p) => p.phase === "sending")) return false;
      if ((visibleSessionOf(state, conversation.id)?.activity ?? "idle") !== "idle") return false;
      return conversation.pmId === null || runningWorkerCount(state, conversation.pmId) === 0;
    })
    .map(({ conversation }) => conversation.id);
}

/**
 * 对话里还在等用户确定的 hub ask（M5）：守护进程还没标成已回答（meta.answered，用户在这个对话里发了消息就标上，
 * 见 ledger/messages.ts）。用户刚发出、服务端还没确认的消息也先当回答了，不等推送。从老到新。
 */
export function pendingAsks(state: ReminderState, conversationId: ConversationId): Message[] {
  const view = state.conversations[conversationId];
  if (!view || view.conversation.kind === "worker" || isPmArchived(state, view.conversation.pmId) || pendingIn(state, conversationId).some((p) => p.phase !== "failed")) return [];
  return view.messages.filter((m) => {
    const meta = askOf(m);
    return meta !== null && meta.answered !== true;
  });
}

/** 所有对话里还在等用户确定的提问（Worker 对话没有 hub ask，直接跳过）。 */
export function allPendingAsks(state: ReminderState): { conversationId: ConversationId; message: Message }[] {
  const out: { conversationId: ConversationId; message: Message }[] = [];
  for (const { conversation } of Object.values(state.conversations)) {
    if (conversation.kind === "worker") continue;
    for (const message of pendingAsks(state, conversation.id)) {
      out.push({ conversationId: conversation.id, message });
    }
  }
  return out;
}

/**
 * 这个对话在换新会话（资料页的“开新会话”按钮不能点）：交接请求还没结果（排队、已送达、处理中）。
 * 和账本的 waitsForHandover 同一个口径（ledger/handover.ts）。
 */
export function renewingIn(messages: Message[]): boolean {
  return messages.some((m) => systemEventOf(m)?.event === "handover.requested" && m.status !== null && IN_FLIGHT.has(m.status));
}

/**
 * 网页显示用的会话状态（状态行、停止键）：写交接那一轮不给用户看，当空闲；那期间有交给项目经理的话在等（用户的、Worker 汇报），
 * 显示成在想（Thinking…），和平时它马上开始处理一样，换完代就真的开始处理。
 */
export function visibleSessionOf(state: Pick<ReminderState, "sessions" | "conversations" | "pending">, conversationId: ConversationId): SessionState | null {
  const session = sessionOf(state, conversationId);
  const messages = state.conversations[conversationId]?.messages ?? [];
  if (session === null || !inHandoverTurn(messages, session.sessionId)) return session;
  const waiting = messages.some((m) => m.status === "queued" && !isHandoverTraffic(m)) || pendingIn(state, conversationId).some((p) => p.phase === "sending");
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

/** 通知的 tag：同一个项目经理只留最新的一条。 */
export function notificationTag(pmId: PmId | null, conversationId: ConversationId): string {
  return pmId === null ? `conversation-${conversationId}` : `pm-${pmId}`;
}

// ---- 停稳 3 秒、新提问：哪些要提醒 ----

/** 一条要提醒的：waiting 是停稳了的“等你”，ask 是新来的“等你确定”。 */
export interface Reminder<K> {
  kind: "waiting" | "ask";
  conversationId: K;
}

/**
 * 记着哪些对话已经算“等你”、哪些提问提醒过，每次状态变了喂一次现在的候选（waitingConversations、allPendingAsks 的结果），
 * 回该提醒的和下次要再喂的时间（有对话在等停稳时）。时间由调用方给，不自己起定时器。
 * 第一次喂的时候本来就在等的、本来就有的提问直接算，不提醒（刚打开网页、守护进程刚启动）。K 是对话的键（多设备时带设备）。
 */
export class ReminderTracker<K> {
  #started = false;
  /** 已经算“等你”的。 */
  #settled = new Set<K>();
  /** 进入候选的时间，停稳 WAITING_SETTLE_MS 才算。 */
  #since = new Map<K, number>();
  #knownAsks = new Set<MessageId>();

  update(now: number, waiting: readonly K[], asks: readonly { conversationId: K; messageId: MessageId }[]): { fire: Reminder<K>[]; nextCheckAt: number | null } {
    const fire: Reminder<K>[] = [];
    const candidates = new Set(waiting);
    for (const key of this.#settled) if (!candidates.has(key)) this.#settled.delete(key);
    for (const key of this.#since.keys()) if (!candidates.has(key)) this.#since.delete(key);
    if (!this.#started) {
      this.#started = true;
      for (const key of candidates) this.#settled.add(key);
      for (const a of asks) this.#knownAsks.add(a.messageId);
      return { fire, nextCheckAt: null };
    }
    let nextCheckAt: number | null = null;
    for (const key of candidates) {
      if (this.#settled.has(key)) continue;
      const since = this.#since.get(key) ?? now;
      this.#since.set(key, since);
      if (now - since >= WAITING_SETTLE_MS) {
        this.#since.delete(key);
        this.#settled.add(key);
        fire.push({ kind: "waiting", conversationId: key });
      } else {
        nextCheckAt = Math.min(nextCheckAt ?? Infinity, since + WAITING_SETTLE_MS);
      }
    }
    for (const a of asks) {
      if (this.#knownAsks.has(a.messageId)) continue;
      this.#knownAsks.add(a.messageId);
      fire.push({ kind: "ask", conversationId: a.conversationId });
    }
    return { fire, nextCheckAt };
  }

  /** 已经算“等你”的对话。 */
  waiting(): ReadonlySet<K> {
    return this.#settled;
  }
}

// ---- 守护进程那份状态 ----

/** 从快照（/api/state 或账本的 snapshot）起一份。提醒规则不看 Worker 自己对话里的消息，不留它们省内存。 */
export function reminderStateFrom(snapshot: Pick<LedgerSnapshot, "seq" | "pms" | "conversations" | "sessions">): ReminderState {
  return {
    seq: snapshot.seq,
    pms: snapshot.pms,
    conversations: Object.fromEntries(
      snapshot.conversations.map(({ conversation, messages }) => [
        conversation.id,
        { conversation, messages: conversation.kind === "worker" ? [] : messages },
      ]),
    ),
    sessions: snapshot.sessions,
    pending: [],
  };
}

function upsertBy<T>(list: T[], item: T, same: (a: T, b: T) => boolean): T[] {
  const index = list.findIndex((x) => same(x, item));
  return index === -1 ? [...list, item] : list.with(index, item);
}

/** 按编号插入或替换一条消息，保持从小到大，只留最近 MIRROR_MESSAGES_PER_CONVERSATION 条。 */
function upsertRecent(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((m) => m.id >= message.id);
  const next = index === -1 ? [...messages, message] : messages[index]?.id === message.id ? messages.with(index, message) : messages.toSpliced(index, 0, message);
  return next.length > MIRROR_MESSAGES_PER_CONVERSATION ? next.slice(-MIRROR_MESSAGES_PER_CONVERSATION) : next;
}

/** 应用一条变化（和网页 web/state.ts 的 applyChange 同样的口径，只管提醒用到的部分）。seq 不比现在新的不应用。 */
export function applyReminderChange(state: ReminderState, change: Change): ReminderState {
  if (change.seq <= state.seq) return state;
  const next = { ...state, seq: change.seq };
  switch (change.type) {
    case "message.created":
    case "message.updated": {
      const { message } = change.data;
      const view = state.conversations[message.conversationId];
      if (!view || view.conversation.kind === "worker") return next;
      return { ...next, conversations: { ...state.conversations, [message.conversationId]: { ...view, messages: upsertRecent(view.messages, message) } } };
    }
    case "session.status":
    case "session.created":
      return { ...next, sessions: upsertBy(state.sessions, change.data.session, (a, b) => a.sessionId === b.sessionId) };
    case "pm.created":
    case "pm.updated":
      return { ...next, pms: upsertBy(state.pms, change.data.pm, (a, b) => a.id === b.id) };
    case "pm.removed": {
      const { pmId } = change.data;
      const conversations = Object.fromEntries(
        Object.entries(state.conversations).filter(([, view]) => view.conversation.pmId !== pmId),
      );
      return { ...next, pms: state.pms.filter((p) => p.id !== pmId), conversations };
    }
    case "conversation.created": {
      const { conversation } = change.data;
      if (state.conversations[conversation.id]) return next;
      return { ...next, conversations: { ...state.conversations, [conversation.id]: { conversation, messages: [] } } };
    }
    default:
      return next;
  }
}

// ---- 推送的内容 ----

/** 推送里的设备：self 是不是提醒设备自己（点开的网址不带 #/d/）。 */
export interface ReminderDevice {
  id: DeviceId;
  name: string;
  self: boolean;
}

/**
 * 一条提醒的推送内容：只带标题不带正文（第 9 节拍板）——“设备 · 项目经理：等你 / 等你确定”。
 * 点开回到那个对话；tag 同一个项目经理只留最新一条（提问单独一个 tag，不被“等你”顶掉）。对话找不到回 null。
 */
export function reminderPayload(state: ReminderState, reminder: Reminder<ConversationId>, device: ReminderDevice): PushPayload | null {
  const view = state.conversations[reminder.conversationId];
  if (!view) return null;
  const { conversation } = view;
  const pm = conversation.pmId === null ? undefined : state.pms.find((p) => p.id === conversation.pmId);
  const name = pm?.name ?? conversation.title;
  const tag = notificationTag(conversation.pmId, conversation.id);
  const route = `#/c/${conversation.id}`;
  return {
    title: `${device.name} · ${name}：${reminder.kind === "ask" ? "等你确定" : "等你"}`,
    url: device.self ? `/${route}` : `/#${DEVICE_PROXY_PREFIX}/${device.id}/${route.slice(2)}`,
    tag: `${device.id}:${reminder.kind === "ask" ? `ask-${tag}` : tag}`,
  };
}
