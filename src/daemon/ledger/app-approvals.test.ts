import { describe, it } from "vitest";

describe("app approval store", () => {
  it.todo("rejects requests from Workers without an approved no-outer-sandbox record");
  it.todo("rejects requests whose capability is not mounted on the Worker");
  it.todo("rejects requests from ended Workers and always-denied app ids");
  it.todo("posts one card in the PM conversation for the first request and attaches repeats for the same app");
  it.todo("stops opening cards past the per-Worker pending and total caps");
  it.todo("allow records decided_by user and later requests for the same app return allowed without a card, also after a relaunch");
  it.todo("a grant does not match another Worker or another app id");
  it.todo("deny makes later requests for the same app in this Worker run return denied without a card");
  it.todo("repeating the same clientId returns the stored decision and a different decision conflicts");
  it.todo("allow after every native request ended queues one system note to the Worker");
  it.todo("endProcess expires that process's pending rows and closes their cards, keeping decided rows");
  it.todo("Worker end revokes every row for the Worker");
  it.todo("expireDue expires pending rows at expires_at");
  it.todo("endAllAtStartup ends every live row after a daemon restart");
  it.todo("pruneTerminal keeps retention by age and row count");
  it.todo("hub commands and agent-api have no path that decides an app approval");
});
