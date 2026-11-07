// 联机（docs/multi-device-design.md 第 4 节）：网页同时连好几台设备，每台一份 HubState，按设备编号放在一张表里。
// 这里是纯函数和类型：设备的键、连接状态怎么算、对话的全局键。网络和定时器在 device-hub.ts。
//
// 键：入口本机是 LOCAL_DEVICE（""，不是合法的 UUID，不会和真设备撞）；别的设备是它的 DeviceId。
// 只有一台（入口本机）时界面和没有联机时一模一样：所有“按设备”的显示都看 devices.length > 1。
import { devicePath, type ConversationId, type DeviceId, type DeviceInfo } from "../shared/index.ts";
import { formatAgo } from "./format.ts";
import type { HubState } from "./state.ts";

export type DeviceKey = DeviceId | typeof LOCAL_DEVICE;

/** 入口本机的键。 */
export const LOCAL_DEVICE = "";

/** 断线超过这么久从“重连中”变成“离线”（第 4.3 节）。 */
export const OFFLINE_AFTER_MS = 30_000;

/**
 * 一台设备现在能不能用：
 * - connecting：第一次拉快照还没回来；
 * - online：WebSocket 开着；
 * - reconnecting：断了不到 OFFLINE_AFTER_MS，内容照常、能打字，发送等连上；
 * - offline：断了更久，内容只读、输入框禁用；
 * - unreachable：这次打开网页以来一次都没连上（没有内容可显示）。
 */
export type DeviceStatus = "connecting" | "online" | "reconnecting" | "offline" | "unreachable";

/** 网页里的一台设备：清单里的信息 + 它自己的那份状态。 */
export interface DeviceView {
  key: DeviceKey;
  info: DeviceInfo;
  state: HubState;
  status: DeviceStatus;
  /** 最后一次连着的时间（毫秒）；从没连上过是 null。 */
  lastOnlineAt: number | null;
}

/** 一台设备的接口前缀：入口本机是 ""，别的是 /d/<设备编号>。 */
export function deviceBase(key: DeviceKey): string {
  return devicePath(key === LOCAL_DEVICE ? null : key, "");
}

/** 网址里的设备（undefined = 入口本机；写的是入口自己的编号也算本机）→ 表里的键。 */
export function deviceKeyOf(routeDevice: DeviceId | undefined, selfId: DeviceId | null): DeviceKey {
  return routeDevice === undefined || routeDevice === selfId ? LOCAL_DEVICE : routeDevice;
}

/** 表里的键 → 网址里的设备（入口本机不写，老网址的样子）。 */
export function routeDeviceOf(key: DeviceKey): { device?: DeviceId } {
  return key === LOCAL_DEVICE ? {} : { device: key };
}

/** 对话的全局键：各台的对话编号是本机自增的，会撞号；入口本机的就是编号本身（和没有联机时存的一样）。 */
export function conversationKey(key: DeviceKey, id: ConversationId): string {
  return key === LOCAL_DEVICE ? String(id) : `${key}/${id}`;
}

/** 连接的经历（device-hub.ts 记）：最后一次连上、这次断开的时间。 */
export interface LinkHistory {
  lastOnlineAt: number | null;
  disconnectedAt: number | null;
}

/** 按状态和连接的经历算出设备状态。 */
export function deviceStatus(state: Pick<HubState, "phase" | "connection">, link: LinkHistory, now: number): DeviceStatus {
  if (state.phase !== "ready") return state.phase === "loading" && link.lastOnlineAt === null ? "connecting" : link.lastOnlineAt === null ? "unreachable" : "offline";
  if (state.connection === "open") return "online";
  if (link.disconnectedAt === null) return state.connection === "connecting" ? "connecting" : "reconnecting";
  return now - link.disconnectedAt < OFFLINE_AFTER_MS ? "reconnecting" : "offline";
}

/** 内容只读、输入框禁用。 */
export function isReadOnly(status: DeviceStatus): boolean {
  return status === "offline" || status === "unreachable";
}

/** 能发消息：只有连着的时候（重连中能打字，发送等连上）。 */
export function canSend(status: DeviceStatus): boolean {
  return status === "online";
}

/** 系统名（设备清单的 platform 是 process.platform）。 */
export function platformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "win32") return "Windows";
  return platform;
}

/** 还没拉到设备清单（或者守护进程还没有联机）时，入口本机的样子。 */
export function placeholderSelf(platform: string): DeviceInfo {
  return { id: LOCAL_DEVICE, name: "本机", platform, self: true, url: null };
}

/**
 * 别的设备连不上时对话里怎么显示（第 4.3 节）：offline 是顶上的提示（只在离线时）；link 是输入框的样子（Composer 的 link）。
 * 入口本机照旧（它连不上是整页的“连不上守护进程”和“重连中”），两样都是 null。
 */
export function deviceNotices(device: Pick<DeviceView, "key" | "info" | "status" | "lastOnlineAt">, now: number = Date.now()) {
  if (device.key === LOCAL_DEVICE) return { offline: null, link: null };
  const { name } = device.info;
  const ago = formatAgo(device.lastOnlineAt ?? now, now);
  const offline = device.status !== "offline" ? null : ago === "刚刚" ? `${name}离线，显示的是刚断线时的内容` : `${name}离线，显示的是 ${ago}的内容`;
  const link = { readOnly: isReadOnly(device.status) ? `${name}离线，暂时不能发消息` : null, waiting: !canSend(device.status) };
  return { offline, link };
}
