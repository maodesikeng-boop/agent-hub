import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, type UpdateStatus } from "../../shared/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createUpdateChecker, type UpdateChecker } from "../update-checker.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";
import { testLogin } from "./test-login.ts";

const PORT = 4000;
const STATUS: UpdateStatus = {
  status: "up_to_date",
  currentVersion: "0.2.0",
  installKind: "source",
  platformTarget: "macos-arm64",
  releaseUrl: "https://github.com/maodesikeng-boop/agent-hub/releases/tag/v0.2.0",
  checkedAt: 1_000,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serve(update: UpdateChecker) {
  const root = mkdtempSync(join(tmpdir(), "hub-update-routes-"));
  roots.push(root);
  const db = openTestDb();
  const app = createUiServer({
    ledger: new FakeLedger().asLedger(),
    token: "test-token-0123456789abcdef",
    staticDir: join(root, "no-static"),
    uploadsDir: join(root, "uploads"),
    sentFilesDir: join(root, "sent-files"),
    port: PORT,
    db,
    update,
  });
  const headers = { host: `127.0.0.1:${PORT}`, cookie: testLogin(db, PORT).cookie(), origin: `http://127.0.0.1:${PORT}` };
  return { app, headers, db };
}

describe("update routes", () => {
  it("GET reads the checker, POST forces a check, and both require a signed-in browser", async () => {
    const update = { get: vi.fn(async () => STATUS), check: vi.fn(async () => ({ ...STATUS, checkedAt: 2_000 })), close: vi.fn() };
    const { app, headers, db } = serve(update);
    expect((await app.inject({ method: "GET", url: API_PATHS.update, headers: { host: headers.host } })).statusCode).toBe(401);
    const got = await app.inject({ method: "GET", url: API_PATHS.update, headers });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(STATUS);
    const checked = await app.inject({ method: "POST", url: API_PATHS.updateCheck, headers });
    expect(checked.json()).toMatchObject({ checkedAt: 2_000 });
    expect(update.check).toHaveBeenCalledTimes(1);
    await app.close();
    expect(update.close).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("closing the server aborts a pending GitHub request", async () => {
    let signal: AbortSignal | undefined;
    const hanging = vi.fn<typeof fetch>((_url, init) => {
      signal = init!.signal!;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
    });
    const update = createUpdateChecker({ currentVersion: "0.2.0", installKind: "bundled", platformTarget: "macos-arm64", releaseApiUrl: "http://127.0.0.1:9/latest", fetch: hanging });
    const { app, headers, db } = serve(update);
    await app.ready();
    const pending = app.inject({ method: "GET", url: API_PATHS.update, headers });
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    await app.close();
    expect(signal?.aborted).toBe(true);
    expect((await pending).json()).toMatchObject({ status: "unavailable", currentVersion: "0.2.0" });
    db.close();
  });
});
