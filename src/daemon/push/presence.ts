import { PRESENCE_STALE_MS, type ConversationId, type DeviceId, type PresenceMessage } from "../../shared/index.ts";

export interface PresenceBoard {
  report(key: object, message: PresenceMessage): void;
  remove(key: object): void;
  foreground(): boolean;
  viewing(device: DeviceId | null): ConversationId[];
}

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
