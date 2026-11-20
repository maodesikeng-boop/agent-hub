import { workerEventOf, type ConversationId, type Message, type MessageId, type WorkerMessageMeta } from "./domain.ts";
import { SNAPSHOT_RECENT_MESSAGES } from "./limits.ts";
import { isInFlight, isQuietMessage, isUnansweredAsk } from "./reminders.ts";

export interface WorkerLineSummary {
  messageId: MessageId;
  at: number;
  line: WorkerMessageMeta;
  endedAt: number | null;
}

export function isWorkerEndLine(line: WorkerMessageMeta): boolean {
  return line.event === "ended" || line.event === "worktree_failed";
}

export function workerLineSummaries(
  messages: Iterable<Pick<Message, "id" | "kind" | "meta" | "createdAt">>,
): Map<ConversationId, WorkerLineSummary> {
  const out = new Map<ConversationId, WorkerLineSummary>();
  for (const message of messages) {
    const line = workerEventOf(message);
    if (line === null) continue;
    const prev = out.get(line.workerConversationId);
    const endedAt = isWorkerEndLine(line) ? Math.max(prev?.endedAt ?? 0, message.createdAt) : (prev?.endedAt ?? null);
    out.set(line.workerConversationId, { messageId: message.id, at: message.createdAt, line, endedAt });
  }
  return out;
}

const mustKeep = (m: Message) => isUnansweredAsk(m) || isInFlight(m);

export function snapshotWindowStart(messages: readonly Message[]): number {
  let start = Math.max(0, messages.length - SNAPSHOT_RECENT_MESSAGES);
  if (start === 0) return 0;
  const lastPreview = messages.findLastIndex((m) => !isQuietMessage(m) && m.kind === "text" && m.workerId === null && m.sender !== "pm");
  const lastLoud = lastPreview !== -1 ? lastPreview : messages.findLastIndex((m) => !isQuietMessage(m));
  if (lastLoud !== -1) start = Math.min(start, lastLoud);
  const firstKept = messages.findIndex(mustKeep);
  if (firstKept !== -1) start = Math.min(start, firstKept);
  return start;
}
