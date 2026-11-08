// 网页的前台上报（联机 P4，shared/api.ts 的 PresenceMessage）：每个 WebSocket 连接记最近一条。有网页在前台就不推，
// 网页自己提醒（iOS 要求每条推送都显示出来，所以只能在这边少发，不能在 Service Worker 里吞）。
import { PRESENCE_STALE_MS, type ConversationId, type DeviceId, type PresenceMessage } from "../../shared/index.ts";

export interface PresenceBoard {
  /** key 是那条连接（WebSocket 对象），断了调 remove。 */
  report(key: object, message: PresenceMessage): void;
  remove(key: object): void;
  /** 有没有网页在前台（PRESENCE_STALE_MS 内报过 visible）。 */
  foreground(): boolean;
  /** 在前台的网页正看着的这台设备的对话（device 是 null = 入口本机）。 */
  viewing(device: DeviceId | null): ConversationId[];
}

/** 网页发来的一条：不是 presence、字段不对是 null。 */
export function parsePresence(data: unknown): PresenceMessage | null {
  if (typeof data !== "string" || data.length > 1_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { type, visible, deviceId, conversationId } = value as Record<string, unknown>;
  if (type !== "presence" || typeof visible !== "boolean") return null;
  if (deviceId !== null && typeof deviceId !== "string") return null;
  if (conversationId !== null && !(typeof conversationId === "number" && Number.isSafeInteger(conversationId) && conversationId > 0)) return null;
  return { type, visible, deviceId, conversationId };
}

export function createPresenceBoard(): PresenceBoard {
  const reports = new Map<object, { message: PresenceMessage; at: number }>();
  const fresh = () => {
    const now = Date.now();
    return [...reports.values()].filter((r) => r.message.visible && now - r.at <= PRESENCE_STALE_MS).map((r) => r.message);
  };
  return {
    report: (key, message) => void reports.set(key, { message, at: Date.now() }),
    remove: (key) => void reports.delete(key),
    foreground: () => fresh().length > 0,
    viewing: (device) => fresh().flatMap((m) => (m.deviceId === device && m.conversationId !== null ? [m.conversationId] : [])),
  };
}
