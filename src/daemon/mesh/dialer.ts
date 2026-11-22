// Direct and relayed links run the same mutual TLS 1.3 with ALPN fusa-mesh/1; the peer certificate must pass trust.verifyPeerCert and match the dialed device.
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

export const MESH_ALPN = "fusa-mesh/1";

const ZONE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

/** Link-local addresses are skipped because their scope does not work across machines. */
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
        const lower = info.address.split("%", 1)[0]!.toLowerCase();
        if (isUlaIpv6(lower) && isIP(lower) === 6 && !seen.has(lower)) {
          v6.push({ host: lower, port });
          seen.add(lower);
        }
      }
    }
  }
  return [...v4, ...v6].slice(0, MESH_CANDIDATES_MAX);
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function isLoopbackIpv4(address: string): boolean {
  return Number(address.split(".", 1)[0]) === 127;
}
const isUlaIpv6 = (address: string) => /^f[cd][0-9a-f]{2}:/.test(address);
const isLinkLocalIpv6 = (address: string) => /^fe[89ab][0-9a-f]:/.test(address);
const isLoopbackIpv6 = (address: string) => address === "::1" || /^(?:0+:){7}0*1$/.test(address);

export function isAllowedDirectHost(host: string, options?: { allowLoopback?: boolean }): boolean {
  const allowLoopback = options?.allowLoopback === true;
  const parts = host.split("%");
  if (parts.length > 2) return false;
  const bare = parts[0]!.toLowerCase();
  const zone = parts[1];
  if (zone !== undefined && !ZONE_ID_PATTERN.test(zone)) return false;
  const family = isIP(bare);
  if (family === 4) return zone === undefined && (isPrivateIpv4(bare) || (allowLoopback && isLoopbackIpv4(bare)));
  if (family === 6) {
    if (bare.startsWith("::ffff:")) return false;
    if (zone !== undefined) return isLinkLocalIpv6(bare);
    return (allowLoopback && isLoopbackIpv6(bare)) || isUlaIpv6(bare) || isLinkLocalIpv6(bare);
  }
  return false;
}

export interface MeshConnection {
  socket: TLSSocket;
  link: Exclude<MeshLinkKind, "local">;
  peer: TrustedDevice;
}

export interface MeshDialerOptions {
  identity: MeshIdentity;
  trust: MeshTrust;
  relay: RelayClient;
  candidatesOf: (deviceId: DeviceId) => MeshCandidate[];
  allowLoopback?: boolean;
  now?: () => number;
  log: (line: string) => void;
}

export interface MeshDialer {
  dial(deviceId: DeviceId): Promise<MeshConnection>;
  linkOf(deviceId: DeviceId): MeshLinkKind | null;
  agentFor(deviceId: DeviceId): Agent;
  forget(deviceId: DeviceId): void;
  networkChanged(): void;
  close(): void;
}

/** Certificates are not CA-verified; trust.verifyPeerCert pins fingerprints instead. */
function tlsOptions(identity: MeshIdentity) {
  return { key: identity.keyPem, cert: identity.certPem, minVersion: "TLSv1.3" as const, ALPNProtocols: [MESH_ALPN], rejectUnauthorized: false };
}

function verifyPeer(socket: TLSSocket, trust: MeshTrust, expected?: DeviceId): TrustedDevice | null {
  if (socket.alpnProtocol !== MESH_ALPN) return null;
  const cert = socket.getPeerX509Certificate();
  if (cert === undefined) return null;
  const peer = trust.verifyPeerCert(cert.toString());
  if (peer === null || (expected !== undefined && peer.id !== expected)) return null;
  return peer;
}

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
    const candidates = tryDirect
      ? options
          .candidatesOf(deviceId)
          .filter((c) => Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535 && isAllowedDirectHost(c.host, { allowLoopback: options.allowLoopback }))
      : [];

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
  port: number;
  host?: string;
  onConnection: (connection: MeshConnection) => void;
  log: (line: string) => void;
}

export interface MeshListener {
  port: number;
  close(): Promise<void>;
}

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
        // On a slow link the dialer's own relay channel opens seconds after ours, so wait out its whole dial budget.
        const timer = setTimeout(() => socket.destroy(), MESH_DIAL_TIMEOUT_MS);
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
