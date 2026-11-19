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

export async function startTestRelay(options: { log?: (line: string) => void } = {}): Promise<TestRelay> {
  const { startNodeRelay } = await import("../../relay/node/server.ts");
  const running = await startNodeRelay({
    port: 0,
    dbFile: join(tempDir("relay-"), "relay.sqlite"),
    fetch: fakeGithubFetch,
    githubApiOrigin: FAKE_GITHUB,
    ...(options.log ? { log: options.log } : {}),
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
