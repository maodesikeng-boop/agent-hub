import { attachmentsOf } from "../../../shared/attachments.ts";
import { truncateChars, type ConversationId, type MessageId } from "../../../shared/domain.ts";
import { WORKER_DIRECT_CHAT_SUMMARY_MAX_CHARS, WORKER_DIRECT_CHAT_SUMMARY_MAX_MESSAGES } from "../../../shared/limits.ts";
import { hasReportQuestion, parseWorkerReport } from "../../../shared/worker.ts";
import { parseMessageMeta, type WorkerDbRow } from "../rows.ts";
import type { WorkersCtx } from "./types.ts";

export function isDirectChat(w: WorkersCtx, conversationId: ConversationId, messageIds: readonly MessageId[]): boolean {
  return messageIds.length > 0 && messageIds.every(
    (id) => w.db.get<{ sender: string }>("SELECT sender FROM messages WHERE id = ? AND conversation_id = ?", id, conversationId)?.sender === "user",
  );
}

export function shouldDeliverDirectChatReport(text: string): boolean {
  const parsed = parseWorkerReport(text);
  return parsed.kind === "ok" && (parsed.report.status === "done" || hasReportQuestion(parsed.report.questions));
}

const SUMMARY_HEADING = "【用户近期直接发给此 Worker 的消息摘要（按发送顺序，最后一条最新）】";
const EARLIER_MESSAGES_OMITTED = "…（更早的消息省略）";

export function directChatSummary(w: WorkersCtx, worker: WorkerDbRow, { markSeen }: { markSeen: boolean }): string | undefined {
  const rows = w.db.all<{ id: MessageId; text: string; meta: string | null }>(
    `SELECT id, substr(text, 1, ?) AS text, meta
       FROM messages
      WHERE conversation_id = ? AND sender = 'user' AND id > COALESCE((
        SELECT seen_through FROM worker_direct_chat_receipts WHERE worker_id = ?
      ), 0) AND status IS NOT 'cancelled' AND json_extract(meta, '$.rewound') IS NOT 1
      ORDER BY id DESC LIMIT ?`,
    WORKER_DIRECT_CHAT_SUMMARY_MAX_CHARS + 1,
    worker.worker_conversation_id,
    worker.id,
    WORKER_DIRECT_CHAT_SUMMARY_MAX_MESSAGES + 1,
  );
  const latest = rows[0];
  if (latest === undefined) return undefined;
  if (markSeen) {
    w.db.run(
      `INSERT INTO worker_direct_chat_receipts (worker_id, seen_through) VALUES (?, ?)
       ON CONFLICT (worker_id) DO UPDATE SET seen_through = excluded.seen_through`,
      worker.id, latest.id,
    );
  }
  const excerpts: string[] = [];
  let remaining = WORKER_DIRECT_CHAT_SUMMARY_MAX_CHARS - SUMMARY_HEADING.length - 1;
  for (const [index, { text, meta }] of rows.slice(0, WORKER_DIRECT_CHAT_SUMMARY_MAX_MESSAGES).entries()) {
    const files = attachmentsOf({ meta: parseMessageMeta("text", meta) }).map((file) => file.name);
    const excerpt = files.length === 0 ? text : [text, `附件：${files.join("、")}`].join(" ");
    const line = `> ${excerpt.replace(/\s+/gu, " ").trim()}`;
    const lineChars = [...line].length;
    const reserved = index + 1 < rows.length ? EARLIER_MESSAGES_OMITTED.length + 1 : 0;
    if (lineChars > remaining - reserved) {
      if (index === 0) excerpts.push(truncateChars(line, remaining - reserved));
      break;
    }
    excerpts.push(line);
    remaining -= lineChars + 1;
  }
  if (excerpts.length < rows.length) excerpts.push(EARLIER_MESSAGES_OMITTED);
  return [SUMMARY_HEADING, ...excerpts.reverse()].join("\n");
}
