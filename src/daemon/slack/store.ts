// Slack 的绑定与投影（迁移 0034：slack_workspace、slack_channels、slack_posts；docs/slack-design.md）。
// 不变量：
// - 令牌不在这里（secrets.ts）；
// - slack_posts 是“账本里的这样东西发到了 Slack 的哪条消息”，同一个 ref 只有一行，重发、改定案、补发都先查它；
// - 换工作区时三张表在一个事务里清空。
import type { MessageId, PmId, RouterCommandId, RouterItemId } from "../../shared/domain.ts";
import type { SlackChannelId, SlackChannelTarget, SlackTeamId, SlackTs, SlackUserId } from "../../shared/slack.ts";
import type { Db } from "../store/index.ts";

export interface SlackWorkspaceRecord {
  teamId: SlackTeamId;
  teamName: string;
  botUserId: SlackUserId;
  ownerUserId: SlackUserId | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SlackChannelBinding {
  channelId: SlackChannelId;
  target: SlackChannelTarget;
  /** Slack 里现在的频道名。 */
  name: string;
  /** 上次对齐时总助或项目经理的名字。 */
  label: string;
  archivedAt: number | null;
  /** 已投影到这个频道的最大编号（项目经理频道看消息，总助频道看卡片和指令）；没有是 null。 */
  lastMessageId: MessageId | null;
  lastRouterItemId: RouterItemId | null;
  lastRouterCommandId: RouterCommandId | null;
}

/** 账本里的哪样东西：一条消息的第几段正文、第几个文件，总助的一张卡片、一条指令的回复。 */
export type SlackPostRef =
  | { kind: "message"; messageId: MessageId; part: number }
  | { kind: "file"; messageId: MessageId; part: number }
  | { kind: "router_item"; itemId: RouterItemId }
  | { kind: "router_command"; commandId: RouterCommandId };

export const SLACK_POST_STATES = ["streaming", "final", "card_pending", "card_settled"] as const;
export type SlackPostState = (typeof SLACK_POST_STATES)[number];

export interface SlackPostRecord {
  ref: SlackPostRef;
  channelId: SlackChannelId;
  ts: SlackTs;
  threadTs: SlackTs | null;
  state: SlackPostState;
  updatedAt: number;
}

export interface SlackStore {
  workspace(): SlackWorkspaceRecord | null;
  /**
   * 后置：存下工作区和机器人。teamId 和已存的不同（换了工作区）时先在同一个事务里清空三张表，ownerUserId 回到 null。
   * teamId 相同只更新名字和机器人编号，主人和频道保留。
   */
  saveWorkspace(input: { teamId: SlackTeamId; teamName: string; botUserId: SlackUserId }, now: number): SlackWorkspaceRecord;
  /** 前置：已有工作区。后置：认下主人；已有主人时原样返回（换主人要先断开）。 */
  bindOwner(userId: SlackUserId, now: number): SlackWorkspaceRecord;
  setEnabled(enabled: boolean, now: number): void;
  /** 后置：三张表清空。 */
  clear(): void;

  channels(): SlackChannelBinding[];
  channelById(channelId: SlackChannelId): SlackChannelBinding | null;
  channelOfTarget(target: SlackChannelTarget): SlackChannelBinding | null;
  /** 后置：同一个 target 只有一行（数据库唯一索引）；已有时更新频道编号和名字。 */
  upsertChannel(input: { channelId: SlackChannelId; target: SlackChannelTarget; name: string; label: string }, now: number): SlackChannelBinding;
  /** label 不给时只记 Slack 里的新名字（用户在 Slack 里改的）。 */
  renameChannel(channelId: SlackChannelId, name: string, label: string | null, now: number): void;
  /** archivedAt 为 null 是取消归档。 */
  setChannelArchived(channelId: SlackChannelId, archivedAt: number | null, now: number): void;
  /** 后置：水位只往大了改，传更小的值不变。 */
  advanceWatermark(channelId: SlackChannelId, mark: { messageId?: MessageId; routerItemId?: RouterItemId; routerCommandId?: RouterCommandId }, now: number): void;

  postOf(ref: SlackPostRef): SlackPostRecord | null;
  /** 后置：按 (频道, ts) 找回是哪样东西（按钮点击、串里接话时用）。 */
  postAt(channelId: SlackChannelId, ts: SlackTs): SlackPostRecord | null;
  /** 后置：同一个 ref 已有时覆盖 ts、state（流式消息定稿、卡片定案）。 */
  savePost(record: Omit<SlackPostRecord, "updatedAt">, now: number): void;
  /** 某个项目经理的频道里还在等拍板的卡（重连后对一遍账本现状）。 */
  pendingCards(pmId: PmId | null): SlackPostRecord[];
  /** 后置：删掉 state 为 final / card_settled 且早于 before 的行，返回删了几行。等拍板的不删。 */
  prunePosts(before: number): number;
}

export function createSlackStore(db: Db): SlackStore {
  throw new Error("未实现");
}
