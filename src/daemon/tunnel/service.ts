// 隧道服务（docs/hub-tunnel-design.md 第 6、7 节）：守护进程这一半，管理 socket（admin.ts）和 /api/state 都经它。
// - 连入方：生成专用钥匙 state/tunnel/id_ed25519（不读、不存管理员钥匙）；收连接码 → 钉主机公钥、记中心、起 ssh 监督；
// - 中心：分槽位（-R 端口）、出邀请码。要 root 的（建用户、sshd 片段、钥匙行）不在这里，在 scripts/tunnel-sshd.sh。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { decodeConnectionCode, isTunnelName, parseEd25519PublicKey, type TunnelStatus } from "../../shared/tunnel.ts";
import { buildSshArgs, knownHostsLine } from "./ssh-args.ts";
import { createTunnelSupervisor, killStaleSsh, type TunnelSupervisor } from "./supervisor.ts";
import { TunnelInputError, keyFingerprint, loadTunnelTable, removeSlot, saveTunnelTable, upsertSlot, type TunnelHub } from "./table.ts";

export { TunnelInputError };

export interface TunnelServicePaths {
  tableFile: string;
  keyFile: string;
  knownHostsFile: string;
  pidFile: string;
  /** 本机设备入口 run/peer.sock（块 A），-R 的目标。 */
  peerSocket: string;
  /** -L 建的 run/tunnel/hub.sock。 */
  hubSocket: string;
}

export interface TunnelServiceOptions {
  paths: TunnelServicePaths;
  /** 本机当中心时的设备入口端口（写进连接码，-L 连它）。 */
  entryPort: number;
  /** 给某个槽位出一个邀请码（绑槽位由块 B 做；现在接 peers 的邀请码）。 */
  createInvite(slotPort: number): { code: string; expiresAt: number };
  sshCommand?: string;
  keygenCommand?: string;
  /** 起一个 ssh 监督（测试换成假的）。默认 createTunnelSupervisor。 */
  startSupervisor?: (args: readonly string[]) => TunnelSupervisor;
}

export interface TunnelSlotGrant {
  port: number;
  entryPort: number;
  invite: string;
  expiresAt: number;
}

export interface TunnelService {
  /** 启动时：收掉上次留下的 ssh；表里有中心就起隧道。 */
  start(): Promise<void>;
  /** 连入方隧道的状态；没连过中心是 null。 */
  status(): TunnelStatus | null;
  onChange(listener: (status: TunnelStatus | null) => void): () => void;
  /** 提前重连（块 B 的转发在 /d/<中心> 连不上时调），见 supervisor.ts。没有隧道回 false。 */
  reconnectNow(): boolean;
  retry(): void;
  /** 专用钥匙：没有就生成；regenerate 换一把。回公钥一行。 */
  ensureKey(opts?: { regenerate?: boolean }): Promise<{ publicKey: string }>;
  /** 收连接码：钉主机公钥、记中心、（重新）起隧道。 */
  connect(code: string): Promise<TunnelStatus>;
  /** 中心：给一台设备分槽位、出邀请码。同名再来保留端口、换钥匙。 */
  addSlot(input: { name: string; publicKey: string }): TunnelSlotGrant;
  /** 中心：收回槽位。本来就没有回 null。 */
  removeSlot(name: string): { port: number } | null;
  close(): Promise<void>;
}

const run = promisify(execFile);

export function createTunnelService(opts: TunnelServiceOptions): TunnelService {
  const { paths } = opts;
  const listeners = new Set<(status: TunnelStatus | null) => void>();
  let supervisor: TunnelSupervisor | null = null;
  let offSupervisor: (() => void) | null = null;
  /** 钥匙生成、起停隧道都排队做，免得两条命令同时来时交错。 */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const emit = () => {
    const status = supervisor?.status() ?? null;
    for (const listener of listeners) listener(status);
  };
  const startSupervisor =
    opts.startSupervisor ?? ((args: readonly string[]) => createTunnelSupervisor({ command: opts.sshCommand ?? "ssh", args, pidFile: paths.pidFile }));

  async function stopTunnel() {
    offSupervisor?.();
    offSupervisor = null;
    const old = supervisor;
    supervisor = null;
    await old?.stop();
  }

  async function startTunnel(hub: TunnelHub) {
    await stopTunnel();
    mkdirSync(dirname(paths.hubSocket), { recursive: true, mode: 0o700 });
    const args = buildSshArgs({
      host: hub.host,
      sshPort: hub.sshPort,
      user: hub.user,
      listenPort: hub.listenPort,
      hubEntryPort: hub.hubEntryPort,
      keyFile: paths.keyFile,
      knownHostsFile: paths.knownHostsFile,
      peerSocket: paths.peerSocket,
      hubSocket: paths.hubSocket,
    });
    const next = startSupervisor(args);
    supervisor = next;
    offSupervisor = next.onChange(emit);
    next.start();
  }

  function writeKnownHosts(hostKey: string) {
    mkdirSync(dirname(paths.knownHostsFile), { recursive: true, mode: 0o700 });
    writeFileSync(paths.knownHostsFile, knownHostsLine(hostKey), { mode: 0o600 });
  }

  return {
    start: () =>
      serial(async () => {
        await killStaleSsh(paths.pidFile, paths.keyFile);
        const { hub } = loadTunnelTable(paths.tableFile);
        if (hub === null) return;
        // known_hosts 以表为准（被改过、丢了都照表重写）
        writeKnownHosts(hub.hostKey);
        await startTunnel(hub);
      }),
    status: () => supervisor?.status() ?? null,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reconnectNow: () => supervisor?.reconnectNow() ?? false,
    retry: () => supervisor?.retry(),
    ensureKey: ({ regenerate = false } = {}) =>
      serial(async () => {
        const pub = `${paths.keyFile}.pub`;
        if (regenerate || !existsSync(paths.keyFile) || !existsSync(pub)) {
          mkdirSync(dirname(paths.keyFile), { recursive: true, mode: 0o700 });
          rmSync(paths.keyFile, { force: true });
          rmSync(pub, { force: true });
          // 无口令（守护进程要自己用）、ed25519；私钥 ssh-keygen 自己写成 0600
          await run(opts.keygenCommand ?? "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "agent-hub", "-f", paths.keyFile]);
        }
        const publicKey = readFileSync(pub, "utf8").trim();
        if (parseEd25519PublicKey(publicKey) === null) throw new Error(`专用钥匙的公钥不是 ed25519：${pub}`);
        return { publicKey };
      }),
    connect: (text) =>
      serial(async () => {
        const code = decodeConnectionCode(text);
        if (code === null) throw new TunnelInputError("连接码不对：要中心上 add 打出来的那一整行（ahtun1_ 开头）");
        const previous = loadTunnelTable(paths.tableFile);
        const sameHub = previous.hub !== null && previous.hub.hostKey === code.hostKey;
        const hub: TunnelHub = {
          host: code.host,
          sshPort: code.sshPort,
          user: code.user,
          hostKey: code.hostKey,
          listenPort: code.listenPort,
          hubEntryPort: code.entryPort,
          deviceId: sameHub ? previous.hub!.deviceId : null,
          invite: code.invite,
        };
        writeKnownHosts(hub.hostKey);
        saveTunnelTable(paths.tableFile, { ...previous, hub });
        await startTunnel(hub);
        return supervisor!.status();
      }),
    addSlot({ name, publicKey }) {
      if (!isTunnelName(name)) throw new TunnelInputError("设备名只能用小写字母、数字和 -，1–32 个，不以 - 开头");
      const key = parseEd25519PublicKey(publicKey);
      if (key === null) throw new TunnelInputError("公钥要是一行 ssh-ed25519");
      const result = upsertSlot(loadTunnelTable(paths.tableFile), name, keyFingerprint(key.body));
      if (result.changed) saveTunnelTable(paths.tableFile, result.table);
      const invite = opts.createInvite(result.slot.port);
      return { port: result.slot.port, entryPort: opts.entryPort, invite: invite.code, expiresAt: invite.expiresAt };
    },
    removeSlot(name) {
      if (!isTunnelName(name)) throw new TunnelInputError("设备名只能用小写字母、数字和 -，1–32 个，不以 - 开头");
      const result = removeSlot(loadTunnelTable(paths.tableFile), name);
      if (result.removed === null) return null;
      saveTunnelTable(paths.tableFile, result.table);
      return { port: result.removed.port };
    },
    close: () => serial(stopTunnel),
  };
}
