import { describe, it } from "vitest";

describe("POST /api/app-approvals/:id/decide", () => {
  it.todo("requires a browser session or mTLS device session");
  it.todo("rejects unknown fields and decisions other than allow and deny");
  it.todo("forwards a valid decision to ledger.decideAppApproval");
  it.todo("returns conflict for an expired or revoked card");
  it.todo("is not reachable on agent-api");
});
