// Cloudflare 版中继测试：既在真实 workerd 运行时（wrangler unstable_startWorker + SQLite Durable Object）里跑完整 HTTP / WebSocket / 租约改授，
// 也直接驱动 RelayAccountObject 验证休眠 acceptWebSocket、attachment 恢复、零定时器与每条消息后 sweep 的契约。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { unstable_startWorker } from "wrangler";
import { loadOrCreateMeshIdentity, type MeshIdentity } from "../../daemon/mesh/identity.ts";
import { createRelayClient, registerWithRelay } from "../../daemon/mesh/relay-client.ts";
import { startFakeGithub, type FakeGithub } from "../../../test/e2e/fake-github.ts";
import { MESH_LEASE_TTL_MS, RELAY_PENDING_DEVICE_TTL_MS, RELAY_REGISTER_PER_IP_PER_MINUTE } from "../../shared/limits.ts";
import type { AccountId, MeshLeaseGrant } from "../../shared/mesh.ts";
import { encodeRelayFrame, parseRelayServerFrame, relayControlMessage, relayRegisterMessage, RELAY_PATHS, RELAY_PROTOCOL_VERSION } from "../protocol.ts";

const DEVICE_A = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE_B = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

interface WorkerModule {
  handleRelayRequest(request: Request, env: unknown): Promise<Response>;
  RelayAccountObject: new (state: FakeDoState, env: { PUBLIC_ORIGIN: string; GITHUB_API_ORIGIN?: string }) => {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(ws: FakeCfSocket, message: string | ArrayBuffer): Promise<void>;
    webSocketClose(ws: FakeCfSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  };
}

const WORKER_URL = new URL("./worker.ts", import.meta.url).href;
const workerMod = (await import(WORKER_URL)) as WorkerModule;

interface FakeCfSocket {
  sent: (string | ArrayBuffer)[];
  closedWith: { code?: number; reason?: string } | null;
  tags: string[];
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

function makeFakeSocket(): FakeCfSocket {
  let attachment: unknown = null;
  return {
    sent: [],
    closedWith: null,
    tags: [],
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.closedWith = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    },
    serializeAttachment(value) {
      attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return structuredClone(attachment);
    },
  };
}

interface FakeDoState {
  accepted: FakeCfSocket[];
  sqlRows: Map<number, string>;
  storage: {
    sql: {
      exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
    };
  };
  acceptWebSocket(ws: FakeCfSocket, tags?: string[]): void;
  getWebSockets(tag?: string): FakeCfSocket[];
}

function makeFakeDoState(sharedSql = new Map<number, string>(), hibernated: FakeCfSocket[] = []): FakeDoState {
  const accepted = [...hibernated];
  return {
    accepted,
    sqlRows: sharedSql,
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          const normalized = query.trim().toUpperCase();
          if (normalized.startsWith("CREATE TABLE")) return { toArray: () => [] };
          if (normalized.startsWith("SELECT")) {
            const record = sharedSql.get(1);
            return { toArray: () => (record === undefined ? [] : [{ record }]) };
          }
          if (normalized.startsWith("INSERT")) {
            sharedSql.set(1, String(bindings[0]));
            return { toArray: () => [] };
          }
          throw new Error(`unexpected SQL: ${query}`);
        },
      },
    },
    acceptWebSocket(ws, tags = []) {
      ws.tags = tags;
      accepted.push(ws);
    },
    getWebSockets(tag) {
      const open = accepted.filter((s) => s.closedWith === null);
      return tag === undefined ? open : open.filter((s) => s.tags.includes(tag));
    },
  };
}

let github: FakeGithub;
let workerd: Awaited<ReturnType<typeof unstable_startWorker>>;
let relayOrigin = "";
let persistDir = "";
let idA: MeshIdentity;
let idB: MeshIdentity;

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), "fusa-cf-relay-"));
  idA = await loadOrCreateMeshIdentity(join(persistDir, "id-a"), DEVICE_A);
  idB = await loadOrCreateMeshIdentity(join(persistDir, "id-b"), DEVICE_B);
  github = await startFakeGithub({
    tok_alice: { id: 101, login: "alice" },
    tok_bob: { id: 202, login: "bob" },
  });
  workerd = await unstable_startWorker({
    config: "wrangler.toml",
    bindings: {
      PUBLIC_ORIGIN: { type: "plain_text", value: "" },
      GITHUB_API_ORIGIN: { type: "plain_text", value: github.origin },
    },
    dev: {
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      persist: persistDir,
      logLevel: "error",
    },
  });
  await workerd.ready;
  relayOrigin = (await workerd.url).origin;
});

afterAll(async () => {
  await workerd?.dispose();
  await github?.close();
  if (persistDir !== "") rmSync(persistDir, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("handleRelayRequest", () => {
  it("POST /v1/register 验过 GitHub 后交给账号编号对应的 Durable Object", async () => {
    const res = await registerWithRelay({
      relayUrl: relayOrigin,
      githubToken: "tok_alice",
      identity: idA,
      device: { id: DEVICE_A, name: "Mac", platform: "darwin" },
    });
    expect(res.login).toBe("alice");
    expect(res.state).toBe("active");
    expect(res.accountId).toMatch(/^acct_[a-z2-7]{26}$/);
  });

  it("/v1/accounts/<账号>/control 和 channels 的 WebSocket 升级交给同一个 Durable Object", async () => {
    const regA = await registerWithRelay({
      relayUrl: relayOrigin,
      githubToken: "tok_bob",
      identity: idA,
      device: { id: DEVICE_A, name: "Mac", platform: "darwin" },
    });
    await registerWithRelay({
      relayUrl: relayOrigin,
      githubToken: "tok_bob",
      identity: idB,
      device: { id: DEVICE_B, name: "Win", platform: "win32" },
    });

    const clientA = createRelayClient({ relayUrl: relayOrigin, accountId: regA.accountId, identity: idA, candidates: () => [], log: () => {} });
    const clientB = createRelayClient({ relayUrl: relayOrigin, accountId: regA.accountId, identity: idB, candidates: () => [], log: () => {} });
    let incomingChannel: Promise<import("node:stream").Duplex> | null = null;
    clientB.on("incoming", (from, ch) => {
      incomingChannel = clientB.acceptChannel(from, ch);
    });
    clientA.start();
    clientB.start();
    try {
      await waitFor(() => clientA.state() === "connected" && clientB.state() === "connected");
      clientA.send({ type: "device.activate", id: DEVICE_B });
      let bActive = false;
      clientB.on("self", (s) => {
        if (s === "active") bActive = true;
      });
      await waitFor(() => bActive);

      const streamA = await clientA.openChannel(DEVICE_B);
      await waitFor(() => incomingChannel !== null);
      const streamB = await incomingChannel!;
      const received: Buffer[] = [];
      streamB.on("data", (chunk: Buffer) => received.push(chunk));
      streamA.write(Buffer.from([0x17, 0x03, 0x03, 0x00, 0x02, 0xaa, 0xbb]));
      await waitFor(() => Buffer.concat(received).length === 7);
      expect([...Buffer.concat(received)]).toEqual([0x17, 0x03, 0x03, 0x00, 0x02, 0xaa, 0xbb]);
      streamA.destroy();
      streamB.destroy();
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });

  it("别的路径回 404，不是 WebSocket 升级的账号路径回 426", async () => {
    const notFound = await fetch(`${relayOrigin}/v1/nope`);
    expect(notFound.status).toBe(404);

    const accountId = "acct_abcdefghijklmnopqrstuvwxyz";
    const noUpgradeControl = await fetch(`${relayOrigin}${RELAY_PATHS.control(accountId as AccountId)}`);
    expect(noUpgradeControl.status).toBe(426);

    const noUpgradeChannel = await fetch(`${relayOrigin}/v1/accounts/${accountId}/channels/0123456789abcdef0123456789abcdef`);
    expect(noUpgradeChannel.status).toBe(426);
  });

  it("同一 IP 每分钟登记超过 RELAY_REGISTER_PER_IP_PER_MINUTE 次回 429", async () => {
    const stub = { fetch: async () => new Response("{}", { status: 200 }) };
    const env = {
      ACCOUNTS: { idFromName: (n: string) => n, get: () => stub },
      PUBLIC_ORIGIN: "https://relay.test",
      GITHUB_API_ORIGIN: github.origin,
    };
    let lastStatus = 0;
    for (let i = 0; i <= RELAY_REGISTER_PER_IP_PER_MINUTE; i++) {
      const res = await workerMod.handleRelayRequest(
        new Request("https://relay.test/v1/register", {
          method: "POST",
          headers: { "cf-connecting-ip": "198.51.100.77", "content-type": "application/json" },
          body: "{}",
        }),
        env,
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("RelayAccountObject", () => {
  async function registerOnDo(
    doObj: InstanceType<WorkerModule["RelayAccountObject"]>,
    accountId: AccountId,
    identity: MeshIdentity,
    name: string,
    origin = "https://relay.test",
  ) {
    const req: import("../protocol.ts").RelayRegisterRequest = {
      provider: "github",
      token: "tok",
      device: { id: identity.deviceId, name, platform: "linux", certPem: identity.certPem, publicKey: identity.publicKey },
      signature: identity.sign(relayRegisterMessage({ relayOrigin: origin, provider: "github", device: identity.deviceId, fingerprint: identity.fingerprint })),
    };
    const res = await doObj.fetch(
      new Request("https://do.internal/internal/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, login: { provider: "github", userId: "1", login: "alice" }, request: req, relayOrigin: origin }),
      }),
    );
    expect(res.status).toBe(200);
  }

  it("WebSocket 用 acceptWebSocket 收下，空闲时能休眠", async () => {
    const accountId = "acct_abcdefghijklmnopqrstuvwxyz" as AccountId;
    const ws = new WebSocket(`${relayOrigin.replace(/^http/, "ws")}${RELAY_PATHS.control(accountId)}`);
    try {
      const firstFrame = await new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(data.toString("utf8")));
        ws.once("error", reject);
      });
      const parsed = parseRelayServerFrame(firstFrame);
      expect(parsed?.type).toBe("challenge");
    } finally {
      ws.close();
    }
  });

  it("休眠醒来按 attachment 恢复在线、claim 时间和租约持有者", async () => {
    const origin = "https://relay.test";
    const accountId = "acct_abcdefghijklmnopqrstuvwxyz" as AccountId;
    const sql = new Map<number, string>();

    const pairQueue: [FakeCfSocket, FakeCfSocket][] = [];
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0: FakeCfSocket;
        1: FakeCfSocket;
        constructor() {
          const pair = pairQueue.shift() ?? [makeFakeSocket(), makeFakeSocket()];
          this[0] = pair[0];
          this[1] = pair[1];
        }
      },
    );
    vi.stubGlobal(
      "Response",
      class extends globalThis.Response {
        webSocket?: unknown;
        constructor(body?: ConstructorParameters<typeof globalThis.Response>[0], init?: ResponseInit & { webSocket?: unknown }) {
          const { status, ...rest } = init ?? {};
          super(body, { ...rest, status: status === 101 ? 200 : status });
          this.webSocket = init?.webSocket;
        }
      },
    );

    try {
      const state1 = makeFakeDoState(sql);
      const do1 = new workerMod.RelayAccountObject(state1, { PUBLIC_ORIGIN: origin });
      await registerOnDo(do1, accountId, idA, "Mac", origin);
      await registerOnDo(do1, accountId, idB, "Win", origin);

      const serverA = makeFakeSocket();
      pairQueue.push([makeFakeSocket(), serverA]);
      await do1.fetch(new Request(`${origin}${RELAY_PATHS.control(accountId)}`, { headers: { upgrade: "websocket" } }));
      expect(state1.accepted).toContain(serverA);
      const chA = parseRelayServerFrame(String(serverA.sent.at(-1)));
      expect(chA?.type).toBe("challenge");
      await do1.webSocketMessage(
        serverA,
        encodeRelayFrame({
          type: "hello",
          device: DEVICE_A,
          version: RELAY_PROTOCOL_VERSION,
          signature: idA.sign(relayControlMessage({ relayOrigin: origin, accountId, device: DEVICE_A, nonce: (chA as { nonce: string }).nonce })),
        }),
      );
      await do1.webSocketMessage(serverA, encodeRelayFrame({ type: "device.activate", id: DEVICE_B }));
      await do1.webSocketMessage(serverA, encodeRelayFrame({ type: "lease.claim", name: "feishu" }));

      const serverB = makeFakeSocket();
      pairQueue.push([makeFakeSocket(), serverB]);
      await do1.fetch(new Request(`${origin}${RELAY_PATHS.control(accountId)}`, { headers: { upgrade: "websocket" } }));
      const chB = parseRelayServerFrame(String(serverB.sent.at(-1)));
      await do1.webSocketMessage(
        serverB,
        encodeRelayFrame({
          type: "hello",
          device: DEVICE_B,
          version: RELAY_PROTOCOL_VERSION,
          signature: idB.sign(relayControlMessage({ relayOrigin: origin, accountId, device: DEVICE_B, nonce: (chB as { nonce: string }).nonce })),
        }),
      );
      await do1.webSocketMessage(serverB, encodeRelayFrame({ type: "lease.claim", name: "feishu" }));

      serverA.sent.length = 0;
      serverB.sent.length = 0;
      const state2 = makeFakeDoState(sql, [serverA, serverB]);
      const do2 = new workerMod.RelayAccountObject(state2, { PUBLIC_ORIGIN: origin });
      await do2.webSocketMessage(serverB, encodeRelayFrame({ type: "presence", candidates: [{ host: "192.168.1.9", port: 4320 }] }));

      const presenceToA = serverA.sent.map((s) => parseRelayServerFrame(String(s))).find((f) => f?.type === "presence");
      expect(presenceToA).toBeDefined();
      if (presenceToA?.type === "presence") {
        expect(presenceToA.presence.find((p) => p.id === DEVICE_B)?.online).toBe(true);
      }

      serverB.sent.length = 0;
      await do2.webSocketClose(serverA, 1000, "bye", true);
      const leaseToB = serverB.sent.map((s) => parseRelayServerFrame(String(s))).filter((f) => f?.type === "lease").at(-1);
      expect(leaseToB).toMatchObject({ type: "lease", name: "feishu", grant: { holder: DEVICE_B, epoch: 2 } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("每条消息处理完存 attachment、调 sweep，不开定时器", async () => {
    const origin = "https://relay.test";
    const accountId = "acct_abcdefghijklmnopqrstuvwxyz" as AccountId;
    const sql = new Map<number, string>();
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const serverA = makeFakeSocket();
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = makeFakeSocket();
        1 = serverA;
      },
    );
    vi.stubGlobal(
      "Response",
      class extends globalThis.Response {
        webSocket?: unknown;
        constructor(body?: ConstructorParameters<typeof globalThis.Response>[0], init?: ResponseInit & { webSocket?: unknown }) {
          const { status, ...rest } = init ?? {};
          super(body, { ...rest, status: status === 101 ? 200 : status });
          this.webSocket = init?.webSocket;
        }
      },
    );
    try {
      const state = makeFakeDoState(sql);
      const doObj = new workerMod.RelayAccountObject(state, { PUBLIC_ORIGIN: origin });
      await registerOnDo(doObj, accountId, idA, "Mac", origin);
      await registerOnDo(doObj, accountId, idB, "Win", origin);
      await doObj.fetch(new Request(`${origin}${RELAY_PATHS.control(accountId)}`, { headers: { upgrade: "websocket" } }));
      const chA = parseRelayServerFrame(String(serverA.sent.at(-1))) as { nonce: string };
      await doObj.webSocketMessage(
        serverA,
        encodeRelayFrame({
          type: "hello",
          device: DEVICE_A,
          version: RELAY_PROTOCOL_VERSION,
          signature: idA.sign(relayControlMessage({ relayOrigin: origin, accountId, device: DEVICE_A, nonce: chA.nonce })),
        }),
      );
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(serverA.deserializeAttachment()).toMatchObject({ kind: "control", accountId, control: { device: DEVICE_A } });

      now += RELAY_PENDING_DEVICE_TTL_MS + MESH_LEASE_TTL_MS + 1;
      serverA.sent.length = 0;
      await doObj.webSocketMessage(serverA, encodeRelayFrame({ type: "presence", candidates: [] }));
      const devicesFrame = serverA.sent.map((s) => parseRelayServerFrame(String(s))).find((f) => f?.type === "devices");
      expect(devicesFrame).toBeDefined();
      if (devicesFrame?.type === "devices") {
        expect(devicesFrame.devices.map((d) => d.id)).toEqual([DEVICE_A]);
      }
    } finally {
      dateSpy.mockRestore();
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("控制连接关闭时交给 room，持有者断开马上改授租约", async () => {
    const regA = await registerWithRelay({
      relayUrl: relayOrigin,
      githubToken: "tok_alice",
      identity: idA,
      device: { id: DEVICE_A, name: "Mac", platform: "darwin" },
    });
    await registerWithRelay({
      relayUrl: relayOrigin,
      githubToken: "tok_alice",
      identity: idB,
      device: { id: DEVICE_B, name: "Win", platform: "win32" },
    });

    const clientA = createRelayClient({ relayUrl: relayOrigin, accountId: regA.accountId, identity: idA, candidates: () => [], log: () => {} });
    const clientB = createRelayClient({ relayUrl: relayOrigin, accountId: regA.accountId, identity: idB, candidates: () => [], log: () => {} });
    let grantA: MeshLeaseGrant | null = null;
    let grantB: MeshLeaseGrant | null = null;
    clientA.on("lease", (_name, grant) => {
      grantA = grant;
    });
    clientB.on("lease", (_name, grant) => {
      grantB = grant;
    });
    clientA.start();
    clientB.start();
    try {
      await waitFor(() => clientA.state() === "connected" && clientB.state() === "connected");
      clientA.send({ type: "device.activate", id: DEVICE_B });
      let bActive = false;
      clientB.on("self", (s) => {
        if (s === "active") bActive = true;
      });
      await waitFor(() => bActive);

      clientA.send({ type: "lease.claim", name: "feishu" });
      clientB.send({ type: "lease.claim", name: "feishu" });
      await waitFor(() => grantA?.holder === DEVICE_A);

      await clientA.close();
      await waitFor(() => grantB?.holder === DEVICE_B);
      expect(grantB!.epoch).toBeGreaterThanOrEqual(2);
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });
});
