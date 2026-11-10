// 隧道命令（docs/hub-tunnel-design.md 第 7 节）：中心上 add / remove，连入方上 join（一条命令做完）/ connect（贴连接码兜底）/ key。
// 守护进程（管理 socket）、外部命令（ssh、sudo）、读文件都换成假的，只看命令按什么顺序调了什么、输出什么。
import { describe, expect, it } from "vitest";
import { decodeConnectionCode, encodeConnectionCode } from "../shared/tunnel.ts";
import { AdminUnavailableError, TUNNEL_ROOT_SCRIPT, runTunnelCli, type TunnelCliIo } from "./cli.ts";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhsK3UFdyXPDkN0GMsDdzcuMdUKAxB7m9PiRJEBVSqU agent-hub";
const CODE = encodeConnectionCode({
  host: "203.0.113.10",
  sshPort: 22,
  user: "agenthub-tunnel",
  hostKey: HOST_KEY,
  listenPort: 4401,
  entryPort: 4319,
  invite: "Xy9_abcdefghijklmnopqr",
});

type Call = { kind: "admin"; method: string; path: string; body?: unknown } | { kind: "run"; cmd: string; args: string[] };

function harness(opts: {
  admin?: (method: string, path: string, body?: unknown) => unknown;
  run?: (cmd: string, args: string[]) => { code: number; stdout: string };
  files?: Record<string, string>;
}) {
  const calls: Call[] = [];
  let stdout = "";
  let stderr = "";
  const io = (argv: string[]): TunnelCliIo => ({
    argv,
    stdout: { write: (t: string) => (stdout += t) },
    stderr: { write: (t: string) => (stderr += t) },
    admin: async (method, path, body) => {
      calls.push({ kind: "admin", method, path, ...(body === undefined ? {} : { body }) });
      return opts.admin ? opts.admin(method, path, body) : {};
    },
    run: async (cmd, args) => {
      calls.push({ kind: "run", cmd, args });
      return opts.run ? opts.run(cmd, args) : { code: 0, stdout: "" };
    },
    readFile: (path) => {
      const text = opts.files?.[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      return text;
    },
    hostname: () => "dev-macbook-pro.local",
  });
  return { io, calls, out: () => stdout, err: () => stderr };
}

describe("中心：add", () => {
  const files = { "/etc/ssh/ssh_host_ed25519_key.pub": `${HOST_KEY} root@ip-172-26-0-1\n` };

  it("守护进程分槽位 → sudo 装钥匙行 → 标准输出只有一行连接码", async () => {
    const h = harness({
      admin: (_m, path) => (path === "/tunnel/slots" ? { port: 4401, entryPort: 4319, invite: "Xy9_abcdefghijklmnopqr", expiresAt: 1 } : {}),
      files,
    });
    const code = await runTunnelCli(h.io(["add", "--name", "mac", "--host", "203.0.113.10", "--pubkey", PUB]));
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      { kind: "admin", method: "POST", path: "/tunnel/slots", body: { name: "mac", publicKey: PUB } },
      {
        kind: "run",
        cmd: "sudo",
        args: ["-n", TUNNEL_ROOT_SCRIPT, "add-key", "--name", "mac", "--port", "4401", "--entry-port", "4319", "--pubkey", PUB],
      },
    ]);
    const lines = h.out().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(decodeConnectionCode(lines[0]!)).toEqual({
      host: "203.0.113.10",
      sshPort: 22,
      user: "agenthub-tunnel",
      hostKey: HOST_KEY,
      listenPort: 4401,
      entryPort: 4319,
      invite: "Xy9_abcdefghijklmnopqr",
    });
  });

  it("--ssh-port 写进连接码", async () => {
    const h = harness({ admin: () => ({ port: 4402, entryPort: 4319, invite: "Xy9_abcdefghijklmnopqr", expiresAt: 1 }), files });
    expect(await runTunnelCli(h.io(["add", "--name", "pi", "--host", "hub.example.com", "--ssh-port", "2222", "--pubkey", PUB]))).toBe(0);
    expect(decodeConnectionCode(h.out().trim())).toMatchObject({ host: "hub.example.com", sshPort: 2222, listenPort: 4402 });
  });

  it("sudo 那步失败：不出连接码，退出码 1", async () => {
    const h = harness({
      admin: () => ({ port: 4401, entryPort: 4319, invite: "Xy9_abcdefghijklmnopqr", expiresAt: 1 }),
      run: () => ({ code: 1, stdout: "" }),
      files,
    });
    expect(await runTunnelCli(h.io(["add", "--name", "mac", "--host", "203.0.113.10", "--pubkey", PUB]))).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toMatch(/sudo/);
  });

  it("守护进程没在跑：说清楚，退出码 1，不碰 sudo", async () => {
    const h = harness({
      admin: () => {
        throw new AdminUnavailableError("/home/ubuntu/.agent-hub/run/admin.sock");
      },
      files,
    });
    expect(await runTunnelCli(h.io(["add", "--name", "mac", "--host", "203.0.113.10", "--pubkey", PUB]))).toBe(1);
    expect(h.calls.filter((c) => c.kind === "run")).toEqual([]);
    expect(h.err()).toMatch(/守护进程/);
  });

  it("参数不对：退出码 2，什么都不做", async () => {
    for (const argv of [
      ["add", "--name", "mac", "--pubkey", PUB],
      ["add", "--name", "-mac", "--host", "h", "--pubkey", PUB],
      ["add", "--name", "mac", "--host", "-oProxyCommand=x", "--pubkey", PUB],
      ["add", "--name", "mac", "--host", "h", "--pubkey", "ssh-rsa AAAA"],
      ["add", "--name", "mac", "--host", "h", "--pubkey", PUB, "--ssh-port", "0"],
      ["nope"],
      [],
    ]) {
      const h = harness({ files });
      expect(await runTunnelCli(h.io(argv)), argv.join(" ")).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });
});

describe("中心：remove", () => {
  it("先 sudo 删钥匙行、断旧会话，再让守护进程收回槽位；跑两遍一样", async () => {
    for (const removed of [{ port: 4401 }, null]) {
      const h = harness({ admin: () => ({ removed }) });
      expect(await runTunnelCli(h.io(["remove", "--name", "mac"]))).toBe(0);
      expect(h.calls).toEqual([
        { kind: "run", cmd: "sudo", args: ["-n", TUNNEL_ROOT_SCRIPT, "remove-key", "--name", "mac"] },
        { kind: "admin", method: "POST", path: "/tunnel/slots/remove", body: { name: "mac" } },
      ]);
    }
  });
});

describe("连入方：join 一条命令", () => {
  it("守护进程出公钥 → 用管理员钥匙 ssh 到中心跑 add → 连接码交给守护进程", async () => {
    const h = harness({
      admin: (_m, path) => (path === "/tunnel/key" ? { publicKey: PUB } : { status: { state: "connecting", since: 0, retryAt: null, detail: null } }),
      run: (_cmd, args) =>
        args.includes("-G")
          ? { code: 0, stdout: "user ubuntu\nhostname 203.0.113.10\nport 22\nidentityfile ~/.ssh/id_ed25519\n" }
          : { code: 0, stdout: `[tunnel] 一些提示\n${CODE}\n` },
    });
    const code = await runTunnelCli(h.io(["join", "-i", "/Users/u/.ssh/id_ed25519", "ubuntu@tokyo"]));
    expect(code).toBe(0);
    expect(h.calls).toEqual([
      { kind: "admin", method: "POST", path: "/tunnel/key", body: {} },
      { kind: "run", cmd: "ssh", args: ["-i", "/Users/u/.ssh/id_ed25519", "-G", "ubuntu@tokyo"] },
      {
        kind: "run",
        cmd: "ssh",
        args: [
          "-i",
          "/Users/u/.ssh/id_ed25519",
          "ubuntu@tokyo",
          `node agent-hub/src/tunnel/main.ts add --name dev-macbook-pro --host 203.0.113.10 --ssh-port 22 --pubkey 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhsK3UFdyXPDkN0GMsDdzcuMdUKAxB7m9PiRJEBVSqU agent-hub'`,
        ],
      },
      { kind: "admin", method: "POST", path: "/tunnel/connect", body: { code: CODE } },
    ]);
  });

  it("-p、--name、--remote-dir", async () => {
    const h = harness({
      admin: (_m, path) => (path === "/tunnel/key" ? { publicKey: PUB } : { status: null }),
      run: (_cmd, args) => (args.includes("-G") ? { code: 0, stdout: "hostname hub.example.com\nport 2222\n" } : { code: 0, stdout: `${CODE}\n` }),
    });
    expect(await runTunnelCli(h.io(["join", "-p", "2222", "--name", "mac", "--remote-dir", "/opt/agent hub", "admin@hub.example.com"]))).toBe(0);
    const remote = h.calls[2] as { args: string[] };
    expect(remote.args.slice(0, 3)).toEqual(["-p", "2222", "admin@hub.example.com"]);
    expect(remote.args[3]).toBe(`node '/opt/agent hub/src/tunnel/main.ts' add --name mac --host hub.example.com --ssh-port 2222 --pubkey '${PUB}'`);
  });

  it("中心上那条失败、没输出连接码：退出码 1，不交给守护进程", async () => {
    for (const result of [{ code: 1, stdout: "" }, { code: 0, stdout: "没有连接码\n" }]) {
      const h = harness({
        admin: () => ({ publicKey: PUB }),
        run: (_cmd, args) => (args.includes("-G") ? { code: 0, stdout: "hostname 1.2.3.4\nport 22\n" } : result),
      });
      expect(await runTunnelCli(h.io(["join", "ubuntu@1.2.3.4"]))).toBe(1);
      expect(h.calls.some((c) => c.kind === "admin" && c.path === "/tunnel/connect")).toBe(false);
    }
  });
});

describe("连入方：connect / key", () => {
  it("connect：先在本地校验连接码，再交给守护进程", async () => {
    const h = harness({ admin: () => ({ status: null }) });
    expect(await runTunnelCli(h.io(["connect", CODE]))).toBe(0);
    expect(h.calls).toEqual([{ kind: "admin", method: "POST", path: "/tunnel/connect", body: { code: CODE } }]);
    const bad = harness({});
    expect(await runTunnelCli(bad.io(["connect", "ahtun1_garbage"]))).toBe(2);
    expect(bad.calls).toEqual([]);
  });

  it("key：打印专用公钥（在别的机器上跑 add 时用）", async () => {
    const h = harness({ admin: () => ({ publicKey: PUB }) });
    expect(await runTunnelCli(h.io(["key"]))).toBe(0);
    expect(h.out()).toBe(`${PUB}\n`);
  });
});
