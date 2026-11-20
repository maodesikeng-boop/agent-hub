import { LRUCache } from "lru-cache";
import { truncateChars } from "../../shared/domain.ts";
import { feishuDisplayName } from "../../shared/feishu.ts";
import type { FeishuChatId, FeishuChatMode, FeishuContextLine, FeishuOpenId } from "../../shared/feishu.ts";
import type { FeishuInboundFileRef } from "./inbound.ts";
import {
  FEISHU_CHAT_CACHE_MAX,
  FEISHU_CHAT_MEMBERS_MAX,
  FEISHU_CONTEXT_MAX_CHARS,
  FEISHU_CONTEXT_MAX_FILES,
  FEISHU_CONTEXT_MAX_LINES,
  FEISHU_CONTEXT_TTL_MS,
  FEISHU_MEMBERS_RETRY_MS,
  FEISHU_MEMBERS_TTL_MS,
  FEISHU_POLICY_CARD_COOLDOWN_MS,
} from "../../shared/limits.ts";

export interface FeishuMember {
  openId: FeishuOpenId;
  name: string;
}

export interface FeishuDirectory {
  members(chatId: FeishuChatId, now: number): Promise<FeishuMember[] | null>;
  modeOf(chatId: FeishuChatId, owner: FeishuOpenId, speaker: FeishuOpenId | null, now: number): Promise<FeishuChatMode>;
  nameOf(chatId: FeishuChatId, openId: FeishuOpenId, fallback: string, now: number): Promise<string>;
  peekMembers(chatId: FeishuChatId): FeishuMember[] | null;
  applyJoined(chatId: FeishuChatId, members: readonly FeishuMember[], now: number): void;
  applyLeft(chatId: FeishuChatId, openIds: readonly FeishuOpenId[], now: number): void;
  policyCardDue(chatId: FeishuChatId, now: number): boolean;
  notePolicyCard(chatId: FeishuChatId, now: number): void;
  markAllStale(): void;
  forget(chatId: FeishuChatId): void;
  clear(): void;
}

interface ChatEntry {
  members: Map<FeishuOpenId, string>;
  fetchedAt: number | null;
  failedAt: number | null;
  stale: boolean;
  unnamed: Set<FeishuOpenId>;
  policyCardAt: number | null;
}

export function createFeishuDirectory(fetch: (chatId: FeishuChatId) => Promise<FeishuMember[]>): FeishuDirectory {
  const chats = new LRUCache<FeishuChatId, ChatEntry>({ max: FEISHU_CHAT_CACHE_MAX });
  const inflight = new Map<FeishuChatId, Promise<FeishuMember[] | null>>();

  const entryOf = (chatId: FeishuChatId): ChatEntry => {
    let entry = chats.get(chatId);
    if (entry === undefined) {
      entry = { members: new Map(), fetchedAt: null, failedAt: null, stale: true, unnamed: new Set(), policyCardAt: null };
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
    // A failed lookup returns null so the chat counts as shared: asking for an extra @ is safer than treating a guest as the owner.
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
    policyCardDue(chatId, now) {
      const at = chats.peek(chatId)?.policyCardAt ?? null;
      return at === null || now - at >= FEISHU_POLICY_CARD_COOLDOWN_MS;
    },
    notePolicyCard(chatId, now) {
      entryOf(chatId).policyCardAt = now;
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

export interface FeishuPendingFile extends FeishuInboundFileRef {
  speaker: FeishuOpenId;
  at: number;
}

export interface FeishuContextWindows {
  add(chatId: FeishuChatId, line: FeishuContextLine, files?: readonly FeishuPendingFile[]): void;
  peek(chatId: FeishuChatId, now: number): FeishuContextLine[];
  peekFiles(chatId: FeishuChatId, now: number): FeishuPendingFile[];
  dropFiles(chatId: FeishuChatId, shouldDrop: (file: FeishuPendingFile) => boolean): void;
  clear(chatId: FeishuChatId): void;
  clearAll(): void;
}

export function createFeishuContextWindows(): FeishuContextWindows {
  const windows = new LRUCache<FeishuChatId, { lines: FeishuContextLine[]; files: FeishuPendingFile[] }>({ max: FEISHU_CHAT_CACHE_MAX });
  const chars = (lines: readonly FeishuContextLine[]) => lines.reduce((sum, line) => sum + [...line.text].length, 0);
  const fresh = (now: number) => (item: { at: number }) => now - item.at <= FEISHU_CONTEXT_TTL_MS;
  return {
    add(chatId, line, added = []) {
      const window = windows.get(chatId);
      const lines = [...(window?.lines ?? []), { ...line, text: truncateChars(line.text, FEISHU_CONTEXT_MAX_CHARS) }];
      while (lines.length > FEISHU_CONTEXT_MAX_LINES || (lines.length > 1 && chars(lines) > FEISHU_CONTEXT_MAX_CHARS)) lines.shift();
      const known = window?.files ?? [];
      const isNew = (item: FeishuPendingFile) => !known.some((k) => k.messageId === item.messageId && k.file.fileKey === item.file.fileKey);
      const files = [...known, ...added.filter(isNew)].slice(-FEISHU_CONTEXT_MAX_FILES);
      windows.set(chatId, { lines, files });
    },
    peek(chatId, now) {
      return (windows.get(chatId)?.lines ?? []).filter(fresh(now));
    },
    peekFiles(chatId, now) {
      return (windows.get(chatId)?.files ?? []).filter(fresh(now));
    },
    dropFiles(chatId, shouldDrop) {
      const window = windows.get(chatId);
      if (window === undefined) return;
      windows.set(chatId, { lines: window.lines, files: window.files.filter((file) => !shouldDrop(file)) });
    },
    clear(chatId) {
      windows.delete(chatId);
    },
    clearAll() {
      windows.clear();
    },
  };
}
