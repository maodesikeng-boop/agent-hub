// 本机管理 socket run/admin.sock（docs/hub-tunnel-design.md 第 7 节）：隧道命令（src/tunnel/）经它让守护进程生成钥匙、分槽位、收连接码。
// socket 0600，另外要带界面令牌（state/ui-token，agent 读不到 state/）。
import { request } from "node:http";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTunnelAdmin, type RunningTunnelAdmin } from "./admin.ts";
import { TunnelInputError, type TunnelService } from "./service.ts";

const TOKEN = "admin-token-0123456789abcdef";

function call(socketPath: string, method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method, path, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: text === "" ? null : JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const calls: Array<[string, unknown]> = [];
const fakeService = {
  ensureKey: async (opts?: { regenerate?: boolean }) => (calls.push(["ensureKey", opts ?? {}]), { publicKey: "ssh-ed25519 AAAA agent-hub" }),
  addSlot: (input: { name: string; publicKey: string }) => {
    calls.push(["addSlot", input]);
    if (input.name === "bad") throw new TunnelInputError("名字不合格");
    return { port: 4401, entryPort: 4319, invite: "inv", expiresAt: 1 };
  },
  removeSlot: (name: string) => (calls.push(["removeSlot", name]), name === "mac" ? { port: 4401 } : null),
  connect: async (code: string) => (calls.push(["connect", code]), { state: "connecting", since: 0, retryAt: null, detail: null }),
  status: () => null,
} as unknown as TunnelService;

let admin: RunningTunnelAdmin | undefined;
afterEach(async () => {
  await admin?.close();
  admin = undefined;
  calls.length = 0;
});

async function start() {
  const runDir = join(mkdtempSync(join(tmpdir(), "hub-adm-")), "run");
  admin = await startTunnelAdmin({ runDir, socketPath: join(runDir, "admin.sock"), authorize: (t) => t === TOKEN, service: fakeService });
  return admin.socketPath;
}

describe("管理 socket", () => {
  it("socket 0600；不带令牌、令牌不对 401，服务一次都没调", async () => {
    const sock = await start();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect((await call(sock, "POST", "/tunnel/key", {}, null)).status).toBe(401);
    expect((await call(sock, "POST", "/tunnel/key", {}, "wrong-token-0123456789")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("各个接口转给服务", async () => {
    const sock = await start();
    expect(await call(sock, "POST", "/tunnel/key", { regenerate: true })).toEqual({ status: 200, body: { publicKey: "ssh-ed25519 AAAA agent-hub" } });
    expect(await call(sock, "POST", "/tunnel/slots", { name: "mac", publicKey: "ssh-ed25519 AAAA" })).toEqual({
      status: 200,
      body: { port: 4401, entryPort: 4319, invite: "inv", expiresAt: 1 },
    });
    expect(await call(sock, "POST", "/tunnel/slots/remove", { name: "mac" })).toEqual({ status: 200, body: { removed: { port: 4401 } } });
    expect(await call(sock, "POST", "/tunnel/slots/remove", { name: "gone" })).toEqual({ status: 200, body: { removed: null } });
    expect((await call(sock, "POST", "/tunnel/connect", { code: "ahtun1_x" })).body).toEqual({ status: { state: "connecting", since: 0, retryAt: null, detail: null } });
    expect(await call(sock, "GET", "/tunnel/status")).toEqual({ status: 200, body: { status: null } });
    expect(calls.map((c) => c[0])).toEqual(["ensureKey", "addSlot", "removeSlot", "removeSlot", "connect"]);
    expect(calls[0]![1]).toEqual({ regenerate: true });
  });

  it("输入不对 400 带原因；坏 JSON 400；没有的接口 404", async () => {
    const sock = await start();
    expect(await call(sock, "POST", "/tunnel/slots", { name: "bad", publicKey: "x" })).toEqual({ status: 400, body: { error: "名字不合格" } });
    expect((await call(sock, "POST", "/tunnel/slots", { name: 1 })).status).toBe(400);
    expect((await call(sock, "POST", "/tunnel/connect", "not an object")).status).toBe(400);
    expect((await call(sock, "POST", "/nope", {})).status).toBe(404);
  });
});
