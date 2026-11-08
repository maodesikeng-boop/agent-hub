// 测试用：在本进程里起一台“设备”（真的界面服务 + 假账本 + 真的 peers），网址是 http://127.0.0.1:<端口>（认本机回环网址）。
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uiCookieName, type DeviceId, type DeviceInfo } from "../../shared/index.ts";
import type { TailnetSelf } from "../platform/index.ts";
import { migrate, openDatabase, type Db } from "../store/index.ts";
import { FakeLedger } from "../ui-server/fake-ledger.ts";
import { startUiServer, type RunningUiServer, type UiServerOptions } from "../ui-server/server.ts";
import { createBrowserSessions } from "../ui-server/sessions.ts";
import { createPeers, type Peers } from "./service.ts";
import type { PeerRecord } from "./store.ts";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TestDevice {
  id: DeviceId;
  name: string;
  port: number;
  url: string;
  dir: string;
  peersFile: string;
  peers: Peers;
  ledger: FakeLedger;
  server: RunningUiServer;
  /** 浏览器的 cookie 头（已登录）。 */
  cookie: string;
  /** 像浏览器一样访问这台：带 cookie 和同源 Origin。 */
  browser(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  /** peers.json 里存的设备（直接读文件）。 */
  records(): PeerRecord[];
  /** 停掉界面服务（模拟离线），之后可以 restart 在同一个端口上再起来。 */
  stop(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface TestDeviceOptions {
  name?: string;
  now?: () => number;
  /** 经 serve 进来时认的 tailnet 名字和主人。 */
  tailnet?: TailnetSelf | null;
  fetch?: typeof fetch;
  serverOptions?: Partial<UiServerOptions>;
  /** 启动前写进 peers.json 的设备（比如指向一个假的上游）。 */
  seed?: PeerRecord[];
}

export async function startTestDevice(opts: TestDeviceOptions = {}): Promise<TestDevice> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-peers-")));
  const id = randomUUID();
  const name = opts.name ?? `dev-${id.slice(0, 4)}`;
  const peersFile = join(dir, "state", "peers.json");
  if (opts.seed !== undefined) {
    mkdirSync(dirname(peersFile), { recursive: true });
    writeFileSync(peersFile, JSON.stringify({ version: 1, devices: opts.seed, removed: [] }), { mode: 0o600 });
  }
  const ledger = new FakeLedger();
  const db: Db = openDatabase(":memory:");
  migrate(db);
  let port = 0;
  const makePeers = () =>
    createPeers({
      file: peersFile,
      device: { id, name },
      saveName: () => {},
      selfUrl: () => (port === 0 ? null : `http://127.0.0.1:${port}`),
      allowLoopback: true,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  let peers = makePeers();
  const start = (p: number, current: Peers) =>
    startUiServer({
      ledger: ledger.asLedger(),
      token: "test-token-0123456789abcdef",
      db,
      port: p,
      staticDir: join(dir, "no-static"),
      uploadsDir: join(dir, "uploads"),
      sentFilesDir: join(dir, "sent-files"),
      peers: current,
      ...(opts.tailnet !== undefined ? { tailnet: { current: () => opts.tailnet ?? null } } : {}),
      ...opts.serverOptions,
    });
  let server = await start(0, peers);
  port = server.port;
  const session = createBrowserSessions(db).create({ userAgent: "test", entry: `127.0.0.1:${port}` });
  const cookie = `${uiCookieName(`127.0.0.1:${port}`)}=${session.token}`;
  const base = `http://127.0.0.1:${port}`;
  const device: TestDevice = {
    id,
    name,
    port,
    url: base,
    dir,
    peersFile,
    get peers() {
      return peers;
    },
    ledger,
    get server() {
      return server;
    },
    cookie,
    browser(path, init = {}) {
      const headers: Record<string, string> = { cookie, origin: base, ...init.headers };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      return fetch(base + path, { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    },
    records() {
      try {
        return (JSON.parse(readFileSync(peersFile, "utf8")) as { devices: PeerRecord[] }).devices;
      } catch {
        return [];
      }
    },
    async stop() {
      peers.close();
      await server.close();
    },
    async restart() {
      // 重新读 peers.json（像守护进程重启那样），在同一个端口上起
      peers = makePeers();
      server = await start(port, peers);
    },
    async close() {
      peers.close();
      await server.close().catch(() => {});
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return device;
}

/** 等几台设备之间的后台同步、介绍都做完（一台做完可能又触发别的台）。 */
export async function settle(devices: TestDevice[], rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(devices.map((d) => d.peers.idle()));
    await sleep(20);
  }
}

/** b 生成邀请码，a 用它添加 b。返回 a 的 POST /api/devices 的响应。 */
export async function pair(a: TestDevice, b: TestDevice): Promise<Response> {
  const invite = (await (await b.browser("/api/devices/invites", { method: "POST" })).json()) as { code: string; url: string };
  return a.browser("/api/devices", { method: "POST", body: { url: invite.url, code: invite.code } });
}

export async function deviceIds(d: TestDevice): Promise<string[]> {
  const body = (await (await d.browser("/api/devices")).json()) as { devices: DeviceInfo[] };
  return body.devices.map((x) => x.id);
}
