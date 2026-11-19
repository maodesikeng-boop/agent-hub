// 本机管理 socket run/admin.sock：飞书和账号组网的终端命令经它找守护进程。
// socket 0600，另外要带界面令牌（state/ui-token，agent 读不到 state/）。
import { request } from "node:http";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_SOCKET_MAX_BODY_BYTES } from "../../shared/limits.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import type { Mesh } from "../mesh/index.ts";
import { startAdminSocket, type RunningAdminSocket } from "./socket.ts";

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
const DEVICE = "22222222-2222-4222-8222-222222222222";
const fakeMesh = {
  status: () => ({ state: "signed_out", lastError: null }),
  startLogin: async (input: unknown) => (calls.push(["startLogin", input]), { state: "signing_in", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: 1 }),
  cancelLogin: () => void calls.push(["cancelLogin", null]),
  logout: async () => void calls.push(["logout", null]),
  beginApproval: async (id: string) => (calls.push(["beginApproval", id]), { state: "signed_out", lastError: null }),
  answerApproval: async (id: string, match: boolean) => (calls.push(["answerApproval", [id, match]]), { state: "signed_out", lastError: null }),
  setCenterPriority: async (priority: string[]) => void calls.push(["setCenterPriority", priority]),
  removeDevice: async (id: string) => {
    calls.push(["removeDevice", id]);
    throw new Error("不能移除本机：本机请退出账号");
  },
} as unknown as Mesh;

let admin: RunningAdminSocket | undefined;
afterEach(async () => {
  await admin?.close();
  admin = undefined;
  calls.length = 0;
});

async function start(onShutdown?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "hub-adm-"));
  const runDir = join(dir, "run");
  const socketPath = process.platform === "win32" ? resolveHubPaths({}, dir).adminSock : join(runDir, "admin.sock");
  admin = await startAdminSocket({
    runDir,
    socketPath,
    authorize: (t) => t === TOKEN,
    mesh: () => fakeMesh,
    ...(onShutdown ? { onShutdown } : {}),
  });
  return admin.socketPath;
}

describe("管理 socket", () => {
  it("socket 0600；不带令牌、令牌不对 401，服务一次都没调", async () => {
    const sock = await start();
    if (process.platform !== "win32") expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect((await call(sock, "POST", "/mesh/login", {}, null)).status).toBe(401);
    expect((await call(sock, "POST", "/mesh/login", {}, "wrong-token-0123456789")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("账号组网的接口转给 Mesh", async () => {
    const sock = await start();
    expect(await call(sock, "GET", "/mesh/status")).toEqual({ status: 200, body: { state: "signed_out", lastError: null } });
    expect((await call(sock, "POST", "/mesh/login", { relayUrl: "https://relay.example" })).body).toMatchObject({ state: "signing_in", userCode: "ABCD-EFGH" });
    expect((await call(sock, "DELETE", "/mesh/login")).status).toBe(200);
    expect((await call(sock, "POST", "/mesh/approvals/begin", { requestId: DEVICE })).status).toBe(200);
    expect((await call(sock, "POST", "/mesh/approvals/answer", { requestId: DEVICE, match: true })).status).toBe(200);
    expect((await call(sock, "PUT", "/mesh/priority", { priority: [DEVICE] })).status).toBe(200);
    expect((await call(sock, "POST", "/mesh/logout")).status).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(["startLogin", "cancelLogin", "beginApproval", "answerApproval", "setCenterPriority", "logout"]);
    expect(calls[0]![1]).toEqual({ relayUrl: "https://relay.example" });
  });

  it("输入不对 400 带原因；坏 JSON、超限请求体 400；没有的接口 404", async () => {
    const sock = await start();
    expect(await call(sock, "POST", "/mesh/devices/remove", { id: DEVICE })).toEqual({ status: 400, body: { error: "不能移除本机：本机请退出账号" } });
    expect((await call(sock, "POST", "/mesh/approvals/begin", { requestId: "../x" })).status).toBe(400);
    expect((await call(sock, "POST", "/mesh/login", "not an object")).status).toBe(400);
    expect(await call(sock, "PUT", "/mesh/priority", { priority: ["x".repeat(ADMIN_SOCKET_MAX_BODY_BYTES)] })).toEqual({
      status: 400,
      body: { error: "请求太大" },
    });
    expect((await call(sock, "POST", "/nope", {})).status).toBe(404);
    expect((await call(sock, "POST", "/tunnel/key", {})).status).toBe(404);
  });

  it("POST /admin/shutdown 带正确令牌触发优雅关机回调", async () => {
    let triggered = false;
    const sock = await start(() => {
      triggered = true;
    });
    expect(await call(sock, "POST", "/admin/shutdown", {})).toEqual({ status: 200, body: { ok: true } });
    await new Promise((r) => setImmediate(r));
    expect(triggered).toBe(true);
  });
});
