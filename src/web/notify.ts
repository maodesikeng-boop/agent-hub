// “等你”提醒（m4-plan）：对话停稳了就在左栏、标签页标题和浏览器通知里提醒用户。判断在网页里算，守护进程不管。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRODUCT_NAME } from "../shared/names.ts";
import type { ConversationId } from "../shared/index.ts";
import { listConversations, previewText, waitingConversations, type LastSeen } from "./selectors.ts";
import type { HubState } from "./state.ts";

/** 对话要持续满足“等你”的条件这么久才算，避开 Worker 刚汇报、项目经理还没开始处理的那一瞬间。 */
export const WAITING_SETTLE_MS = 3_000;

/** 用户上次看每个对话的时间存在这个 localStorage 键里。 */
export const LAST_SEEN_KEY = `${PRODUCT_NAME}:lastSeen`;

/** 通知的 tag：同一个项目经理只留最新的一条。 */
const notificationTag = (pmId: number | null, conversationId: ConversationId) => (pmId === null ? `conversation-${conversationId}` : `pm-${pmId}`);

export type NotifyPermission = NotificationPermission | "unsupported";

function loadLastSeen(): LastSeen {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as LastSeen) : {};
  } catch {
    return {};
  }
}

function saveLastSeen(lastSeen: LastSeen): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(lastSeen));
  } catch {
    // 存不了（隐私模式、被禁用）：这次打开期间还是有效，重开以后当作都没看过
  }
}

/** 网页在前台：标签页看得见，并且窗口有焦点。 */
function isForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function useForeground(): boolean {
  const [foreground, setForeground] = useState(isForeground);
  useEffect(() => {
    const update = () => setForeground(isForeground());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return foreground;
}

function currentPermission(): NotifyPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * 判断每个对话在不在“等你”，并提醒用户：返回在“等你”的对话（左栏显示）、通知权限和申请权限的函数；
 * 同时把标签页标题改成“(N) 产品名”，从“不算”变成“等你”时弹一次浏览器通知。
 * viewing 是用户正开着的对话（没有就是 null）；onOpen 在用户点通知时调，打开那个对话。
 */
export function useWaitingReminders(state: HubState, viewing: ConversationId | null, onOpen: (conversationId: ConversationId) => void) {
  const foreground = useForeground();
  const [lastSeen, setLastSeen] = useState(loadLastSeen);
  const [permission, setPermission] = useState(currentPermission);
  const [waiting, setWaiting] = useState<ReadonlySet<ConversationId>>(new Set());

  // 网页在前台、正开着这个对话的时候，它的每条新消息都算看过
  const viewingLastId = viewing === null ? null : (state.conversations[viewing]?.messages.at(-1)?.id ?? null);
  useEffect(() => {
    if (viewing === null || !foreground) return;
    setLastSeen((prev) => {
      const next = { ...prev, [viewing]: Date.now() };
      saveLastSeen(next);
      return next;
    });
  }, [viewing, foreground, viewingLastId]);

  const ready = state.phase === "ready";
  const candidates = useMemo(() => (ready ? waitingConversations(state, lastSeen) : []), [ready, state, lastSeen]);
  const candidatesKey = candidates.join(",");

  const latest = useRef({ state, viewing, foreground, onOpen });
  latest.current = { state, viewing, foreground, onOpen };
  /** 已经算“等你”的（停稳了的，和刚打开网页时本来就在等的）。 */
  const settled = useRef(new Set<ConversationId>());
  const timers = useRef(new Map<ConversationId, ReturnType<typeof setTimeout>>());
  const opened = useRef(false);

  const announce = useCallback((conversationId: ConversationId) => {
    const { state, viewing, foreground, onOpen } = latest.current;
    if (foreground && viewing === conversationId) return;
    if (currentPermission() !== "granted") return;
    const entry = listConversations(state).find((e) => e.id === conversationId);
    if (!entry) return;
    try {
      const notification = new Notification(`${entry.name} 等你`, {
        body: previewText(entry),
        tag: notificationTag(entry.pm?.id ?? null, conversationId),
      });
      notification.onclick = () => {
        window.focus();
        onOpen(conversationId);
        notification.close();
      };
    } catch {
      // 有的环境不让页面直接弹通知：左栏和标题照常，不弹
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const now = new Set(candidates);
    for (const [id, timer] of timers.current) {
      if (!now.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const id of settled.current) if (!now.has(id)) settled.current.delete(id);
    if (!opened.current) {
      // 刚打开网页时本来就在等的：直接算，不弹
      opened.current = true;
      for (const id of now) settled.current.add(id);
    }
    for (const id of now) {
      if (settled.current.has(id) || timers.current.has(id)) continue;
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          settled.current.add(id);
          setWaiting(new Set(settled.current));
          announce(id);
        }, WAITING_SETTLE_MS),
      );
    }
    setWaiting((prev) => (prev.size === settled.current.size && [...prev].every((id) => settled.current.has(id)) ? prev : new Set(settled.current)));
    // candidates 的内容变了才重新算；它的引用每次状态变化都是新的
  }, [ready, candidatesKey, announce]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    document.title = waiting.size > 0 ? `(${waiting.size}) ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [waiting]);

  /** 申请通知权限；浏览器要求由用户的操作触发（点按钮），所以只在点的时候调。 */
  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    try {
      await Notification.requestPermission();
    } catch {
      // 被浏览器拒了：按当前的权限状态走
    }
    setPermission(currentPermission());
  }, []);

  return { waiting, permission, requestPermission };
}
