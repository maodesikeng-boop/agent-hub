import { describe, it } from "vitest";

describe("ui-server sandbox approval routes", () => {
  it.todo("rejects unauthenticated requests to POST /api/sandbox-approvals/:id/decide with 401");
  it.todo("accepts approve and reject decisions from an authenticated browser session and returns updated approval and worker status");
  it.todo("validates decision enum and clientId bounds with 400 on malformed payloads");
  it.todo("treats repeated requests with the same clientId as idempotent and rejects conflicting second decisions with 409");
  it.todo("proxies sandbox approval decisions over mTLS mesh peer connections to the target device");
  it.todo("never exposes any sandbox approval confirmation route on agent-api (run/hub.sock)");
});
