import { describe, it } from "vitest";

describe("ledger worker sandbox approvals", () => {
  it.todo("rejects hub worker start --no-outer-sandbox when Computer Use capability is not explicitly mounted");
  it.todo("holds a valid --no-outer-sandbox Worker in pending without enqueuing worktree.create, session.start, or session.send");
  it.todo("posts a human-only confirmation card in the PM conversation and exposes the pending summary in snapshot");
  it.todo("blocks PM override via hub ask close, hub graph decide, and hub worker send while approval is pending");
  it.todo("keeps a pending Worker paused across recoverAfterRestart without launching it");
  it.todo("starts the deferred worktree or session turn only after human approval via decideSandboxApproval");
  it.todo("re-validates PM capability policy on approve and fails with conflict if Computer Use was disabled while waiting");
  it.todo("ends the Worker, settles the card, and notifies the PM when the user clicks reject");
  it.todo("allows PM hub worker end on a pending Worker, revoking the approval and closing the card");
  it.todo("revokes an approved bypass immediately on hub worker end, PM archive, and worktree setup failure");
  it.todo("requires a brand-new user confirmation card for a takeover Worker on the same Task Graph step");
  it.todo("leaves concurrent normal Workers on the same project inside Bellwood's outer sandbox");
  it.todo("prunes terminal approval rows past SANDBOX_APPROVALS_RETENTION_DAYS and SANDBOX_APPROVALS_TERMINAL_MAX_ROWS without deleting pending or open-Worker rows");
});
