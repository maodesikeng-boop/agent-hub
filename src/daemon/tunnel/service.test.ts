// 隧道服务（docs/hub-tunnel-design.md 第 6、7 节）：专用钥匙、中心上的槽位和邀请码、连入方收连接码起隧道。
// ssh-keygen 用真的；ssh 子进程换成记参数的假监督器。
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TUNNEL_FIRST_SLOT_PORT } from "../../shared/limits.ts";
import { encodeConnectionCode, type TunnelStatus } from "../../shared/tunnel.ts";
import { TunnelInputError, createTunnelService, type TunnelServiceOptions } from "./service.ts";
import { buildSshArgs } from "./ssh-args.ts";
import type { TunnelSupervisor } from "./supervisor.ts";
import { bindSlotDevice, loadTunnelTable, saveTunnelTable } from "./table.ts";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const PUB_MAC = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhsK3UFdyXPDkN0GMsDdzcuMdUKAxB7m9PiRJEBVSqU agent-hub";
const CODE = {
  host: "203.0.113.10",
  sshPort: 22,
  user: "agenthub-tunnel",
  hostKey: HOST_KEY,
  listenPort: 4401,
  entryPort: 4319,
  invite: "Xy9_abcdefghijklmnopqr",
};

interface FakeSupervisor extends TunnelSupervisor {
  args: readonly string[];
  started: boolean;
  stopped: boolean;
  emit(status: TunnelStatus): void;
}

let dir: string;
let paths: TunnelServiceOptions["paths"];
let supervisors: FakeSupervisor[];
let invites: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-tunnel-svc-"));
  paths = {
    tableFile: join(dir, "state", "tunnels.json"),
    keyFile: join(dir, "state", "tunnel", "id_ed25519"),
    knownHostsFile: join(dir, "state", "tunnel", "known_hosts"),
    pidFile: join(dir, "state", "tunnel", "ssh.pid"),
    peerSocket: join(dir, "run", "peer.sock"),
    hubSocket: join(dir, "run", "tunnel", "hub.sock"),
  };
  supervisors = [];
  invites = [];
});

function service(extra: Partial<TunnelServiceOptions> = {}) {
  return createTunnelService({
    paths,
    entryPort: 4319,
    createInvite: (port) => {
      invites.push(port);
      return { code: `invite-code-for-${port}-xxxxxxxx`, expiresAt: 123 };
    },
    startSupervisor: (args) => {
      const listeners = new Set<(s: TunnelStatus) => void>();
      let status: TunnelStatus = { state: "connecting", since: 0, retryAt: null, detail: null };
      const s: FakeSupervisor = {
        args,
        started: false,
        stopped: false,
        start: () => void (s.started = true),
        status: () => status,
        onChange: (l) => (listeners.add(l), () => listeners.delete(l)),
        reconnectNow: () => true,
        retry: () => {},
        stop: async () => void (s.stopped = true),
        emit: (next) => {
          status = next;
          for (const l of listeners) l(next);
        },
      };
      supervisors.push(s);
      return s;
    },
    ...extra,
  });
}

describe.skipIf(process.platform === "win32")("专用钥匙", () => {
  it("第一次生成 ed25519、私钥 0600、无口令；之后沿用；regenerate 换一把", async () => {
    const svc = service();
    const { publicKey } = await svc.ensureKey();
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* agent-hub$/);
    expect(statSync(paths.keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.keyFile, "utf8")).toContain("OPENSSH PRIVATE KEY");
    expect((await svc.ensureKey()).publicKey).toBe(publicKey);
    const next = await svc.ensureKey({ regenerate: true });
    expect(next.publicKey).not.toBe(publicKey);
  });
});

describe.skipIf(process.platform === "win32")("中心：槽位和邀请码", () => {
  it("加设备：分槽位、出绑这个槽位的邀请码；同名再加端口不变；表 0600", () => {
    const svc = service();
    const a = svc.addSlot({ name: "mac", publicKey: PUB_MAC });
    expect(a).toEqual({ port: TUNNEL_FIRST_SLOT_PORT, entryPort: 4319, invite: `invite-code-for-${TUNNEL_FIRST_SLOT_PORT}-xxxxxxxx`, expiresAt: 123 });
    expect(invites).toEqual([TUNNEL_FIRST_SLOT_PORT]);
    expect(svc.addSlot({ name: "mac", publicKey: PUB_MAC }).port).toBe(TUNNEL_FIRST_SLOT_PORT);
    expect(svc.addSlot({ name: "linux", publicKey: PUB_MAC.replace("IBhs", "IChs") }).port).toBe(TUNNEL_FIRST_SLOT_PORT + 1);
    expect(statSync(paths.tableFile).mode & 0o777).toBe(0o600);
    expect(loadTunnelTable(paths.tableFile).slots.map((s) => [s.name, s.port])).toEqual([
      ["mac", TUNNEL_FIRST_SLOT_PORT],
      ["linux", TUNNEL_FIRST_SLOT_PORT + 1],
    ]);
  });

  it("名字、公钥不合格或别的设备已用同一把公钥：TunnelInputError，表不动", () => {
    const svc = service();
    expect(() => svc.addSlot({ name: "-mac", publicKey: PUB_MAC })).toThrow(TunnelInputError);
    expect(() => svc.addSlot({ name: "mac", publicKey: "ssh-rsa AAAA" })).toThrow(TunnelInputError);
    expect(existsSync(paths.tableFile)).toBe(false);
    svc.addSlot({ name: "mac", publicKey: PUB_MAC });
    expect(() => svc.addSlot({ name: "linux", publicKey: PUB_MAC })).toThrow(TunnelInputError);
    expect(loadTunnelTable(paths.tableFile).slots.map((s) => s.name)).toEqual(["mac"]);
  });

  it("删设备：回端口；槽位绑了 deviceId 时触发 onRemoveDevice；再删回 null", () => {
    const removedDevices: string[] = [];
    const svc = service({ onRemoveDevice: (id) => removedDevices.push(id) });
    svc.addSlot({ name: "mac", publicKey: PUB_MAC });
    const table = loadTunnelTable(paths.tableFile);
    saveTunnelTable(paths.tableFile, bindSlotDevice(table, TUNNEL_FIRST_SLOT_PORT, "device-mac-1").table);
    expect(svc.removeSlot("mac")).toEqual({ port: TUNNEL_FIRST_SLOT_PORT });
    expect(removedDevices).toEqual(["device-mac-1"]);
    expect(svc.removeSlot("mac")).toBeNull();
    expect(loadTunnelTable(paths.tableFile).slots).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("连入方：连接码 → 隧道", () => {
  it("钉主机公钥、记下中心、用 ssh-args 拼的参数起监督；状态转出去", async () => {
    const svc = service();
    expect(svc.status()).toBeNull();
    const seen: Array<TunnelStatus | null> = [];
    svc.onChange((s) => seen.push(s));
    await svc.connect(encodeConnectionCode(CODE));
    expect(readFileSync(paths.knownHostsFile, "utf8")).toBe(`agent-hub-hub ${HOST_KEY}\n`);
    const hub = loadTunnelTable(paths.tableFile).hub;
    expect(hub).toEqual({ host: CODE.host, sshPort: 22, user: CODE.user, hostKey: HOST_KEY, listenPort: 4401, hubEntryPort: 4319, deviceId: null, invite: CODE.invite });
    expect(supervisors).toHaveLength(1);
    expect(supervisors[0]!.started).toBe(true);
    expect(supervisors[0]!.args).toEqual(
      buildSshArgs({
        host: CODE.host,
        sshPort: 22,
        user: CODE.user,
        listenPort: 4401,
        hubEntryPort: 4319,
        keyFile: paths.keyFile,
        knownHostsFile: paths.knownHostsFile,
        peerSocket: paths.peerSocket,
        hubSocket: paths.hubSocket,
      }),
    );
    const connected: TunnelStatus = { state: "connected", since: 5, retryAt: null, detail: null };
    supervisors[0]!.emit(connected);
    expect(svc.status()).toEqual(connected);
    expect(seen.at(-1)).toEqual(connected);
    expect(svc.reconnectNow()).toBe(true);
  });

  it("再贴一次（换中心或换钥匙）：停掉旧的、起新的", async () => {
    const svc = service();
    await svc.connect(encodeConnectionCode(CODE));
    await svc.connect(encodeConnectionCode({ ...CODE, listenPort: 4402 }));
    expect(supervisors[0]!.stopped).toBe(true);
    expect(supervisors[1]!.started).toBe(true);
    expect(supervisors[1]!.args).toContain(`4402:${paths.peerSocket}`);
  });

  it("坏的连接码：TunnelInputError，什么都不写", async () => {
    const svc = service();
    await expect(svc.connect("ahtun1_garbage")).rejects.toThrow(TunnelInputError);
    expect(existsSync(paths.tableFile)).toBe(false);
    expect(supervisors).toEqual([]);
  });

  it("启动时表里已经有中心：起监督；没有：不起，提前重连回 false；close 停掉", async () => {
    const empty = service();
    await empty.start();
    expect(supervisors).toEqual([]);
    expect(empty.reconnectNow()).toBe(false);

    await service().connect(encodeConnectionCode(CODE));
    supervisors.length = 0;
    const svc = service();
    await svc.start();
    expect(supervisors).toHaveLength(1);
    expect(supervisors[0]!.started).toBe(true);
    await svc.close();
    expect(supervisors[0]!.stopped).toBe(true);
  });

  it("known_hosts 被别人改了：下次 connect 照连接码重写", async () => {
    const svc = service();
    await svc.connect(encodeConnectionCode(CODE));
    writeFileSync(paths.knownHostsFile, "agent-hub-hub ssh-ed25519 AAAAevil\n");
    await svc.connect(encodeConnectionCode(CODE));
    expect(readFileSync(paths.knownHostsFile, "utf8")).toBe(`agent-hub-hub ${HOST_KEY}\n`);
  });
});
