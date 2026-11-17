// 流式回复的状态机（docs/slack-design.md「流式与急停」）：一个项目经理对话同一时间最多一条在流式的 Slack 消息。
// 所有回复都发在频道主聊天流里：第一块文字来了先 chat.postMessage，之后按 SLACK_STREAM_UPDATE_INTERVAL_MS 用 chat.update
// 整条替换（整个工作区共用一份 SLACK_UPDATE_BUDGET_PER_MINUTE 的预算，超了只合并不排队）。
// 不变量：
// - 账本的一段文字在 Slack 里只有一条（超长时按 splitSlackMarkdown 拆的几条）：流式那条在定稿时被改成最终正文，不另发；
// - 定稿后的 Slack 正文等于账本里这段文字；
// - 流式中的消息带“停止”按钮，定稿或这一轮结束时去掉。
import type { ConversationId, MessageId } from "../../shared/domain.ts";
import type { SlackChannelId, SlackTs } from "../../shared/slack.ts";

export type SlackStreamState =
  | { phase: "idle" }
  /** 第一块文字来了，postMessage 在路上（还没有 ts）。 */
  | { phase: "opening"; text: string }
  | {
      phase: "live";
      ts: SlackTs;
      /** 已经发到 Slack 的文字。 */
      sentText: string;
      /** 最新的预览全文（可能比 sentText 新）。 */
      text: string;
      lastFlushAt: number;
    }
  /** 落库了，最终正文在路上；ts 之后归账本这条消息（slack_posts 的 message ref）。 */
  | { phase: "finalizing"; ts: SlackTs | null; messageId: MessageId };

export type SlackStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "segment_done"; messageId: MessageId; text: string }
  | { kind: "turn_end" }
  | { kind: "opened"; ts: SlackTs }
  | { kind: "tick" };

export type SlackStreamEffect =
  | { kind: "post"; text: string; withStop: boolean }
  | { kind: "update"; ts: SlackTs; text: string; withStop: boolean }
  /** 定稿：ts 为 null 表示这段没流式过，直接按最终正文发；之后记 slack_posts。 */
  | { kind: "finalize"; ts: SlackTs | null; messageId: MessageId; text: string }
  | { kind: "schedule_tick"; at: number };

export interface SlackStreamTarget {
  conversationId: ConversationId;
  channelId: SlackChannelId;
}

/**
 * 纯函数：给定现状、一个事件和现在的时间，算出新状态和要做的事。
 * 后置：
 * - idle 收到 text → opening，发 post（带停止按钮）；
 * - opening 收到 opened → live；opening 期间来的文字只记下，live 之后按间隔补上；
 * - live 收到 text：距上次刷新不足 SLACK_STREAM_UPDATE_INTERVAL_MS 只记下、发 schedule_tick，到点（tick）发 update；
 *   拿不到预算（SlackUpdateBudget）时也只记下，下一次 tick 再试；
 * - segment_done → finalizing，发 finalize（ts 为 null 时直接发最终正文）；
 * - turn_end 时还在 opening / live（这一轮被打断、没落库）：发 update 去掉停止按钮，回 idle；
 * - 同一个事件序列总得到同一个结果（不读别的状态）。
 */
export function stepSlackStream(
  state: SlackStreamState,
  event: SlackStreamEvent,
  target: SlackStreamTarget,
  now: number,
): { state: SlackStreamState; effects: SlackStreamEffect[] } {
  throw new Error("未实现");
}

/**
 * 整个工作区共用的 chat.update 预算（令牌桶）。
 * 后置：tryTake 在最近一分钟内已用满 SLACK_UPDATE_BUDGET_PER_MINUTE 次时返回 false，调用方合并到下一次；定稿的更新不走预算。
 */
export interface SlackUpdateBudget {
  tryTake(now: number): boolean;
}

export function createSlackUpdateBudget(perMinute: number): SlackUpdateBudget {
  throw new Error("未实现");
}
