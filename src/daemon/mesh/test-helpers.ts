// 组网测试共用：临时目录里的设备身份。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { DeviceId } from "../../shared/api.ts";
import type { AccountId } from "../../shared/mesh.ts";
import { loadOrCreateMeshIdentity, type MeshIdentity } from "./identity.ts";

export const DEVICE_A: DeviceId = "11111111-1111-4111-8111-111111111111";
export const DEVICE_B: DeviceId = "22222222-2222-4222-8222-222222222222";
export const DEVICE_C: DeviceId = "33333333-3333-4333-8333-333333333333";
export const DEVICE_D: DeviceId = "44444444-4444-4444-8444-444444444444";

const dirs: string[] = [];

/** 一个测试结束后自动删掉的临时目录。 */
export function tempDir(prefix = "mesh-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 在临时目录里生成一台设备的身份。 */
export function makeIdentity(deviceId: DeviceId): Promise<MeshIdentity> {
  return loadOrCreateMeshIdentity(join(tempDir(), "mesh"), deviceId);
}

// ---- 本机起一个真的自建中继（假 GitHub） ----

export const FAKE_GITHUB = "http://github.test";
/** 假 GitHub 认的 token → 用户。 */
export const GITHUB_USERS: Record<string, { id: number; login: string }> = { tok_alice: { id: 1, login: "alice" }, tok_bob: { id: 2, login: "bob" } };

/** 假 GitHub 的 GET /user；别的地址交给真 fetch（连本机中继）。 */
export const fakeGithubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(FAKE_GITHUB)) return fetch(input, init);
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const user = GITHUB_USERS[auth.replace("Bearer ", "")];
  return user === undefined ? new Response("{}", { status: 401 }) : Response.json(user);
}) as typeof fetch;

export interface TestRelay {
  url: string;
  close(): Promise<void>;
  /** 把一台设备登记进 token 对应的账号，回账号编号和状态。 */
  register(identity: MeshIdentity, token?: string): Promise<{ accountId: AccountId; state: string }>;
}

const relays: TestRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
});

export async function startTestRelay(options: { log?: (line: string) => void; now?: () => number; publicOrigin?: string } = {}): Promise<TestRelay> {
  const { startNodeRelay } = await import("../../relay/node/server.ts");
  const running = await startNodeRelay({
    port: 0,
    dbFile: join(tempDir("relay-"), "relay.sqlite"),
    fetch: fakeGithubFetch,
    githubApiOrigin: FAKE_GITHUB,
    ...(options.log ? { log: options.log } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
  });
  const port = running.port;
  const url = `http://127.0.0.1:${port}`;
  const { registerWithRelay } = await import("./relay-client.ts");
  const relay: TestRelay = {
    url,
    close: () => running.close(),
    async register(identity, token = "tok_alice") {
      const result = await registerWithRelay({ relayUrl: url, githubToken: token, identity, device: { id: identity.deviceId, name: `dev-${identity.deviceId.slice(0, 4)}`, platform: "linux" }, fetch: fakeGithubFetch });
      return { accountId: result.accountId, state: result.state };
    },
  };
  relays.push(relay);
  return relay;
}

/** 等条件成立（每 5 毫秒看一次），超时抛错。 */
export async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("等太久了");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- 一台完整的组网设备（createMesh），带一个最小的组网入口 HTTP 服务 ----

/** 假 GitHub 的设备码登录：立刻授权，token 由 tokenOf 给。 */
export function fakeGithubDeviceFlow(token: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${FAKE_GITHUB}/login/device/code`) {
      return Response.json({ device_code: "dev", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    if (url === `${FAKE_GITHUB}/login/oauth/access_token`) return Response.json({ access_token: token, token_type: "bearer", scope: "" });
    return fakeGithubFetch(input, init);
  }) as typeof fetch;
}

export interface TestMeshNode {
  mesh: import("./index.ts").Mesh;
  id: DeviceId;
  /** 组网入口后面的 HTTP 服务（测试可以挂 WebSocket 的 upgrade）。 */
  http: import("node:http").Server;
  dir: string;
  /** 本机组网入口收到的请求路径（对方编号 + 路径）。 */
  requests: Array<{ from: DeviceId; path: string }>;
  close(): Promise<void>;
}

const nodes: TestMeshNode[] = [];
afterEach(async () => {
  for (const node of nodes.splice(0)) await node.close();
});

export async function startTestMeshNode(
  relay: TestRelay,
  deviceId: DeviceId,
  options: {
    token?: string;
    dir?: string;
    lan?: boolean;
    relayUrl?: string;
    now?: () => number;
    handler?: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, from: DeviceId) => void;
  } = {},
): Promise<TestMeshNode> {
  const { createMesh } = await import("./index.ts");
  const { createServer } = await import("node:http");
  const { API_PATHS } = await import("../../shared/api.ts");
  const dir = options.dir ?? tempDir("node-");
  const requests: TestMeshNode["requests"] = [];
  const peerOf = new WeakMap<object, DeviceId>();
  let mesh!: import("./index.ts").Mesh;
  const http = createServer((req, res) => {
    const from = peerOf.get(req.socket)!;
    requests.push({ from, path: req.url ?? "" });
    if (options.handler !== undefined && req.url !== API_PATHS.peerTrust && req.url !== API_PATHS.peerLease) return options.handler(req, res, from);
    if (req.url === API_PATHS.peerLease && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(mesh.leaseSnapshot()));
    }
    if (req.url === API_PATHS.peerTrust && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ statements: mesh.trustStatements() }));
    }
    if (req.url === API_PATHS.peerTrust && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        mesh.receiveTrustStatements(from, JSON.parse(body));
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.end(`pong from ${deviceId} to ${from} ${req.url}`);
  });
  mesh = await createMesh({
    identityDir: join(dir, "mesh"),
    accountFile: join(dir, "account.json"),
    trustFile: join(dir, "peers.json"),
    device: { id: deviceId, name: `dev-${deviceId.slice(0, 4)}` },
    platform: "linux",
    relayUrl: options.relayUrl ?? relay.url,
    githubClientId: "Iv1.test",
    listenPort: 0,
    listenHost: "127.0.0.1",
    candidates: options.lan === false ? () => [] : (port) => [{ host: "127.0.0.1", port }],
    allowLoopback: true,
    onConnection: (connection) => {
      peerOf.set(connection.socket, connection.peer.id);
      http.emit("connection", connection.socket);
    },
    github: { webOrigin: FAKE_GITHUB, apiOrigin: FAKE_GITHUB, sleep: async () => {} },
    fetch: fakeGithubDeviceFlow(options.token ?? "tok_alice"),
    ...(options.now ? { now: options.now } : {}),
    log: () => {},
  });
  const node: TestMeshNode = {
    mesh,
    id: deviceId,
    http,
    dir,
    requests,
    async close() {
      await mesh.close();
      http.close();
    },
  };
  nodes.push(node);
  return node;
}

/** 登录并等到 signed_in（账号第一台）或 awaiting_approval。 */
export async function loginNode(node: Pick<TestMeshNode, "mesh">): Promise<void> {
  await node.mesh.startLogin();
  await waitFor(() => {
    const state = node.mesh.status().state;
    return (state === "signed_in" || state === "awaiting_approval") && (node.mesh.status() as { relay?: string }).relay === "connected";
  });
}

/** approver 批准 joiner：两边核对码一致、都点“一致”，等 joiner 变成 signed_in 且两边信任表都有对方。 */
export async function approveNode(approver: Pick<TestMeshNode, "mesh">, joiner: Pick<TestMeshNode, "mesh">): Promise<string> {
  const joinerId = joiner.mesh.selfId;
  await waitFor(() => approver.mesh.status().state === "signed_in" && (approver.mesh.status() as { approvals: Array<{ requestId: string }> }).approvals.some((a) => a.requestId === joinerId));
  await approver.mesh.beginApproval(joinerId);
  const sas = await waitFor(() => {
    const a = approver.mesh.status() as { approvals?: Array<{ requestId: string; sas: string | null }> };
    const j = joiner.mesh.status() as { approval?: { sas: string | null } | null };
    const sa = a.approvals?.find((x) => x.requestId === joinerId)?.sas ?? null;
    const sj = j.approval?.sas ?? null;
    return sa !== null && sj !== null ? ([sa, sj] as const) : null;
  });
  if (sas[0] !== sas[1]) throw new Error(`核对码不一致：${sas[0]} / ${sas[1]}`);
  await joiner.mesh.answerApproval(approver.mesh.selfId, true);
  await approver.mesh.answerApproval(joinerId, true);
  await waitFor(() => joiner.mesh.status().state === "signed_in" && approver.mesh.trust.get(joinerId) !== undefined && joiner.mesh.trust.get(approver.mesh.selfId) !== undefined);
  return sas[0];
}
