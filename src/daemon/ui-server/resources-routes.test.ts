import { Agent, createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_PATHS,
  DEVICE_PROXY_PREFIX,
  type ResourceCleanupResponse,
  type ResourceDecisionResponse,
  type ResourcesSnapshot,
} from "../../shared/index.ts";
import { createLedger } from "../ledger/index.ts";
import type { ResourceInspector } from "../resources/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createUiServer } from "./server.ts";

const TOKEN = "resources_routes_test_token_1234";
const PORT = 4567;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

const SAMPLE_SNAPSHOT: ResourcesSnapshot = {
  scannedAt: 1_760_000_000_000,
  database: { fileBytes: 1024 * 1024, walBytes: 4096, freelistBytes: 0, dbstatAvailable: true, tables: [] },
  directories: [],
  branches: [],
  processes: { trackedCount: 1, leakedCount: 0 },
  held: [],
  heldTruncated: false,
  totalDiskBytes: 1024 * 1024,
  attentionCount: 0,
};

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

async function setupServer(resources: ResourceInspector, extraOpts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-res-routes-"));
  cleanupDirs.push(dir);
  const db = openTestDb();
  const ledger = createLedger(db, { pmHomeRoot: join(dir, "pm"), dataHome: dir });
  const app = createUiServer({
    ledger,
    db,
    token: TOKEN,
    port: PORT,
    uploadsDir: join(dir, "uploads"),
    sentFilesDir: join(dir, "sent-files"),
    staticDir: join(dir, "static"),
    resources,
    ...extraOpts,
  });
  await app.ready();
  const authRes = await app.inject({ method: "GET", url: `/auth?token=${TOKEN}`, headers: { host: HOST } });
  const cookie = authRes.headers["set-cookie"] as string;
  const headers = { host: HOST, origin: ORIGIN, cookie: cookie.split(";")[0]! };
  return {
    app,
    headers,
    close: async () => {
      await app.close();
      ledger.close();
      db.close();
    },
  };
}

function makeFakeInspector(): ResourceInspector {
  return {
    inspect: vi.fn(async () => SAMPLE_SNAPSHOT),
    decide: vi.fn(async (): Promise<ResourceDecisionResponse> => ({ snapshot: SAMPLE_SNAPSHOT, removedBytes: 512 })),
    runCleanup: vi.fn(
      async (): Promise<ResourceCleanupResponse> => ({
        snapshot: SAMPLE_SNAPSHOT,
        purgedDbRows: 10,
        reclaimedDbPages: 2,
        removedFiles: 1,
        removedWorktrees: 1,
        removedBranches: 2,
        removedTempDirs: 1,
        reapedProcesses: 0,
      }),
    ),
    close: vi.fn(),
  };
}

describe("registerResourceRoutes", () => {
  it("returns ResourcesSnapshot on GET /api/resources and passes refresh=1 through", async () => {
    const inspector = makeFakeInspector();
    const { app, headers, close } = await setupServer(inspector);
    try {
      const r1 = await app.inject({ method: "GET", url: API_PATHS.resources, headers });
      expect(r1.statusCode).toBe(200);
      expect(r1.json()).toEqual(SAMPLE_SNAPSHOT);
      expect(inspector.inspect).toHaveBeenLastCalledWith({ refresh: false });

      const r2 = await app.inject({ method: "GET", url: `${API_PATHS.resources}?refresh=1`, headers });
      expect(r2.statusCode).toBe(200);
      expect(inspector.inspect).toHaveBeenLastCalledWith({ refresh: true });
    } finally {
      await close();
    }
  });

  it("validates POST /api/resources/decision payloads with zod and rejects invalid actions or empty target keys with 400", async () => {
    const inspector = makeFakeInspector();
    const { app, headers, close } = await setupServer(inspector);
    try {
      const badAction = await app.inject({
        method: "POST",
        url: API_PATHS.resourceDecision,
        headers,
        payload: { kind: "worktree", targetKey: "1", action: "nuke" },
      });
      expect(badAction.statusCode).toBe(400);

      const emptyKey = await app.inject({
        method: "POST",
        url: API_PATHS.resourceDecision,
        headers,
        payload: { kind: "worktree", targetKey: "   ", action: "keep" },
      });
      expect(emptyKey.statusCode).toBe(400);
      expect(inspector.decide).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("dispatches keep, unkeep, and discard actions and returns the updated snapshot", async () => {
    const inspector = makeFakeInspector();
    const { app, headers, close } = await setupServer(inspector);
    try {
      for (const action of ["keep", "unkeep", "discard"] as const) {
        const res = await app.inject({
          method: "POST",
          url: API_PATHS.resourceDecision,
          headers,
          payload: { kind: "worktree", targetKey: "42", action, ...(action === "discard" ? { deleteBranch: true } : {}) },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ snapshot: SAMPLE_SNAPSHOT, removedBytes: 512 });
      }
      expect(inspector.decide).toHaveBeenNthCalledWith(1, { kind: "worktree", targetKey: "42", action: "keep" });
      expect(inspector.decide).toHaveBeenNthCalledWith(2, { kind: "worktree", targetKey: "42", action: "unkeep" });
      expect(inspector.decide).toHaveBeenNthCalledWith(3, { kind: "worktree", targetKey: "42", action: "discard", deleteBranch: true });
    } finally {
      await close();
    }
  });

  it("triggers safe automatic cleanup on POST /api/resources/cleanup", async () => {
    const inspector = makeFakeInspector();
    const { app, headers, close } = await setupServer(inspector);
    try {
      const res = await app.inject({ method: "POST", url: API_PATHS.resourceCleanup, headers, payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ purgedDbRows: 10, removedBranches: 2 });
      expect(inspector.runCleanup).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it("proxies /api/resources routes across mesh computers inside device scope", async () => {
    const inspector = makeFakeInspector();
    const peerId = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
    const remoteRequests: string[] = [];
    const remote = createServer((req, res) => {
      remoteRequests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(SAMPLE_SNAPSHOT));
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const remotePort = (remote.address() as { port: number }).port;
    const agent = new Agent({ keepAlive: false });
    (agent as unknown as { createConnection: () => ReturnType<typeof createConnection> }).createConnection = () =>
      createConnection(remotePort, "127.0.0.1");

    const { app, headers, close } = await setupServer(inspector, {
      peers: {
        self: { id: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", name: "Mac", platform: "darwin" },
        list: () => [],
        target: (id: string) => (id === peerId ? { name: "Linux", agent } : null),
        rename: vi.fn(),
        remove: vi.fn(),
        close: vi.fn(),
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `${DEVICE_PROXY_PREFIX}/${peerId}${API_PATHS.resources}?refresh=1`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SAMPLE_SNAPSHOT);
      expect(remoteRequests).toEqual([`GET ${API_PATHS.resources}?refresh=1`]);
      expect(inspector.inspect).not.toHaveBeenCalled();
    } finally {
      await close();
      agent.destroy();
      await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
  });

  it("calls inspector.close() in the Fastify preClose hook", async () => {
    const inspector = makeFakeInspector();
    const { close } = await setupServer(inspector);
    await close();
    expect(inspector.close).toHaveBeenCalledTimes(1);
  });
});
