import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { API_PATHS, LedgerRequestError } from "../../shared/index.ts";
import { createAgentApi } from "../agent-api/server.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";
import { loginCookie } from "./test-login.ts";

const PORT = 4052;
const TOKEN = "app-ui-test-token-0123456789";
const HOST = `127.0.0.1:${PORT}`;
const click = { decision: "allow", clientId: "clicked" };
const decide = vi.fn();
let ui: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  decide.mockReset().mockReturnValue({ approval: { id: 4, status: "allowed" }, workerStatus: "open" });
  const ledger = Object.assign(new FakeLedger().asLedger(), { decideAppApproval: decide });
  ui = createUiServer({ ledger, token: TOKEN, port: PORT, staticDir: ".missing", uploadsDir: ".missing", sentFilesDir: ".missing" });
  cookie = await loginCookie(ui, { token: TOKEN, port: PORT });
});
afterEach(async () => { await ui.close(); });

function post(payload: object = click, headers = { cookie, origin: `http://${HOST}` }) {
  return ui.inject({ method: "POST", url: API_PATHS.decideAppApproval(4), headers: { host: HOST, ...headers }, payload });
}

describe("app approval route", () => {
  it("requires a browser session or mTLS device session", async () => {
    expect((await post(click, { cookie: "", origin: `http://${HOST}` })).statusCode).toBe(401);
    expect((await post(click, { cookie, origin: "https://example.test" })).statusCode).toBe(403);
    expect(decide).not.toHaveBeenCalled();
    expect((await post()).statusCode).toBe(200);
  });
  it("rejects unknown fields and decisions other than allow and deny", async () => {
    for (const body of [{ ...click, actor: "pm" }, { ...click, decision: "yes" }, { ...click, clientId: "" }]) {
      expect((await post(body)).statusCode).toBe(400);
    }
    expect(decide).not.toHaveBeenCalled();
  });
  it("forwards a valid decision to ledger.decideAppApproval", async () => {
    expect((await post()).json()).toMatchObject({ approval: { id: 4, status: "allowed" } });
    expect(decide).toHaveBeenCalledExactlyOnceWith(4, click);
  });
  it("returns conflict for an expired or revoked card", async () => {
    decide.mockImplementation(() => { throw new LedgerRequestError("conflict", "Approval ended"); });
    expect((await post()).statusCode).toBe(409);
    expect(decide).toHaveBeenCalledExactlyOnceWith(4, click);
  });
  it("is not reachable on agent-api", async () => {
    const tokens = createSessionTokens();
    const app = createAgentApi({ ledger: new FakeLedger().asLedger(), tokens });
    try {
      await app.ready();
      expect(app.hasRoute({ method: "POST", url: "/api/app-approvals/:id/decide" })).toBe(false);
      const res = await app.inject({ method: "POST", url: API_PATHS.decideAppApproval(4),
        headers: { authorization: `Bearer ${tokens.issue(1)}` }, payload: click });
      expect(res.statusCode).toBe(400);
      expect(decide).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
