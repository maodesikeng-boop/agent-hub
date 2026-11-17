// 频道成员与发言人显示名（docs/slack-design.md）：直接用 Slack 私密频道的成员关系当“谁能参与”的名单，不另造白名单。
// 不变量：
// - 成员由 member_joined_channel / member_left_channel 实时改；连上、重连、过了 SLACK_MEMBERS_TTL_MS 再整份对一遍；
//   查失败只记 SLACK_MEMBERS_RETRY_MS，期间按“有访客”（shared）处理，宁可少唤醒也不误把访客当单人频道；
// - 显示名按 SLACK_USER_CACHE_TTL_MS 缓存，最多 SLACK_USER_CACHE_MAX 人；查失败记 SLACK_USER_CACHE_RETRY_MS，期间用用户编号当名字；
// - 换工作区、断开时整份清掉。
import type { SlackChannelId, SlackChannelMode, SlackUserId } from "../../shared/slack.ts";
import type { SlackTransport } from "./transport.ts";

/**
 * 后置：members 里除 owner、bot 以外的人数是 guestCount；为 0 时 solo，否则 shared。owner 为 null 时也按这个算（不排除任何人）。
 */
export function slackChannelModeOf(
  members: ReadonlySet<SlackUserId>,
  owner: SlackUserId | null,
  bot: SlackUserId,
): { mode: SlackChannelMode; guestCount: number } {
  throw new Error("未实现");
}

export interface SlackDirectory {
  /** 后置：这个频道现在的模式；缓存过期或没有时先查 conversations.members（分页，最多 SLACK_CHANNEL_MEMBERS_MAX 人）。 */
  modeOf(channelId: SlackChannelId): Promise<{ mode: SlackChannelMode; guestCount: number }>;
  /** 后置：主人在不在这个频道（频道同步用来决定要不要拉主人进来）。 */
  hasMember(channelId: SlackChannelId, userId: SlackUserId): Promise<boolean>;
  /** 成员事件：只改已缓存的频道，没缓存的等下次查。 */
  applyMembership(channelId: SlackChannelId, userId: SlackUserId, joined: boolean): void;
  /** 后置：显示名（display_name，没有用 real_name），截到 SLACK_DISPLAY_NAME_MAX_CHARS 字。 */
  nameOf(userId: SlackUserId): Promise<string>;
  /** 重连后调：所有频道成员都标成过期。 */
  invalidateMembers(): void;
  forgetChannel(channelId: SlackChannelId): void;
  clear(): void;
}

export function createSlackDirectory(options: {
  transport: SlackTransport;
  botUserId: SlackUserId;
  ownerUserId: () => SlackUserId | null;
  now?: () => number;
}): SlackDirectory {
  throw new Error("未实现");
}
