import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { uiCookieName, type DeviceId } from "../../shared/index.ts";
import { createMesh, type Mesh } from "../mesh/index.ts";
import { FAKE_GITHUB, approveNode, fakeGithubDeviceFlow, loginNode, startTestRelay, waitFor, type TestRelay } from "../mesh/test-helpers.ts";
import { migrate, openDatabase, type Db } from "../store/index.ts";
import { FakeLedger } from "../ui-server/fake-ledger.ts";
import { startUiServer, type RunningUiServer, type UiServerOptions } from "../ui-server/server.ts";
import { createBrowserSessions } from "../ui-server/sessions.ts";
import { createPeers, type Peers } from "./service.ts";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TestDevice {
  id: DeviceId;
  name: string;
  port: number;
  url: string;
  dir: string;
  peers: Peers;
  mesh: Mesh;
  ledger: FakeLedger;
  db: Db;
  server: RunningUiServer;
  cookie: string;
  browser(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface TestDeviceOptions {
  relay: TestRelay;
  name?: string;
  lan?: boolean;
  serverOptions?: Partial<UiServerOptions>;
}

const devices: TestDevice[] = [];
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close();
});

export async function startTestDevice(opts: TestDeviceOptions): Promise<TestDevice> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-peers-")));
  const id = randomUUID();
  const deviceRecord = { id, name: opts.name ?? `dev-${id.slice(0, 4)}` };
  const ledger = new FakeLedger();
  const db: Db = openDatabase(":memory:");
  migrate(db);
  let server!: RunningUiServer;
  let mesh!: Mesh;
  let peers!: Peers;
  let port = 0;
  const start = async () => {
    mesh = await createMesh({
      identityDir: join(dir, "state", "mesh"),
      accountFile: join(dir, "state", "account.json"),
      trustFile: join(dir, "state", "peers.json"),
      device: deviceRecord,
      platform: "linux",
      relayUrl: opts.relay.url,
      githubClientId: "Iv1.test",
      listenPort: 0,
      listenHost: "127.0.0.1",
      candidates: opts.lan === false ? () => [] : (p) => [{ host: "127.0.0.1", port: p }],
      allowLoopback: true,
      onConnection: (connection) => server.acceptMeshConnection(connection),
      github: { webOrigin: FAKE_GITHUB, apiOrigin: FAKE_GITHUB, sleep: async () => {} },
      fetch: fakeGithubDeviceFlow("tok_alice"),
      log: () => {},
    });
    peers = createPeers({ device: deviceRecord, saveName: () => {}, mesh });
    server = await startUiServer({
      ledger: ledger.asLedger(),
      token: "test-token-0123456789abcdef",
      db,
      port,
      staticDir: join(dir, "no-static"),
      uploadsDir: join(dir, "uploads"),
      sentFilesDir: join(dir, "sent-files"),
      peers,
      mesh,
      ...opts.serverOptions,
    });
    port = server.port;
  };
  await start();
  const session = createBrowserSessions(db).create({ userAgent: "test", entry: `127.0.0.1:${port}` });
  const cookie = `${uiCookieName(`127.0.0.1:${port}`)}=${session.token}`;
  const base = `http://127.0.0.1:${port}`;
  let closed = false;
  const stop = async () => {
    peers.close();
    await mesh.close();
    await server.close();
  };
  const device: TestDevice = {
    id,
    get name() {
      return deviceRecord.name;
    },
    port,
    url: base,
    dir,
    get peers() {
      return peers;
    },
    get mesh() {
      return mesh;
    },
    ledger,
    db,
    get server() {
      return server;
    },
    cookie,
    browser(path, init = {}) {
      const headers: Record<string, string> = { cookie, origin: base, ...init.headers };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      return fetch(base + path, { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    },
    stop,
    restart: start,
    async close() {
      if (closed) return;
      closed = true;
      await stop().catch(() => {});
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  devices.push(device);
  return device;
}

export async function startTestAccount(count: number, options: Omit<TestDeviceOptions, "relay"> = {}): Promise<{ relay: TestRelay; devices: TestDevice[] }> {
  const relay = await startTestRelay();
  const list: TestDevice[] = [];
  for (let i = 0; i < count; i++) {
    const d = await startTestDevice({ ...options, relay });
    await loginNode(d);
    if (i > 0) await approveNode(list[0]!, d);
    list.push(d);
  }
  await waitFor(() => list.every((d) => d.mesh.trust.list().length === count), 10_000);
  return { relay, devices: list };
}
