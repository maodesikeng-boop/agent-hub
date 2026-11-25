import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { COMPUTER_USE_INVENTORY, SANDBOX_APPROVAL } from "../../../test/sandbox-approval-fixture.ts";
import { API_PATHS, type CapabilityInventory } from "../../shared/index.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";
import { loginCookie } from "./test-login.ts";

const PORT = 4052;
const TOKEN = "sandbox-ui-test-token-0123456789";
const HOST = `127.0.0.1:${PORT}`;
const decide = vi.fn(() => ({ approval: SANDBOX_APPROVAL, workerStatus: "open" as const }));
const get = vi.fn<() => Promise<CapabilityInventory>>();
let ui: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  decide.mockClear();
  get.mockReset();
  get.mockResolvedValue(COMPUTER_USE_INVENTORY);
  const ledger = Object.assign(new FakeLedger().asLedger(), {
    decideSandboxApproval: decide,
    getSandboxApproval: () => ({ ...SANDBOX_APPROVAL, status: "pending" as const }),
  });
  ui = createUiServer({ ledger, token: TOKEN, port: PORT, staticDir: ".missing", uploadsDir: ".missing", sentFilesDir: ".missing",
    capabilityInventory: { get, invalidate() {} } });
  cookie = await loginCookie(ui, { token: TOKEN, port: PORT });
});
afterEach(async () => { await ui.close(); });

function post(decision: "approve" | "reject", origin = `http://${HOST}`) {
  return ui.inject({ method: "POST", url: API_PATHS.decideSandboxApproval(SANDBOX_APPROVAL.id),
    headers: { host: HOST, origin, cookie }, payload: { decision, clientId: "clicked" },
  });
}

describe("sandbox approval route", () => {
  it("rechecks installation before approving", async () => {
    get.mockResolvedValue({ ...COMPUTER_USE_INVENTORY, items: [] });
    expect((await post("approve")).statusCode).toBe(409);
    expect(decide).not.toHaveBeenCalled();
    get.mockResolvedValue(COMPUTER_USE_INVENTORY);
    expect((await post("approve")).statusCode).toBe(200);
    expect(decide).toHaveBeenCalledWith(SANDBOX_APPROVAL.id, { decision: "approve", clientId: "clicked" });
  });

  it("accepts rejection even when the capability inventory is unavailable", async () => {
    get.mockRejectedValue(new Error("Discovery failed"));
    expect((await post("reject")).statusCode).toBe(200);
    expect(get).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith(SANDBOX_APPROVAL.id, { decision: "reject", clientId: "clicked" });
  });

  it("rejects foreign browser origins before checking inventory or deciding", async () => {
    expect((await post("approve", "https://example.com")).statusCode).toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });
});
