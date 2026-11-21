import { describe, it } from "vitest";

describe("turn completion receipts", () => {
  it.todo("records the same receipt before an earlier reply attachment finishes copying");
  it.todo("settles after one SQLite abort on the replied transition without sending the request again");
  it.todo("retries the same receipt after its initial SQLite insert fails while the daemon stays up");
  it.todo("rolls back message status, reply links, steps, worker reports, and live state when a later write fails");
  it.todo("publishes message and session changes once after settlement and ignores a settled sequence");
  it.todo("settles each session in order and continues settling other sessions while one session is blocked");
  it.todo("keeps new sends on hold until the affected session settles and keeps retries within their batch and delay limits");
  it.todo("prevents an executor retry from resending a failed turn and allows a new explicit user retry");
  it.todo("settles tool-only, failed, stopped, and message-free turns without inferring success from reply text");
  it.todo("keeps the existing restart policy for shutdown interruptions and turns without a completion receipt");
  it.todo("settles only the listed messages still owned by the session and ignores deleted or superseded messages");
  it.todo("recovers a receipt without attachment facts without linking a different turn's reply");
  it.todo("stops retries when the ledger closes and leaves committed receipts for restart");
});
