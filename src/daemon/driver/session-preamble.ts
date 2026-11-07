// 换代后的新会话第一条消息前面的开场说明 + 交接 + 最近原话（DriverOptions.sessionPreamble，ledger/handover.ts 给内容）：三家驱动共用。
// 和性格设定说明（persona-note.ts）一样拼在一行最前面的 text 块里，退回的时机也一样：#dropBatch、停止、进程没了要重写。
// 带没带过记在驱动层会话状态里（preambleTaken，只在内存）：账本那边要等 agent 开始处理带着它的那一行（message.processing 带
// preamble: true，命令那一行不带所以不算）才记“读到了”，
// 之后 sessionPreamble 返回 null；写进去到开始处理之间别的行（一轮中途写的、排队的）靠这个标记不重复带。
// 守护进程重启后内存清空、账本还没记读到：再带一次（多带一次无害，漏了不行）。
import type { DriverOptions, SessionId } from "../../shared/index.ts";

/** 驱动层会话状态里的那一格。 */
export interface PreambleHolder {
  preambleTaken: boolean;
}

/** 带了开场说明的一行：没写成、agent 没读到时 restore，下一行再带。 */
export interface PreambleTaken {
  note: string;
  restore: () => void;
}

/** 写一行之前调：这个进程里还没带过、账本给了内容就返回（并记下带过了）；否则 null。sessionPreamble 抛错当没有，交给 onError。 */
export function takeSessionPreamble(
  sessionPreamble: DriverOptions["sessionPreamble"],
  sessionId: SessionId,
  holder: PreambleHolder,
  onError: (error: unknown) => void,
): PreambleTaken | null {
  if (!sessionPreamble || holder.preambleTaken) return null;
  let note: string | null;
  try {
    note = sessionPreamble(sessionId);
  } catch (error) {
    onError(error);
    return null;
  }
  if (note === null) return null;
  holder.preambleTaken = true;
  return {
    note,
    restore: () => {
      holder.preambleTaken = false;
    },
  };
}
