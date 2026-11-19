// 账号组网对守护进程其余部分的出口（docs/account-mesh-design.md）。daemon.ts 建一个 Mesh，界面服务、peers/、总助跨设备派活、飞书都只认这里。
// 不变量：没登录时 Mesh 照样能建，dial 一律失败、没有租约，单机功能不受影响；登录、退出、被移除都不用重启守护进程。
import { networkInterfaces } from "node:os";
import type { TLSSocket } from "node:tls";
import { API_PATHS, type DeviceId } from "../../shared/api.ts";
import {
  MESH_APPROVAL_TTL_MS,
  MESH_CANDIDATES_REFRESH_MS,
  MESH_LAN_PROBE_TIMEOUT_MS,
  MESH_LOGOUT_REVOKE_TIMEOUT_MS,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  MESH_REQUEST_TIMEOUT_MS,
  MESH_TRUST_SYNC_ATTEMPTS,
  MESH_TRUST_SYNC_RETRY_MS,
  MESH_TRUST_TOMBSTONES_MAX,
  RELAY_PENDING_DEVICE_TTL_MS,
} from "../../shared/limits.ts";
import type { AccountStatusView, MeshApprovalView, MeshCandidate, MeshDeviceView, MeshLeaseName, RelayConnectionState } from "../../shared/mesh.ts";
import { MESH_LEASE_NAMES } from "../../shared/mesh.ts";
import { newRelayToken, type RelayDeviceView, type RelayPresenceView, type RelayRevocationEnvelope } from "../../relay/protocol.ts";
import { createAccountService, type AccountFile } from "./account.ts";
import { agentFetch } from "./agent-fetch.ts";
import { createMeshDialer, localCandidates, startMeshListener, type MeshConnection, type MeshDialer, type MeshListener } from "./dialer.ts";
import { loadOrCreateMeshIdentity } from "./identity.ts";
import { createCenterLease, type CenterLease } from "./lease.ts";
import { createRelayClient, RelayDialError, type RelayClient, type RelayClientEvents } from "./relay-client.ts";
import {
  acceptTrustStatement,
  openMeshTrust,
  parseApprovalSignal,
  parseSignedTrustStatement,
  signTrustStatement,
  startApproval,
  type ApprovalCeremony,
  type ApprovalSignal,
  type MeshTrust,
  type SignedTrustStatement,
} from "./trust.ts";

export { createAccountService, readAccountFile, type AccountFile, type AccountService } from "./account.ts";
export { agentFetch } from "./agent-fetch.ts";
export { createMeshDialer, localCandidates, startMeshListener, type MeshConnection, type MeshDialer, type MeshListener } from "./dialer.ts";
export { loadOrCreateMeshIdentity, type MeshIdentity } from "./identity.ts";
export { createCenterLease, stepCenterLease, type CenterLease } from "./lease.ts";
export { createRelayClient, registerWithRelay, RelayDialError, type RelayClient } from "./relay-client.ts";
export { acceptTrustStatement, openMeshTrust, signTrustStatement, startApproval, type MeshTrust, type TrustedDevice } from "./trust.ts";

export interface MeshOptions {
  /** state/mesh/（设备密钥）。 */
  identityDir: string;
  /** state/account.json。 */
  accountFile: string;
  /** state/peers.json（v2 信任表）。 */
  trustFile: string;
  device: { id: DeviceId; name: string };
  platform: string;
  /** 默认中继网址（设置里可以换）。 */
  relayUrl: string;
  githubClientId: string;
  /** 组网入口端口（MESH_LISTEN_PORT；测试给 0）。 */
  listenPort: number;
  /** 测试只听回环。 */
  listenHost?: string;
  /** 验过身份的组网连接交给界面服务的组网入口（ui-server 的 acceptMeshConnection）。 */
  onConnection: (connection: MeshConnection) => void;
  /** 本机报给中继的局域网候选地址（测试换成回环）。不给按本机网卡（localCandidates）。 */
  candidates?: (port: number) => MeshCandidate[];
  /** 仅本机单测与 e2e 打开：允许向 127.0.0.0/8 与 ::1 发起直连。生产默认关闭。 */
  allowLoopback?: boolean;
  /** 测试换：假 GitHub 的地址、轮询之间等多久。 */
  github?: { webOrigin?: string; apiOrigin?: string; sleep?: (ms: number, signal: AbortSignal) => Promise<void> };
  fetch?: typeof fetch;
  now?: () => number;
  log: (line: string) => void;
}

/** 一种聊天软件的长连接怎么挂、能不能挂（飞书服务给）。 */
export interface CenterLeaseHooks {
  /** 有这个聊天软件的凭证。 */
  eligible: () => boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
}

export interface MeshLogoutResult {
  /** 连不上中继且未送达任何在线设备时为 true，需在其他设备上手动移除本机。 */
  remoteRevokePending: boolean;
}

export interface Mesh {
  readonly selfId: DeviceId;
  readonly trust: MeshTrust;
  readonly dialer: MeshDialer;
  /** GET /api/account。 */
  status(): AccountStatusView;
  startLogin(input?: { relayUrl?: string; githubClientId?: string }): Promise<AccountStatusView>;
  cancelLogin(): void;
  logout(): Promise<MeshLogoutResult>;
  /** 本机用户在“等批准”那一条上点“核对”：开始批准仪式（本机当批准方）。requestId 是那台的设备编号。 */
  beginApproval(requestId: string): Promise<AccountStatusView>;
  /** 本机用户点“一致”或“不一致”。requestId 是对方的设备编号（批准方和新设备都一样）。 */
  answerApproval(requestId: string, match: boolean): Promise<AccountStatusView>;
  /** 后置：只收已在账号里的设备，去重；发给中继，中继推回后 status() 才变。没连上中继抛错。 */
  setCenterPriority(priority: DeviceId[]): Promise<void>;
  /** 后置：本机删掉、签撤销声明发给其他可信设备、告诉中继删掉它；不能删本机（本机用 logout）。 */
  removeDevice(id: DeviceId): Promise<void>;
  /** 中继说它在线（离线、不知道都是 false）。 */
  isOnline(id: DeviceId): boolean;
  /** 经组网对一台可信设备发 HTTP 请求（走 dialer.agentFor）。对方离线、不在信任表里抛错。 */
  request(id: DeviceId, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<Response>;
  /** 一种聊天软件一个租约，第一次调时建（同名再调回同一个）。能挂长连接 = 已登录且可用、在中心顺序里、hooks.eligible()。 */
  lease(name: MeshLeaseName, hooks: CenterLeaseHooks): CenterLease;
  /** GET /api/peer/trust：本机签的声明（信任表里每台的批准、每条墓碑的撤销）。 */
  trustStatements(): SignedTrustStatement[];
  /** POST /api/peer/trust：收下 from 转来的声明。后置：body 不对抛错；撤销本机的声明生效时本机退出账号。 */
  receiveTrustStatements(from: DeviceId, body: unknown): void;
  /** GET /api/peer/lease：本机所知的中心租约持有情况（局域网降级前防双活探测用）。 */
  leaseSnapshot(): { relayConnected: boolean; holders: Partial<Record<MeshLeaseName, DeviceId | null>> };
  /** 账号状态、设备表、在线、租约任一变化时调（界面服务据此推 account.updated）。 */
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

const RELAY_EVENTS: Array<keyof RelayClientEvents> = ["devices", "revocations", "presence", "self", "lease", "leaseYield", "signal", "incoming", "removed", "state"];
const PLATFORM_PATTERN = /^[a-z0-9]{1,32}$/;
const LOGOUT_REMOTE_REMOVE_HINT = "已在本机退出；因未连上中继且无在线设备，请在其他设备上手动移除本机";

/** 登录、退出时换底下的中继客户端；拨号、组网入口、租约一直认这一个。 */
function createSwitchableRelay(): RelayClient & { attach(client: RelayClient): void; detach(): Promise<void> } {
  let current: RelayClient | null = null;
  let offs: Array<() => void> = [];
  const listeners = new Map<keyof RelayClientEvents, Set<(...args: never[]) => void>>();
  const emit = (event: keyof RelayClientEvents, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
  };
  const offline = () => new RelayDialError("offline", "没登录账号");
  return {
    state: () => current?.state() ?? "unreachable",
    start: () => current?.start(),
    send: (frame) => current?.send(frame) ?? false,
    refreshCandidates: () => current?.refreshCandidates(),
    openChannel: (to) => (current === null ? Promise.reject(offline()) : current.openChannel(to)),
    acceptChannel: (from, channel) => (current === null ? Promise.reject(offline()) : current.acceptChannel(from, channel)),
    on(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      const added = listener as (...args: never[]) => void;
      set.add(added);
      return () => set.delete(added);
    },
    close: async () => {
      await current?.close();
    },
    attach(client) {
      current = client;
      offs = RELAY_EVENTS.map((event) => client.on(event, ((...args: unknown[]) => emit(event, ...args)) as never));
    },
    async detach() {
      for (const off of offs) off();
      offs = [];
      const was = current;
      current = null;
      if (was !== null) {
        await was.close();
        emit("state", "unreachable");
      }
    },
  };
}

/** 后置：读设备密钥（没有就生成）、信任表、account.json；已登录就连中继、开组网入口。 */
export async function createMesh(options: MeshOptions): Promise<Mesh> {
  const now = options.now ?? Date.now;
  const log = (line: string) => options.log(`组网：${line}`);
  const selfId = options.device.id;
  const identity = await loadOrCreateMeshIdentity(options.identityDir, selfId);
  const platform = PLATFORM_PATTERN.test(options.platform) ? options.platform : "unknown";
  const trust = openMeshTrust(options.trustFile, identity, { name: options.device.name, platform }, now);
  const account = createAccountService({
    file: options.accountFile,
    identity,
    device: { id: selfId, name: options.device.name, platform },
    relayUrl: options.relayUrl,
    githubClientId: options.githubClientId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    ...(options.github?.webOrigin ? { githubWebOrigin: options.github.webOrigin } : {}),
    ...(options.github?.apiOrigin ? { githubApiOrigin: options.github.apiOrigin } : {}),
    ...(options.github?.sleep ? { sleep: options.github.sleep } : {}),
    log,
  });
  const relay = createSwitchableRelay();
  const changeListeners = new Set<() => void>();
  const changed = () => {
    for (const listener of changeListeners) listener();
  };
  const candidatesFor = options.candidates ?? ((port: number) => localCandidates(networkInterfaces(), port));

  let relayDevices: RelayDeviceView[] = [];
  let priority: DeviceId[] = [];
  const presence = new Map<DeviceId, RelayPresenceView>();
  const leaseHolders = new Map<MeshLeaseName, DeviceId | null>();
  const leases = new Map<MeshLeaseName, CenterLease>();
  const ceremonies = new Map<DeviceId, ApprovalCeremony>();
  /** 别的设备连进来的连接：对方被移出信任表、证书变了时当场断开。 */
  const inbound = new Map<TLSSocket, { id: DeviceId; fingerprint: string }>();
  let removedReason: string | null = null;
  let remoteRevokePending = false;
  let listener: MeshListener | null = null;
  let session: { client: RelayClient; account: AccountFile } | null = null;
  let sessionChange: Promise<void> = Promise.resolve();
  let closed = false;

  const currentCandidates = () => (listener === null ? [] : candidatesFor(listener.port));
  const dialer = createMeshDialer({
    identity,
    trust,
    relay,
    candidatesOf: (id) => presence.get(id)?.candidates ?? [],
    ...(options.allowLoopback ? { allowLoopback: true } : {}),
    now,
    log,
  });

  const signedIn = () => {
    const state = account.state();
    return state.kind === "signed_in" ? state.account : null;
  };
  const activeSelf = () => signedIn()?.state === "active";
  const isOnline = (id: DeviceId) => presence.get(id)?.online ?? false;
  const refreshLeases = () => {
    for (const lease of leases.values()) lease.refresh();
  };

  // ---- 设备之间的请求 ----
  const request: Mesh["request"] = async (id, path, init = {}) => {
    if (id === selfId || trust.get(id) === undefined) throw new Error("不是这个账号里的可信设备");
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers["content-type"] ??= "application/json";
    return agentFetch(dialer.agentFor(id), path, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? MESH_REQUEST_TIMEOUT_MS),
    });
  };
  const run = (what: string, task: () => Promise<unknown>) => {
    task().catch((error: unknown) => {
      if (!closed) log(`${what}没成：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const broadcast = (statements: SignedTrustStatement[], except?: DeviceId) => {
    for (const peer of trust.list().slice(1)) {
      if (peer.id === except || !isOnline(peer.id)) continue;
      run(`把信任声明发给“${peer.name}”`, async () => {
        const res = await request(peer.id, API_PATHS.peerTrust, { method: "POST", body: JSON.stringify({ statements }) });
        await res.body?.cancel();
        if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
      });
    }
  };
  const deliverStatements = async (statements: SignedTrustStatement[], timeoutMs: number): Promise<number> => {
    const relayOffline = relay.state() !== "connected";
    const peers = trust
      .list()
      .slice(1)
      .filter((peer) => isOnline(peer.id) || (relayOffline && (presence.get(peer.id)?.candidates.length ?? 0) > 0));
    if (peers.length === 0) return 0;
    if (relayOffline) dialer.networkChanged();
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const res = await request(peer.id, API_PATHS.peerTrust, {
          method: "POST",
          body: JSON.stringify({ statements }),
          timeoutMs,
        });
        await res.body?.cancel();
        if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
      }),
    );
    return results.filter((r) => r.status === "fulfilled").length;
  };

  // ---- 信任表对齐 ----
  let syncTimer: NodeJS.Timeout | null = null;
  let syncAttempts = 0;
  const trustMatchesRelay = () => {
    const active = new Set(relayDevices.filter((d) => d.state === "active" && d.id !== selfId).map((d) => d.id));
    const trusted = trust.list().slice(1);
    return trusted.length === active.size && trusted.every((d) => active.has(d.id));
  };
  const scheduleTrustSync = (delay = 0) => {
    if (syncTimer !== null || closed) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void syncTrust();
    }, delay);
    syncTimer.unref?.();
  };
  const applyStatements = (from: DeviceId, body: unknown) => {
    const raw = (body as { statements?: unknown } | null)?.statements;
    if (!Array.isArray(raw) || raw.length > MESH_MAX_DEVICES_PER_ACCOUNT + MESH_TRUST_TOMBSTONES_MAX) throw new Error("statements 不对");
    const gossipRevokes: SignedTrustStatement[] = [];
    for (const item of raw) {
      const signed = parseSignedTrustStatement(item);
      if (signed === null || signed.statement.by !== from) continue;
      const result = acceptTrustStatement(trust, signed);
      if (result === "applied" && signed.statement.kind === "revoke" && signed.statement.device === selfId) {
        void handleRemoved("这台已被别的设备移出账号");
        return;
      }
      if (result === "applied" && signed.statement.kind === "revoke") {
        gossipRevokes.push(
          signTrustStatement(
            { kind: "revoke", device: signed.statement.device, fingerprint: signed.statement.fingerprint, by: selfId, at: signed.statement.at },
            identity,
          ),
        );
      }
    }
    if (gossipRevokes.length > 0) broadcast(gossipRevokes, from);
  };
  const applyRelayRevocations = (revocations: RelayRevocationEnvelope[] | undefined) => {
    if (revocations === undefined || revocations.length === 0) return;
    for (const item of revocations) {
      const signed = parseSignedTrustStatement(item);
      if (signed === null || signed.statement.kind !== "revoke") continue;
      const result = acceptTrustStatement(trust, signed);
      if (result === "applied" && signed.statement.device === selfId) {
        void handleRemoved("这台已被别的设备移出账号");
        return;
      }
    }
  };
  const syncTrust = async () => {
    if (!activeSelf() || trustMatchesRelay()) {
      syncAttempts = 0;
      return;
    }
    for (const peer of trust.list().slice(1)) {
      if (!isOnline(peer.id)) continue;
      try {
        const res = await request(peer.id, API_PATHS.peerTrust);
        if (res.status !== 200) {
          await res.body?.cancel();
          continue;
        }
        applyStatements(peer.id, await res.json());
        break;
      } catch (error) {
        log(`从“${peer.name}”对齐信任表没成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!trustMatchesRelay() && ++syncAttempts < MESH_TRUST_SYNC_ATTEMPTS) scheduleTrustSync(MESH_TRUST_SYNC_RETRY_MS * syncAttempts);
    else syncAttempts = 0;
  };

  // ---- 批准仪式 ----
  const sendSignals = (to: DeviceId, signals: ApprovalSignal[]) => {
    for (const signal of signals) relay.send({ type: "signal", to, payload: JSON.stringify(signal) });
  };
  const relayDevice = (id: DeviceId) => relayDevices.find((d) => d.id === id);
  const settle = (peer: DeviceId, ceremony: ApprovalCeremony) => {
    const outcome = ceremony.outcome();
    if (outcome === "pending") return;
    ceremonies.delete(peer);
    if (outcome === "aborted") return;
    const certPem = ceremony.peerCertPem()!;
    const info = relayDevice(peer);
    const device = { id: peer, name: info?.name ?? peer.slice(0, 8), platform: info !== undefined && PLATFORM_PATTERN.test(info.platform) ? info.platform : "unknown", certPem };
    if (ceremony.role === "approver") {
      const added = trust.add({ ...device, approvedBy: selfId });
      relay.send({ type: "device.activate", id: peer });
      log(`批准了“${added.name}”（${peer}）`);
      broadcast([signTrustStatement({ kind: "approve", device, by: selfId, at: added.since }, identity)], peer);
    } else {
      trust.add({ ...device, approvedBy: peer });
      log(`“${device.name}”批准了本机`);
    }
  };
  const handleSignal = async (from: DeviceId, payload: string) => {
    const signal = parseApprovalSignal(payload);
    if (signal === null) return;
    let ceremony = ceremonies.get(from);
    if (ceremony === undefined) {
      if (signal.kind !== "offer" || signedIn()?.state !== "pending" || relayDevice(from)?.state !== "active") return;
      if ([...ceremonies.values()].some((c) => c.role === "joiner")) {
        sendSignals(from, [{ kind: "abort", requestId: signal.requestId, reason: "cancelled" }]);
        return;
      }
      ceremony = startApproval({ role: "joiner", requestId: signal.requestId, self: identity, peerDeviceId: from, expiresAt: now() + MESH_APPROVAL_TTL_MS }).ceremony;
      ceremonies.set(from, ceremony);
    }
    sendSignals(from, await ceremony.receive(signal));
    settle(from, ceremony);
    changed();
  };
  const expiryTimer = setInterval(() => {
    for (const [peer, ceremony] of ceremonies) {
      const signals = ceremony.expire(now());
      if (signals.length === 0) continue;
      sendSignals(peer, signals);
      settle(peer, ceremony);
      changed();
    }
  }, 1_000);
  expiryTimer.unref?.();

  // ---- 中继推来的 ----
  relay.on("devices", (devices, nextPriority) => {
    relayDevices = devices;
    priority = nextPriority;
    const knownIds = new Set(devices.map((d) => d.id));
    for (const id of [...presence.keys()]) {
      if (!knownIds.has(id)) {
        presence.delete(id);
        dialer.forget(id);
      }
    }
    for (const [peer, ceremony] of ceremonies) {
      if (ceremony.role === "approver" && relayDevice(peer)?.state !== "pending") {
        sendSignals(peer, ceremony.cancel("cancelled"));
        ceremonies.delete(peer);
      }
    }
    refreshLeases();
    syncAttempts = 0;
    scheduleTrustSync();
    changed();
  });
  relay.on("revocations", (revocations) => {
    applyRelayRevocations(revocations);
    changed();
  });
  relay.on("presence", (list) => {
    const seen = new Set<DeviceId>();
    for (const entry of list) {
      seen.add(entry.id);
      const was = presence.get(entry.id)?.online ?? false;
      presence.set(entry.id, entry);
      if (was && !entry.online) dialer.forget(entry.id);
    }
    for (const id of [...presence.keys()]) {
      if (!seen.has(id)) {
        presence.delete(id);
        dialer.forget(id);
      }
    }
    changed();
  });
  relay.on("self", (state) => {
    account.markState(state);
    if (state === "active") scheduleTrustSync();
    refreshLeases();
    changed();
  });
  relay.on("lease", (name, grant) => {
    leaseHolders.set(name, grant?.holder ?? null);
    changed();
  });
  relay.on("signal", (from, payload) => void handleSignal(from, payload).catch((error: unknown) => log(`批准消息处理没成：${String(error)}`)));
  relay.on("removed", () => void handleRemoved("这台已被移出账号"));
  relay.on("state", (state: RelayConnectionState) => {
    if (state !== "connected") {
      for (const [id, entry] of presence) presence.set(id, { ...entry, online: false });
      leaseHolders.clear();
    }
    changed();
  });

  trust.onChange(() => {
    for (const [socket, peer] of inbound) {
      if (trust.get(peer.id)?.fingerprint !== peer.fingerprint) {
        socket.destroy();
        inbound.delete(socket);
      }
    }
    for (const id of [...presence.keys()]) if (trust.get(id) === undefined) dialer.forget(id);
    changed();
  });

  // ---- 登录状态 ----
  let candidatesTimer: NodeJS.Timeout | null = null;
  let lastCandidates = "";
  const startSession = async (current: AccountFile) => {
    if (session !== null && session.account.accountId === current.accountId && session.account.relayUrl === current.relayUrl) {
      session.account = current;
      return;
    }
    await stopSession();
    if (closed) return;
    const client = createRelayClient({ relayUrl: current.relayUrl, accountId: current.accountId, identity, candidates: currentCandidates, now, log });
    session = { client, account: current };
    relay.attach(client);
    try {
      listener = await startMeshListener({
        identity,
        trust,
        relay,
        port: options.listenPort,
        ...(options.listenHost !== undefined ? { host: options.listenHost } : {}),
        onConnection: (connection) => {
          inbound.set(connection.socket, { id: connection.peer.id, fingerprint: connection.peer.fingerprint });
          connection.socket.once("close", () => inbound.delete(connection.socket));
          options.onConnection(connection);
        },
        log,
      });
    } catch (error) {
      log(`局域网入口没开成（${error instanceof Error ? error.message : String(error)}），只走中继`);
    }
    lastCandidates = JSON.stringify(currentCandidates());
    candidatesTimer = setInterval(() => {
      const key = JSON.stringify(currentCandidates());
      if (key === lastCandidates) return;
      lastCandidates = key;
      relay.refreshCandidates();
      dialer.networkChanged();
    }, MESH_CANDIDATES_REFRESH_MS);
    candidatesTimer.unref?.();
    client.start();
    refreshLeases();
  };
  const stopSession = async () => {
    if (candidatesTimer !== null) clearInterval(candidatesTimer);
    candidatesTimer = null;
    session = null;
    await relay.detach();
    if (listener !== null) {
      const closing = listener;
      listener = null;
      await closing.close();
    }
    for (const socket of inbound.keys()) socket.destroy();
    inbound.clear();
    for (const id of presence.keys()) dialer.forget(id);
    presence.clear();
    relayDevices = [];
    priority = [];
    leaseHolders.clear();
    ceremonies.clear();
    refreshLeases();
  };
  const applyAccountState = () => {
    const current = signedIn();
    sessionChange = sessionChange
      .then(() => (current !== null && !closed ? startSession(current) : stopSession()))
      .catch((error: unknown) => log(`切换账号状态没成：${error instanceof Error ? error.message : String(error)}`));
    return sessionChange;
  };
  account.onChange(() => {
    void applyAccountState();
    refreshLeases();
    changed();
  });
  const handleRemoved = async (reason: string) => {
    if (signedIn() === null) return;
    removedReason = reason;
    remoteRevokePending = false;
    log(reason);
    trust.clear();
    await account.logout();
    await sessionChange;
  };
  await applyAccountState();

  // ---- 状态视图 ----
  const deviceViews = (): MeshDeviceView[] =>
    trust.list().map((d) => {
      const self = d.id === selfId;
      const online = self || isOnline(d.id);
      return {
        id: d.id,
        name: d.name,
        platform: d.platform,
        fingerprint: d.fingerprint,
        self,
        online,
        link: self ? "local" : online ? dialer.linkOf(d.id) : null,
        lastSeenAt: self ? null : (presence.get(d.id)?.lastSeenAt ?? null),
      };
    });
  const approvalView = (peer: RelayDeviceView, ceremony: ApprovalCeremony | undefined, expiresAt: number): MeshApprovalView => ({
    requestId: peer.id,
    device: { id: peer.id, name: peer.name, platform: peer.platform, fingerprint: peer.fingerprint },
    requestedAt: peer.addedAt,
    expiresAt,
    sas: ceremony?.sas() ?? null,
  });
  const status = (): AccountStatusView => {
    const state = account.state();
    if (state.kind === "signed_out") {
      return {
        state: "signed_out",
        lastError: account.lastError() ?? removedReason,
        ...(remoteRevokePending ? { remoteRevokePending: true } : {}),
      };
    }
    if (state.kind === "signing_in") return { state: "signing_in", userCode: state.userCode, verificationUri: state.verificationUri, expiresAt: state.expiresAt };
    const relayState = relay.state();
    if (state.account.state === "pending") {
      const joining = [...ceremonies.entries()].find(([, c]) => c.role === "joiner");
      const approver = joining === undefined ? undefined : relayDevice(joining[0]);
      return {
        state: "awaiting_approval",
        login: state.account.login,
        relay: relayState,
        approval: joining !== undefined && approver !== undefined ? approvalView(approver, joining[1], joining[1].expiresAt) : null,
      };
    }
    return {
      state: "signed_in",
      login: state.account.login,
      accountId: state.account.accountId,
      relayUrl: state.account.relayUrl,
      relay: relayState,
      devices: deviceViews(),
      approvals: relayDevices.filter((d) => d.state === "pending" && d.id !== selfId).map((d) => approvalView(d, ceremonies.get(d.id), d.addedAt + RELAY_PENDING_DEVICE_TTL_MS)),
      centerPriority: priority,
      feishuHolder: leaseHolders.get("feishu") ?? null,
    };
  };

  const leaseSnapshot = () => {
    const relayConnected = relay.state() === "connected";
    const holders: Partial<Record<MeshLeaseName, DeviceId | null>> = {};
    for (const name of MESH_LEASE_NAMES) {
      if (leases.get(name)?.holding()) holders[name] = selfId;
      else if (relayConnected) holders[name] = leaseHolders.get(name) ?? null;
      else holders[name] = null;
    }
    return { relayConnected, holders };
  };
  const probePeerLeaseHolder = async (name: MeshLeaseName): Promise<boolean> => {
    const peers = trust.list().slice(1);
    if (peers.length === 0) return false;
    dialer.networkChanged();
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const res = await request(peer.id, API_PATHS.peerLease, { timeoutMs: MESH_LAN_PROBE_TIMEOUT_MS });
        if (res.status !== 200) {
          await res.body?.cancel();
          return false;
        }
        const snap = (await res.json()) as { holders?: Partial<Record<MeshLeaseName, unknown>> } | null;
        const holder = snap?.holders?.[name];
        return typeof holder === "string" && holder !== selfId;
      }),
    );
    return results.some((r) => r.status === "fulfilled" && r.value);
  };

  return {
    selfId,
    trust,
    dialer,
    status,
    async startLogin(input) {
      removedReason = null;
      remoteRevokePending = false;
      await account.startLogin(input);
      return status();
    },
    cancelLogin: () => account.cancelLogin(),
    async logout() {
      const current = signedIn();
      if (current === null) return { remoteRevokePending: false };
      let pendingRemoteRevoke = false;
      if (current.state === "active") {
        const revokeAt = Math.max(
          now(),
          ...trust.list().map((d) => d.since + 1),
          ...relayDevices.filter((d) => d.id === selfId).map((d) => d.addedAt + 1),
        );
        const selfRevoke = signTrustStatement(
          { kind: "revoke", device: selfId, fingerprint: identity.fingerprint, by: selfId, at: revokeAt },
          identity,
        );
        const delivered = await deliverStatements([selfRevoke], MESH_LOGOUT_REVOKE_TIMEOUT_MS);
        const sentToRelay = relay.send({ type: "device.remove", id: selfId, revocation: selfRevoke as RelayRevocationEnvelope });
        pendingRemoteRevoke = signedIn() !== null && !sentToRelay && delivered === 0;
      }
      removedReason = null;
      remoteRevokePending = false;
      trust.clear();
      await account.logout();
      await sessionChange;
      removedReason = pendingRemoteRevoke ? LOGOUT_REMOTE_REMOVE_HINT : null;
      remoteRevokePending = pendingRemoteRevoke;
      if (pendingRemoteRevoke) changed();
      return { remoteRevokePending: pendingRemoteRevoke };
    },
    async beginApproval(requestId) {
      const peer = relayDevices.find((d) => d.id === requestId && d.state === "pending");
      if (!activeSelf() || peer === undefined) throw new Error("没有这条等批准的请求");
      const existing = ceremonies.get(peer.id);
      if (existing === undefined || existing.outcome() !== "pending") {
        const started = startApproval({ role: "approver", requestId: newRelayToken(), self: identity, peerDeviceId: peer.id, expiresAt: now() + MESH_APPROVAL_TTL_MS });
        ceremonies.set(peer.id, started.ceremony);
        sendSignals(peer.id, started.first);
      }
      changed();
      return status();
    },
    async answerApproval(requestId, match) {
      const ceremony = ceremonies.get(requestId);
      if (ceremony === undefined) throw new Error("这次核对已经结束了");
      sendSignals(requestId, match ? ceremony.confirmLocal() : ceremony.cancel("mismatch"));
      settle(requestId, ceremony);
      changed();
      return status();
    },
    async setCenterPriority(next) {
      const active = new Set([
        ...relayDevices.filter((d) => d.state === "active").map((d) => d.id),
        ...trust.list().map((d) => d.id),
      ]);
      const filtered = [...new Set(next)].filter((id) => active.has(id));
      if (!relay.send({ type: "priority.set", priority: filtered })) throw new Error("没连上中继，稍后再试");
    },
    async removeDevice(id) {
      if (id === selfId) throw new Error("不能移除本机：本机请退出账号");
      const trusted = trust.get(id);
      if (trusted === undefined && relayDevice(id) === undefined) throw new Error("账号里没有这台设备");
      let signedRevoke: SignedTrustStatement | undefined;
      if (trusted !== undefined) {
        trust.remove(id);
        const revocation = trust.revocations().find((r) => r.fingerprint === trusted.fingerprint);
        if (revocation !== undefined) {
          signedRevoke = signTrustStatement({ kind: "revoke", device: id, fingerprint: trusted.fingerprint, by: selfId, at: revocation.at }, identity);
          broadcast([signedRevoke]);
        }
      }
      ceremonies.delete(id);
      dialer.forget(id);
      relay.send({ type: "device.remove", id, ...(signedRevoke !== undefined ? { revocation: signedRevoke as RelayRevocationEnvelope } : {}) });
      changed();
    },
    isOnline,
    request,
    lease(name, hooks) {
      let lease = leases.get(name);
      if (lease === undefined) {
        lease = createCenterLease({
          name,
          selfId,
          relay,
          eligible: () => activeSelf() && priority.includes(selfId) && hooks.eligible(),
          priority: () => priority,
          hasPeerHolder: () => probePeerLeaseHolder(name),
          connect: hooks.connect,
          disconnect: hooks.disconnect,
          now,
          log,
        });
        leases.set(name, lease);
      }
      return lease;
    },
    trustStatements() {
      const approvals = trust
        .list()
        .slice(1)
        .map((d) => signTrustStatement({ kind: "approve", device: { id: d.id, name: d.name, platform: d.platform, certPem: d.certPem }, by: selfId, at: d.since }, identity));
      const revocations = trust.revocations().map((r) => signTrustStatement({ kind: "revoke", device: r.id, fingerprint: r.fingerprint, by: selfId, at: r.at }, identity));
      return [...approvals, ...revocations];
    },
    receiveTrustStatements(from, body) {
      if (trust.get(from) === undefined) throw new Error("不是可信设备");
      applyStatements(from, body);
    },
    leaseSnapshot,
    onChange(listenerFn) {
      changeListeners.add(listenerFn);
      return () => changeListeners.delete(listenerFn);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(expiryTimer);
      if (syncTimer !== null) clearTimeout(syncTimer);
      for (const lease of leases.values()) await lease.close();
      account.close();
      await sessionChange;
      await stopSession();
      dialer.close();
      changeListeners.clear();
    },
  };
}
