// 卡片投影（docs/slack-design.md）：账本里等用户拍板的东西在 Slack 里画成 Block Kit 消息，按钮带回来的值在这里编解码。
// 不变量：
// - 卡片的真相在账本（AskMeta、router_items、user_blockers、任务图门禁），Slack 消息只是投影；回答一律走账本原有的接口，
//   账本推 message.updated / router.item.updated 后再把 Slack 原消息改成“已定案”，网页和 Slack 点哪边都一样；
// - 按钮值只带编号，不带选项原文；处理时照账本现状重新校验。
import type { AskMeta, ConversationId, Message, MessageId, RouterItemId, TaskGraphId, TaskNodeKey } from "../../shared/domain.ts";
import type { RouterItem } from "../../shared/router.ts";
import type { UserBlockerId } from "../../shared/user-blockers.ts";

/** Block Kit 的一个块（只在这一层拼，原样交给传输层）。 */
export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

/** 一张卡对应账本里的哪样东西，决定点了按钮调哪个账本接口。 */
export type SlackCardRef =
  | { kind: "ask"; askMessageId: MessageId }
  | { kind: "gate"; askMessageId: MessageId; graphId: TaskGraphId; nodeKey: TaskNodeKey }
  | { kind: "blocker"; askMessageId: MessageId; blockerId: UserBlockerId }
  | { kind: "router_item"; itemId: RouterItemId };

/** 按钮、弹窗带回来的动作。 */
export type SlackActionValue =
  | { kind: "choose"; card: SlackCardRef; optionIndex: number }
  /** 打开填写弹窗（没有选项的提问、检查点卡“打回”要写原因、选完想补充说明）。 */
  | { kind: "open_note"; card: SlackCardRef; optionIndex: number | null }
  | { kind: "blocker_done"; card: Extract<SlackCardRef, { kind: "blocker" }> }
  | { kind: "stop"; conversationId: ConversationId };

/** 后置：返回放进按钮 value（最多 2,000 字）或弹窗 private_metadata 的字符串。decodeSlackActionValue(encode(v)) 等于 v。 */
export function encodeSlackActionValue(value: SlackActionValue): string {
  throw new Error("未实现");
}

/** 后置：形状对返回动作，不对（被改过、老版本的值）返回 null。 */
export function decodeSlackActionValue(raw: string): SlackActionValue | null {
  throw new Error("未实现");
}

/** 卡片在 Slack 里的样子：等拍板、已定案（谁、选了什么）、被项目经理关掉或替换。 */
export type SlackCardState =
  | { kind: "pending" }
  | { kind: "answered"; chosenOption: string | null; note: string | null; byName: string }
  | { kind: "closed" };

/**
 * 前置：message 是 askOf(message) 不为 null 的项目经理消息，ask 是它的 meta。
 * 后置：pending 时有选项按钮（推荐项排第一、带星标）和“补充说明”按钮，检查点卡是“通过 / 打回”，提醒卡是 Done；
 * answered / closed 时没有按钮，写明结论。交付物不放进块里（files.ts 单独传成附件）。
 */
export function renderAskCard(message: Message, ask: AskMeta, state: SlackCardState): SlackBlock[] {
  throw new Error("未实现");
}

/**
 * 后置：总助频道里的一条：简报是摘要 + 链接；带 askMessageId 的拍板项只写一行摘要和项目经理频道里那张卡的链接（不重复放按钮）；
 * 没有 askMessageId 的拍板项带按钮。
 */
export function renderRouterItem(item: RouterItem, cardPermalink: string | null): SlackBlock[] {
  throw new Error("未实现");
}

/** 后置：流式中的消息末尾的“停止”按钮块。 */
export function renderStopButton(conversationId: ConversationId): SlackBlock {
  throw new Error("未实现");
}
