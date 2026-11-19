import { describe, expect, it } from "vitest";
import { AdminUnavailableError } from "../admin/client.ts";
import type { AccountId, AccountStatusView, DeviceFingerprint } from "../shared/mesh.ts";
import { runMeshCli, type MeshCliIo } from "./cli.ts";

const DEV_A = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const DEV_B = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
const FP_A = "a".repeat(64) as DeviceFingerprint;
const FP_B = "b".repeat(64) as DeviceFingerprint;
const ACCOUNT_ID = "acct_abcdefghijklmnopqrstuvwxyz" as AccountId;
const LOGIN = { provider: "github" as const, userId: "1", login: "alice" };

function signedIn(over: Partial<Extract<AccountStatusView, { state: "signed_in" }>> = {}): AccountStatusView {
  return {
    state: "signed_in",
    login: LOGIN,
    accountId: ACCOUNT_ID,
    relayUrl: "https://relay.test",
    relay: "connected",
    devices: [
      { id: DEV_A, name: "Tokyo", platform: "linux", fingerprint: FP_A, self: true, online: true, link: "local", lastSeenAt: null },
      { id: DEV_B, name: "Mac", platform: "darwin", fingerprint: FP_B, self: false, online: true, link: "relay", lastSeenAt: null },
    ],
    approvals: [],
    centerPriority: [DEV_A, DEV_B],
    feishuHolder: DEV_A,
    ...over,
  };
}

function harness(
  argv: string[],
  handlers: Record<string, (body: unknown) => unknown | Promise<unknown>>,
  answers: string[] = [],
) {
  let out = "";
  let err = "";
  const calls: { method: string; path: string; body: unknown }[] = [];
  const prompts: string[] = [];
  const io: MeshCliIo = {
    argv,
    stdout: { write: (t) => (out += t) },
    stderr: { write: (t) => (err += t) },
    admin: async (method, path, body) => {
      calls.push({ method, path, body });
      const fn = handlers[`${method} ${path}`];
      if (!fn) throw new Error(`unexpected ${method} ${path}`);
      return await fn(body);
    },
    readLine: async (prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? "";
    },
    sleep: async () => {},
  };
  return {
    run: () => runMeshCli(io),
    out: () => out,
    err: () => err,
    calls,
    prompts,
  };
}

describe("runMeshCli", () => {
  it("login 打印 8 位码和 github.com/login/device，登录完成后退出码 0", async () => {
    const states: AccountStatusView[] = [
      { state: "signing_in", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 600_000 },
      signedIn({ devices: [{ id: DEV_A, name: "Tokyo", platform: "linux", fingerprint: FP_A, self: true, online: true, link: "local", lastSeenAt: null }], centerPriority: [DEV_A] }),
    ];
    const h = harness(["login", "--relay", "https://relay.self.test"], {
      "POST /mesh/login": () => states[0]!,
      "GET /mesh/status": () => states.shift() ?? states[0]!,
    });
    expect(await h.run()).toBe(0);
    expect(h.calls[0]).toEqual({ method: "POST", path: "/mesh/login", body: { relayUrl: "https://relay.self.test" } });
    expect(h.out()).toContain("WDJB-MJHT");
    expect(h.out()).toContain("https://github.com/login/device");
    expect(h.out()).toContain("alice");
  });

  it("login 后本机要批准时打印核对码，输入 y 后等到加入", async () => {
    const states: AccountStatusView[] = [
      { state: "awaiting_approval", login: LOGIN, relay: "connected", approval: null },
      {
        state: "awaiting_approval",
        login: LOGIN,
        relay: "connected",
        approval: {
          requestId: DEV_A,
          device: { id: DEV_A, name: "Tokyo", platform: "linux", fingerprint: FP_A },
          requestedAt: 1,
          expiresAt: Date.now() + 600_000,
          sas: "042917",
        },
      },
      signedIn(),
    ];
    const h = harness(
      ["login"],
      {
        "POST /mesh/login": () => ({ state: "signing_in", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 600_000 }),
        "GET /mesh/status": () => states.shift() ?? signedIn(),
        "POST /mesh/approvals/answer": () => states[0] ?? signedIn(),
      },
      ["y"],
    );
    expect(await h.run()).toBe(0);
    expect(h.out()).toContain("等批准");
    expect(h.out()).toMatch(/042\s?917/);
    expect(h.calls).toContainEqual({ method: "POST", path: "/mesh/approvals/answer", body: { requestId: DEV_A, match: true } });
  });

  it("核对时输入 n 退出码 1，批准作废", async () => {
    const h = harness(
      ["approve", DEV_B],
      {
        "POST /mesh/approvals/begin": () =>
          signedIn({
            approvals: [
              {
                requestId: DEV_B,
                device: { id: DEV_B, name: "Mac", platform: "darwin", fingerprint: FP_B },
                requestedAt: 1,
                expiresAt: Date.now() + 600_000,
                sas: "581204",
              },
            ],
          }),
        "POST /mesh/approvals/answer": () => signedIn({ approvals: [] }),
      },
      ["n"],
    );
    expect(await h.run()).toBe(1);
    expect(h.calls).toContainEqual({ method: "POST", path: "/mesh/approvals/answer", body: { requestId: DEV_B, match: false } });
    expect(h.err()).not.toBe("");
  });

  it("status 打印账号、中继状态、设备列表和当前中心", async () => {
    const h = harness(["status"], {
      "GET /mesh/status": () => signedIn(),
    });
    expect(await h.run()).toBe(0);
    expect(h.out()).toContain("alice");
    expect(h.out()).toContain("connected");
    expect(h.out()).toContain("Tokyo");
    expect(h.out()).toContain("Mac");
    expect(h.out()).toContain(DEV_A);
  });

  it("approve 对一条等批准的请求开始核对，输入 y 后完成", async () => {
    const pending = signedIn({
      devices: [{ id: DEV_A, name: "Tokyo", platform: "linux", fingerprint: FP_A, self: true, online: true, link: "local", lastSeenAt: null }],
      approvals: [
        {
          requestId: DEV_B,
          device: { id: DEV_B, name: "Mac", platform: "darwin", fingerprint: FP_B },
          requestedAt: 1,
          expiresAt: Date.now() + 600_000,
          sas: null,
        },
      ],
    });
    const withSas = signedIn({
      devices: pending.state === "signed_in" ? pending.devices : [],
      approvals: [
        {
          requestId: DEV_B,
          device: { id: DEV_B, name: "Mac", platform: "darwin", fingerprint: FP_B },
          requestedAt: 1,
          expiresAt: Date.now() + 600_000,
          sas: "918273",
        },
      ],
    });
    const states = [withSas, signedIn()];
    const h = harness(
      ["approve", DEV_B],
      {
        "POST /mesh/approvals/begin": () => pending,
        "GET /mesh/status": () => states.shift() ?? signedIn(),
        "POST /mesh/approvals/answer": () => signedIn(),
      },
      ["y"],
    );
    expect(await h.run()).toBe(0);
    expect(h.calls[0]).toEqual({ method: "POST", path: "/mesh/approvals/begin", body: { requestId: DEV_B } });
    expect(h.out()).toMatch(/918\s?273/);
    expect(h.calls).toContainEqual({ method: "POST", path: "/mesh/approvals/answer", body: { requestId: DEV_B, match: true } });
  });

  it("priority 按给的顺序设中心顺序，不在账号里的设备报错", async () => {
    const bad = harness(["priority", DEV_B, "99999999-9999-4999-8999-999999999999"], {
      "GET /mesh/status": () => signedIn(),
    });
    expect(await bad.run()).toBe(1);
    expect(bad.err()).toContain("不在账号里");
    expect(bad.calls.some((c) => c.path === "/mesh/priority")).toBe(false);

    const ok = harness(["priority", DEV_B, DEV_A], {
      "GET /mesh/status": () => signedIn(),
      "PUT /mesh/priority": () => signedIn({ centerPriority: [DEV_B, DEV_A] }),
    });
    expect(await ok.run()).toBe(0);
    expect(ok.calls).toContainEqual({ method: "PUT", path: "/mesh/priority", body: { priority: [DEV_B, DEV_A] } });
  });

  it("守护进程连不上时退出码 1，提示先启动守护进程", async () => {
    const h = harness(["status"], {
      "GET /mesh/status": () => {
        throw new AdminUnavailableError("/tmp/run/admin.sock");
      },
    });
    expect(await h.run()).toBe(1);
    expect(h.err()).toContain("先启动");
  });

  it("不认识的子命令打印用法，退出码 2", async () => {
    const h = harness(["unknown-cmd"], {});
    expect(await h.run()).toBe(2);
    expect(h.err()).toContain("用法：");
  });
});
