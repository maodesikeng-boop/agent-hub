import type { Deliverable } from "./deliverables.ts";
import { truncateChars, type MessageId, type RouterItemId, type TaskGraphId, type TaskNodeKey } from "./domain.ts";
import { HUB_HELP_ONLY_COMMANDS } from "./hub.ts";
import { ASK_LIST_MAX, WAITING_ASK_QUESTION_CHARS, WAITING_ASKS_LISTED_MAX } from "./limits.ts";
import { HUB_COMMAND } from "./names.ts";

export type PendingAskSource =
  | { kind: "ask"; itemId: RouterItemId }
  | { kind: "step"; graphId: TaskGraphId; graphTitle: string; nodeKey: TaskNodeKey; checkpoint: boolean };

export interface PendingAsk {
  source: PendingAskSource;
  messageId: MessageId | null;
  question: string;
  askedAt: number;
}

export type AskStatus =
  | { state: "waiting" }
  | { state: "answered"; choice: string | null; note: string | null; at: number }
  | { state: "closed"; at: number };

export interface AskDetail {
  source: PendingAskSource;
  messageId: MessageId | null;
  /** Null when retention removed the original message. */
  text: string | null;
  options: string[];
  recommended: string | null;
  deliverables: Deliverable[];
  askedAt: number;
  status: AskStatus;
}

function askAge(askedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - askedAt) / 60_000);
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))} 天`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时`;
  return minutes > 0 ? `${minutes} 分钟` : "不到 1 分钟";
}

function askLabel({ source, messageId }: Pick<PendingAsk, "source" | "messageId">): string {
  if (source.kind === "ask") return `#${source.itemId}`;
  const step = `任务图 #${source.graphId}「${source.graphTitle}」步骤 ${source.nodeKey}${source.checkpoint ? "（检查点）" : ""}`;
  return messageId === null ? step : `${step}（消息 #${messageId}，用 ${HUB_COMMAND} ask show --message ${messageId}）`;
}

function askLines(asks: readonly PendingAsk[], now: number, cap: number): string[] {
  const lines = asks.slice(0, cap).map((ask) => {
    const question = truncateChars(ask.question.replace(/\s+/g, " ").trim(), WAITING_ASK_QUESTION_CHARS);
    return `- ${askLabel(ask)}「${question}」 · 已等 ${askAge(ask.askedAt, now)}`;
  });
  if (asks.length > cap) lines.push(`- 另有 ${asks.length - cap} 张没列出`);
  return lines;
}

export function formatPendingAskList(asks: readonly PendingAsk[], now: number): string {
  if (asks.length === 0) return "你没有在等用户回答的卡。";
  return [`还有 ${asks.length} 张卡在等用户回答：`, ...askLines(asks, now, ASK_LIST_MAX), HUB_HELP_ONLY_COMMANDS["ask.show"]].join("\n");
}

function statusText(status: AskStatus): string {
  if (status.state === "waiting") return "在等用户回答";
  if (status.state === "closed") return "已关闭";
  return [
    status.choice === null ? "已回答" : `已回答：选了「${status.choice}」`,
    ...(status.note ? [`补充说明：${status.note}`] : []),
  ].join("\n");
}

export function formatAskDetail(detail: AskDetail, now: number): string {
  return [
    `${askLabel(detail)} · ${askAge(detail.askedAt, now)}前挂出 · ${statusText(detail.status)}`,
    "",
    detail.text ?? "原始提问记录已清理。",
    ...(detail.options.length === 0 ? [] : [
      "",
      "选项：",
      ...detail.options.map((option) => `- ${option}${option === detail.recommended ? "（推荐）" : ""}`),
    ]),
    ...(detail.deliverables.length === 0 ? [] : [
      "",
      "文件：",
      ...detail.deliverables.map((file) => `- ${file.label}：${file.href}`),
    ]),
  ].join("\n");
}

export function pendingAsksNote(asks: readonly PendingAsk[], now: number): string | null {
  if (asks.length === 0) return null;
  return [
    `【系统：账本里现在还在等用户回答的卡有 ${asks.length} 张。这条消息不一定在回答它们；用户在对话里回答了哪张，用 \`${HUB_COMMAND} ask close <编号>\`（步骤卡用 \`${HUB_COMMAND} ask close --message <消息编号>\`）关掉那张，没回答的留着：`,
    ...askLines(asks, now, WAITING_ASKS_LISTED_MAX),
    HUB_HELP_ONLY_COMMANDS["ask.list"],
    HUB_HELP_ONLY_COMMANDS["ask.show"],
    "】",
  ].join("\n");
}

export function pendingAsksSection(asks: readonly PendingAsk[], now: number): string {
  if (asks.length === 0) return "无：账本里没有在等用户回答的卡。";
  return [`账本里现在还在等用户回答的卡有 ${asks.length} 张：`, ...askLines(asks, now, WAITING_ASKS_LISTED_MAX)].join("\n");
}
