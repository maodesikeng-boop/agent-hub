import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRODUCT_ID, PRODUCT_NAME } from "../shared/names.ts";
import { WAITING_SETTLE_MS, notificationTag, pendingDecisionsOf, type ConversationId } from "../shared/index.ts";
import { LOCAL_DEVICE, conversationKey, type DeviceKey } from "./devices.ts";
import { NEEDS_YOU, YOUR_TURN } from "./format.ts";
import { stripMarkdown } from "./plainText.ts";
import { hasPushSubscription, pushSupport, subscribePush, unsubscribePush } from "./push.ts";
import { allPendingAsks, askingConversations, listConversations, previewText, waitingConversations, type LastSeen } from "./selectors.ts";
import type { HubState } from "./state.ts";

function sameSessionActivities(a: HubState["sessions"], b: HubState["sessions"]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x !== y &&
      (x.sessionId !== y.sessionId ||
        x.conversationId !== y.conversationId ||
        x.pmId !== y.pmId ||
        x.generation !== y.generation ||
        x.status !== y.status ||
        x.activity !== y.activity)
    ) {
      return false;
    }
  }
  return true;
}

interface WaitingMemoEntry {
  conversations: HubState["conversations"];
  pms: HubState["pms"];
  pending: HubState["pending"];
  sessions: HubState["sessions"];
  seenKey: string;
  list: Array<{ device: DeviceKey; key: string; id: ConversationId }>;
}

interface AsksMemoEntry {
  conversations: HubState["conversations"];
  pms: HubState["pms"];
  projects: HubState["projects"];
  pending: HubState["pending"];
  routerItems: unknown;
  activeTaskGraphs: HubState["activeTaskGraphs"];
  asks: Array<{ uid: string; device: DeviceKey; conversationId: ConversationId; text: string }>;
  askingKey: string;
}

export { WAITING_SETTLE_MS };

export const LAST_SEEN_KEY = `${PRODUCT_ID}:lastSeen`;

export const NOTIFY_ENABLED_KEY = `${PRODUCT_ID}:notifyEnabled`;

export type NotifyPermission = NotificationPermission | "unsupported" | "install";

export interface NotifySettings {
  permission: NotifyPermission;
  enabled: boolean;
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
  }
}

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
  }
}

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

export interface ReminderDevice {
  key: DeviceKey;
  name: string;
  state: HubState;
}

export interface ConversationRef {
  device: DeviceKey;
  id: ConversationId;
}

export function useDeviceReminders(devices: readonly ReminderDevice[], viewing: ConversationRef | null, onOpen: (ref: ConversationRef) => void) {
  const foreground = useForeground();
  const lastSeenRef = useRef<Partial<Record<DeviceKey, LastSeen>>>({});
  const getLastSeen = (device: DeviceKey): LastSeen => {
    let seen = lastSeenRef.current[device];
    if (seen === undefined) {
      seen = loadLastSeen(device);
      lastSeenRef.current[device] = seen;
    }
    return seen;
  };
  const [permission, setPermission] = useState(currentPermission);
  const [notifyPref, setNotifyPref] = useState(loadNotifyPref);
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());

  const viewingDevice = viewing === null ? null : viewing.device;
  const viewingId = viewing === null ? null : viewing.id;
  const viewingState = devices.find((d) => d.key === viewingDevice)?.state;
  const viewingLastId = viewingId === null ? null : (viewingState?.conversations[viewingId]?.messages.at(-1)?.id ?? null);
  useEffect(() => {
    if (viewingDevice === null || viewingId === null || !foreground) return;
    const next = { ...getLastSeen(viewingDevice), [viewingId]: Date.now() };
    lastSeenRef.current[viewingDevice] = next;
    saveLastSeen(viewingDevice, next);
  }, [viewingDevice, viewingId, foreground, viewingLastId]);

  const ready = devices.filter((d) => d.state.phase === "ready");
  // The local device key is "", so join() would collide; use JSON.
  const readyKey = JSON.stringify(ready.map((d) => d.key));
  const readyKeys = useMemo(() => JSON.parse(readyKey) as DeviceKey[], [readyKey]);
  const waitingCacheRef = useRef(new Map<DeviceKey, WaitingMemoEntry>());
  const candidates = useMemo(
    () =>
      ready.flatMap((d) => {
        const seen = getLastSeen(d.key);
        const isViewing = foreground && d.key === viewingDevice && viewingId !== null;
        const effectiveSeen = isViewing ? { ...seen, [viewingId]: Date.now() } : seen;
        const seenKey = `${Object.keys(seen).length}:${isViewing ? viewingId : ""}`;
        const prev = waitingCacheRef.current.get(d.key);
        if (
          prev !== undefined &&
          prev.conversations === d.state.conversations &&
          prev.pms === d.state.pms &&
          prev.pending === d.state.pending &&
          prev.seenKey === seenKey &&
          sameSessionActivities(prev.sessions, d.state.sessions)
        ) {
          return prev.list;
        }
        const list = waitingConversations(d.state, effectiveSeen).map((id) => ({ device: d.key, key: conversationKey(d.key, id), id }));
        waitingCacheRef.current.set(d.key, {
          conversations: d.state.conversations,
          pms: d.state.pms,
          pending: d.state.pending,
          sessions: d.state.sessions,
          seenKey,
          list,
        });
        return list;
      }),
    [devices, foreground, viewingDevice, viewingId],
  );
  const candidatesKey = candidates.map((c) => c.key).join(",");

  const notifyEnabled = permission === "granted" && notifyPref !== false;
  const latest = useRef({ devices, viewing, foreground, onOpen, notifyEnabled });
  latest.current = { devices, viewing, foreground, onOpen, notifyEnabled };
  const settled = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const opened = useRef(new Set<DeviceKey>());

  const announce = useCallback((ref: ConversationRef, ask?: string) => {
    const { devices, viewing, foreground, onOpen, notifyEnabled } = latest.current;
    if (foreground && viewing !== null && viewing.device === ref.device && viewing.id === ref.id) return;
    // Push already covers background tabs; avoid a duplicate notification.
    if (!foreground && hasPushSubscription()) return;
    if (!notifyEnabled || currentPermission() !== "granted") return;
    const device = devices.find((d) => d.key === ref.device);
    const entry = device && listConversations(device.state).find((e) => e.id === ref.id);
    if (!device || !entry) return;
    const prefix = devices.length > 1 ? `${device.name} · ` : "";
    const tag = `${ref.device === LOCAL_DEVICE ? "" : `${ref.device}:`}${notificationTag(entry.pm?.id ?? null, ref.id)}`;
    try {
      const notification = new Notification(`${prefix}${entry.name}: ${ask === undefined ? YOUR_TURN : NEEDS_YOU}`, {
        body: ask === undefined ? previewText(entry) : stripMarkdown(ask),
        tag: ask === undefined ? tag : `ask-${tag}`,
      });
      notification.onclick = () => {
        window.focus();
        onOpen(ref);
        notification.close();
      };
    } catch {
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
    for (const device of readyKeys) {
      if (opened.current.has(device)) continue;
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
    // candidates is a new array on every state change; depend on its content key instead.
  }, [readyKeys, candidatesKey, announce]);

  const asksCacheRef = useRef(new Map<DeviceKey, AsksMemoEntry>());
  const { asks, askingKey } = useMemo(() => {
    const allAsks: Array<{ uid: string; device: DeviceKey; conversationId: ConversationId; text: string }> = [];
    const askingParts: string[] = [];
    for (const d of ready) {
      const prev = asksCacheRef.current.get(d.key);
      let entry = prev;
      if (
        entry === undefined ||
        entry.conversations !== d.state.conversations ||
        entry.pms !== d.state.pms ||
        entry.projects !== d.state.projects ||
        entry.pending !== d.state.pending ||
        entry.routerItems !== d.state.router.items ||
        entry.activeTaskGraphs !== d.state.activeTaskGraphs
      ) {
        const deviceId = d.key === LOCAL_DEVICE ? "local" : d.key;
        const msgItems = allPendingAsks(d.state).map(({ conversationId, message }) => ({
          uid: `ask:${d.key}:${message.id}`,
          device: d.key,
          conversationId,
          text: message.text,
        }));
        const decisionItems = pendingDecisionsOf(d.state, deviceId)
          .filter(
            (dec) =>
              dec.askMessageId === null &&
              !d.state.pending.some((p) => p.conversationId === dec.conversationId && p.phase !== "failed"),
          )
          .map((dec) => ({
            uid: `dec:${dec.key}`,
            device: d.key,
            conversationId: dec.conversationId,
            text: dec.question,
          }));
        const askingIds = [...askingConversations(d.state, deviceId)].map((id) => conversationKey(d.key, id));
        entry = {
          conversations: d.state.conversations,
          pms: d.state.pms,
          projects: d.state.projects,
          pending: d.state.pending,
          routerItems: d.state.router.items,
          activeTaskGraphs: d.state.activeTaskGraphs,
          asks: [...msgItems, ...decisionItems],
          askingKey: askingIds.join(","),
        };
        asksCacheRef.current.set(d.key, entry);
      }
      allAsks.push(...entry.asks);
      if (entry.askingKey !== "") askingParts.push(entry.askingKey);
    }
    return { asks: allAsks, askingKey: askingParts.join(",") };
  }, [devices]);
  const asking = useMemo<ReadonlySet<string>>(() => new Set(askingKey === "" ? [] : askingKey.split(",")), [askingKey]);
  const knownAsks = useRef(new Set<string>());
  const asksOpened = useRef(new Set<DeviceKey>());
  useEffect(() => {
    const fresh = new Set(asks.map((a) => a.device).filter((device) => !asksOpened.current.has(device)));
    for (const { uid, device, conversationId, text } of asks) {
      if (knownAsks.current.has(uid)) continue;
      knownAsks.current.add(uid);
      if (!fresh.has(device)) announce({ device, id: conversationId }, text);
    }
    for (const device of readyKeys) asksOpened.current.add(device);
  }, [readyKeys, asks, announce]);

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

  useEffect(() => {
    if (notifyEnabled) void subscribePush();
  }, [notifyEnabled]);

  // Browsers only grant notification permission from a user gesture, so request it here.
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
      }
      setPermission(currentPermission());
    }
    const granted = currentPermission() === "granted";
    saveNotifyPref(granted);
    setNotifyPref(granted);
    if (granted) await subscribePush();
  }, []);

  const notify = useMemo<NotifySettings>(
    () => ({ permission, enabled: notifyEnabled, setEnabled }),
    [permission, notifyEnabled, setEnabled],
  );
  return { waiting, asking, notify };
}

export function useWaitingReminders(state: HubState, viewing: ConversationId | null, onOpen: (conversationId: ConversationId) => void) {
  const devices = useMemo(() => [{ key: LOCAL_DEVICE, name: "", state }], [state]);
  const reminders = useDeviceReminders(devices, viewing === null ? null : { device: LOCAL_DEVICE, id: viewing }, (ref) => onOpen(ref.id));
  const waiting = useMemo<ReadonlySet<ConversationId>>(() => new Set([...reminders.waiting].map(Number)), [reminders.waiting]);
  const asking = useMemo<ReadonlySet<ConversationId>>(() => new Set([...reminders.asking].map(Number)), [reminders.asking]);
  return { waiting, asking, notify: reminders.notify };
}
