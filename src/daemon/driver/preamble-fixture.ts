import type { Driver } from "../../shared/index.ts";

export const PREAMBLE = "【系统】这是新会话：交接在下面";

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
