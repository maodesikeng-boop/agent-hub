// “等你”提醒（m4-plan）：对话停稳了就在左栏、标签页标题和浏览器通知里提醒用户。判断在网页里算，守护进程不管。
// “等你确定”（M5）：项目经理用 hub ask 问的事不用等停稳，一来就提醒；一直提醒到用户处理（selectors.ts 的 pendingAsks）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRODUCT_NAME } from "../shared/names.ts";
import type { ConversationId } from "../shared/index.ts";
import { LOCAL_DEVICE, conversationKey, type DeviceKey } from "./devices.ts";
import { stripMarkdown } from "./plainText.ts";
import { listConversations, pendingAsks, previewText, waitingConversations, type LastSeen } from "./selectors.ts";
import type { HubState } from "./state.ts";

/** 对话要持续满足“等你”的条件这么久才算，避开 Worker 刚汇报、项目经理还没开始处理的那一瞬间。 */
export const WAITING_SETTLE_MS = 3_000;

/** 用户上次看每个对话的时间存在这个 localStorage 键里。 */
export const LAST_SEEN_KEY = `${PRODUCT_NAME}:lastSeen`;

/** 通知的 tag：同一个项目经理只留最新的一条。 */
const notificationTag = (pmId: number | null, conversationId: ConversationId) => (pmId === null ? `conversation-${conversationId}` : `pm-${pmId}`);

/** 用户有没有开通知，存在这个 localStorage 键里（"1" 开，"0" 关）；没有值或值不认识就看浏览器的授权。 */
export const NOTIFY_ENABLED_KEY = `${PRODUCT_NAME}:notifyEnabled`;

export type NotifyPermission = NotificationPermission | "unsupported";

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

/** 每台设备的“上次看过”分开存：入口本机用 LAST_SEEN_KEY（和没有联机时一样），别的设备在后面加设备编号。 */
function lastSeenKey(device: DeviceKey): string {
  return device === LOCAL_DEVICE ? LAST_SEEN_KEY : `${LAST_SEEN_KEY}:${device}`;
}

function loadLastSeen(device: DeviceKey): LastSeen {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(lastSeenKey(device)) ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as LastSeen) : {};
  } catch {
    return {};
  }
}

function saveLastSeen(device: DeviceKey, lastSeen: LastSeen): void {
  try {
    localStorage.setItem(lastSeenKey(device), JSON.stringify(lastSeen));
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

/** 提醒要看的一台设备。name 只在两台以上时用（通知标题前面加设备名）。 */
export interface ReminderDevice {
  key: DeviceKey;
  name: string;
  state: HubState;
}

/** 哪台设备的哪个对话。 */
export interface ConversationRef {
  device: DeviceKey;
  id: ConversationId;
}

/**
 * 判断所有设备的每个对话在不在“等你”、有没有“等你确定”的提问，并提醒用户：返回在“等你”的对话、有提问的对话
 * （都是 devices.ts 的 conversationKey，左栏显示）、通知权限和申请权限的函数；同时把标签页标题改成“(N) 产品名”
 * （N 是所有设备两种提醒的对话数合计，同一个对话只算一次），从“不算”变成“等你”时弹一次浏览器通知，来了新的提问马上弹一次。
 * 每台设备第一次加载好时本来就在等的、本来就有的提问直接算，不弹。
 * viewing 是用户正开着的对话（没有就是 null）；onOpen 在用户点通知时调，打开那个对话。
 */
export function useDeviceReminders(devices: readonly ReminderDevice[], viewing: ConversationRef | null, onOpen: (ref: ConversationRef) => void) {
  const foreground = useForeground();
  const [lastSeen, setLastSeen] = useState<Partial<Record<DeviceKey, LastSeen>>>({});
  const [permission, setPermission] = useState(currentPermission);
  const [notifyPref, setNotifyPref] = useState(loadNotifyPref);
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());

  // 网页在前台、正开着这个对话的时候，它的每条新消息都算看过
  const viewingDevice = viewing === null ? null : viewing.device;
  const viewingId = viewing === null ? null : viewing.id;
  const viewingState = devices.find((d) => d.key === viewingDevice)?.state;
  const viewingLastId = viewingId === null ? null : (viewingState?.conversations[viewingId]?.messages.at(-1)?.id ?? null);
  useEffect(() => {
    if (viewingDevice === null || viewingId === null || !foreground) return;
    setLastSeen((prev) => {
      const next = { ...(prev[viewingDevice] ?? loadLastSeen(viewingDevice)), [viewingId]: Date.now() };
      saveLastSeen(viewingDevice, next);
      return { ...prev, [viewingDevice]: next };
    });
  }, [viewingDevice, viewingId, foreground, viewingLastId]);

  const ready = devices.filter((d) => d.state.phase === "ready");
  // 入口本机的键是 ""，不能用 join 拼：用 JSON
  const readyKey = JSON.stringify(ready.map((d) => d.key));
  const candidates = useMemo(
    () => ready.flatMap((d) => waitingConversations(d.state, lastSeen[d.key] ?? loadLastSeen(d.key)).map((id) => ({ device: d.key, key: conversationKey(d.key, id), id }))),
    [devices, lastSeen],
  );
  const candidatesKey = candidates.map((c) => c.key).join(",");

  // 没存过偏好的老用户：授权过就是开
  const notifyEnabled = permission === "granted" && notifyPref !== false;
  const latest = useRef({ devices, viewing, foreground, onOpen, notifyEnabled });
  latest.current = { devices, viewing, foreground, onOpen, notifyEnabled };
  /** 已经算“等你”的（停稳了的，和刚打开网页时本来就在等的）。 */
  const settled = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** 已经加载好过的设备：第一次加载好时本来就在等的不弹。 */
  const opened = useRef(new Set<DeviceKey>());

  /** 弹一条通知。ask 是提问的正文（有就是“等你确定”，没有就是“等你”，正文取对话的最后一条）。 */
  const announce = useCallback((ref: ConversationRef, ask?: string) => {
    const { devices, viewing, foreground, onOpen, notifyEnabled } = latest.current;
    if (foreground && viewing !== null && viewing.device === ref.device && viewing.id === ref.id) return;
    if (!notifyEnabled || currentPermission() !== "granted") return;
    const device = devices.find((d) => d.key === ref.device);
    const entry = device && listConversations(device.state).find((e) => e.id === ref.id);
    if (!device || !entry) return;
    const prefix = devices.length > 1 ? `${device.name} · ` : "";
    const tag = `${ref.device === LOCAL_DEVICE ? "" : `${ref.device}:`}${notificationTag(entry.pm?.id ?? null, ref.id)}`;
    try {
      const notification = new Notification(`${prefix}${entry.name} ${ask === undefined ? "等你" : "等你确定"}`, {
        body: ask === undefined ? previewText(entry) : stripMarkdown(ask),
        tag: ask === undefined ? tag : `ask-${tag}`,
      });
      notification.onclick = () => {
        window.focus();
        onOpen(ref);
        notification.close();
      };
    } catch {
      // 有的环境不让页面直接弹通知：左栏和标题照常，不弹
    }
  }, []);

  useEffect(() => {
    const now = new Map(candidates.map((c) => [c.key, c]));
    for (const [key, timer] of timers.current) {
      if (!now.has(key)) {
        clearTimeout(timer);
        timers.current.delete(key);
      }
    }
    for (const key of settled.current) if (!now.has(key)) settled.current.delete(key);
    for (const device of JSON.parse(readyKey) as DeviceKey[]) {
      if (opened.current.has(device)) continue;
      // 这台刚加载好：本来就在等的直接算，不弹
      opened.current.add(device);
      for (const c of candidates) if (c.device === device) settled.current.add(c.key);
    }
    for (const c of now.values()) {
      if (settled.current.has(c.key) || timers.current.has(c.key)) continue;
      timers.current.set(
        c.key,
        setTimeout(() => {
          timers.current.delete(c.key);
          settled.current.add(c.key);
          setWaiting(new Set(settled.current));
          announce({ device: c.device, id: c.id });
        }, WAITING_SETTLE_MS),
      );
    }
    setWaiting((prev) => (prev.size === settled.current.size && [...prev].every((key) => settled.current.has(key)) ? prev : new Set(settled.current)));
    // candidates 的内容变了才重新算；它的引用每次状态变化都是新的（useMemo 跟着 devices 变）
  }, [readyKey, candidatesKey, announce]);

  // 有提问的对话：一直算到处理；新来的提问马上弹通知（每台第一次加载好时本来就有的不弹）
  const asks = useMemo(
    () =>
      ready.flatMap((d) =>
        Object.keys(d.state.conversations).flatMap((key) =>
          pendingAsks(d.state, Number(key)).map((message) => ({ device: d.key, conversationId: Number(key), message })),
        ),
      ),
    [devices],
  );
  const asking = useMemo<ReadonlySet<string>>(() => new Set(asks.map((a) => conversationKey(a.device, a.conversationId))), [asks]);
  const knownAsks = useRef(new Set<string>());
  const asksOpened = useRef(new Set<DeviceKey>());
  useEffect(() => {
    const fresh = new Set(asks.map((a) => a.device).filter((device) => !asksOpened.current.has(device)));
    for (const { device, conversationId, message } of asks) {
      const key = `${device}:${message.id}`;
      if (knownAsks.current.has(key)) continue;
      knownAsks.current.add(key);
      if (!fresh.has(device)) announce({ device, id: conversationId }, message.text);
    }
    for (const device of JSON.parse(readyKey) as DeviceKey[]) asksOpened.current.add(device);
  }, [readyKey, asks, announce]);

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

  /** 拨通知开关；浏览器要求申请权限由用户的操作触发，所以只在拨的时候申请。 */
  const setEnabled = useCallback(async (on: boolean) => {
    if (!on) {
      saveNotifyPref(false);
      setNotifyPref(false);
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
  }, []);

  const notify: NotifySettings = { permission, enabled: notifyEnabled, setEnabled };
  return { waiting, asking, notify };
}

/** 只看入口本机一台（没有联机时的样子）：在“等你”、有提问的对话编号。 */
export function useWaitingReminders(state: HubState, viewing: ConversationId | null, onOpen: (conversationId: ConversationId) => void) {
  const devices = useMemo(() => [{ key: LOCAL_DEVICE, name: "", state }], [state]);
  const reminders = useDeviceReminders(devices, viewing === null ? null : { device: LOCAL_DEVICE, id: viewing }, (ref) => onOpen(ref.id));
  const waiting = useMemo<ReadonlySet<ConversationId>>(() => new Set([...reminders.waiting].map(Number)), [reminders.waiting]);
  const asking = useMemo<ReadonlySet<ConversationId>>(() => new Set([...reminders.asking].map(Number)), [reminders.asking]);
  return { waiting, asking, notify: reminders.notify };
}
