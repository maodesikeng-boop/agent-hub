// 接入飞书（docs/feishu-design.md）：守护进程、界面服务、终端命令和以后的网页设置页共用的形状。
// 不变量：
// - 飞书的编号一律先过 parseFeishu* 变成品牌类型才进领域，领域代码不接受裸字符串；
// - 每个守护进程只接一个飞书自建应用（长连接是集群模式，同一个应用连两台会随机分走事件）；
// - “主人”只有一个：扫码建应用的那个人（或手动接入后私聊机器人发绑定码的人）。总助单聊、全局设置永远只认主人；
// - App Secret 只在 state/feishu-secrets.json，不进数据库、不进任何接口响应。

import type { HubCommand } from "./hub.ts";
import type { PmId } from "./domain.ts";

declare const feishuBrand: unique symbol;
type FeishuBrand<T extends string> = string & { readonly [feishuBrand]: T };

/** 应用编号，cli_ 开头。 */
export type FeishuAppId = FeishuBrand<"FeishuAppId">;
/** 用户在这个应用里的编号，ou_ 开头。机器人自己也有一个。 */
export type FeishuOpenId = FeishuBrand<"FeishuOpenId">;
/** 会话编号，oc_ 开头（群和单聊都是）。 */
export type FeishuChatId = FeishuBrand<"FeishuChatId">;
/** 消息编号，om_ 开头。 */
export type FeishuMessageId = FeishuBrand<"FeishuMessageId">;
/** 卡片实体编号（cardkit/v1/cards 返回的 card_id），流式卡片按它更新。 */
export type FeishuCardId = FeishuBrand<"FeishuCardId">;
/** 上传图片得到的 image_key（群头像、图片消息）。 */
export type FeishuImageKey = FeishuBrand<"FeishuImageKey">;

/** 后置：形状对（cli_ 开头、只含字母数字）返回品牌值，否则 null。不查飞书。 */
export function parseFeishuAppId(raw: unknown): FeishuAppId | null {
  throw new Error("未实现");
}

/** 后置：形状对（ou_ 开头）返回品牌值，否则 null。 */
export function parseFeishuOpenId(raw: unknown): FeishuOpenId | null {
  throw new Error("未实现");
}

/** 后置：形状对（oc_ 开头）返回品牌值，否则 null。 */
export function parseFeishuChatId(raw: unknown): FeishuChatId | null {
  throw new Error("未实现");
}

/** 后置：形状对（om_ 开头）返回品牌值，否则 null。 */
export function parseFeishuMessageId(raw: unknown): FeishuMessageId | null {
  throw new Error("未实现");
}

/** 后置：非空、只含数字和字母的字符串返回品牌值，否则 null。 */
export function parseFeishuCardId(raw: unknown): FeishuCardId | null {
  throw new Error("未实现");
}

/** 后置：非空字符串返回品牌值，否则 null。 */
export function parseFeishuImageKey(raw: unknown): FeishuImageKey | null {
  throw new Error("未实现");
}

/** 飞书还是 Lark（国际版）：决定开放平台域名。扫码建应用时由 registerApp 返回，手动接入时用户选。 */
export const FEISHU_BRANDS = ["feishu", "lark"] as const;
export type FeishuBrandName = (typeof FEISHU_BRANDS)[number];

/** 发言人身份：主人是绑定的那个人；同一企业里被拉进项目群的其他真人都是访客。外部企业的人不进领域。 */
export const FEISHU_SPEAKER_ROLES = ["owner", "guest"] as const;
export type FeishuSpeakerRole = (typeof FEISHU_SPEAKER_ROLES)[number];

/**
 * 群里现在几个人，按除机器人以外的真人数实时定：
 * - solo：只有主人；
 * - shared：还有别人。
 */
export const FEISHU_CHAT_MODES = ["solo", "shared"] as const;
export type FeishuChatMode = (typeof FEISHU_CHAT_MODES)[number];

/**
 * 群里什么话会唤醒项目经理（用户 2026-11-18 拍板：单人群直聊，拉人进群后自动切 @机器人 才触发）：
 * - auto（默认）：solo 时每句话都送达；shared 时只有 @机器人 的话送达，别的话记成背景；
 * - mention_only：不管几个人，一律 @机器人 才送达。主人按群手动切。
 */
export const FEISHU_TRIGGER_MODES = ["auto", "mention_only"] as const;
export type FeishuTriggerMode = (typeof FEISHU_TRIGGER_MODES)[number];

/**
 * 访客权限档位，按项目群设，默认 chat_only：
 * - chat_only：访客 @机器人 能和项目经理对话；拍板、停止、发附件只认主人；
 * - collaborator：再放开拍板卡、停止、发附件；
 * - observer：访客说话不唤醒项目经理，只记成背景，主人下次唤醒时一起交给项目经理。
 * 不管哪一档，越出这个项目的操作（建项目、挂卸文件夹、准备命令、改性格设定）在访客的话触发的轮次里都由账本拦下。
 */
export const FEISHU_GUEST_TIERS = ["chat_only", "collaborator", "observer"] as const;
export type FeishuGuestTier = (typeof FEISHU_GUEST_TIERS)[number];

/** 访客想做的事。 */
export type FeishuGuestAction = "talk" | "answer_card" | "stop" | "send_files";

/** 后置：按上面档位的定义回答这一档的访客能不能做这件事。这张表是访客权限的唯一定义。 */
export function feishuGuestMay(tier: FeishuGuestTier, action: FeishuGuestAction): boolean {
  throw new Error("未实现");
}

/** 一个会话对应谁：总助（主人和机器人的单聊），或某个项目经理的群。Worker 不建群。 */
export type FeishuChatTarget = { kind: "router" } | { kind: "pm"; pmId: PmId };

/** 群里没 @机器人 的一句话，记在内存近窗里，下次唤醒时当背景捎给项目经理。 */
export interface FeishuContextLine {
  name: string;
  role: FeishuSpeakerRole;
  text: string;
  at: number;
}

/**
 * 从飞书进来的用户消息的来源，实现步骤写进 UserMessageMeta.origin，发给 agent 时据此加署名和背景（feishuDeliveryPrefixes）。
 * 网页发的消息没有 origin。
 */
export interface FeishuMessageOrigin {
  kind: "feishu";
  openId: FeishuOpenId;
  /** 发的那一刻的显示名，最多 FEISHU_DISPLAY_NAME_MAX_CHARS 字。 */
  name: string;
  role: FeishuSpeakerRole;
  mode: FeishuChatMode;
  /** 这一轮的访客档位；主人的话也记，账本据此决定拦哪些 hub 命令（见 feishuGuestTurnBlockReason）。 */
  guestTier: FeishuGuestTier;
  /** 上次唤醒以来群里没 @机器人 的话，按时间先后，最多 FEISHU_CONTEXT_MAX_LINES 行、FEISHU_CONTEXT_MAX_CHARS 字。 */
  context: FeishuContextLine[];
}

/**
 * 发给 agent 时放在正文前的几段（交给 shared/worker.ts 的 deliveryParts 拼进 prefixes）。
 * 后置：
 * - solo 下主人的话、没有背景时返回空数组（和网页发的一样）；
 * - shared 下有一行署名，写明显示名和主人或访客，如“【飞书 · 李四（访客）】”；
 * - context 不为空时多一段“群里之前的讨论”，每行“名字（主人/访客）：原话”。
 */
export function feishuDeliveryPrefixes(origin: FeishuMessageOrigin): string[] {
  throw new Error("未实现");
}

/**
 * 访客的话触发的那一轮里项目经理不能调的 hub 命令，按档位列。这是唯一定义，账本的 hubCall 按它拦。
 * 越出项目的几件每一档都拦；chat_only 和 observer 再拦拍板步骤和加定时任务。
 */
export const FEISHU_GUEST_BLOCKED_HUB_COMMANDS: Readonly<Record<FeishuGuestTier, readonly HubCommand[]>> = {
  chat_only: ["project.create", "project.attach", "project.detach", "project.setup", "persona.edit", "graph.decide", "schedule.add"],
  collaborator: ["project.create", "project.attach", "project.detach", "project.setup", "persona.edit"],
  observer: ["project.create", "project.attach", "project.detach", "project.setup", "persona.edit", "graph.decide", "schedule.add"],
};

/**
 * 前置：origin 是项目经理正在处理的这一轮的那条用户消息的来源（网页发的是 null）。
 * 后置：访客的话触发的轮次里调本档 FEISHU_GUEST_BLOCKED_HUB_COMMANDS 中的命令时，返回给项目经理看的拒绝原因；
 * 主人的话、网页的话、不在表里的命令返回 null。
 */
export function feishuGuestTurnBlockReason(command: HubCommand, origin: FeishuMessageOrigin | null): string | null {
  throw new Error("未实现");
}

// ---- 连接状态与设置接口（界面服务与终端命令共用）----

/**
 * - unconfigured：还没接应用；
 * - registering：二维码已出，等主人扫码确认；
 * - connecting：有凭证，长连接正在连（含断线重连）；
 * - awaiting_owner：手动接入、连上了，还没认主人（等主人私聊机器人发绑定码）；
 * - needs_permission：连上了，但应用缺权限或事件（missing 写哪几项），缺的功能先降级；
 * - connected：连上了、认了主人、权限齐，群已同步；
 * - auth_failed：凭证失效（lastError 写原因），不自动重试，等用户重新扫码或重填；
 * - disabled：用户暂停了，凭证留着。
 */
export const FEISHU_CONNECTION_STATES = [
  "unconfigured",
  "registering",
  "connecting",
  "awaiting_owner",
  "needs_permission",
  "connected",
  "auth_failed",
  "disabled",
] as const;
export type FeishuConnectionState = (typeof FEISHU_CONNECTION_STATES)[number];

export interface FeishuChatView {
  chatId: FeishuChatId;
  target: FeishuChatTarget;
  /** 飞书里的群名（单聊是机器人名）。 */
  name: string;
  mode: FeishuChatMode;
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  /** 除主人和机器人以外的成员数。 */
  guestCount: number;
  archived: boolean;
}

/** GET 状态接口和终端命令 status 的结果。不含 App Secret。 */
export interface FeishuStatusView {
  state: FeishuConnectionState;
  brand: FeishuBrandName | null;
  appId: FeishuAppId | null;
  botName: string | null;
  ownerOpenId: FeishuOpenId | null;
  ownerName: string | null;
  /** registering 时的扫码链接和过期时间；别的状态是 null。 */
  registration: FeishuRegistrationView | null;
  /** needs_permission 时缺的权限或事件名（如 im:message.group_msg）。 */
  missing: string[];
  /** 给人看的最近一次错误；没有是 null。 */
  lastError: string | null;
  chats: FeishuChatView[];
}

export interface FeishuRegistrationView {
  /** 飞书给的确认页链接，网页画成二维码，终端直接打印成二维码。 */
  url: string;
  expiresAt: number;
}

/** 手动接入（扫码建应用的兜底）：开发者后台复制的 App ID 和 App Secret。 */
export interface FeishuCredentialsRequest {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
}

/** 主人手动接入后私聊机器人发这串码，发的人就成了主人。扫码建应用时不需要（registerApp 直接给了扫码人）。 */
export interface FeishuBindCodeResponse {
  code: string;
  expiresAt: number;
}

/** 改一个项目群的唤醒方式和访客档位；不给的字段不变。 */
export interface FeishuChatPolicyRequest {
  pmId: PmId;
  triggerMode?: FeishuTriggerMode;
  guestTier?: FeishuGuestTier;
}

/** 断开。dissolveChats 为 true 时把 Fusa 建的项目群一起解散（聊天记录随群消失），默认 false：群留着，只停机器人。 */
export interface FeishuDisconnectRequest {
  dissolveChats: boolean;
}
