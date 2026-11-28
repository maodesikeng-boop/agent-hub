// Invariant: stop dispatch never touches the ledger after daemon shutdown begins and always reconciles settled idle stops via StopId.
import type { Driver, Ledger, Unsubscribe } from "../shared/index.ts";
import type { SetupRunner } from "./setup/index.ts";

export interface SessionStopHandlerDeps {
  ledger: Pick<Ledger, "onStopRequested" | "settleStop">;
  driver: Pick<Driver, "interrupt" | "isBusy">;
  setup: Pick<SetupRunner, "cancel" | "isRunning">;
  isClosing: () => boolean;
  log: (line: string) => void;
}

/**
 * Precondition: ledger, driver, and setup belong to the same daemon instance.
 * Postcondition: subscribes to ledger.onStopRequested, cancels setup and invokes driver.interrupt(sessionId), and upon completion (if !isClosing() and event.stopId is defined) calls ledger.settleStop with the observed driverBusy and setupActive flags.
 */
export function wireSessionStopHandler(_deps: SessionStopHandlerDeps): Unsubscribe {
  throw new Error("Not implemented");
}
