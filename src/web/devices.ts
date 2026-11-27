import type { ConversationId, DeviceId, DeviceInfo, MeshLinkKind } from "../shared/index.ts";
import { formatAgo, JUST_NOW } from "./format.ts";
import type { HubState } from "./state.ts";

export type DeviceKey = DeviceId | typeof LOCAL_DEVICE;

export const LOCAL_DEVICE = "";

export const OFFLINE_AFTER_MS = 30_000;

export type DeviceStatus = "connecting" | "online" | "reconnecting" | "offline" | "unreachable";

export interface DeviceView {
  key: DeviceKey;
  info: DeviceInfo;
  state: HubState;
  status: DeviceStatus;
  lastOnlineAt: number | null;
}

export function deviceKeyOf(routeDevice: DeviceId | undefined, selfId: DeviceId | null): DeviceKey {
  return routeDevice === undefined || routeDevice === selfId ? LOCAL_DEVICE : routeDevice;
}

export function routeDeviceOf(key: DeviceKey): { device?: DeviceId } {
  return key === LOCAL_DEVICE ? {} : { device: key };
}

export function conversationKey(key: DeviceKey, id: ConversationId): string {
  return key === LOCAL_DEVICE ? String(id) : `${key}/${id}`;
}

export interface LinkHistory {
  lastOnlineAt: number | null;
  disconnectedAt: number | null;
}

export function deviceStatus(state: Pick<HubState, "phase" | "connection">, link: LinkHistory, now: number): DeviceStatus {
  if (state.phase !== "ready") return state.phase === "loading" && link.lastOnlineAt === null ? "connecting" : link.lastOnlineAt === null ? "unreachable" : "offline";
  if (state.connection === "open") return "online";
  if (link.disconnectedAt === null) return state.connection === "connecting" ? "connecting" : "reconnecting";
  return now - link.disconnectedAt < OFFLINE_AFTER_MS ? "reconnecting" : "offline";
}

export function isReadOnly(status: DeviceStatus): boolean {
  return status === "offline" || status === "unreachable";
}

function canSend(status: DeviceStatus): boolean {
  return status === "online";
}

export function platformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows";
  return platform;
}

export const LINK_LABELS: Readonly<Record<Exclude<MeshLinkKind, "local">, string>> = {
  lan: "Same network",
  relay: "Via relay",
};

const placeholderSelfCache = new Map<string, DeviceInfo>();

export function placeholderSelf(platform: string): DeviceInfo {
  const cached = placeholderSelfCache.get(platform);
  if (cached !== undefined) return cached;
  const info: DeviceInfo = { id: LOCAL_DEVICE, name: "This computer", platform, self: true, online: true, link: "local", fingerprint: null };
  if (placeholderSelfCache.size >= 8) {
    const oldest = placeholderSelfCache.keys().next().value;
    if (oldest !== undefined) placeholderSelfCache.delete(oldest);
  }
  placeholderSelfCache.set(platform, info);
  return info;
}

export function sameDeviceInfo(a: DeviceInfo, b: DeviceInfo): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.platform === b.platform &&
    a.self === b.self &&
    a.online === b.online &&
    a.link === b.link &&
    a.fingerprint === b.fingerprint
  );
}

export interface OfflineNotice {
  name: string;
  lastOnlineAt: number | null;
}

export function offlineNoticeText({ name, lastOnlineAt }: OfflineNotice, now: number): string {
  const ago = formatAgo(lastOnlineAt ?? now, now);
  return ago === JUST_NOW ? `${name} is offline. Showing content from when it disconnected` : `${name} is offline. Showing content from ${ago}`;
}

export function deviceNotices(device: Pick<DeviceView, "key" | "info" | "status" | "lastOnlineAt">) {
  if (device.key === LOCAL_DEVICE) return { offline: null, link: null };
  const { name } = device.info;
  const offline: OfflineNotice | null = device.status !== "offline" ? null : { name, lastOnlineAt: device.lastOnlineAt };
  const link = { readOnly: isReadOnly(device.status) ? `${name} is offline. Can't send messages right now` : null, waiting: !canSend(device.status) };
  return { offline, link };
}
