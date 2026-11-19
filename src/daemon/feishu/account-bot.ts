// 全账号一个飞书机器人（docs/account-mesh-design.md「飞书：一个机器人，按群转给归属电脑」）。
// 不变量：
// - 只有持有 feishu 租约的设备（中心）连长连接；每台设备自己往飞书发自己项目群的消息，出站不经中心；
// - 中心收到的事件按群归属分流：总助单聊和本机的群本机处理，别的设备的群经组网转过去，归属设备离线时立刻在群里回一句；
// - 同一条飞书消息在归属设备上只进账本一次（clientId feishu:<message_id>），转发重试、短暂双连、暂存后再送都不会重复；
// - 群归属只信群说明里的 fusa:<设备编号>:pm:<编号> 标记和可信设备的广播，飞书消息正文里写的什么都不算。
import type { DeviceId } from "../../shared/api.ts";
import type { PmId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import type { Db } from "../store/index.ts";
import type { FeishuCardActionResponse, FeishuRawCardAction, FeishuRawEvent } from "./transport.ts";

/** 一个群归谁。 */
export type FeishuChatOwner =
  /** 主人和机器人的单聊：归中心的总助。 */
  | { kind: "router" }
  | { kind: "device"; deviceId: DeviceId; pmId: PmId }
  /** 不是 Fusa 建的群，或还没查到。 */
  | { kind: "unknown" };

/** 后置：群说明里带合法的 fusa:<设备编号>:pm:<编号> 标记时回设备和项目经理，否则 null。和 chats.ts 的 feishuChatMarker 互逆。 */
export function feishuChatOwnerOfDescription(description: string): { deviceId: DeviceId; pmId: PmId } | null {
  throw new Error("未实现");
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
  throw new Error("未实现");
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

/** 后置：给群里回的一句离线提示。queued 为 true 时说“先存着，上线后自动交给项目经理”，否则说“上线后再发”。 */
export function feishuOfflineNotice(deviceName: string, queued: boolean): string {
  throw new Error("未实现");
}

/** 后置：卡片点击时归属设备离线的 toast 文案。 */
export function feishuOfflineCardToast(deviceName: string): FeishuCardActionResponse {
  throw new Error("未实现");
}

/**
 * 卡片接口每秒预算按接着飞书的设备数平分。
 * 前置：total 是正整数。后置：devices 小于 1 时按 1 算；结果是 floor(total / devices) 和 FEISHU_CARDKIT_MIN_SHARE_PER_SECOND 里大的那个。
 */
export function feishuCardkitBudgetShare(total: number, devices: number): number {
  throw new Error("未实现");
}

/** 暂存箱里的一条。 */
export interface FeishuOfflineInboxItem {
  id: number;
  deviceId: DeviceId;
  chatId: FeishuChatId;
  event: FeishuRawEvent;
  receivedAt: number;
}

/** feishu_offline_inbox 表（migrations/0038）。只在中心上有内容。 */
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

export function createFeishuOfflineInbox(db: Db): FeishuOfflineInbox {
  throw new Error("未实现");
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

export function createFeishuAccountBot(options: FeishuAccountBotOptions): FeishuAccountBot {
  throw new Error("未实现");
}
