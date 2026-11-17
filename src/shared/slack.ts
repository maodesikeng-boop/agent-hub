// 接入 Slack（docs/slack-design.md）：守护进程和界面服务、以后的网页设置页共用的形状。
// 不变量：
// - Slack 的编号一律先过 parseSlack*Id / parseSlackTs 变成品牌类型才进领域，领域代码不接受裸字符串；
// - 每个守护进程最多接一个 Slack 工作区，“主人”是绑定时认下的那一个 Slack 用户，别人都是访客；
// - 令牌只在 state/slack-secrets.json，不进数据库、不进任何接口响应。

import type { HubCommand } from "./hub.ts";
import type { PmId } from "./domain.ts";

declare const slackBrand: unique symbol;
type SlackBrand<T extends string> = string & { readonly [slackBrand]: T };

/** 工作区编号，如 T0123ABCD。 */
export type SlackTeamId = SlackBrand<"SlackTeamId">;
/** 频道编号（私密频道新老格式 C… / G…，单聊 D…）。 */
export type SlackChannelId = SlackBrand<"SlackChannelId">;
/** 用户编号（U… / W…）。机器人自己也有一个。 */
export type SlackUserId = SlackBrand<"SlackUserId">;
/** 消息时间戳，同时是消息在频道里的编号，如 1700000001.123456。 */
export type SlackTs = SlackBrand<"SlackTs">;

/** 后置：形状对就返回品牌值，否则 null。不查 Slack。 */
export function parseSlackTeamId(raw: unknown): SlackTeamId | null {
  throw new Error("未实现");
}

/** 后置：形状对就返回品牌值，否则 null。不查 Slack。 */
export function parseSlackChannelId(raw: unknown): SlackChannelId | null {
  throw new Error("未实现");
}

/** 后置：形状对就返回品牌值，否则 null。不查 Slack。 */
export function parseSlackUserId(raw: unknown): SlackUserId | null {
  throw new Error("未实现");
}

/** 后置：形状对就返回品牌值，否则 null。 */
export function parseSlackTs(raw: unknown): SlackTs | null {
  throw new Error("未实现");
}

/** 发言人身份：主人是绑定的那个 Slack 用户；同一工作区里的其他真人都是访客。别的工作区（Slack Connect）的人不进领域。 */
export const SLACK_SPEAKER_ROLES = ["owner", "guest"] as const;
export type SlackSpeakerRole = (typeof SLACK_SPEAKER_ROLES)[number];

/**
 * 频道模式，按频道里除机器人以外的真人数自动定：
 * - solo：只有主人，每句话直达总助或项目经理；
 * - shared：还有别人，只有在频道主聊天流里 @机器人 才唤醒，其余只记作背景。
 */
export const SLACK_CHANNEL_MODES = ["solo", "shared"] as const;
export type SlackChannelMode = (typeof SLACK_CHANNEL_MODES)[number];

/** 一个频道对应谁：总助，或某个项目经理。Worker 不建频道。 */
export type SlackChannelTarget = { kind: "router" } | { kind: "pm"; pmId: PmId };

/**
 * 从 Slack 进来的用户消息的来源，写进 UserMessageMeta.origin，发给 agent 时据此加署名（slackSpeakerPrefix）。
 * 网页发的消息没有 origin。
 */
export interface SlackMessageOrigin {
  kind: "slack";
  userId: SlackUserId;
  /** 发的那一刻的显示名，最多 SLACK_DISPLAY_NAME_MAX_CHARS 字。 */
  name: string;
  role: SlackSpeakerRole;
  mode: SlackChannelMode;
  /**
   * 多人频道里，上次唤醒之后、这句之前没唤醒机器人的聊天（按时间从早到晚），
   * 最多 SLACK_CONTEXT_WINDOW_MESSAGES 条、合计 SLACK_CONTEXT_WINDOW_CHARS 字；没有就不写。
   */
  context?: SlackContextLine[];
}

/** 一条背景聊天。 */
export interface SlackContextLine {
  name: string;
  role: SlackSpeakerRole;
  text: string;
  at: number;
}

/**
 * 发给 agent 时放在正文前的几块（交给 shared/worker.ts 的 deliveryParts 拼进 prefixes）：
 * 有背景聊天时先放一块“频道里刚才的讨论”，再放一行署名，如“【Slack · 李四（访客）】”。
 * 后置：solo 模式下主人的话返回空数组（和网页发的一样不加）；shared 模式下总有署名，写明显示名和主客身份。
 */
export function slackDeliveryPrefixes(origin: SlackMessageOrigin): string[] {
  throw new Error("未实现");
}

/**
 * 访客唤醒的那一轮里项目经理不能调的 hub 命令：建项目、挂卸文件夹、准备命令、改性格设定、拍板步骤、加定时任务。
 * 这一份是唯一定义，账本的 hubCall 按它拦。
 */
export const SLACK_GUEST_BLOCKED_HUB_COMMANDS: readonly HubCommand[] = [
  "project.create",
  "project.attach",
  "project.detach",
  "project.setup",
  "persona.edit",
  "graph.decide",
  "schedule.add",
];

/**
 * 前置：origin 是项目经理正在处理的这一轮的那条用户消息的来源（网页发的是 null）。
 * 后置：访客唤醒的轮次里调 SLACK_GUEST_BLOCKED_HUB_COMMANDS 中的命令时返回给项目经理看的拒绝原因；其余返回 null。
 */
export function slackGuestTurnBlockReason(command: HubCommand, origin: SlackMessageOrigin | null): string | null {
  throw new Error("未实现");
}

// ---- 连接状态与设置接口（界面服务与终端命令共用）----

/**
 * - unconfigured：还没填令牌；
 * - connecting：令牌对了，Socket Mode 正在连（含断线重连）；
 * - awaiting_owner：连上了，还没认主人（等主人私聊机器人发绑定码）；
 * - connected：连上了、认了主人，频道已同步；
 * - auth_failed：令牌失效或权限不够（lastError 写哪一项），不自动重试，等用户重填；
 * - disabled：用户暂停了，令牌留着。
 */
export const SLACK_CONNECTION_STATES = ["unconfigured", "connecting", "awaiting_owner", "connected", "auth_failed", "disabled"] as const;
export type SlackConnectionState = (typeof SLACK_CONNECTION_STATES)[number];

export interface SlackChannelView {
  channelId: SlackChannelId;
  target: SlackChannelTarget;
  /** Slack 里的频道名（不带 #）。 */
  name: string;
  mode: SlackChannelMode;
  /** 除主人和机器人以外的成员数。 */
  guestCount: number;
  archived: boolean;
}

/** GET /api/slack 和终端命令 status 的结果。不含任何令牌。 */
export interface SlackStatusView {
  state: SlackConnectionState;
  teamId: SlackTeamId | null;
  teamName: string | null;
  botUserId: SlackUserId | null;
  ownerUserId: SlackUserId | null;
  ownerName: string | null;
  /** 给人看的最近一次错误（auth_failed 时写缺哪个权限）；没有是 null。 */
  lastError: string | null;
  channels: SlackChannelView[];
}

/** PUT /api/slack/credentials。xoxb- 开头的机器人令牌和 xapp- 开头的应用级令牌（connections:write）。 */
export interface SlackCredentialsRequest {
  botToken: string;
  appToken: string;
}

/** POST /api/slack/bind-code：主人在 Slack 里私聊机器人发这串码，发的人就成了主人。 */
export interface SlackBindCodeResponse {
  code: string;
  expiresAt: number;
}

/** GET /api/slack/manifest：预填好的应用清单，和一键创建应用的网址（manifest 已编码进去）。 */
export interface SlackManifestResponse {
  manifest: Record<string, unknown>;
  createAppUrl: string;
}

/** POST /api/slack/disconnect。archiveChannels 为 true 时把 Fusa 建的频道一起归档。 */
export interface SlackDisconnectRequest {
  archiveChannels: boolean;
}
