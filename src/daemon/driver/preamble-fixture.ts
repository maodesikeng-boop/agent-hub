// 三家驱动测“换代后的开场说明”（session-preamble.ts）共用：一个假账本，和 ledger/handover.ts 同一个口径——
// 一直给到带着它的那一行开始处理（message.processing 带 preamble: true）。
import type { Driver } from "../../shared/index.ts";

export const PREAMBLE = "【系统】这是新会话：交接在下面";

/** 假账本：sessionPreamble 一直给到带着它的那一行开始处理（message.processing 的 preamble）；calls 记问了几次。 */
export function fakePreambleLedger() {
  const seen = new Set<number>();
  const ledger = {
    calls: 0,
    sessionPreamble: (sessionId: number): string | null => {
      ledger.calls++;
      return seen.has(sessionId) ? null : PREAMBLE;
    },
    watch(driver: Pick<Driver, "onEvent">) {
      driver.onEvent((sessionId, event) => {
        if (event.type === "message.processing" && event.preamble === true) seen.add(sessionId);
      });
    },
  };
  return ledger;
}
