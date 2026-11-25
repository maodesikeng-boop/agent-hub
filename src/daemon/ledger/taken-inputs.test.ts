import { describe, it } from "vitest";
import { createLedgerTakenInputs } from "./taken-inputs.ts";

describe(createLedgerTakenInputs.name, () => {
  it.todo("stamps a queued pm.wakeup with the newest message id and midTurn false when message.processing opens a new turn");
  it.todo("stamps midTurn true when message.delivered carries midTurn and the vendor later reports message.processing");
  it.todo("stamps Worker report lines and schedule.run messages the same way");
  it.todo("never stamps user or pm messages");
  it.todo("keeps the first stamp when a requeued message is delivered again");
  it.todo("pushes exactly one message.updated change per stamped message");
  it.todo("leaves a message that is cancelled, stopped, or retired as stale before it is taken without a stamp");
});
