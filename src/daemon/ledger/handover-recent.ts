import type { MessageId } from "../../shared/domain.ts";

export interface RecentMessage {
  id: MessageId;
  sender: "user" | "agent";
  text: string;
  generation: number;
}

export const OMITTED_MARK = "（前面略）";

export const generationMark = (generation: number) => `（这之前是第 ${generation} 个会话）`;

export function pickRecent(rows: Iterable<RecentMessage>, cut: MessageId, limit: number): { picked: RecentMessage[]; postCutChars: number } {
  const picked: RecentMessage[] = [];
  let postCutChars = 0;
  let used = 0;
  for (const row of rows) {
    if (row.id > cut) {
      picked.push(row);
      postCutChars += row.text.length;
      continue;
    }
    const left = limit - used;
    if (left <= 0) break;
    if (row.text.length <= left) {
      picked.push(row);
      used += row.text.length;
      if (used >= limit) break;
      continue;
    }
    picked.push({ ...row, text: `${OMITTED_MARK}${row.text.slice(row.text.length - left)}` });
    break;
  }
  return { picked: picked.reverse(), postCutChars };
}

export function recentEntriesNewestFirst(picked: readonly RecentMessage[]): string[] {
  const parts: string[] = [];
  picked.forEach((row, i) => {
    const prev = picked[i - 1];
    if (prev !== undefined && prev.generation !== row.generation) parts.push(generationMark(prev.generation));
    parts.push(`${row.sender === "user" ? "用户" : "你"}：${row.text}`);
  });
  return parts.reverse();
}
