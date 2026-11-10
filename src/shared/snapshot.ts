// 初始快照（/api/state，账本的 snapshot）里带哪些消息、给哪些摘要。本机直连和经别的设备转发（/d/<设备>/api/state）
// 拿的都是账本这一份；网页（web/selectors.ts）和守护进程的推送（reminders.ts）按同一套规则用它。
// - 项目经理对话、在跑的 Worker 对话：最近 SNAPSHOT_RECENT_MESSAGES 条，往前带到最近一条要算的消息（snapshotWindowStart）；
//   在跑的 Worker 只有几个（不随历史变多），点进去不用再等一次拉取；
// - 已收工的 Worker 对话：不带消息，点开时按 hasMore 拉最新一页；
// - Worker 的状态色、已收工、最近一行：项目经理对话里那几行可能早就不在最近几条里了，账本把每个 Worker 最近一行的摘要
//   （workerLineSummaries）挂在它自己的对话上，网页再拿实时来的新行盖掉旧的。
import { workerEventOf, type ConversationId, type Message, type MessageId, type WorkerMessageMeta } from "./domain.ts";
import { SNAPSHOT_RECENT_MESSAGES } from "./limits.ts";
import { isInFlight, isQuietMessage, isUnansweredAsk } from "./reminders.ts";

/** 项目经理对话里指向一个 Worker 的那几行的摘要（快照时刻的，网页按消息编号和之后实时来的行比新旧）。 */
export interface WorkerLineSummary {
  /** 最近一行的消息编号、时间和内容。 */
  messageId: MessageId;
  at: number;
  line: WorkerMessageMeta;
  /** 最晚一行“已收工”“建 worktree 失败”的时间；没有是 null。 */
  endedAt: number | null;
}

/** 收工的那两种行（ended、worktree_failed）。 */
export function isWorkerEndLine(line: WorkerMessageMeta): boolean {
  return line.event === "ended" || line.event === "worktree_failed";
}

/** 按编号从小到大给的那些行（不是 Worker 行的跳过）→ 每个 Worker 对话一份摘要。 */
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

/** 提醒、状态要看的消息：没回答的提问、没处理完的（含交接请求）。 */
const mustKeep = (m: Message) => isUnansweredAsk(m) || isInFlight(m);

/**
 * 项目经理对话、在跑的 Worker 对话在快照里从第几条开始带（messages 是最近一页，从旧到新）：最近 SNAPSHOT_RECENT_MESSAGES 条，
 * 往前带到最早一条没回答的提问、没处理完的消息，以及最近一条非安静的消息（左栏预览、排序、“等你”看它）。
 * 带的是连着的一段，往上翻页（before = 最早一条的编号）接得上。
 */
export function snapshotWindowStart(messages: readonly Message[]): number {
  let start = Math.max(0, messages.length - SNAPSHOT_RECENT_MESSAGES);
  if (start === 0) return 0;
  const lastLoud = messages.findLastIndex((m) => !isQuietMessage(m));
  if (lastLoud !== -1) start = Math.min(start, lastLoud);
  const firstKept = messages.findIndex(mustKeep);
  if (firstKept !== -1) start = Math.min(start, firstKept);
  return start;
}
