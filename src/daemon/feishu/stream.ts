// 流式回复的状态机（docs/feishu-design.md「流式与急停」）：用卡片 JSON 2.0 的流式更新模式（streaming_mode），
// 飞书客户端按全量文本自己算增量、打字机上屏。一个项目经理对话同一时间最多一张在流式的卡片。
// 流程：第一块文字来了 → 建卡片实体（streaming_mode 开、带停止按钮）并发到群主聊天流 → 之后按 FEISHU_STREAM_FLUSH_MS
// 调“流式更新文本”推全文 → 一段落库时把正文换成账本里这段文字、关掉流式模式、删掉停止按钮。
// 不变量：
// - 账本的一段文字在飞书里只对应一张卡（超过 FEISHU_CARD_MAX_CHARS 时按 splitFeishuMarkdown 续到下一张），定稿后卡片正文等于账本这段文字，不另发；
// - 同一张卡片实体上的操作 sequence 严格递增（状态里记着，落库在 feishu_posts.sequence）；
// - 每张卡两次推送间隔不小于 FEISHU_STREAM_FLUSH_MS（飞书每张卡 10 次/秒）；整个应用共用 FEISHU_CARDKIT_BUDGET_PER_SECOND 的预算
//   （“流式更新文本”接口 50 次/秒），拿不到预算只合并不排队；定稿不走预算、不丢；
// - 流式模式开了 10 分钟会被飞书自动关掉：开着超过 FEISHU_STREAM_RENEW_MS 时续开一次；
// - 流式模式开着时，卡片回调响应不能改卡片：停止按钮的点击只回 toast，卡片由这一轮结束时的定稿改。
import type { ConversationId, MessageId } from "../../shared/domain.ts";
import type { FeishuCardId, FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";

export type FeishuStreamState =
  | { phase: "idle" }
  /** 第一块文字来了，建卡和发消息在路上。 */
  | { phase: "opening"; text: string }
  | {
      phase: "live";
      cardId: FeishuCardId;
      messageId: FeishuMessageId;
      /** 这张卡片上一次操作用的 sequence。 */
      sequence: number;
      /** 已推到飞书的全文。 */
      sentText: string;
      /** 最新的预览全文（可能比 sentText 新）。 */
      text: string;
      lastFlushAt: number;
      streamingSince: number;
    }
  /** 落库了，定稿在路上。 */
  | { phase: "finalizing"; messageId: MessageId };

export type FeishuStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "opened"; cardId: FeishuCardId; messageId: FeishuMessageId; sequence: number }
  | { kind: "segment_done"; messageId: MessageId; text: string }
  | { kind: "turn_end" }
  | { kind: "tick" };

export type FeishuStreamEffect =
  /** 建流式卡片实体并发到群里（带停止按钮）；完成后调用方喂回 opened。 */
  | { kind: "open"; text: string }
  | { kind: "push"; cardId: FeishuCardId; text: string; sequence: number }
  | { kind: "renew"; cardId: FeishuCardId; sequence: number }
  /**
   * 定稿：cardId 为 null 表示这段没流式过，按最终正文新发一张普通卡；否则换正文、关流式、删停止按钮。
   * text 超过 FEISHU_CARD_MAX_CHARS 时调用方按 splitFeishuMarkdown 拆，余下的发成新卡。之后记 feishu_posts。
   */
  | { kind: "finalize"; cardId: FeishuCardId | null; sequence: number; messageId: MessageId; text: string }
  /** 这一轮被打断、没落库：关流式、删停止按钮，正文留着已推的部分。 */
  | { kind: "abandon"; cardId: FeishuCardId; sequence: number }
  | { kind: "schedule_tick"; at: number };

export interface FeishuStreamTarget {
  conversationId: ConversationId;
  chatId: FeishuChatId;
}

/**
 * 纯函数：给定现状、一个事件和现在的时间，算出新状态和要做的事。
 * 后置：
 * - idle 收到 text → opening，发 open；opening 期间来的文字只记下，opened 之后按间隔补推；
 * - live 收到 text：距上次推送不足 FEISHU_STREAM_FLUSH_MS 或拿不到预算（budget.tryTake 为 false）只记下、发 schedule_tick；
 *   否则发 push，sequence 加一；
 * - live 收到 tick：streamingSince 起超过 FEISHU_STREAM_RENEW_MS 发 renew；有没推的文字照上一条处理；
 * - segment_done → finalizing，发 finalize（opening 期间落库时 cardId 为 null 且等 opened 之后再定稿）；
 * - turn_end 时还在 live（被打断、没落库）发 abandon，回 idle；在 opening 时等 opened 之后再 abandon；
 * - 同一个事件序列、同一个 now、同一份预算结果总得到同一个结果。
 */
export function stepFeishuStream(
  state: FeishuStreamState,
  event: FeishuStreamEvent,
  target: FeishuStreamTarget,
  now: number,
  budget: FeishuCardkitBudget,
): { state: FeishuStreamState; effects: FeishuStreamEffect[] } {
  throw new Error("未实现");
}

/**
 * 整个应用共用的卡片接口预算（令牌桶）。
 * 后置：最近一秒内已用满 perSecond 次时 tryTake 返回 false；定稿和 abandon 不调它。
 */
export interface FeishuCardkitBudget {
  tryTake(now: number): boolean;
}

export function createFeishuCardkitBudget(perSecond: number): FeishuCardkitBudget {
  throw new Error("未实现");
}
