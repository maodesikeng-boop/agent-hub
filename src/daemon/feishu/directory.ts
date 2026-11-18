// 群成员和背景近窗（docs/feishu-design.md「性能」）：判断单人还是多人、查显示名、暂存没 @机器人 的话。全在内存里，有上限。
// 不变量：
// - 成员按群缓存，最多 FEISHU_CHAT_CACHE_MAX 个群（lru-cache）；成员事件实时改，连上和重连时整份标过期，
//   每 FEISHU_MEMBERS_TTL_MS 对一遍，查失败只记 FEISHU_MEMBERS_RETRY_MS，期间按 shared 处理（宁可多要一次 @，不把访客当主人）；
// - 发言人不是主人时，这个群立刻算 shared，不等对账（访客的话本身就证明群里有别人）；
// - 背景近窗每群最多 FEISHU_CONTEXT_MAX_LINES 行、FEISHU_CONTEXT_MAX_CHARS 字，超过丢最早的；超过 FEISHU_CONTEXT_TTL_MS 的行丢掉；
//   守护进程重启后近窗为空（不落库，只是背景）；
// - 群解散、机器人被移出、断开时清掉这个群的全部缓存。
import { LRUCache } from "lru-cache";
import { truncateChars } from "../../shared/domain.ts";
import { feishuDisplayName } from "../../shared/feishu.ts";
import type { FeishuChatId, FeishuChatMode, FeishuContextLine, FeishuOpenId } from "../../shared/feishu.ts";
import {
  FEISHU_CHAT_CACHE_MAX,
  FEISHU_CHAT_MEMBERS_MAX,
  FEISHU_CONTEXT_MAX_CHARS,
  FEISHU_CONTEXT_MAX_LINES,
  FEISHU_CONTEXT_TTL_MS,
  FEISHU_MEMBERS_RETRY_MS,
  FEISHU_MEMBERS_TTL_MS,
} from "../../shared/limits.ts";

export interface FeishuMember {
  openId: FeishuOpenId;
  /** 群成员接口给的显示名，已截到 FEISHU_DISPLAY_NAME_MAX_CHARS 字。 */
  name: string;
}

export interface FeishuDirectory {
  /** 后置：有新鲜缓存时直接返回；过期或没有时调 fetch 拉全群成员（不含机器人）再返回。fetch 失败返回 null 并按重试间隔记下。 */
  members(chatId: FeishuChatId, now: number): Promise<FeishuMember[] | null>;
  /**
   * 后置：除主人以外没有别人时 solo；有别人、或成员查不到时 shared。
   * speaker 不是主人时直接返回 shared，并把 speaker 记进成员。
   */
  modeOf(chatId: FeishuChatId, owner: FeishuOpenId, speaker: FeishuOpenId | null, now: number): Promise<FeishuChatMode>;
  /** 后置：缓存里有这个人返回显示名，没有时拉一次群成员；还是没有返回 fallback。 */
  nameOf(chatId: FeishuChatId, openId: FeishuOpenId, fallback: string, now: number): Promise<string>;
  /** 缓存里现有的成员（不发请求，状态接口用）；没缓存过是 null。 */
  peekMembers(chatId: FeishuChatId): FeishuMember[] | null;
  /** 成员进出事件：直接改缓存，不发请求。 */
  applyJoined(chatId: FeishuChatId, members: readonly FeishuMember[], now: number): void;
  applyLeft(chatId: FeishuChatId, openIds: readonly FeishuOpenId[], now: number): void;
  /** 连上或重连：全部标过期，下一次 members 时重拉。 */
  markAllStale(): void;
  forget(chatId: FeishuChatId): void;
  clear(): void;
}

interface ChatEntry {
  /** 成员（不含机器人），按 openId；最多 FEISHU_CHAT_MEMBERS_MAX 个。 */
  members: Map<FeishuOpenId, string>;
  /** 上次从飞书拉全的时间；null 表示只靠事件知道一部分、还没拉过。 */
  fetchedAt: number | null;
  /** 上次拉失败的时间；失败后 FEISHU_MEMBERS_RETRY_MS 内不再拉。 */
  failedAt: number | null;
  stale: boolean;
  /** 只从事件、发言知道、还不知道名字的人：查名字时为他们重拉一次。 */
  unnamed: Set<FeishuOpenId>;
}

export function createFeishuDirectory(fetch: (chatId: FeishuChatId) => Promise<FeishuMember[]>): FeishuDirectory {
  const chats = new LRUCache<FeishuChatId, ChatEntry>({ max: FEISHU_CHAT_CACHE_MAX });
  const inflight = new Map<FeishuChatId, Promise<FeishuMember[] | null>>();

  const entryOf = (chatId: FeishuChatId): ChatEntry => {
    let entry = chats.get(chatId);
    if (entry === undefined) {
      entry = { members: new Map(), fetchedAt: null, failedAt: null, stale: true, unnamed: new Set() };
      chats.set(chatId, entry);
    }
    return entry;
  };
  const remember = (entry: ChatEntry, member: FeishuMember) => {
    if (!entry.members.has(member.openId) && entry.members.size >= FEISHU_CHAT_MEMBERS_MAX) return;
    if (member.name.trim() === "") {
      if (!entry.members.has(member.openId)) entry.members.set(member.openId, "");
      if (entry.members.get(member.openId) === "") entry.unnamed.add(member.openId);
      return;
    }
    entry.members.set(member.openId, feishuDisplayName(member.name));
    entry.unnamed.delete(member.openId);
  };
  const list = (entry: ChatEntry): FeishuMember[] => [...entry.members].map(([openId, name]) => ({ openId, name }));
  const fresh = (entry: ChatEntry, now: number) => !entry.stale && entry.fetchedAt !== null && now - entry.fetchedAt < FEISHU_MEMBERS_TTL_MS;

  const members = (chatId: FeishuChatId, now: number): Promise<FeishuMember[] | null> => {
    const entry = entryOf(chatId);
    if (fresh(entry, now)) return Promise.resolve(list(entry));
    if (entry.failedAt !== null && now - entry.failedAt < FEISHU_MEMBERS_RETRY_MS) return Promise.resolve(null);
    const running = inflight.get(chatId);
    if (running !== undefined) return running;
    const task = fetch(chatId).then(
      (got) => {
        const current = entryOf(chatId);
        current.members.clear();
        current.unnamed.clear();
        for (const member of got) remember(current, member);
        current.fetchedAt = now;
        current.failedAt = null;
        current.stale = false;
        return list(current);
      },
      () => {
        entryOf(chatId).failedAt = now;
        return null;
      },
    );
    inflight.set(chatId, task);
    void task.finally(() => inflight.delete(chatId));
    return task;
  };

  return {
    members,
    async modeOf(chatId, owner, speaker, now) {
      if (speaker !== null && speaker !== owner) {
        remember(entryOf(chatId), { openId: speaker, name: entryOf(chatId).members.get(speaker) ?? "" });
        return "shared";
      }
      const got = await members(chatId, now);
      if (got === null) return "shared";
      return got.some((m) => m.openId !== owner) ? "shared" : "solo";
    },
    async nameOf(chatId, openId, fallback, now) {
      const entry = chats.get(chatId);
      const cached = entry?.members.get(openId);
      if (cached !== undefined && cached !== "") return cached;
      // 只从事件知道这个人、还不知道名字：缓存再新鲜也重拉一次（之后有名字就不再拉）
      if (entry?.unnamed.has(openId) === true) {
        entry.unnamed.delete(openId);
        entry.stale = true;
      }
      const got = await members(chatId, now);
      const name = got?.find((m) => m.openId === openId)?.name;
      return name !== undefined && name !== "" ? name : feishuDisplayName(fallback);
    },
    peekMembers(chatId) {
      const entry = chats.peek(chatId);
      return entry === undefined ? null : list(entry);
    },
    applyJoined(chatId, joined) {
      const entry = entryOf(chatId);
      for (const member of joined) remember(entry, member);
    },
    applyLeft(chatId, openIds) {
      const entry = chats.get(chatId);
      if (entry === undefined) return;
      for (const openId of openIds) entry.members.delete(openId);
    },
    markAllStale() {
      for (const entry of chats.values()) entry.stale = true;
    },
    forget(chatId) {
      chats.delete(chatId);
    },
    clear() {
      chats.clear();
    },
  };
}

export interface FeishuContextWindows {
  /** 后置：记下这一行；超出行数或字数上限时丢最早的。 */
  add(chatId: FeishuChatId, line: FeishuContextLine): void;
  /** 后置：返回这个群未过期的背景（按时间先后），不清空。 */
  peek(chatId: FeishuChatId, now: number): FeishuContextLine[];
  /** 后置：这一轮已送达，清空这个群的背景。 */
  clear(chatId: FeishuChatId): void;
  clearAll(): void;
}

export function createFeishuContextWindows(): FeishuContextWindows {
  // 群数跟着成员缓存一起有上限：同一个 FEISHU_CHAT_CACHE_MAX
  const windows = new LRUCache<FeishuChatId, FeishuContextLine[]>({ max: FEISHU_CHAT_CACHE_MAX });
  const chars = (lines: readonly FeishuContextLine[]) => lines.reduce((sum, line) => sum + [...line.text].length, 0);
  return {
    add(chatId, line) {
      const lines = [...(windows.get(chatId) ?? []), { ...line, text: truncateChars(line.text, FEISHU_CONTEXT_MAX_CHARS) }];
      while (lines.length > FEISHU_CONTEXT_MAX_LINES || (lines.length > 1 && chars(lines) > FEISHU_CONTEXT_MAX_CHARS)) lines.shift();
      windows.set(chatId, lines);
    },
    peek(chatId, now) {
      return (windows.get(chatId) ?? []).filter((line) => now - line.at <= FEISHU_CONTEXT_TTL_MS);
    },
    clear(chatId) {
      windows.delete(chatId);
    },
    clearAll() {
      windows.clear();
    },
  };
}
