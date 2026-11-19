// 拨号和组网入口（docs/account-mesh-design.md「连法：局域网直连优先，中继兜底」）。
// 不变量：
// - 直连和经中继都跑同一条 TLS 1.3 双向认证（ALPN fusa-mesh/1）；握手后对方证书必须过 trust.verifyPeerCert，并且是要拨的那台，否则断开；
// - 交给 HTTP 层的连接都已经验过对方是谁，组网入口的请求按这个身份认，不看任何头；
// - 直连失败的设备在 MESH_DIRECT_RETRY_MS 内不再试直连，本机候选地址变了就清掉这份记录。
import { Agent, type AgentOptions } from "node:http";
import { isIP, type Socket } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import type { Duplex } from "node:stream";
import { TLSSocket, connect as tlsConnect, createSecureContext, createServer as createTlsServer, type SecureContext, type Server as TlsServer } from "node:tls";
import type { DeviceId } from "../../shared/api.ts";
import { MESH_CANDIDATES_MAX, MESH_DIAL_TIMEOUT_MS, MESH_DIRECT_HEAD_START_MS, MESH_DIRECT_RETRY_MS, MESH_HANDSHAKE_TIMEOUT_MS } from "../../shared/limits.ts";
import type { MeshCandidate, MeshLinkKind } from "../../shared/mesh.ts";
import type { MeshIdentity } from "./identity.ts";
import type { RelayClient } from "./relay-client.ts";
import type { MeshTrust, TrustedDevice } from "./trust.ts";

/** TLS 里的应用层协议名。 */
export const MESH_ALPN = "fusa-mesh/1";

/**
 * 本机的局域网候选地址。
 * 后置：只收私有 IPv4（10/8、172.16/12、192.168/16）、IPv6 ULA（fc00::/7）和链路本地（fe80::/10，带网卡名）；
 * 跳过回环、内部网卡、公网地址；去重后最多 MESH_CANDIDATES_MAX 个，IPv4 在前；同样的输入顺序稳定。
 */
export function localCandidates(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number): MeshCandidate[] {
  const v4: MeshCandidate[] = [];
  const v6: MeshCandidate[] = [];
  const seen = new Set<string>();
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      if (info.internal) continue;
      if (info.family === "IPv4" && isPrivateIpv4(info.address)) {
        if (!seen.has(info.address)) v4.push({ host: info.address, port });
        seen.add(info.address);
      } else if (info.family === "IPv6") {
        const lower = info.address.toLowerCase();
        const host = isLinkLocalIpv6(lower) ? `${lower.split("%", 1)[0]}%${name}` : isUlaIpv6(lower) ? lower : null;
        if (host !== null && !seen.has(host)) v6.push({ host, port });
        if (host !== null) seen.add(host);
      }
    }
  }
  return [...v4, ...v6].slice(0, MESH_CANDIDATES_MAX);
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const isUlaIpv6 = (address: string) => /^f[cd][0-9a-f]{2}:/.test(address);
const isLinkLocalIpv6 = (address: string) => /^fe[89ab][0-9a-f]:/.test(address);

/** 一条验过对方身份的连接。 */
export interface MeshConnection {
  socket: TLSSocket;
  link: Exclude<MeshLinkKind, "local">;
  peer: TrustedDevice;
}

export interface MeshDialerOptions {
  identity: MeshIdentity;
  trust: MeshTrust;
  relay: RelayClient;
  /** 中继最近推来的这台设备的候选地址。 */
  candidatesOf: (deviceId: DeviceId) => MeshCandidate[];
  now?: () => number;
  log: (line: string) => void;
}

export interface MeshDialer {
  /**
   * 拨一台可信设备。
   * 后置：先并发试直连，MESH_DIRECT_HEAD_START_MS 后还没成就同时经中继拨，先握手成功的那条胜出、另一条关掉；
   * 不在信任表里抛错；都失败抛错（调用方按离线处理）；总共不超过 MESH_DIAL_TIMEOUT_MS。
   */
  dial(deviceId: DeviceId): Promise<MeshConnection>;
  /** 最近一次连上这台用的哪种；没连过回 null。 */
  linkOf(deviceId: DeviceId): MeshLinkKind | null;
  /** 一台设备一个 keep-alive 的 http.Agent（createConnection 走 dial），转发、总助派活、飞书转发和 ws 客户端共用。 */
  agentFor(deviceId: DeviceId): Agent;
  /** 后置：关掉这台的 Agent 和空闲连接（对方被移除、证书变了、下线时调）。 */
  forget(deviceId: DeviceId): void;
  /** 后置：本机网卡地址变了：清掉直连失败的记录。 */
  networkChanged(): void;
  close(): void;
}

/** 组网 TLS 的公共参数：TLS 1.3、双向出示证书、证书不按 CA 验（由 trust.verifyPeerCert 钉指纹）。 */
function tlsOptions(identity: MeshIdentity) {
  return { key: identity.keyPem, cert: identity.certPem, minVersion: "TLSv1.3" as const, ALPNProtocols: [MESH_ALPN], rejectUnauthorized: false };
}

/** 握手完了查对方：ALPN 对、出示了证书、证书在信任表里；expected 给了还要是那台。不对回 null。 */
function verifyPeer(socket: TLSSocket, trust: MeshTrust, expected?: DeviceId): TrustedDevice | null {
  if (socket.alpnProtocol !== MESH_ALPN) return null;
  const cert = socket.getPeerX509Certificate();
  if (cert === undefined) return null;
  const peer = trust.verifyPeerCert(cert.toString());
  if (peer === null || (expected !== undefined && peer.id !== expected)) return null;
  return peer;
}

/** 在一条字节流上（或直接 TCP）当 TLS 客户端，握手成功且对方是 expected 才 resolve。 */
function handshakeAsClient(input: { identity: MeshIdentity; trust: MeshTrust; expected: DeviceId; socket?: Duplex; host?: string; port?: number }): Promise<{ socket: TLSSocket; peer: TrustedDevice }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      ...tlsOptions(input.identity),
      ...(input.socket !== undefined ? { socket: input.socket } : { host: input.host!, port: input.port! }),
      checkServerIdentity: () => undefined,
    });
    const timer = setTimeout(() => socket.destroy(new Error("握手超时")), MESH_HANDSHAKE_TIMEOUT_MS);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const peer = verifyPeer(socket, input.trust, input.expected);
      if (peer === null) {
        socket.destroy();
        return reject(new Error("对方证书不对"));
      }
      socket.off("error", onError);
      resolve({ socket, peer });
    });
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
  });
}

export function createMeshDialer(options: MeshDialerOptions): MeshDialer {
  const now = options.now ?? Date.now;
  const directFailedAt = new Map<DeviceId, number>();
  const links = new Map<DeviceId, Exclude<MeshLinkKind, "local">>();
  const agents = new Map<DeviceId, Agent>();
  let closed = false;

  const dial = async (deviceId: DeviceId): Promise<MeshConnection> => {
    if (closed) throw new Error("组网已关闭");
    const trusted = options.trust.get(deviceId);
    if (trusted === undefined || deviceId === options.identity.deviceId) throw new Error("不是这个账号里的可信设备");
    const failedAt = directFailedAt.get(deviceId);
    const tryDirect = failedAt === undefined || now() - failedAt >= MESH_DIRECT_RETRY_MS;
    const candidates = tryDirect ? options.candidatesOf(deviceId).filter((c) => isIP(c.host.split("%", 1)[0]!) !== 0) : [];

    return new Promise<MeshConnection>((resolve, reject) => {
      let settled = false;
      let running = 0;
      let directRunning = candidates.length;
      let relayStarted = false;
      const errors: string[] = [];
      const winners: TLSSocket[] = [];
      const finish = (error?: Error) => {
        if (settled || running > 0 || (!relayStarted && error === undefined)) return;
        settled = true;
        clearTimeout(overall);
        clearTimeout(headStart);
        reject(error ?? new Error(`连不上“${trusted.name}”：${errors.join("；") || "不在线"}`));
      };
      const attempt = (link: Exclude<MeshLinkKind, "local">, open: () => Promise<{ socket: TLSSocket; peer: TrustedDevice }>) => {
        running++;
        open().then(
          ({ socket, peer }) => {
            running--;
            if (link === "lan") directRunning--;
            if (settled) {
              socket.destroy();
              return;
            }
            settled = true;
            winners.push(socket);
            clearTimeout(overall);
            clearTimeout(headStart);
            links.set(deviceId, link);
            if (link === "lan") directFailedAt.delete(deviceId);
            resolve({ socket, link, peer });
          },
          (error: Error) => {
            running--;
            errors.push(error.message);
            if (link === "lan" && --directRunning === 0) {
              directFailedAt.set(deviceId, now());
              startRelay();
            }
            if (link === "relay" || relayStarted) finish();
          },
        );
      };
      const startRelay = () => {
        if (relayStarted || settled) return;
        relayStarted = true;
        attempt("relay", async () => handshakeAsClient({ identity: options.identity, trust: options.trust, expected: deviceId, socket: await options.relay.openChannel(deviceId) }));
      };
      const overall = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(headStart);
        reject(new Error(`连“${trusted.name}”超时`));
      }, MESH_DIAL_TIMEOUT_MS);
      for (const candidate of candidates) {
        attempt("lan", () => handshakeAsClient({ identity: options.identity, trust: options.trust, expected: deviceId, host: candidate.host, port: candidate.port }));
      }
      const headStart = setTimeout(startRelay, candidates.length === 0 ? 0 : MESH_DIRECT_HEAD_START_MS);
    });
  };

  return {
    dial,
    linkOf: (deviceId) => links.get(deviceId) ?? null,
    agentFor(deviceId) {
      let agent = agents.get(deviceId);
      if (agent === undefined) {
        agent = new MeshAgent(() => dial(deviceId), { keepAlive: true });
        agents.set(deviceId, agent);
      }
      return agent;
    },
    forget(deviceId) {
      agents.get(deviceId)?.destroy();
      agents.delete(deviceId);
      links.delete(deviceId);
      directFailedAt.delete(deviceId);
    },
    networkChanged() {
      directFailedAt.clear();
    },
    close() {
      closed = true;
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  };
}

/** 连接从 dial() 来的 http.Agent：按设备复用 keep-alive，HTTP 和 WebSocket 客户端共用。 */
class MeshAgent extends Agent {
  readonly #dial: () => Promise<MeshConnection>;
  constructor(dialer: () => Promise<MeshConnection>, agentOptions: AgentOptions) {
    super(agentOptions);
    this.#dial = dialer;
  }
  override createConnection(_options: unknown, callback?: (error: Error | null, socket: Socket) => void): Socket {
    this.#dial().then(
      (connection) => callback?.(null, connection.socket),
      (error: Error) => callback?.(error, undefined as unknown as Socket),
    );
    return undefined as unknown as Socket;
  }
}

export interface MeshListenerOptions {
  identity: MeshIdentity;
  trust: MeshTrust;
  relay: RelayClient;
  /** 局域网监听端口（MESH_LISTEN_PORT；测试给 0）。 */
  port: number;
  /** 测试只听回环。 */
  host?: string;
  /** 握手成功、验过身份的连接交给 HTTP 层（界面服务的 meshEntry 入口）。 */
  onConnection: (connection: MeshConnection) => void;
  log: (line: string) => void;
}

export interface MeshListener {
  port: number;
  close(): Promise<void>;
}

/**
 * 开组网入口：听局域网 TCP，同时接起中继推来的 incoming 通道，两边都当 TLS 服务端。
 * 后置：对方证书不在信任表里、没出示证书、ALPN 不对时握手失败，不调 onConnection；端口被占时抛错。
 */
export async function startMeshListener(options: MeshListenerOptions): Promise<MeshListener> {
  const context: SecureContext = createSecureContext({ key: options.identity.keyPem, cert: options.identity.certPem, minVersion: "TLSv1.3" });
  const open = new Set<TLSSocket>();
  const accept = (socket: TLSSocket, link: Exclude<MeshLinkKind, "local">, expected?: DeviceId) => {
    const peer = verifyPeer(socket, options.trust, expected);
    if (peer === null) {
      socket.destroy();
      return;
    }
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    options.onConnection({ socket, link, peer });
  };
  const server: TlsServer = createTlsServer({ ...tlsOptions(options.identity), requestCert: true, handshakeTimeout: MESH_HANDSHAKE_TIMEOUT_MS }, (socket) => accept(socket, "lan"));
  server.on("tlsClientError", (_error, socket) => socket.destroy());

  const offIncoming = options.relay.on("incoming", (from, channel) => {
    if (options.trust.get(from) === undefined) return;
    options.relay.acceptChannel(from, channel).then(
      (stream) => {
        const socket = new TLSSocket(stream, { isServer: true, server, secureContext: context, requestCert: true, rejectUnauthorized: false, ALPNProtocols: [MESH_ALPN] });
        const timer = setTimeout(() => socket.destroy(), MESH_HANDSHAKE_TIMEOUT_MS);
        socket.once("secure", () => {
          clearTimeout(timer);
          accept(socket, "relay", from);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          socket.destroy();
        });
      },
      (error: Error) => options.log(`组网：接起 ${from} 经中继的连接没成：${error.message}`),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: options.port, host: options.host ?? "::", ipv6Only: false }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: address !== null && typeof address === "object" ? address.port : options.port,
    close: () =>
      new Promise<void>((resolve) => {
        offIncoming();
        server.close(() => resolve());
        for (const socket of open) socket.destroy();
      }),
  };
}
