import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_PATHS, LedgerRequestError } from "../../shared/index.ts";
import { startTestAccount, type TestDevice } from "../peers/test-helpers.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/index.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";
import { testLogin } from "./test-login.ts";

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let staticDir: string;
let uploadsDir: string;
let sentFilesDir: string;
let ledger: FakeLedger;
let db: Db;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "hub-pin-static-"));
  uploadsDir = join(mkdtempSync(join(tmpdir(), "hub-pin-uploads-")), "uploads");
  sentFilesDir = join(uploadsDir, "..", "sent-files");
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>agent-hub</title>");
  ledger = new FakeLedger();
  ledger.snapshotValue = {
    ...ledger.snapshotValue,
    pms: [
      { id: 3, name: "小林", mode: "manage_only", vendor: "claude", defaultModel: null, effort: null, personaFile: null, createdAt: 1, pinnedAt: null },
      { id: 4, name: "已归档", mode: "manage_only", vendor: "claude", defaultModel: null, effort: null, personaFile: null, createdAt: 1, archivedAt: 500, pinnedAt: null },
    ],
  };
  db = openTestDb();
  cookie = testLogin(db, PORT).cookie();
  app = createUiServer({ ledger: ledger.asLedger(), token: TOKEN, staticDir, uploadsDir, sentFilesDir, port: PORT, db });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(staticDir, { recursive: true, force: true });
  rmSync(join(uploadsDir, ".."), { recursive: true, force: true });
});

function call(url: string, body: unknown) {
  return app.inject({
    method: "PUT",
    url,
    headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("PUT /api/pms/:id/pin", () => {
  it("calls setPmPinned with the parsed boolean and returns { pm }", async () => {
    const pinRes = await call(API_PATHS.pmPin(3), { pinned: true });
    expect(pinRes.statusCode).toBe(200);
    expect(pinRes.json()).toMatchObject({ pm: { id: 3, pinnedAt: 1_000 } });

    const unpinRes = await call(API_PATHS.pmPin(3), { pinned: false });
    expect(unpinRes.statusCode).toBe(200);
    expect(unpinRes.json()).toMatchObject({ pm: { id: 3, pinnedAt: null } });

    expect(ledger.pinCalls).toEqual([
      { pmId: 3, pinned: true },
      { pmId: 3, pinned: false },
    ]);
  });

  it.each([
    ["missing pinned", {}],
    ["string pinned", { pinned: "true" }],
    ["numeric pinned", { pinned: 1 }],
    ["null pinned", { pinned: null }],
    ["extra field", { pinned: true, extra: 1 }],
  ])("rejects a body without a boolean pinned (%s) with 400 and does not call setPmPinned", async (_label, body) => {
    const res = await call(API_PATHS.pmPin(3), body);
    expect(res.statusCode).toBe(400);
    expect(ledger.pinCalls).toEqual([]);
  });

  it("maps conflict and not_found from the ledger to their HTTP statuses", async () => {
    const missing = await call(API_PATHS.pmPin(999), { pinned: true });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "not_found" });

    const archived = await call(API_PATHS.pmPin(4), { pinned: true });
    expect(archived.statusCode).toBe(409);
    expect(archived.json()).toMatchObject({ code: "conflict" });

    const asMockConflict = app.inject({
      method: "PUT",
      url: API_PATHS.pmPin(3),
      headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
      payload: JSON.stringify({ pinned: true }),
    });
    expect((await asMockConflict).statusCode).toBe(200);

    ledger.setPmPinned = () => {
      throw new LedgerRequestError("conflict", "archived");
    };
    expect((await call(API_PATHS.pmPin(3), { pinned: false })).statusCode).toBe(409);
  });

  it("is reachable for a remote computer through the device proxy", async () => {
    const { devices } = await startTestAccount(2);
    const [a, b] = devices as [TestDevice, TestDevice];
    b.ledger.snapshotValue = {
      ...b.ledger.snapshotValue,
      pms: [{ id: 7, name: "远程项目经理", mode: "manage_only", vendor: "claude", defaultModel: null, effort: null, personaFile: null, createdAt: 1, pinnedAt: null }],
    };

    const res = await a.browser(`/d/${b.id}${API_PATHS.pmPin(7)}`, { method: "PUT", body: { pinned: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pm: { id: 7, pinnedAt: 1_000 } });
    expect(b.ledger.pinCalls).toEqual([{ pmId: 7, pinned: true }]);
  });
});
