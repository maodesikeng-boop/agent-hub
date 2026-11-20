import { truncateChars } from "./domain.ts";
import type { RouterItemId } from "./domain.ts";
import { WAITING_ASK_QUESTION_CHARS, WAITING_ASKS_LISTED_MAX } from "./limits.ts";
import { HUB_COMMAND } from "./names.ts";

export interface WaitingAsk {
  id: RouterItemId;
  question: string;
}

const line = (ask: WaitingAsk) => `- #${ask.id}「${truncateChars(ask.question.replace(/\s+/g, " ").trim(), WAITING_ASK_QUESTION_CHARS)}」`;

function listOf(asks: readonly WaitingAsk[]): string[] {
  const lines = asks.slice(0, WAITING_ASKS_LISTED_MAX).map(line);
  if (asks.length > WAITING_ASKS_LISTED_MAX) lines.push(`- 另有 ${asks.length - WAITING_ASKS_LISTED_MAX} 张没列出`);
  return lines;
}

export function waitingAsksNote(asks: readonly WaitingAsk[]): string | null {
  if (asks.length === 0) return null;
  return [
    `【系统：账本里现在还在等用户回答的提问卡有 ${asks.length} 张。这条消息不一定在回答它们；用户回答了哪张，用 \`${HUB_COMMAND} ask close <编号>\` 关掉那张，没回答的留着：`,
    ...listOf(asks),
    "】",
  ].join("\n");
}

export function waitingAsksSection(asks: readonly WaitingAsk[]): string {
  if (asks.length === 0) return "无：账本里没有在等用户回答的提问卡；上面交接正文里提到的卡，用户那边已经没有了。";
  return [`账本里现在还在等用户回答的提问卡，一共 ${asks.length} 张，用户那边就这几张；上面交接正文里提到、但不在这里的卡，用户那边已经没有了：`, ...listOf(asks)].join("\n");
}
