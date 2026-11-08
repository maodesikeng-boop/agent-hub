// 传输目标解析与 Unix socket 连接池（docs/hub-tunnel-design.md 第 5、8 节）：
// - tailscale 设备：走记录里的 https://<机器>.<tailnet>.ts.net；
// - ssh-tunnel 设备：地址永远只从本机隧道表（state/tunnels.json）取，绝不从对方发来的数据里取：
//   - 连入方（Mac）找中心（东京，hub.deviceId）：走 unix socket run/tunnel/hub.sock，并按 socketPath 缓存复用 keepAlive Agent；
//   - 中心（东京）找连入方（Mac，slot.deviceId）：先读 /proc/net/tcp（及 /proc/net/tcp6）校验 slot.port 的 LISTEN 行 uid 必须是 agenthub-tunnel，
//     通过后才发往 http://127.0.0.1:<slot.port>，否则按离线拒绝（不发请求、不泄露设备令牌）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import type { DeviceId, TunnelRole } from "../../shared/index.ts";
import { TUNNEL_SSH_USER } from "../../shared/tunnel.ts";
import { loadTunnelTable, type TunnelTable } from "../tunnel/table.ts";
import type { PeerRecord } from "./store.ts";

export type ResolvedPeerTarget = { kind: "tcp"; origin: string } | { kind: "unix"; socketPath: string };

export interface ProcNetCheckOptions {
  /** 默认 process.platform。为 "linux" 或显式注入了 readProcNet / expectedUid 时执行 /proc/net/tcp 校验。 */
  platform?: string;
  /** 读取 /proc/net/tcp（及 /proc/net/tcp6）内容。测试里注入假表。 */
  readProcNet?: () => string | readonly string[];
  /** 期望的隧道专用用户 UID（默认查 agenthub-tunnel 的 uid 并缓存）。测试里可注入。 */
  expectedUid?: () => number | null;
}

export interface ResolvePeerTargetOptions {
  /** 已配对的设备记录（或按 deviceId 查记录的函数）。都不传时直接按 ssh-tunnel 查隧道表。 */
  record?: Pick<PeerRecord, "id" | "url" | "transport"> | null;
  getRecord?: (deviceId: DeviceId) => Pick<PeerRecord, "id" | "url" | "transport"> | undefined;
  /** 本机隧道表文件路径或已读出的表。 */
  tunnels?: TunnelTable | string;
  /** 连入方 ssh -L 的 unix socket 路径（paths.tunnelHubSock）。 */
  hubSocket?: string;
  /** Linux 槽位端口监听者 UID 校验选项。 */
  procNet?: ProcNetCheckOptions;
}

/** TCP_LISTEN 在 /proc/net/tcp 的 st 列是 0A（十进制 10）。 */
const TCP_LISTEN_STATE = "0A";

let cachedTunnelUid: number | undefined;

/** 解析 /etc/passwd 里指定用户名的 uid；找不到回 null。 */
export function parsePasswdUid(passwdText: string, username: string = TUNNEL_SSH_USER): number | null {
  for (const raw of passwdText.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(":");
    if (fields[0] !== username) continue;
    const uid = Number.parseInt(fields[2] ?? "", 10);
    if (Number.isInteger(uid) && uid >= 0 && String(uid) === fields[2]?.trim()) return uid;
  }
  return null;
}

function resolveTunnelUserUid(): number | null {
  if (cachedTunnelUid !== undefined) return cachedTunnelUid;
  try {
    const uid = parsePasswdUid(readFileSync("/etc/passwd", "utf8"), TUNNEL_SSH_USER);
    if (uid !== null) {
      cachedTunnelUid = uid;
      return uid;
    }
  } catch {
    // 读不到 /etc/passwd 时退回 id -u
  }
  try {
    const out = execFileSync("id", ["-u", TUNNEL_SSH_USER], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const uid = Number.parseInt(out, 10);
    if (Number.isInteger(uid) && uid >= 0 && String(uid) === out) {
      cachedTunnelUid = uid;
      return uid;
    }
  } catch {
    // 用户还没建时不缓存 null，等下次 tunnel add 建好后再查
  }
  return null;
}

function readDefaultProcNet(): string[] {
  const out: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      out.push(readFileSync(file, "utf8"));
    } catch {
      // 忽略读不到的（如关了 IPv6）
    }
  }
  return out;
}

/**
 * 核对 /proc/net/tcp（及 /proc/net/tcp6）里本地端口 port 的 LISTEN（0A）行：
 * 必须至少有一条 0A 监听行，且所有该端口 0A 行的 uid 都等于 expectedUid（agenthub-tunnel）。
 */
export function verifySlotListenerUid(port: number, opts?: ProcNetCheckOptions): boolean {
  const platform = opts?.platform ?? process.platform;
  if (opts?.readProcNet === undefined && platform !== "linux") return true;

  const uid = (opts?.expectedUid ?? resolveTunnelUserUid)();
  if (uid === null || !Number.isInteger(uid) || uid < 0) return false;

  const raw = (opts?.readProcNet ?? readDefaultProcNet)();
  const tables = typeof raw === "string" ? [raw] : raw;
  let foundListen = false;

  for (const table of tables) {
    for (const line of table.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("sl")) continue;
      const cols = trimmed.split(/\s+/);
      if (cols.length < 8) continue;
      const local = cols[1]!;
      const colon = local.lastIndexOf(":");
      if (colon === -1) continue;
      const portHex = local.slice(colon + 1);
      if (!/^[0-9a-fA-F]+$/.test(portHex)) continue;
      if (Number.parseInt(portHex, 16) !== port) continue;
      if (cols[3]!.toUpperCase() !== TCP_LISTEN_STATE) continue;
      const uidCol = cols[7]!;
      if (!/^\d+$/.test(uidCol) || Number.parseInt(uidCol, 10) !== uid) return false;
      foundListen = true;
    }
  }
  return foundListen;
}

function readTable(tunnels: TunnelTable | string | undefined): TunnelTable | null {
  if (tunnels === undefined) return null;
  return typeof tunnels === "string" ? loadTunnelTable(tunnels) : tunnels;
}

export type TunnelRoute = { role: TunnelRole; port?: number };

/** 查本机隧道表里有没有这台设备（不查 /proc/net/tcp），判断路由存在性和角色（hub / spoke）。 */
export function findTunnelRoute(deviceId: DeviceId, tunnels: TunnelTable | string | undefined, hubSocket?: string): TunnelRoute | null {
  const table = readTable(tunnels);
  if (table === null) return null;
  if (table.hub?.deviceId === deviceId) {
    return hubSocket ? { role: "hub" } : null;
  }
  const slot = table.slots.find((s) => s.deviceId === deviceId);
  if (slot !== undefined) return { role: "spoke", port: slot.port };
  return null;
}

/**
 * 解析一台设备的转发目标：
 * - tailscale：返回 `{ kind: "tcp", origin: record.url }`；
 * - ssh-tunnel：只从本机隧道表取（中心 hub → unix socket；槽位 slot → 先过 UID 校验再回 `http://127.0.0.1:<port>`）；找不到或校验不过回 null。
 */
export function resolvePeerTarget(deviceId: DeviceId, opts: ResolvePeerTargetOptions = {}): ResolvedPeerTarget | null {
  const hasRecordSource = opts.record !== undefined || opts.getRecord !== undefined;
  const record = opts.record !== undefined ? (opts.record ?? undefined) : opts.getRecord?.(deviceId);
  if (hasRecordSource && record === undefined) return null;

  if (record !== undefined) {
    const transport = record.transport ?? (record.url !== "" ? "tailscale" : "ssh-tunnel");
    if (transport === "tailscale") {
      return record.url !== "" ? { kind: "tcp", origin: record.url } : null;
    }
  }

  const table = readTable(opts.tunnels);
  if (table === null) return null;
  if (table.hub?.deviceId === deviceId) {
    return opts.hubSocket ? { kind: "unix", socketPath: opts.hubSocket } : null;
  }
  const slot = table.slots.find((s) => s.deviceId === deviceId);
  if (slot === undefined) return null;
  if (!verifySlotListenerUid(slot.port, opts.procNet)) return null;
  return { kind: "tcp", origin: `http://127.0.0.1:${slot.port}` };
}

export interface UnixHttpPool {
  fetch(socketPath: string, path: string, init?: RequestInit): Promise<Response>;
  /** 当前缓存着的活跃 Agent 数。 */
  readonly size: number;
  /** 累计新建过的 Agent 总数（测试用来断言复用、不每次请求新建）。 */
  readonly createdCount: number;
  closeSocket(socketPath: string): void;
  closeAll(): void;
}

function normalizeHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

/** 按 socketPath 缓存复用 keepAlive http.Agent，严禁每次请求新建；移除设备或关机时销毁。 */
export function createUnixHttpPool(): UnixHttpPool {
  const agents = new Map<string, HttpAgent>();
  let created = 0;

  const agentFor = (socketPath: string): HttpAgent => {
    let agent = agents.get(socketPath);
    if (agent === undefined) {
      agent = new HttpAgent({ keepAlive: true });
      agents.set(socketPath, agent);
      created++;
    }
    return agent;
  };

  return {
    get size() {
      return agents.size;
    },
    get createdCount() {
      return created;
    },
    fetch(socketPath, path, init = {}) {
      const agent = agentFor(socketPath);
      const method = init.method ?? "GET";
      const headers = normalizeHeaders(init.headers);
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          {
            socketPath,
            path,
            method,
            headers,
            agent,
            ...(init.signal ? { signal: init.signal } : {}),
          },
          (res) => {
            const status = res.statusCode ?? 502;
            const resHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") resHeaders.set(key, value);
              else if (Array.isArray(value)) for (const item of value) resHeaders.append(key, item);
            }
            const nullBody = status === 101 || status === 204 || status === 205 || status === 304 || method === "HEAD";
            if (nullBody) {
              res.resume();
              resolve(new Response(null, { status, headers: resHeaders }));
            } else {
              resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: resHeaders }));
            }
          },
        );
        req.on("error", reject);
        const body = init.body;
        if (body === undefined || body === null) {
          req.end();
        } else if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
          req.end(body);
        } else {
          const stream = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
          stream.on("error", (err) => req.destroy(err));
          stream.pipe(req);
        }
      });
    },
    closeSocket(socketPath) {
      const agent = agents.get(socketPath);
      if (agent !== undefined) {
        agent.destroy();
        agents.delete(socketPath);
      }
    },
    closeAll() {
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  };
}
