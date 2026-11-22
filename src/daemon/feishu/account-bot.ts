import { LRUCache } from "lru-cache";
import { z } from "zod";
import { isDeviceId, type DeviceId } from "../../shared/api.ts";
import type { PmId } from "../../shared/domain.ts";
import {
  FEISHU_BRANDS,
  parseFeishuAppId,
  parseFeishuChatId,
  parseFeishuOpenId,
  type FeishuAppId,
  type FeishuBrandName,
  type FeishuChatId,
  type FeishuOpenId,
} from "../../shared/feishu.ts";
import {
  FEISHU_CARDKIT_MIN_SHARE_PER_SECOND,
  FEISHU_CHAT_CACHE_MAX,
  FEISHU_CONTROL_RETRY_MS,
  FEISHU_FORWARD_CARD_TIMEOUT_MS,
  FEISHU_FORWARD_TIMEOUT_MS,
  FEISHU_INBOUND_QUEUE_MAX,
  FEISHU_MEMBERS_RETRY_MS,
  FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE,
  FEISHU_OFFLINE_INBOX_TTL_MS,
} from "../../shared/limits.ts";
import type { Db } from "../store/index.ts";
import { feishuActionDevice } from "./cards.ts";
import type { FeishuCardActionResponse, FeishuRawCardAction, FeishuRawEvent } from "./transport.ts";

export const PEER_FEISHU_INBOUND_PATH = "/api/peer/feishu/inbound";
export const PEER_FEISHU_CHATS_PATH = "/api/peer/feishu/chats";
export const PEER_FEISHU_APP_PATH = "/api/peer/feishu/app";

const MARKER_SCAN = /(?:^|\s)fusa:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):pm:([1-9]\d*)(?=$|\s)/g;
const EXPIRY_CHECK_INTERVAL_MS = 10 * 60_000;

export type FeishuChatOwner =
  | { kind: "router" }
  | { kind: "device"; deviceId: DeviceId; pmId: PmId }
  | { kind: "unknown" };

// Chat ownership trusts only this description marker and trusted-device broadcasts, never message text.
export function feishuChatOwnerOfDescription(description: string): { deviceId: DeviceId; pmId: PmId } | null {
  for (const match of description.matchAll(MARKER_SCAN)) {
    const deviceId = match[1];
    const pmId = Number(match[2]);
    if (deviceId !== undefined && isDeviceId(deviceId) && Number.isSafeInteger(pmId) && pmId >= 1) {
      return { deviceId, pmId };
    }
  }
  return null;
}

export type FeishuInboundRoute =
  | { kind: "local" }
  | { kind: "forward"; deviceId: DeviceId }
  | { kind: "offline"; deviceId: DeviceId }
  | { kind: "ignore" };

export function routeAccountInbound(owner: FeishuChatOwner, selfId: DeviceId, isOnline: (deviceId: DeviceId) => boolean): FeishuInboundRoute {
  switch (owner.kind) {
    case "router":
      return { kind: "local" };
    case "unknown":
      return { kind: "ignore" };
    case "device":
      if (owner.deviceId === selfId) return { kind: "local" };
      return isOnline(owner.deviceId) ? { kind: "forward", deviceId: owner.deviceId } : { kind: "offline", deviceId: owner.deviceId };
  }
}

export type FeishuForwardedEvent =
  | {
      kind: "event";
      event: FeishuRawEvent;
      receivedAt: number;
      queuedAt: number | null;
    }
  | { kind: "card_action"; action: FeishuRawCardAction; receivedAt: number };

const rawResourceSchema = z.object({
  type: z.enum(["image", "file", "audio", "video", "sticker"]),
  fileKey: z.string(),
  fileName: z.string().nullable(),
});

const rawEventSchema: z.ZodType<FeishuRawEvent> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("im.message.receive_v1"),
    messageId: z.string(),
    chatId: z.string(),
    chatType: z.enum(["p2p", "group"]),
    senderOpenId: z.string(),
    senderType: z.enum(["user", "app"]),
    content: z.string(),
    mentionedBot: z.boolean(),
    threadId: z.string().nullable(),
    resources: z.array(rawResourceSchema),
    createTime: z.number(),
  }),
  z.object({
    type: z.enum(["im.chat.member.user.added_v1", "im.chat.member.user.deleted_v1"]),
    chatId: z.string(),
    openIds: z.array(z.string()),
  }),
  z.object({
    type: z.enum(["im.chat.member.bot.deleted_v1", "im.chat.disbanded_v1"]),
    chatId: z.string(),
  }),
  z.object({
    type: z.literal("im.chat.updated_v1"),
    chatId: z.string(),
    name: z.string().nullable(),
  }),
]);

const rawCardActionSchema: z.ZodType<FeishuRawCardAction> = z.object({
  token: z.string().optional(),
  messageId: z.string(),
  chatId: z.string(),
  operatorOpenId: z.string(),
  value: z.unknown(),
  option: z.string().nullable().optional(),
  formValue: z.record(z.string(), z.unknown()).nullable(),
});

export const feishuForwardedEventSchema: z.ZodType<FeishuForwardedEvent> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event"),
    event: rawEventSchema,
    receivedAt: z.number(),
    queuedAt: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("card_action"),
    action: rawCardActionSchema,
    receivedAt: z.number(),
  }),
]);

const cardActionResponseSchema: z.ZodType<FeishuCardActionResponse> = z.object({
  toast: z
    .object({
      type: z.enum(["success", "info", "warning", "error"]),
      content: z.string(),
    })
    .optional(),
});

export type FeishuPeerAppSync =
  | {
      kind: "configured";
      brand: FeishuBrandName;
      appId: FeishuAppId;
      appSecret: string;
      botOpenId: FeishuOpenId;
      botName: string;
      ownerOpenId: FeishuOpenId | null;
      routerChatId: FeishuChatId | null;
      updatedAt: number;
    }
  | {
      kind: "disconnected";
      dissolveChats: boolean;
      updatedAt: number;
    };

const feishuAppIdSchema = z.string().transform((v, ctx) => {
  const parsed = parseFeishuAppId(v);
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "appId 不对" });
    return z.NEVER;
  }
  return parsed;
});
const feishuOpenIdSchema = z.string().transform((v, ctx) => {
  const parsed = parseFeishuOpenId(v);
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "openId 不对" });
    return z.NEVER;
  }
  return parsed;
});
const feishuChatIdSchema = z.string().transform((v, ctx) => {
  const parsed = parseFeishuChatId(v);
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "chatId 不对" });
    return z.NEVER;
  }
  return parsed;
});

export const feishuPeerAppSyncSchema: z.ZodType<FeishuPeerAppSync> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("configured"),
    brand: z.enum(FEISHU_BRANDS),
    appId: feishuAppIdSchema,
    appSecret: z.string().min(1).max(256),
    botOpenId: feishuOpenIdSchema,
    botName: z.string().max(128),
    ownerOpenId: feishuOpenIdSchema.nullable(),
    routerChatId: feishuChatIdSchema.nullable(),
    updatedAt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("disconnected"),
    dissolveChats: z.boolean(),
    updatedAt: z.number().int().nonnegative(),
  }),
]);

export const feishuPeerChatsSchema = z.strictObject({
  chats: z
    .array(
      z.strictObject({
        chatId: feishuChatIdSchema,
        pmId: z.number().int().positive(),
      }),
    )
    .max(FEISHU_CHAT_CACHE_MAX),
});

export function feishuOfflineNotice(deviceName: string, queued: boolean): string {
  return queued
    ? `「${deviceName}」现在离线，这句先存着，${deviceName} 上线后自动交给项目经理。`
    : `「${deviceName}」现在离线，上线后再发。`;
}

export function feishuUnreachableNotice(deviceName: string): string {
  return `「${deviceName}」这会儿没接上，这句先存着，接上后自动交给项目经理。`;
}

export function feishuOfflineCardToast(deviceName: string): FeishuCardActionResponse {
  return { toast: { type: "warning", content: `「${deviceName}」离线，上线后再点` } };
}

export function feishuCardkitBudgetShare(total: number, devices: number): number {
  const count = devices < 1 ? 1 : Math.floor(devices);
  return Math.max(FEISHU_CARDKIT_MIN_SHARE_PER_SECOND, Math.floor(total / count));
}

export interface FeishuOfflineInboxItem {
  id: number;
  deviceId: DeviceId;
  chatId: FeishuChatId;
  event: FeishuRawEvent;
  receivedAt: number;
}

export interface FeishuOfflineInbox {
  add(deviceId: DeviceId, chatId: FeishuChatId, event: Extract<FeishuRawEvent, { type: "im.message.receive_v1" }>, receivedAt: number): "queued" | "duplicate" | "full";
  has(deviceId: DeviceId): boolean;
  list(deviceId: DeviceId): FeishuOfflineInboxItem[];
  remove(id: number): void;
  expire(now: number): { chatId: FeishuChatId; deviceId: DeviceId; count: number }[];
}

interface InboxRow {
  id: number;
  device_id: string;
  chat_id: string;
  event_json: string;
  received_at: number;
}

export function createFeishuOfflineInbox(db: Db): FeishuOfflineInbox {
  return {
    add(deviceId, chatId, event, receivedAt) {
      return db.transaction(() => {
        if (db.get("SELECT 1 FROM feishu_offline_inbox WHERE message_id = ?", event.messageId) !== undefined) {
          return "duplicate";
        }
        const { n } = db.get<{ n: number }>("SELECT count(*) AS n FROM feishu_offline_inbox WHERE device_id = ?", deviceId)!;
        if (n >= FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE) return "full";
        db.run(
          "INSERT INTO feishu_offline_inbox (device_id, chat_id, message_id, event_json, received_at) VALUES (?, ?, ?, ?, ?)",
          deviceId,
          chatId,
          event.messageId,
          JSON.stringify(event),
          receivedAt,
        );
        return "queued";
      });
    },
    has(deviceId) {
      return db.get("SELECT 1 FROM feishu_offline_inbox WHERE device_id = ? LIMIT 1", deviceId) !== undefined;
    },
    list(deviceId) {
      return db
        .all<InboxRow>("SELECT id, device_id, chat_id, event_json, received_at FROM feishu_offline_inbox WHERE device_id = ? ORDER BY id ASC", deviceId)
        .flatMap((row) => {
          const chatId = parseFeishuChatId(row.chat_id);
          if (chatId === null || !isDeviceId(row.device_id)) return [];
          try {
            const parsed = rawEventSchema.safeParse(JSON.parse(row.event_json));
            if (!parsed.success) return [];
            return [{ id: row.id, deviceId: row.device_id, chatId, event: parsed.data, receivedAt: row.received_at }];
          } catch {
            return [];
          }
        });
    },
    remove(id) {
      db.run("DELETE FROM feishu_offline_inbox WHERE id = ?", id);
    },
    expire(now) {
      const cutoff = now - FEISHU_OFFLINE_INBOX_TTL_MS;
      return db.transaction(() => {
        const expired = db
          .all<{ chat_id: string; device_id: string; count: number }>(
            "SELECT chat_id, device_id, count(*) AS count FROM feishu_offline_inbox WHERE received_at < ? GROUP BY chat_id, device_id",
            cutoff,
          )
          .flatMap((row) => {
            const chatId = parseFeishuChatId(row.chat_id);
            return chatId !== null && isDeviceId(row.device_id) ? [{ chatId, deviceId: row.device_id, count: row.count }] : [];
          });
        if (expired.length > 0) db.run("DELETE FROM feishu_offline_inbox WHERE received_at < ?", cutoff);
        return expired;
      });
    },
  };
}

export interface FeishuAccountMeshPort {
  selfId: DeviceId;
  deviceName(id: DeviceId): string | null;
  isOnline(id: DeviceId): boolean;
  post(id: DeviceId, path: string, body: unknown, timeoutMs: number): Promise<unknown>;
  onOnline(listener: (id: DeviceId) => void): () => void;
}

export interface FeishuLocalInbound {
  handleEvent(event: FeishuRawEvent, queuedAt: number | null): void;
  handleCardAction(action: FeishuRawCardAction): Promise<FeishuCardActionResponse>;
  say(chatId: FeishuChatId, text: string): Promise<void>;
  chatDescription(chatId: FeishuChatId): Promise<string | null>;
}

export interface FeishuAccountBotOptions {
  mesh: FeishuAccountMeshPort;
  local: FeishuLocalInbound;
  inbox: FeishuOfflineInbox | null;
  now?: () => number;
  log: (line: string) => void;
}

export interface FeishuAccountBot {
  onEvent(event: FeishuRawEvent): void;
  onCardAction(action: FeishuRawCardAction): Promise<FeishuCardActionResponse>;
  learnChats(from: DeviceId, chats: { chatId: FeishuChatId; pmId: PmId }[]): void;
  acceptForwarded(event: FeishuForwardedEvent): Promise<FeishuCardActionResponse | null>;
  close(): void;
}

type CachedOwner =
  | { kind: "router" }
  | { kind: "device"; deviceId: DeviceId; pmId: PmId }
  | { kind: "unknown"; retryAfter: number };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isUserMessage = (event: FeishuRawEvent): event is Extract<FeishuRawEvent, { type: "im.message.receive_v1" }> =>
  event.type === "im.message.receive_v1" && event.senderType === "user";

const deviceLabelOf = (mesh: FeishuAccountMeshPort, id: DeviceId) => mesh.deviceName(id) ?? id.slice(0, 8);

// The shared router chat carries cards from every device, so the issuing device stamped in the button decides; untrusted ids stay local and fail the owner's send-record check.
export function routeCardByIssuer(issuer: DeviceId | null, mesh: Pick<FeishuAccountMeshPort, "selfId" | "deviceName" | "isOnline">): FeishuInboundRoute {
  if (issuer === null || issuer === mesh.selfId || mesh.deviceName(issuer) === null) return { kind: "local" };
  return mesh.isOnline(issuer) ? { kind: "forward", deviceId: issuer } : { kind: "offline", deviceId: issuer };
}

async function forwardCardAction(mesh: FeishuAccountMeshPort, deviceId: DeviceId, body: FeishuForwardedEvent, log: (line: string) => void): Promise<FeishuCardActionResponse> {
  const forwardPromise = mesh.post(deviceId, PEER_FEISHU_INBOUND_PATH, body, FEISHU_FORWARD_TIMEOUT_MS);
  forwardPromise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      forwardPromise.then(
        (raw) => ({ status: "ok" as const, raw }),
        (error: unknown) => ({ status: "err" as const, error }),
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), FEISHU_FORWARD_CARD_TIMEOUT_MS);
      }),
    ]);
    if (outcome.status === "timeout") return { toast: { type: "info", content: "已收到，正在处理" } };
    if (outcome.status === "err") {
      log(`飞书中心：转卡片点击给「${deviceLabelOf(mesh, deviceId)}」没成：${errorText(outcome.error)}`);
      return feishuOfflineCardToast(deviceLabelOf(mesh, deviceId));
    }
    const parsed = cardActionResponseSchema.safeParse(outcome.raw ?? {});
    return parsed.success ? parsed.data : {};
  } finally {
    clearTimeout(timer);
  }
}

export function createFeishuAccountBot(options: FeishuAccountBotOptions): FeishuAccountBot {
  const { mesh, local, inbox, log } = options;
  const now = options.now ?? Date.now;
  const owners = new LRUCache<FeishuChatId, CachedOwner>({ max: FEISHU_CHAT_CACHE_MAX });
  const inFlightOwners = new Map<FeishuChatId, Promise<FeishuChatOwner>>();
  const noticedOfflineMessages = new LRUCache<string, true>({ max: FEISHU_CHAT_CACHE_MAX });
  const lanes = new Map<FeishuChatId, { tasks: (() => Promise<void>)[]; running: boolean }>();
  const draining = new Map<DeviceId, Promise<void>>();
  const drainRetryTimers = new Map<DeviceId, ReturnType<typeof setTimeout>>();
  let queuedTasks = 0;
  let closed = false;

  const deviceLabel = (id: DeviceId) => deviceLabelOf(mesh, id);

  const lookupOwner = (chatId: FeishuChatId): Promise<FeishuChatOwner> => {
    const current = now();
    const cached = owners.get(chatId);
    if (cached !== undefined && (cached.kind !== "unknown" || current < cached.retryAfter)) {
      return Promise.resolve(cached.kind === "unknown" ? { kind: "unknown" } : cached);
    }
    const existing = inFlightOwners.get(chatId);
    if (existing !== undefined) return existing;
    const pending = local
      .chatDescription(chatId)
      .catch((error: unknown) => {
        log(`飞书中心：查群 ${chatId} 的说明出错：${errorText(error)}`);
        return null;
      })
      .then((desc): FeishuChatOwner => {
        const parsed = desc === null ? null : feishuChatOwnerOfDescription(desc);
        if (parsed !== null) {
          const found: CachedOwner = { kind: "device", deviceId: parsed.deviceId, pmId: parsed.pmId };
          owners.set(chatId, found);
          return found;
        }
        owners.set(chatId, { kind: "unknown", retryAfter: now() + FEISHU_MEMBERS_RETRY_MS });
        return { kind: "unknown" };
      })
      .finally(() => {
        inFlightOwners.delete(chatId);
      });
    inFlightOwners.set(chatId, pending);
    return pending;
  };

  const routeCardAction = async (action: FeishuRawCardAction): Promise<FeishuInboundRoute> => {
    const chatId = parseFeishuChatId(action.chatId);
    if (chatId === null) return { kind: "local" };
    const owner = await lookupOwner(chatId);
    if (owner.kind === "device") return routeAccountInbound(owner, mesh.selfId, (id) => mesh.isOnline(id));
    return routeCardByIssuer(feishuActionDevice(action.value), mesh);
  };

  const expireInbox = async () => {
    if (inbox === null || closed) return;
    for (const item of inbox.expire(now())) {
      await local
        .say(item.chatId, `离线期间有 ${item.count} 句过了 24 小时没送到，已作废；还要办的话请再发一次。`)
        .catch((error: unknown) => log(`飞书中心：发过期提示出错：${errorText(error)}`));
    }
  };

  const holdEvent = async (deviceId: DeviceId, chatId: FeishuChatId, event: FeishuRawEvent, receivedAt: number) => {
    if (!isUserMessage(event)) return;
    const name = deviceLabel(deviceId);
    // The device still counts as online after a failed forward, so no online transition will drain the inbox for it.
    const online = mesh.isOnline(deviceId);
    if (inbox !== null) {
      await expireInbox();
      const added = inbox.add(deviceId, chatId, event, receivedAt);
      if (added === "duplicate") return;
      if (online) scheduleDrainRetry(deviceId);
      await local.say(chatId, online && added === "queued" ? feishuUnreachableNotice(name) : feishuOfflineNotice(name, added === "queued"));
      return;
    }
    if (noticedOfflineMessages.has(event.messageId)) return;
    noticedOfflineMessages.set(event.messageId, true);
    await local.say(chatId, feishuOfflineNotice(name, false));
  };

  const forwardEvent = async (deviceId: DeviceId, chatId: FeishuChatId, event: FeishuRawEvent, receivedAt: number) => {
    // Held messages go first so a later message cannot overtake them to the project manager.
    if (inbox !== null && isUserMessage(event) && inbox.has(deviceId)) {
      await drainInbox(deviceId);
      if (inbox.has(deviceId)) return holdEvent(deviceId, chatId, event, receivedAt);
    }
    const body: FeishuForwardedEvent = { kind: "event", event, receivedAt, queuedAt: null };
    try {
      await mesh.post(deviceId, PEER_FEISHU_INBOUND_PATH, body, FEISHU_FORWARD_TIMEOUT_MS);
    } catch (error) {
      log(`飞书中心：转给「${deviceLabel(deviceId)}」没成，先存着稍后补送：${errorText(error)}`);
      await holdEvent(deviceId, chatId, event, receivedAt);
    }
  };

  const processEvent = async (chatId: FeishuChatId, event: FeishuRawEvent, receivedAt: number) => {
    let owner: FeishuChatOwner;
    if (event.type === "im.message.receive_v1" && event.chatType === "p2p") {
      owners.set(chatId, { kind: "router" });
      owner = { kind: "router" };
    } else {
      owner = await lookupOwner(chatId);
    }
    const route = routeAccountInbound(owner, mesh.selfId, (id) => mesh.isOnline(id));
    switch (route.kind) {
      case "ignore":
        return;
      case "local":
        local.handleEvent(event, null);
        return;
      case "offline":
        await holdEvent(route.deviceId, chatId, event, receivedAt);
        return;
      case "forward":
        await forwardEvent(route.deviceId, chatId, event, receivedAt);
    }
  };

  const enqueueChatTask = (chatId: FeishuChatId, run: () => Promise<void>) => {
    if (closed || queuedTasks >= FEISHU_INBOUND_QUEUE_MAX) return;
    let lane = lanes.get(chatId);
    if (lane === undefined) {
      lane = { tasks: [], running: false };
      lanes.set(chatId, lane);
    }
    lane.tasks.push(run);
    queuedTasks++;
    if (lane.running) return;
    lane.running = true;
    const currentLane = lane;
    queueMicrotask(() => {
      void (async () => {
        for (let task = currentLane.tasks.shift(); task !== undefined; task = currentLane.tasks.shift()) {
          try {
            if (!closed) await task();
          } catch (error) {
            log(`飞书中心：处理入站事件出错：${errorText(error)}`);
          } finally {
            queuedTasks--;
          }
        }
        currentLane.running = false;
        if (currentLane.tasks.length === 0 && lanes.get(chatId) === currentLane) lanes.delete(chatId);
      })();
    });
  };

  const scheduleDrainRetry = (deviceId: DeviceId) => {
    if (closed || drainRetryTimers.has(deviceId)) return;
    const retry = setTimeout(() => {
      drainRetryTimers.delete(deviceId);
      if (!closed && mesh.isOnline(deviceId)) void drainInbox(deviceId);
    }, FEISHU_CONTROL_RETRY_MS);
    retry.unref?.();
    drainRetryTimers.set(deviceId, retry);
  };

  const drainInbox = (deviceId: DeviceId): Promise<void> => {
    if (inbox === null || closed) return Promise.resolve();
    const existingTimer = drainRetryTimers.get(deviceId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      drainRetryTimers.delete(deviceId);
    }
    const prev = draining.get(deviceId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await expireInbox();
        for (const item of inbox.list(deviceId)) {
          if (closed || !mesh.isOnline(deviceId)) break;
          const body: FeishuForwardedEvent = { kind: "event", event: item.event, receivedAt: now(), queuedAt: item.receivedAt };
          try {
            await mesh.post(deviceId, PEER_FEISHU_INBOUND_PATH, body, FEISHU_FORWARD_TIMEOUT_MS);
            inbox.remove(item.id);
          } catch (error) {
            log(`飞书中心：补送「${deviceLabel(deviceId)}」暂存消息没成，稍后再试：${errorText(error)}`);
            if (mesh.isOnline(deviceId)) scheduleDrainRetry(deviceId);
            break;
          }
        }
      })
      .finally(() => {
        if (draining.get(deviceId) === next) draining.delete(deviceId);
      });
    draining.set(deviceId, next);
    return next;
  };

  const offOnline = mesh.onOnline((deviceId) => {
    void drainInbox(deviceId);
  });
  const expiryTimer =
    inbox === null
      ? null
      : setInterval(() => {
          void expireInbox();
        }, EXPIRY_CHECK_INTERVAL_MS);
  expiryTimer?.unref?.();

  return {
    onEvent(event) {
      const chatId = parseFeishuChatId(event.chatId);
      if (chatId === null || closed) return;
      const receivedAt = now();
      enqueueChatTask(chatId, () => processEvent(chatId, event, receivedAt));
    },
    async onCardAction(action) {
      const route = await routeCardAction(action);
      if (route.kind === "local" || route.kind === "ignore") return local.handleCardAction(action);
      if (route.kind === "offline") return feishuOfflineCardToast(deviceLabel(route.deviceId));
      return forwardCardAction(mesh, route.deviceId, { kind: "card_action", action, receivedAt: now() }, log);
    },
    learnChats(from, chats) {
      if (!isDeviceId(from)) return;
      for (const entry of chats) {
        if ("deviceId" in entry && entry.deviceId !== from) continue;
        const chatId = parseFeishuChatId(entry.chatId);
        if (chatId === null || !Number.isSafeInteger(entry.pmId) || entry.pmId < 1) continue;
        const existing = owners.get(chatId);
        if (existing?.kind === "device" && existing.deviceId !== from) continue;
        owners.set(chatId, { kind: "device", deviceId: from, pmId: entry.pmId });
      }
    },
    async acceptForwarded(forwarded) {
      if (forwarded.kind === "event") {
        local.handleEvent(forwarded.event, forwarded.queuedAt);
        return null;
      }
      return local.handleCardAction(forwarded.action);
    },
    close() {
      if (closed) return;
      closed = true;
      offOnline();
      if (expiryTimer !== null) clearInterval(expiryTimer);
      for (const retry of drainRetryTimers.values()) clearTimeout(retry);
      drainRetryTimers.clear();
      for (const lane of lanes.values()) {
        queuedTasks -= lane.tasks.length;
        lane.tasks.length = 0;
      }
      lanes.clear();
      owners.clear();
      inFlightOwners.clear();
      noticedOfflineMessages.clear();
    },
  };
}
