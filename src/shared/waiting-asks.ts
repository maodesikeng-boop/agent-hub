// 项目经理对“哪些提问卡还在等用户”的认识只来自账本：用户消息送到项目经理时、换新会话的开场说明里，都由这里把账本里
// 还没回答的卡（router_items 的 pending 决策卡）写成文字。卡只在用户回答它、或项目经理 hub ask close / --replace 时才离开这个名单。
import { truncateChars } from "./domain.ts";
import type { RouterItemId } from "./domain.ts";
import { WAITING_ASK_QUESTION_CHARS, WAITING_ASKS_LISTED_MAX } from "./limits.ts";
import { HUB_COMMAND } from "./names.ts";

export interface WaitingAsk {
  id: RouterItemId;
  /** 卡的问题原文（router_items.question）。 */
  question: string;
}

const line = (ask: WaitingAsk) => `- #${ask.id}「${truncateChars(ask.question.replace(/\s+/g, " ").trim(), WAITING_ASK_QUESTION_CHARS)}」`;

function listOf(asks: readonly WaitingAsk[]): string[] {
  const lines = asks.slice(0, WAITING_ASKS_LISTED_MAX).map(line);
  if (asks.length > WAITING_ASKS_LISTED_MAX) lines.push(`- 另有 ${asks.length - WAITING_ASKS_LISTED_MAX} 张没列出`);
  return lines;
}

/** 用户消息原文前面的说明块（没有卡在等：null，不加）。 */
export function waitingAsksNote(asks: readonly WaitingAsk[]): string | null {
  if (asks.length === 0) return null;
  return [
    `【系统：账本里现在还在等用户回答的提问卡有 ${asks.length} 张。这条消息不一定在回答它们；用户回答了哪张，用 \`${HUB_COMMAND} ask close <编号>\` 关掉那张，没回答的留着：`,
    ...listOf(asks),
    "】",
  ].join("\n");
}

/** 换新会话开场说明里“在等用户的提问卡”一节的正文；没有卡写“无”。 */
export function waitingAsksSection(asks: readonly WaitingAsk[]): string {
  if (asks.length === 0) return "无：账本里没有在等用户回答的提问卡；上面交接正文里提到的卡，用户那边已经没有了。";
  return [`账本里现在还在等用户回答的提问卡，一共 ${asks.length} 张，用户那边就这几张；上面交接正文里提到、但不在这里的卡，用户那边已经没有了：`, ...listOf(asks)].join("\n");
}
