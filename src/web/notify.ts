// “等你”提醒（m4-plan）：对话停稳了就在左栏、标签页标题和浏览器通知里提醒用户。判断在网页里算，守护进程不管。
// “等你确定”（M5）：项目经理用 hub ask 问的事不用等停稳，一来就提醒；一直提醒到用户处理（selectors.ts 的 pendingAsks）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRODUCT_NAME } from "../shared/names.ts";
import { WAITING_SETTLE_MS, notificationTag, type ConversationId, type MessageId } from "../shared/index.ts";
import { stripMarkdown } from "./plainText.ts";
import { hasPushSubscription, pushSupport, subscribePush, unsubscribePush } from "./push.ts";
import { listConversations, pendingAsks, previewText, waitingConversations, type LastSeen } from "./selectors.ts";
import type { HubState } from "./state.ts";

// 规则（等你、等你确定、停稳 3 秒、tag）在 shared/reminders.ts，和守护进程的推送共用
export { WAITING_SETTLE_MS };

/** 用户上次看每个对话的时间存在这个 localStorage 键里。 */
export const LAST_SEEN_KEY = `${PRODUCT_NAME}:lastSeen`;

/** 用户有没有开通知，存在这个 localStorage 键里（"1" 开，"0" 关）；没有值或值不认识就看浏览器的授权。 */
export const NOTIFY_ENABLED_KEY = `${PRODUCT_NAME}:notifyEnabled`;

/** install：iPhone / iPad 的 Safari 里，要先“添加到主屏幕”、从主屏打开才能开通知（联机 P4）。 */
export type NotifyPermission = NotificationPermission | "unsupported" | "install";

/** 左栏设置面板里“通知”开关要的东西。 */
export interface NotifySettings {
  permission: NotifyPermission;
  /** 开关现在是开还是关：浏览器已授权，并且用户没关。 */
  enabled: boolean;
  /** 用户拨开关。打开时浏览器还没授权就申请，被拒就仍然是关。 */
  setEnabled: (on: boolean) => Promise<void>;
}

function loadNotifyPref(): boolean | null {
  try {
    const value = localStorage.getItem(NOTIFY_ENABLED_KEY);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

function saveNotifyPref(on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_ENABLED_KEY, on ? "1" : "0");
  } catch {
    // 存不了：这次打开期间还是有效，重开以后按浏览器的授权来
  }
}

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
  if (pushSupport() === "needs-home-screen") return "install";
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/**
 * 判断每个对话在不在“等你”、有没有“等你确定”的提问，并提醒用户：返回在“等你”的对话、有提问的对话（左栏显示）、
 * 通知权限和申请权限的函数；同时把标签页标题改成“(N) 产品名”（N 是两种提醒的对话数，同一个对话只算一次），
 * 从“不算”变成“等你”时弹一次浏览器通知，来了新的提问马上弹一次。
 * viewing 是用户正开着的对话（没有就是 null）；onOpen 在用户点通知时调，打开那个对话。
 */
export function useWaitingReminders(state: HubState, viewing: ConversationId | null, onOpen: (conversationId: ConversationId) => void) {
  const foreground = useForeground();
  const [lastSeen, setLastSeen] = useState(loadLastSeen);
  const [permission, setPermission] = useState(currentPermission);
  const [notifyPref, setNotifyPref] = useState(loadNotifyPref);
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

  // 没存过偏好的老用户：授权过就是开
  const notifyEnabled = permission === "granted" && notifyPref !== false;
  const latest = useRef({ state, viewing, foreground, onOpen, notifyEnabled });
  latest.current = { state, viewing, foreground, onOpen, notifyEnabled };
  /** 已经算“等你”的（停稳了的，和刚打开网页时本来就在等的）。 */
  const settled = useRef(new Set<ConversationId>());
  const timers = useRef(new Map<ConversationId, ReturnType<typeof setTimeout>>());
  const opened = useRef(false);

  /** 弹一条通知。ask 是提问的正文（有就是“等你确定”，没有就是“等你”，正文取对话的最后一条）。 */
  const announce = useCallback((conversationId: ConversationId, ask?: string) => {
    const { state, viewing, foreground, onOpen, notifyEnabled } = latest.current;
    if (foreground && viewing === conversationId) return;
    // 这个浏览器订阅了推送：退到后台时由守护进程推（联机 P4），这里不再弹，免得同一条两遍
    if (!foreground && hasPushSubscription()) return;
    if (!notifyEnabled || currentPermission() !== "granted") return;
    const entry = listConversations(state).find((e) => e.id === conversationId);
    if (!entry) return;
    const tag = notificationTag(entry.pm?.id ?? null, conversationId);
    try {
      const notification = new Notification(`${entry.name} ${ask === undefined ? "等你" : "等你确定"}`, {
        body: ask === undefined ? previewText(entry) : stripMarkdown(ask),
        tag: ask === undefined ? tag : `ask-${tag}`,
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

  // 有提问的对话：一直算到处理；新来的提问马上弹通知（刚打开网页时本来就有的不弹）
  const asks = useMemo(
    () =>
      ready
        ? Object.keys(state.conversations).flatMap((key) => pendingAsks(state, Number(key)).map((message) => ({ conversationId: Number(key), message })))
        : [],
    [ready, state],
  );
  const asking = useMemo<ReadonlySet<ConversationId>>(() => new Set(asks.map((a) => a.conversationId)), [asks]);
  const knownAsks = useRef<Set<MessageId> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const known = (knownAsks.current ??= new Set(asks.map((a) => a.message.id)));
    for (const { conversationId, message } of asks) {
      if (known.has(message.id)) continue;
      known.add(message.id);
      announce(conversationId, message.text);
    }
  }, [ready, asks, announce]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const reminded = new Set([...waiting, ...asking]).size;
  useEffect(() => {
    document.title = reminded > 0 ? `(${reminded}) ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [reminded]);

  // 开着通知的：把这个浏览器的推送订阅再交给守护进程一次（守护进程的数据目录换过、订阅被删过也能回来）。已经订阅过的不会弹授权
  useEffect(() => {
    if (notifyEnabled) void subscribePush();
  }, [notifyEnabled]);

  /** 拨通知开关；浏览器要求申请权限由用户的操作触发，所以只在拨的时候申请。打开时顺带订阅推送（网页关了也能收到），关掉时退订。 */
  const setEnabled = useCallback(async (on: boolean) => {
    if (!on) {
      saveNotifyPref(false);
      setNotifyPref(false);
      void unsubscribePush();
      return;
    }
    if (currentPermission() === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        // 被浏览器拒了：按当前的权限状态走
      }
      setPermission(currentPermission());
    }
    const granted = currentPermission() === "granted";
    saveNotifyPref(granted);
    setNotifyPref(granted);
    if (granted) await subscribePush();
  }, []);

  const notify: NotifySettings = { permission, enabled: notifyEnabled, setEnabled };
  return { waiting, asking, notify };
}
