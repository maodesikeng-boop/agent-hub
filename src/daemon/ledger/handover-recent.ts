// 新会话开场说明里带的原话（docs/background-handover-design.md 第 3 节）：只带用户和项目经理之间网页上看得到的话，
// 从账本取（三家统一），可以跨好几代。切点（开始复制那一刻）之后的全带；切点及之前的从新往旧按字数（String.length）累加到上限，
// 整条整条地取，跨过边界的那一条只留后半截。纯函数：账本那边按 id 倒着走索引喂进来，够数就不再往下取。
import type { MessageId } from "../../shared/domain.ts";

export interface RecentMessage {
  id: MessageId;
  sender: "user" | "agent";
  /** 网页上看得到的字（附件只带文件名，agentTextOf）。 */
  text: string;
  /** 这条消息所在会话是第几代。 */
  generation: number;
}

/** 边界那一条只留后半截时前面的标记。 */
export const OMITTED_MARK = "（前面略）";

/** 跨代的地方插的一行：方便新会话对上交接。 */
export const generationMark = (generation: number) => `（这之前是第 ${generation} 个会话）`;

/**
 * rows 从新到旧（惰性取：够数就停）。id > cut 的全取，不算在 limit 里；id ≤ cut 的从新往旧取到 limit 字。
 * 返回按时间正序的结果和切点之后的字数（太多说明交接太旧，账本作废重来）。
 */
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

/** 按时间正序拼成给新会话看的文字：每条前面标“用户：”“你：”，跨代插一行说明。 */
export function recentText(picked: readonly RecentMessage[]): string {
  const parts: string[] = [];
  picked.forEach((row, i) => {
    const prev = picked[i - 1];
    if (prev !== undefined && prev.generation !== row.generation) parts.push(generationMark(prev.generation));
    parts.push(`${row.sender === "user" ? "用户" : "你"}：${row.text}`);
  });
  return parts.join("\n\n");
}
