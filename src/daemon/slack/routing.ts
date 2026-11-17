// 入站分流（docs/slack-design.md）：一条 Slack 消息或一次点击，交给总助、交给项目经理、只记作背景、拒绝，还是不理。
// 主客权限的硬边界在这里：总助频道、按钮、急停、附件、斜杠命令只认主人；访客唤醒的轮次里高危 hub 命令由账本按
// meta.origin 再拦一次（shared/slack.ts 的 slackGuestTurnBlockReason）。
// 不变量：这里不做 I/O、不读时钟以外的状态；成员、显示名、绑定都由调用方查好放进上下文。
import type { SlackChannelMode, SlackChannelTarget, SlackContextLine, SlackMessageOrigin, SlackSpeakerRole, SlackTs, SlackUserId } from "../../shared/slack.ts";
import type { SlackCardRef } from "./cards.ts";
import type { SlackInbound, SlackInboundFile } from "./inbound.ts";

type InboundMessage = Extract<SlackInbound, { kind: "message" }>;
type InboundAction = Extract<SlackInbound, { kind: "action" }>;
type InboundNote = Extract<SlackInbound, { kind: "note_submitted" }>;

export interface SlackRoutingContext {
  /** 还没认主人时是 null：只认单聊里的绑定码，别的都不理。 */
  ownerUserId: SlackUserId | null;
  /** 这个频道绑的是谁；不是 Fusa 建的频道是 null。 */
  binding: { target: SlackChannelTarget; archived: boolean } | null;
  mode: SlackChannelMode;
  /** 发言人的显示名（调用方已查好、截好长度）。 */
  speakerName: string;
  /** 这条 ts 是不是机器人发的消息（判断“在机器人的串里接话”）。 */
  isBotMessage: (ts: SlackTs) => boolean;
  /** 单聊里的文字是不是当前有效的绑定码。 */
  isBindCode: (text: string) => boolean;
}

/** 回复挂在哪：顶层还是某个串里（跟着提问走）。 */
export interface SlackReplyAnchor {
  threadTs: SlackTs | null;
}

export type SlackMessageRoute =
  | { kind: "bind_owner"; userId: SlackUserId }
  | {
      kind: "deliver";
      target: SlackChannelTarget;
      text: string;
      origin: SlackMessageOrigin;
      /** 要下载、放进附件的文件；访客的文件不收，记在 droppedFiles。 */
      files: SlackInboundFile[];
      droppedFiles: number;
      anchor: SlackReplyAnchor;
    }
  | { kind: "context"; line: SlackContextLine }
  /** 拒绝：给发言人一条只有他看得见的提示（单聊里直接回）。 */
  | { kind: "reject"; userId: SlackUserId; reason: string }
  | { kind: "ignore" };

/**
 * 前置：message 已过 parseSlackEnvelope。
 * 后置（按顺序，命中即返回）：
 * - 单聊：没认主人且文字是有效绑定码 → bind_owner；其余单聊 → reject（提示去频道里说）；
 * - 不是 Fusa 的频道，或还没认主人 → ignore；频道对应的项目经理已归档 → reject；
 * - 总助频道：主人 → deliver；访客 → reject；
 * - 项目经理频道 solo：主人 → deliver（没有前缀的 origin）；
 * - 项目经理频道 shared：@机器人 或在机器人消息的串里接话 → deliver（带署名的 origin），否则 → context；
 * - 访客以“/”开头的文字 → reject（厂商斜杠命令只给主人）；访客带的文件不收，droppedFiles 记个数。
 * deliver 的 anchor：顶层消息回顶层，串里的消息回同一个串。
 */
export function routeSlackMessage(message: InboundMessage, ctx: SlackRoutingContext, now: number): SlackMessageRoute {
  throw new Error("未实现");
}

export type SlackActionRoute =
  | { kind: "answer"; card: SlackCardRef; optionIndex: number | null; note: string | null; clientId: string }
  | { kind: "blocker_done"; card: Extract<SlackCardRef, { kind: "blocker" }> }
  | { kind: "open_note"; triggerId: string; action: Extract<InboundAction["action"], { kind: "open_note" }> }
  | { kind: "stop"; target: SlackChannelTarget }
  | { kind: "reject"; userId: SlackUserId; reason: string }
  | { kind: "ignore" };

/**
 * 后置：不是主人点的一律 reject（“只有主人能拍板 / 停止”）；还没认主人 → ignore。
 * answer 的 clientId 由 Slack 这次点击（或弹窗提交）的编号派生：同一次点击重投得到同一个 clientId，账本按它幂等。
 */
export function routeSlackAction(input: InboundAction | InboundNote, ctx: Pick<SlackRoutingContext, "ownerUserId" | "binding">): SlackActionRoute {
  throw new Error("未实现");
}

/** 后置：userId 是主人返回 owner，否则 guest。ownerUserId 为 null 时一律 guest。 */
export function slackSpeakerRole(userId: SlackUserId, ownerUserId: SlackUserId | null): SlackSpeakerRole {
  throw new Error("未实现");
}

/**
 * 多人频道里没唤醒机器人的聊天，按频道记在内存里（重启就没了，不进账本）。
 * 不变量：每个频道最多 SLACK_CONTEXT_WINDOW_MESSAGES 条、SLACK_CONTEXT_WINDOW_CHARS 字，早于 SLACK_CONTEXT_WINDOW_MAX_AGE_MS 的丢掉；
 * 最多记 SLACK_CHANNEL_CACHE_MAX 个频道，超了丢最久没动的频道。
 */
export interface SlackContextWindows {
  record(channelId: string, line: SlackContextLine): void;
  /** 后置：返回这个频道还在窗口里的聊天（从早到晚）并清空，下一次唤醒不会再带一遍。 */
  take(channelId: string, now: number): SlackContextLine[];
  /** 频道归档、解绑、换工作区时清掉。 */
  forget(channelId: string): void;
}

export function createSlackContextWindows(): SlackContextWindows {
  throw new Error("未实现");
}
