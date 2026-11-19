// 全账号一个飞书机器人（docs/account-mesh-design.md「飞书：一个机器人，按群转给归属电脑」）。
// 不变量：
// - 只有持有 feishu 租约的设备（中心）连长连接；每台设备自己往飞书发自己项目群的消息，出站不经中心；
// - 中心收到的事件按群归属分流：总助单聊和本机的群本机处理，别的设备的群经组网转过去，归属设备离线时立刻在群里回一句；
// - 同一条飞书消息在归属设备上只进账本一次（clientId feishu:<message_id>），转发重试、短暂双连、暂存后再送都不会重复；
// - 群归属只信群说明里的 fusa:<设备编号>:pm:<编号> 标记和可信设备的广播，飞书消息正文里写的什么都不算。
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
import type { FeishuCardActionResponse, FeishuRawCardAction, FeishuRawEvent } from "./transport.ts";

export const PEER_FEISHU_INBOUND_PATH = "/api/peer/feishu/inbound";
export const PEER_FEISHU_CHATS_PATH = "/api/peer/feishu/chats";
export const PEER_FEISHU_APP_PATH = "/api/peer/feishu/app";

const MARKER_SCAN = /(?:^|\s)fusa:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):pm:([1-9]\d*)(?=$|\s)/g;
const EXPIRY_CHECK_INTERVAL_MS = 10 * 60_000;

/** 一个群归谁。 */
export type FeishuChatOwner =
  /** 主人和机器人的单聊：归中心的总助。 */
  | { kind: "router" }
  | { kind: "device"; deviceId: DeviceId; pmId: PmId }
  /** 不是 Bellwood 建的群，或还没查到。 */
  | { kind: "unknown" };

/** 后置：群说明里带合法的 fusa:<设备编号>:pm:<编号> 标记时回设备和项目经理，否则 null。和 chats.ts 的 feishuChatMarker 互逆。 */
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

/** 中心对一个入站事件的处理方式。 */
export type FeishuInboundRoute =
  | { kind: "local" }
  | { kind: "forward"; deviceId: DeviceId }
  | { kind: "offline"; deviceId: DeviceId }
  | { kind: "ignore" };

/**
 * 后置：单聊和归属本机的群回 local；归属别的设备且在线回 forward，离线回 offline；认不出的群回 ignore。只看这三个输入。
 */
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

/** 中心经组网转给归属设备的东西（POST /api/peer/feishu/inbound 的请求体）。 */
export type FeishuForwardedEvent =
  | {
      kind: "event";
      event: FeishuRawEvent;
      /** 中心收到的时刻。 */
      receivedAt: number;
      /** 暂存过才有：原来收到的时刻，归属设备据此在正文前标“离线期间 … 发的”。 */
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

/** 可信设备之间同步飞书机器人凭证和断开状态（PUT / GET /api/peer/feishu/app，只在双向认证的 TLS 里走）。 */
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

/** 后置：给群里回的一句离线提示。queued 为 true 时说“先存着，上线后自动交给项目经理”，否则说“上线后再发”。 */
export function feishuOfflineNotice(deviceName: string, queued: boolean): string {
  return queued
    ? `「${deviceName}」现在离线，这句先存着，${deviceName} 上线后自动交给项目经理。`
    : `「${deviceName}」现在离线，上线后再发。`;
}

/** 后置：卡片点击时归属设备离线的 toast 文案。 */
export function feishuOfflineCardToast(deviceName: string): FeishuCardActionResponse {
  return { toast: { type: "warning", content: `「${deviceName}」离线，上线后再点` } };
}

/**
 * 卡片接口每秒预算按接着飞书的设备数平分。
 * 前置：total 是正整数。后置：devices 小于 1 时按 1 算；结果是 floor(total / devices) 和 FEISHU_CARDKIT_MIN_SHARE_PER_SECOND 里大的那个。
 */
export function feishuCardkitBudgetShare(total: number, devices: number): number {
  const count = devices < 1 ? 1 : Math.floor(devices);
  return Math.max(FEISHU_CARDKIT_MIN_SHARE_PER_SECOND, Math.floor(total / count));
}

/** 暂存箱里的一条。 */
export interface FeishuOfflineInboxItem {
  id: number;
  deviceId: DeviceId;
  chatId: FeishuChatId;
  event: FeishuRawEvent;
  receivedAt: number;
}

/** feishu_offline_inbox 表（migrations/0042）。只在中心上有内容。 */
export interface FeishuOfflineInbox {
  /** 后置：同一条飞书消息只存一次（重复回 duplicate）；这台已满 FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE 条回 full，不存。 */
  add(deviceId: DeviceId, chatId: FeishuChatId, event: Extract<FeishuRawEvent, { type: "im.message.receive_v1" }>, receivedAt: number): "queued" | "duplicate" | "full";
  /** 后置：按收到的顺序返回这台的全部，不删。 */
  list(deviceId: DeviceId): FeishuOfflineInboxItem[];
  /** 后置：送达后删掉这一条。 */
  remove(id: number): void;
  /** 后置：删掉 receivedAt 早于 now - FEISHU_OFFLINE_INBOX_TTL_MS 的，按群返回删了几条（调用方在群里说一声）。 */
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

/** 中心用到的组网能力（daemon/mesh 的 Mesh 的一部分）。 */
export interface FeishuAccountMeshPort {
  selfId: DeviceId;
  deviceName(id: DeviceId): string | null;
  isOnline(id: DeviceId): boolean;
  /** 经组网 POST 一个 JSON 给那台；对方离线、超时抛错。 */
  post(id: DeviceId, path: string, body: unknown, timeoutMs: number): Promise<unknown>;
  /** 那台从离线变成在线时调。 */
  onOnline(listener: (id: DeviceId) => void): () => void;
}

/** 本机飞书服务交给中心路由的能力（FeishuService 实现）。 */
export interface FeishuLocalInbound {
  /** 本机处理一个入站事件（和自己的长连接收到时一样）。 */
  handleEvent(event: FeishuRawEvent, queuedAt: number | null): void;
  handleCardAction(action: FeishuRawCardAction): Promise<FeishuCardActionResponse>;
  /** 往群里发一句纯文本（离线提示、过期提示）。 */
  say(chatId: FeishuChatId, text: string): Promise<void>;
  /** 调 chat.get 读群说明。群没了回 null。 */
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
  /** 中心的长连接收到一个事件。后置：按 routeAccountInbound 处理；转发失败按离线处理；同步返回，重活在队列里。 */
  onEvent(event: FeishuRawEvent): void;
  /**
   * 中心的长连接收到一次卡片点击。
   * 后置：本机的直接处理；别的设备在线时转过去，最多等 FEISHU_FORWARD_CARD_TIMEOUT_MS 拿它的 toast，超时回“已收到，正在处理”；离线回 feishuOfflineCardToast。
   */
  onCardAction(action: FeishuRawCardAction): Promise<FeishuCardActionResponse>;
  /** 可信设备广播的群归属（它对齐完群之后发）。后置：更新缓存；只收它自己设备编号的群。 */
  learnChats(from: DeviceId, chats: { chatId: FeishuChatId; pmId: PmId }[]): void;
  /** 归属设备收到中心转来的东西（POST /api/peer/feishu/inbound）。后置：当成本机长连接收到的处理；卡片点击回 toast。 */
  acceptForwarded(event: FeishuForwardedEvent): Promise<FeishuCardActionResponse | null>;
  close(): void;
}

type CachedOwner =
  | { kind: "router" }
  | { kind: "device"; deviceId: DeviceId; pmId: PmId }
  | { kind: "unknown"; retryAfter: number };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

  const deviceLabel = (id: DeviceId) => mesh.deviceName(id) ?? id.slice(0, 8);

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

  const expireInbox = async () => {
    if (inbox === null || closed) return;
    for (const item of inbox.expire(now())) {
      await local
        .say(item.chatId, `离线期间有 ${item.count} 句过了 24 小时没送到，已作废；还要办的话请再发一次。`)
        .catch((error: unknown) => log(`飞书中心：发过期提示出错：${errorText(error)}`));
    }
  };

  const handleOfflineEvent = async (deviceId: DeviceId, chatId: FeishuChatId, event: FeishuRawEvent, receivedAt: number) => {
    if (event.type !== "im.message.receive_v1" || event.senderType !== "user") return;
    const name = deviceLabel(deviceId);
    if (inbox !== null) {
      await expireInbox();
      const added = inbox.add(deviceId, chatId, event, receivedAt);
      if (added === "duplicate") return;
      await local.say(chatId, feishuOfflineNotice(name, added === "queued"));
      return;
    }
    if (noticedOfflineMessages.has(event.messageId)) return;
    noticedOfflineMessages.set(event.messageId, true);
    await local.say(chatId, feishuOfflineNotice(name, false));
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
        await handleOfflineEvent(route.deviceId, chatId, event, receivedAt);
        return;
      case "forward": {
        const body: FeishuForwardedEvent = { kind: "event", event, receivedAt, queuedAt: null };
        try {
          await mesh.post(route.deviceId, PEER_FEISHU_INBOUND_PATH, body, FEISHU_FORWARD_TIMEOUT_MS);
        } catch (error) {
          log(`飞书中心：转给「${deviceLabel(route.deviceId)}」没成，改按离线处理：${errorText(error)}`);
          await handleOfflineEvent(route.deviceId, chatId, event, receivedAt);
        }
      }
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
            if (!closed && mesh.isOnline(deviceId) && !drainRetryTimers.has(deviceId)) {
              const retry = setTimeout(() => {
                drainRetryTimers.delete(deviceId);
                if (!closed && mesh.isOnline(deviceId)) void drainInbox(deviceId);
              }, FEISHU_CONTROL_RETRY_MS);
              retry.unref?.();
              drainRetryTimers.set(deviceId, retry);
            }
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
      const chatId = parseFeishuChatId(action.chatId);
      if (chatId === null) return local.handleCardAction(action);
      const owner = await lookupOwner(chatId);
      const route = routeAccountInbound(owner, mesh.selfId, (id) => mesh.isOnline(id));
      if (route.kind === "local" || route.kind === "ignore") return local.handleCardAction(action);
      if (route.kind === "offline") return feishuOfflineCardToast(deviceLabel(route.deviceId));
      const body: FeishuForwardedEvent = { kind: "card_action", action, receivedAt: now() };
      const forwardPromise = mesh.post(route.deviceId, PEER_FEISHU_INBOUND_PATH, body, FEISHU_FORWARD_TIMEOUT_MS);
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
          log(`飞书中心：转卡片点击给「${deviceLabel(route.deviceId)}」没成：${errorText(outcome.error)}`);
          return feishuOfflineCardToast(deviceLabel(route.deviceId));
        }
        const parsed = cardActionResponseSchema.safeParse(outcome.raw ?? {});
        return parsed.success ? parsed.data : {};
      } finally {
        clearTimeout(timer);
      }
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
