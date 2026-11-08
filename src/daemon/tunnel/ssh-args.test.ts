// ssh 参数拼装（docs/hub-tunnel-design.md 第 6 节）：快照，改参数要同时改这里和方案。
import { describe, expect, it } from "vitest";
import { TUNNEL_HOST_KEY_ALIAS, buildSshArgs, classifySshLine, knownHostsLine } from "./ssh-args.ts";

const CONFIG = {
  host: "18.179.111.112",
  sshPort: 22,
  user: "agenthub-tunnel",
  listenPort: 4401,
  hubEntryPort: 4319,
  keyFile: "/Users/u/.agent-hub/state/tunnel/id_ed25519",
  knownHostsFile: "/Users/u/.agent-hub/state/tunnel/known_hosts",
  peerSocket: "/Users/u/.agent-hub/run/peer.sock",
  hubSocket: "/Users/u/.agent-hub/run/tunnel/hub.sock",
};

describe("buildSshArgs", () => {
  it("快照", () => {
    expect(buildSshArgs(CONFIG)).toMatchInlineSnapshot(`
      [
        "-N",
        "-T",
        "-F",
        "/dev/null",
        "-i",
        "/Users/u/.agent-hub/state/tunnel/id_ed25519",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "UserKnownHostsFile=/Users/u/.agent-hub/state/tunnel/known_hosts",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "HostKeyAlias=agent-hub-hub",
        "-o",
        "HostKeyAlgorithms=ssh-ed25519",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StreamLocalBindUnlink=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "LogLevel=DEBUG1",
        "-p",
        "22",
        "-R",
        "4401:/Users/u/.agent-hub/run/peer.sock",
        "-L",
        "/Users/u/.agent-hub/run/tunnel/hub.sock:127.0.0.1:4319",
        "agenthub-tunnel@18.179.111.112",
      ]
    `);
  });

  it("别的端口、IPv6 地址", () => {
    const args = buildSshArgs({ ...CONFIG, host: "2001:db8::1", sshPort: 2222, listenPort: 4402 });
    expect(args.slice(-7)).toEqual(["-p", "2222", "-R", `4402:${CONFIG.peerSocket}`, "-L", `${CONFIG.hubSocket}:127.0.0.1:4319`, "agenthub-tunnel@2001:db8::1"]);
  });

  it("地址、用户名、路径不合格就抛（不会拼出一个被 ssh 当成选项的参数）", () => {
    expect(() => buildSshArgs({ ...CONFIG, host: "-oProxyCommand=x" })).toThrow();
    expect(() => buildSshArgs({ ...CONFIG, user: "-l" })).toThrow();
    expect(() => buildSshArgs({ ...CONFIG, peerSocket: "relative/peer.sock" })).toThrow();
    expect(() => buildSshArgs({ ...CONFIG, hubSocket: "/a:b/hub.sock" })).toThrow();
    expect(() => buildSshArgs({ ...CONFIG, listenPort: 0 })).toThrow();
  });
});

describe("known_hosts", () => {
  it("按固定别名钉东京的主机公钥（跟地址无关）", () => {
    expect(TUNNEL_HOST_KEY_ALIAS).toBe("agent-hub-hub");
    expect(knownHostsLine("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")).toBe(
      "agent-hub-hub ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
    );
  });
});

describe("classifySshLine：看 ssh 的 stderr", () => {
  it("两条转发都建好了 = 连上", () => {
    expect(classifySshLine("debug1: remote forward success for: listen 4401, connect /Users/u/.agent-hub/run/peer.sock:-2")).toBe("connected");
  });
  it("钥匙不认、主机公钥不对：不自动重试的两种", () => {
    expect(classifySshLine("agenthub-tunnel@18.179.111.112: Permission denied (publickey).")).toBe("auth_failed");
    expect(classifySshLine("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @")).toBe("hostkey_mismatch");
    expect(classifySshLine("Host key verification failed.")).toBe("hostkey_mismatch");
    expect(classifySshLine("No ED25519 host key is known for agent-hub-hub and you have requested strict checking.")).toBe("hostkey_mismatch");
  });
  it("debug 行里的字样不算；别的错误（东京旧连接占着端口、网络）正常退避", () => {
    expect(classifySshLine("debug1: Permission denied hint")).toBeNull();
    expect(classifySshLine("Error: remote port forwarding failed for listen port 4401")).toBeNull();
    expect(classifySshLine("ssh: connect to host 18.179.111.112 port 22: Connection refused")).toBeNull();
  });
});
