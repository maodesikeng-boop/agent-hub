// 设备配对、设备令牌、设备清单同步、移除（docs/multi-device-design.md 第 3.2 节）。数据结构和配对状态机见 store.ts。
//
// 配对（一次）：新设备 B 上生成邀请码 → 已有设备 A 上填 B 的网址 + 邀请码 → A 带着自己的身份和“B 来访用的令牌”POST B/api/peer/pair →
// B 验邀请码，记下 A（pending），回自己的身份和“A 来访用的令牌” → A 记下 B（paired），把设备清单同步给所有已配对的设备 →
// B 收到 A 带令牌来的第一个请求（就是这次同步），把 A 改成 paired，也同步一遍自己的清单。
// 两边都只存对方令牌的 sha256，自己要出示的那把存明文（state/peers.json 0600）。
//
// 第三台配一次就全通：收到清单里有没配过的设备 X，编号小的那台去请发清单的设备介绍（它替 X 要一个只给自己用的邀请码），
// 再拿邀请码直接和 X 配对。编号大的那台什么也不做，等对方来。所以同一对设备不会两边同时发起配对。
//
// 不轮询：只在配对、确认、改名、启动时同步一次；对方离线就算了，它上线启动时会同步过来。
import { z } from "zod";
import {
  API_PATHS,
  MAX_PEERS,
  PEER_DEVICE_HEADER,
  PEER_PENDING_TTL_MS,
  PEER_REQUEST_TIMEOUT_MS,
  isDeviceId,
  normalizeName,
  type ApiErrorCode,
  type DeviceId,
  type DeviceInfo,
  type DeviceInviteResponse,
  type PeerDevice,
  type PeerIntroductionResponse,
  type PeerPairResponse,
  type PeerTransport,
} from "../../shared/index.ts";
import { API_ERRORS, humanize } from "../../shared/errors.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { bindHubDevice, bindSlotDevice, clearTunnelDevice, loadTunnelTable, saveTunnelTable } from "../tunnel/table.ts";
import { createInviteBook, type InviteBook } from "./invites.ts";
import type { ProxyTarget } from "./proxy.ts";
import { isPlatform, openPeerStore, type PeerRecord, type PeerStore } from "./store.ts";
import { PEER_TOKEN_PATTERN, matchesHash, newPeerToken, sha256Hex } from "./tokens.ts";
import {
  createUnixHttpPool,
  findTunnelRoute,
  resolvePeerTarget,
  type ProcNetCheckOptions,
  type ResolvedPeerTarget,
  type UnixHttpPool,
} from "./transport.ts";
import { normalizePeerUrl } from "./url.ts";

/** 对方拒了本机的设备令牌时回的 error（它已经不认本机了）。 */
export const PEER_UNAUTHORIZED = "peer_unauthorized";
const MAX_INVITE_CODE_CHARS = 64;

export class PeerError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode | undefined;
  constructor(statusCode: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.name = "PeerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const invalid = (message: string) => new PeerError(400, message, "invalid");
const notFound = () => new PeerError(404, API_ERRORS.device_not_found.text, "device_not_found");
const offline = (name?: string) =>
  new PeerError(502, name === undefined ? API_ERRORS.device_offline.text : `连不上“${name}”`, "device_offline");

/** 用 zod strict schema 校验请求体：必须是 JSON 对象且只许出现 schema 定义的字段。 */
function parseStrictBody<T extends z.ZodRawShape>(schema: z.ZodObject<T>, body: unknown): z.infer<z.ZodObject<T>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("请求体必须是 JSON 对象");
  const parsed = schema.strict().safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys") {
      throw invalid(`不认识的字段：${issue.keys[0]}`);
    }
    throw invalid(issue?.message ?? "请求体必须是 JSON 对象");
  }
  return parsed.data;
}

const peerDeviceRawSchema = z.object({
  id: z.string().refine((s) => isDeviceId(s)),
  name: z
    .string()
    .transform((s) => normalizeName(s))
    .refine((v): v is string => v !== null),
  platform: z.custom<PeerDevice["platform"]>((v) => isPlatform(v)),
  url: z.unknown(),
});

/** 对方发来的设备身份：编号、名字、系统要合规；网址按 normalizePeerUrl（不认的回 null，调用方决定怎么办）。 */
function parsePeerDevice(value: unknown, allowLoopback: boolean): (Omit<PeerDevice, "url"> & { url: string | null }) | null {
  const parsed = peerDeviceRawSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    platform: parsed.data.platform,
    url: normalizePeerUrl(parsed.data.url, allowLoopback),
  };
}

const nameBodySchema = z.object({
  name: z
    .string({ error: "名字不能为空，也不能太长" })
    .transform((s) => normalizeName(s))
    .refine((v): v is string => v !== null, "名字不能为空，也不能太长"),
});

const addBodySchema = z.object({
  url: z.unknown(),
  code: z
    .string({ error: "请填那台设备给的邀请码" })
    .max(MAX_INVITE_CODE_CHARS, "请填那台设备给的邀请码")
    .transform((s) => s.trim())
    .refine((s) => s !== "", "请填那台设备给的邀请码"),
});

const acceptPairBodySchema = z.object({
  inviteCode: z.unknown(),
  device: z.unknown(),
  token: z.string({ error: "token 不对" }).regex(PEER_TOKEN_PATTERN, "token 不对"),
});

const deviceListBodySchema = z.object({
  devices: z.array(z.unknown(), { error: "devices 必须是数组" }).max(MAX_PEERS, "devices 必须是数组"),
});

const deviceIdBodySchema = z.object({
  deviceId: z.unknown(),
});

const pairResponseBodySchema = z.object({
  device: z.unknown(),
  token: z.string().regex(PEER_TOKEN_PATTERN),
});

const introductionResponseBodySchema = z.object({
  device: z.unknown(),
  code: z.string(),
});

export interface PeersOptions {
  /** state/peers.json。 */
  file: string;
  /** 本机身份（state/device.json）。 */
  device: { id: DeviceId; name: string };
  /** 本机的 process.platform。 */
  platform?: string;
  /** 本机改名：写 state/device.json。 */
  saveName: (name: string) => void;
  /** 本机的设备网址：https://<tailnet 名字>；没有 Tailscale 时 null（测试入口认回环网址时是 http://127.0.0.1:<端口>）。 */
  selfUrl: () => string | null;
  /** 认不认本机回环网址：只有测试（DaemonOptions.allowLoopbackPeers、test-helpers）开。 */
  allowLoopback: boolean;
  /** state/tunnels.json（ssh 隧道表）。 */
  tunnelsFile?: string;
  /** 连入方 ssh -L 的 unix socket（run/tunnel/hub.sock）。 */
  hubSocket?: string;
  /** 连入方访问中心失败时触发一次提前重连（TunnelService.reconnectNow）。 */
  reconnectTunnel?: () => unknown;
  /** Linux 槽位端口监听者 UID 校验选项（测试可注入）。 */
  procNet?: ProcNetCheckOptions;
  /** Unix socket HTTP Agent 池（测试可注入，默认内部维护）。 */
  unixPool?: UnixHttpPool;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Peers {
  readonly selfId: DeviceId;
  /** GET /api/devices：本机排第一，后面是已配对的（pending 的不算）。 */
  list(): DeviceInfo[];
  /** 转发目标：已配对且能解析出连法目标的才有。 */
  target(id: string): ProxyTarget | null;
  /** 带设备令牌来的请求：X-Agent-Hub-Device + Authorization: Bearer。认得回那台的记录（pending 的顺手确认），不认得回 null。 */
  authenticate(deviceHeader: unknown, authorization: unknown): PeerRecord | null;
  createInvite(): DeviceInviteResponse;
  /** 中心给指定槽位端口发一次性隧道配对邀请码（10 分钟有效）。 */
  createTunnelInvite(slotPort: number): { code: string; expiresAt: number };
  /** 连入方 ssh 隧道连上中心时调用：若还有未消费的 hub.invite 则自动经 hub.sock 完成配对，已配对则同步一次清单。 */
  onTunnelConnected(): void;
  /** 中心移除槽位时联动移除绑定的设备记录（作废设备令牌）。 */
  removeByTunnelSlot(deviceId: DeviceId): void;
  /** POST /api/devices：本机去和那台配对。 */
  add(body: unknown): Promise<DeviceInfo>;
  /** POST /api/peer/pair：应邀配对。 */
  acceptPair(body: unknown): PeerPairResponse;
  /** PUT /api/peer/devices。 */
  receiveDeviceList(from: DeviceId, body: unknown): void;
  /** POST /api/peer/unpair。 */
  receiveUnpair(from: DeviceId): void;
  /** POST /api/peer/invites。 */
  inviteFor(from: DeviceId, body: unknown): DeviceInviteResponse;
  /** POST /api/peer/introductions。 */
  introduce(from: DeviceId, body: unknown): Promise<PeerIntroductionResponse>;
  /** PUT /api/peer/name（入口替本机改名），也是本机自己改名。 */
  renameSelf(body: unknown): DeviceInfo;
  /** PATCH /api/devices/:id。 */
  rename(id: string, body: unknown): Promise<DeviceInfo>;
  /** DELETE /api/devices/:id：删本机记录，后台通知对方。 */
  remove(id: string): void;
  /** 对方拒了本机的令牌（它已经把本机移除了）：本机也删。 */
  forget(id: DeviceId): void;
  /** 把设备清单同步给所有已配对的设备（启动时调一次）。 */
  announce(): void;
  /** 等后台的同步、介绍、通知都做完（测试用）。 */
  idle(): Promise<void>;
  /** 关机：停掉在途的请求。 */
  close(): void;
}

export function createPeers(opts: PeersOptions): Peers {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetch ?? fetch;
  const platform = opts.platform ?? process.platform;
  const selfId = opts.device.id;
  let selfName = opts.device.name;
  const store: PeerStore = openPeerStore(opts.file, now);
  const invites: InviteBook = createInviteBook({ now });
  const unixPool: UnixHttpPool = opts.unixPool ?? createUnixHttpPool();
  const closing = new AbortController();
  const background = new Set<Promise<unknown>>();
  /** 正在配对（介绍或隧道自动配对）的设备：同一台不同时发两次。 */
  const pairing = new Set<string>();

  const run = (what: string, task: () => Promise<unknown>) => {
    const p = task()
      .catch((error: unknown) => {
        if (!closing.signal.aborted) log(`${LOG_PREFIX} 联机：${what}没成：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => background.delete(p));
    background.add(p);
  };

  const prunePending = () => {
    for (const r of store.list()) if (r.state === "pending" && now() - r.since > PEER_PENDING_TTL_MS) store.remove(r.id, { tombstone: false });
  };
  const paired = () => {
    prunePending();
    return store.list().filter((r) => r.state === "paired");
  };

  const resolveRecordTarget = (r: PeerRecord): ResolvedPeerTarget | null =>
    resolvePeerTarget(r.id, {
      record: r,
      tunnels: opts.tunnelsFile,
      hubSocket: opts.hubSocket,
      procNet: opts.procNet,
    });

  const isRoutable = (r: PeerRecord): boolean => {
    if (r.transport === "ssh-tunnel") {
      return findTunnelRoute(r.id, opts.tunnelsFile, opts.hubSocket) !== null;
    }
    return r.url !== "";
  };

  const isHubPeer = (deviceId: DeviceId): boolean => {
    const route = findTunnelRoute(deviceId, opts.tunnelsFile, opts.hubSocket);
    return route?.role === "hub";
  };

  const clearTunnelBinding = (deviceId: DeviceId, options: { closeSocket?: boolean } = {}) => {
    if (opts.tunnelsFile === undefined) return;
    const table = loadTunnelTable(opts.tunnelsFile);
    if ((options.closeSocket ?? true) && table.hub?.deviceId === deviceId && opts.hubSocket !== undefined) {
      unixPool.closeSocket(opts.hubSocket);
    }
    const cleared = clearTunnelDevice(table, deviceId);
    if (cleared.changed) {
      saveTunnelTable(opts.tunnelsFile, cleared.table);
    }
  };

  const selfDevice = (): PeerDevice => {
    const url = opts.selfUrl();
    if (url === null) throw new PeerError(409, "这台还没有 tailnet 网址：先装好 Tailscale 并登录，再配对", "conflict");
    return { id: selfId, name: selfName, platform, url };
  };
  const peerTransportOf = (r: PeerRecord): PeerTransport => {
    if (r.transport === "ssh-tunnel") {
      const route = findTunnelRoute(r.id, opts.tunnelsFile, opts.hubSocket);
      return { kind: "ssh-tunnel", role: route?.role ?? "spoke" };
    }
    return { kind: "tailscale", url: r.url };
  };
  const selfInfo = (): DeviceInfo => ({
    id: selfId,
    name: selfName,
    platform,
    self: true,
    url: opts.selfUrl(),
    transport: { kind: "local" },
  });
  const infoOf = (r: PeerRecord): DeviceInfo => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    self: false,
    url: r.transport === "ssh-tunnel" ? null : r.url,
    transport: peerTransportOf(r),
  });
  const deviceOf = (r: PeerRecord): PeerDevice => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    url: r.transport === "ssh-tunnel" ? "" : r.url,
  });

  /** 设备之间的控制请求。连不上、超时 → device_offline。 */
  const call = async (
    target: ResolvedPeerTarget,
    path: string,
    init: { method: string; token?: string; body?: unknown; onNetworkError?: () => void },
  ) => {
    const headers: Record<string, string> = { [PEER_DEVICE_HEADER]: selfId };
    if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const signal = AbortSignal.any([AbortSignal.timeout(PEER_REQUEST_TIMEOUT_MS), closing.signal]);
    const bodyText = init.body === undefined ? undefined : JSON.stringify(init.body);
    let res: Response;
    let text: string;
    try {
      if (target.kind === "unix") {
        res = await unixPool.fetch(target.socketPath, path, {
          method: init.method,
          headers,
          ...(bodyText === undefined ? {} : { body: bodyText }),
          signal,
        });
      } else {
        res = await fetchImpl(target.origin + path, {
          method: init.method,
          headers,
          redirect: "manual",
          ...(bodyText === undefined ? {} : { body: bodyText }),
          signal,
        });
      }
      text = await res.text();
    } catch {
      init.onNetworkError?.();
      throw offline();
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const error = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : null;
    const code = typeof (body as { code?: unknown } | null)?.code === "string" ? (body as { code: string }).code : null;
    return { status: res.status, body, error, code };
  };

  /** 带本机令牌找已配对的那台。对方说不认本机了：本机也删掉它，回 404。 */
  const callPeer = async (peer: PeerRecord, path: string, init: { method: string; body?: unknown }) => {
    const resolved = resolveRecordTarget(peer);
    if (resolved === null) {
      if (isHubPeer(peer.id)) opts.reconnectTunnel?.();
      throw offline(peer.name);
    }
    let result;
    try {
      result = await call(resolved, path, {
        ...init,
        token: peer.outboundToken,
        onNetworkError: () => {
          if (isHubPeer(peer.id)) opts.reconnectTunnel?.();
        },
      });
    } catch (error) {
      throw error instanceof PeerError && error.code === "device_offline" ? offline(peer.name) : error;
    }
    if (result.status === 401 && (result.code === PEER_UNAUTHORIZED || result.error === PEER_UNAUTHORIZED)) {
      forget(peer.id);
      throw new PeerError(404, `“${peer.name}”已经把这台移除了`, "device_not_found");
    }
    return result;
  };

  const forget = (id: DeviceId) => {
    if (store.remove(id)) {
      clearTunnelBinding(id);
      log(`${LOG_PREFIX} 联机：对方已经不认这台了，删掉 ${id}`);
    }
  };

  const announce = () => {
    const targets = paired();
    if (targets.length === 0) return;
    const url = opts.selfUrl() ?? "";
    const devices = [{ id: selfId, name: selfName, platform, url }, ...targets.map(deviceOf)];
    for (const peer of targets) {
      run(`把设备清单同步给“${peer.name}”`, async () => {
        const res = await callPeer(peer, API_PATHS.peerDevices, { method: "PUT", body: { devices } });
        if (res.status !== 204) throw new Error(res.error ?? `HTTP ${res.status}`);
      });
    }
  };

  /** 拿邀请码去那台配对；expectedId：介绍来的，对方必须是这台。成功后同步清单。 */
  const pairWith = async (url: string, code: string, expectedId?: DeviceId): Promise<PeerRecord> => {
    const me = selfDevice();
    const tokenForThem = newPeerToken();
    const res = await call({ kind: "tcp", origin: url }, API_PATHS.peerPair, {
      method: "POST",
      body: { inviteCode: code, device: me, token: tokenForThem },
    });
    if (res.status >= 500) throw offline();
    if (res.status !== 200) throw invalid(humanize(res.body, res.status).text);
    const parsedBody = pairResponseBodySchema.safeParse(res.body);
    const them = parsedBody.success ? parsePeerDevice(parsedBody.data.device, opts.allowLoopback) : null;
    if (!parsedBody.success || them === null) throw invalid("对方回的配对信息不对");
    if (them.id === selfId) throw invalid("这是本机自己，不用配对");
    if (expectedId !== undefined && them.id !== expectedId) throw invalid("对方不是要配对的那台设备");
    // 网址用本机实际连上的那个（对方自报的只做参考）
    const record: PeerRecord = {
      id: them.id,
      name: them.name,
      platform: them.platform,
      url,
      transport: "tailscale",
      state: "paired",
      since: now(),
      inboundTokenSha256: sha256Hex(tokenForThem),
      outboundToken: parsedBody.data.token,
    };
    store.clearRemoved(record.id);
    store.put(record);
    log(`${LOG_PREFIX} 联机：和“${record.name}”（${record.id}）配好了`);
    announce();
    return record;
  };

  /** 连入方通过 run/tunnel/hub.sock 自动与中心完成配对。 */
  const pairOverTunnel = () => {
    if (opts.tunnelsFile === undefined || opts.hubSocket === undefined) return;
    const table = loadTunnelTable(opts.tunnelsFile);
    if (table.hub === null) return;
    const inviteCode = table.hub.invite;
    if (inviteCode === null || inviteCode === "") {
      if (table.hub.deviceId !== null) announce();
      return;
    }
    const lockKey = `tunnel:${inviteCode}`;
    if (pairing.has(lockKey)) return;
    pairing.add(lockKey);
    const hubSocket = opts.hubSocket;
    const tunnelsFile = opts.tunnelsFile;
    run("经 ssh 隧道和中心自动配对", async () => {
      try {
        const me: PeerDevice = { id: selfId, name: selfName, platform, url: opts.selfUrl() ?? "" };
        const tokenForThem = newPeerToken();
        const res = await call(
          { kind: "unix", socketPath: hubSocket },
          API_PATHS.peerPair,
          {
            method: "POST",
            body: { inviteCode, device: me, token: tokenForThem },
            onNetworkError: () => opts.reconnectTunnel?.(),
          },
        );
        if (res.status >= 500) throw offline();
        if (res.status !== 200) throw invalid(humanize(res.body, res.status).text);
        const parsedBody = pairResponseBodySchema.safeParse(res.body);
        const them = parsedBody.success ? parsePeerDevice(parsedBody.data.device, opts.allowLoopback) : null;
        if (!parsedBody.success || them === null) {
          throw invalid("对方回的配对信息不对");
        }
        if (them.id === selfId) throw invalid("这是本机自己，不用配对");

        const latestTable = loadTunnelTable(tunnelsFile);
        const bound = bindHubDevice(latestTable, them.id);
        if (bound.previousDeviceId !== null) {
          store.remove(bound.previousDeviceId, { tombstone: false });
        }
        saveTunnelTable(tunnelsFile, bound.table);

        const record: PeerRecord = {
          id: them.id,
          name: them.name,
          platform: them.platform,
          url: "",
          transport: "ssh-tunnel",
          state: "paired",
          since: now(),
          inboundTokenSha256: sha256Hex(tokenForThem),
          outboundToken: parsedBody.data.token,
        };
        store.clearRemoved(record.id);
        store.put(record);
        log(`${LOG_PREFIX} 联机：经隧道和中心“${record.name}”（${record.id}）配好了`);
        announce();
      } finally {
        pairing.delete(lockKey);
      }
    });
  };

  /** 请 via 把本机介绍给 targetId，拿到邀请码后直接去配对。 */
  const introduceVia = (via: PeerRecord, targetId: DeviceId) => {
    if (pairing.has(targetId)) return;
    pairing.add(targetId);
    run(`经“${via.name}”和 ${targetId} 配对`, async () => {
      try {
        const res = await callPeer(via, API_PATHS.peerIntroductions, { method: "POST", body: { deviceId: targetId } });
        if (res.status !== 200) throw new Error(res.error ?? `HTTP ${res.status}`);
        const parsedBody = introductionResponseBodySchema.safeParse(res.body);
        const target = parsedBody.success ? parsePeerDevice(parsedBody.data.device, opts.allowLoopback) : null;
        if (!parsedBody.success || target === null || target.id !== targetId || target.url === null) throw new Error("介绍回来的信息不对");
        if (store.get(targetId) !== undefined || store.isRemoved(targetId)) return;
        await pairWith(target.url, parsedBody.data.code, targetId);
      } finally {
        pairing.delete(targetId);
      }
    });
  };

  const requirePaired = (id: string): PeerRecord => {
    const record = isDeviceId(id) ? paired().find((r) => r.id === id) : undefined;
    if (record === undefined) throw notFound();
    return record;
  };

  const parseName = (body: unknown): string => parseStrictBody(nameBodySchema, body).name;

  const renameSelf = (body: unknown): DeviceInfo => {
    selfName = parseName(body);
    opts.saveName(selfName);
    announce();
    return selfInfo();
  };

  return {
    selfId,

    list: () => [selfInfo(), ...paired().map(infoOf)],

    target(id) {
      const record = isDeviceId(id) ? paired().find((r) => r.id === id) : undefined;
      if (record === undefined || !isRoutable(record)) return null;
      const hubPeer = isHubPeer(record.id);
      return {
        name: record.name,
        url: record.url,
        token: record.outboundToken,
        resolve: () => resolveRecordTarget(record),
        onOffline: hubPeer ? () => opts.reconnectTunnel?.() : undefined,
        unixPool,
      };
    },

    authenticate(deviceHeader, authorization) {
      if (typeof deviceHeader !== "string" || !isDeviceId(deviceHeader) || typeof authorization !== "string") return null;
      const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
      prunePending();
      const record = store.get(deviceHeader);
      // 不认得的设备也比一次哈希，回得一样快
      const ok = matchesHash(record?.inboundTokenSha256 ?? "0".repeat(64), match?.[1] ?? "");
      if (record === undefined || match === null || !ok) return null;
      if (record.state === "pending") {
        // 对方带着令牌来了 = 它那边存好了：确认，并把清单同步一遍（这时它才知道本机的别的设备）
        const confirmed = store.update(record.id, { state: "paired", since: now() })!;
        log(`${LOG_PREFIX} 联机：“${confirmed.name}”（${confirmed.id}）确认配对`);
        announce();
        return confirmed;
      }
      return record;
    },

    createInvite() {
      const invite = invites.create("user")!;
      return { code: invite.code, url: opts.selfUrl(), expiresAt: invite.expiresAt };
    },

    createTunnelInvite(slotPort) {
      const invite = invites.create({ slotPort })!;
      return { code: invite.code, expiresAt: invite.expiresAt };
    },

    onTunnelConnected() {
      pairOverTunnel();
    },

    removeByTunnelSlot(deviceId) {
      const peer = store.get(deviceId);
      if (peer === undefined) return;
      store.remove(peer.id);
      clearTunnelBinding(peer.id);
      log(`${LOG_PREFIX} 联机：槽位移除联动删掉“${peer.name}”（${peer.id}）`);
    },

    async add(body) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("请求体必须是 JSON 对象");
      const extra = Object.keys(body).filter((k) => k !== "url" && k !== "code");
      if (extra.length > 0) throw invalid(`不认识的字段：${extra[0]}`);
      const url = normalizePeerUrl((body as { url?: unknown }).url, opts.allowLoopback);
      if (url === null) throw invalid("设备网址要是那台的 tailnet 网址：https://<机器>.<tailnet>.ts.net");
      const raw = parseStrictBody(addBodySchema, body);
      return infoOf(await pairWith(url, raw.code));
    },

    acceptPair(body) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("请求体必须是 JSON 对象");
      const extra = Object.keys(body).filter((k) => k !== "inviteCode" && k !== "device" && k !== "token");
      if (extra.length > 0) throw invalid(`不认识的字段：${extra[0]}`);
      const rawDevice = (body as { device?: unknown }).device;
      const them = parsePeerDevice(rawDevice, opts.allowLoopback);
      const rawUrl = typeof rawDevice === "object" && rawDevice !== null ? (rawDevice as Record<string, unknown>).url : undefined;
      const hasNonEmptyBadUrl = rawUrl !== "" && rawUrl !== null && rawUrl !== undefined && them?.url === null;
      if (them === null || hasNonEmptyBadUrl) throw invalid("device 不对（网址要是 https://<机器>.<tailnet>.ts.net）");
      const raw = parseStrictBody(acceptPairBodySchema, body);
      if (them.id === selfId) throw invalid("这是本机自己，不用配对");
      const consumed = invites.consume(raw.inviteCode, them.id);
      if (!consumed.ok) {
        throw new PeerError(
          403,
          consumed.reason === "locked" ? "邀请码错太多次，已经锁住：请在新设备上重新生成邀请码" : "邀请码不对、过期了或已经用过",
          "forbidden",
        );
      }
      const isTunnelInvite = typeof consumed.by === "object" && "slotPort" in consumed.by;
      if (!isTunnelInvite && them.url === null) {
        throw invalid("device 不对（网址要是 https://<机器>.<tailnet>.ts.net）");
      }
      const me = isTunnelInvite
        ? { id: selfId, name: selfName, platform, url: opts.selfUrl() ?? "" }
        : selfDevice();

      // 用户亲手发的邀请码或绑槽位的隧道邀请码：以前移除过也重新认；替别的设备要的（介绍）要求不是移除过的，且发起介绍的那台还配着
      if (typeof consumed.by === "object" && "via" in consumed.by) {
        const { via } = consumed.by;
        if (store.isRemoved(them.id)) throw new PeerError(403, "这台设备已经被移除了", "forbidden");
        if (!paired().some((r) => r.id === via)) throw new PeerError(403, "介绍这台的设备已经不在了", "forbidden");
      }
      prunePending();

      if (typeof consumed.by === "object" && "slotPort" in consumed.by) {
        const { slotPort } = consumed.by;
        if (opts.tunnelsFile === undefined) throw new PeerError(403, "本机未启用隧道槽位", "forbidden");
        const table = loadTunnelTable(opts.tunnelsFile);
        const slot = table.slots.find((s) => s.port === slotPort);
        if (slot === undefined) throw new PeerError(403, "邀请码对应的隧道槽位已不存在", "forbidden");
        const existing = store.get(them.id);
        // 编号已经有了且不是同一槽位重新配对：拒绝覆盖，防止别的槽位或设备冒充已有设备编号
        if (existing !== undefined && slot.deviceId !== them.id) {
          throw new PeerError(409, "这台设备已经配对过：要重新配对，先在这边把它移除", "conflict");
        }
        const bound = bindSlotDevice(table, slotPort, them.id);
        if (bound.previousDeviceId !== null) {
          store.remove(bound.previousDeviceId, { tombstone: false });
        }
        saveTunnelTable(opts.tunnelsFile, bound.table);
        store.clearRemoved(them.id);
        const tokenForThem = newPeerToken();
        store.put({
          id: them.id,
          name: them.name,
          platform: them.platform,
          url: "",
          transport: "ssh-tunnel",
          state: "pending",
          since: now(),
          inboundTokenSha256: sha256Hex(tokenForThem),
          outboundToken: raw.token,
        });
        log(`${LOG_PREFIX} 联机：“${them.name}”（${them.id}）经隧道槽位 ${slotPort} 来配对，等它确认`);
        return { device: me, token: tokenForThem };
      }

      // 编号已经有了（配好的或没过期的待确认）：不覆盖，免得别的设备报这个编号把它的网址、令牌换掉
      if (store.get(them.id) !== undefined) throw new PeerError(409, "这台设备已经配对过：要重新配对，先在这边把它移除", "conflict");
      if (consumed.by === "user") store.clearRemoved(them.id);
      const tokenForThem = newPeerToken();
      store.put({
        id: them.id,
        name: them.name,
        platform: them.platform,
        url: them.url!,
        transport: "tailscale",
        state: "pending",
        since: now(),
        inboundTokenSha256: sha256Hex(tokenForThem),
        outboundToken: raw.token,
      });
      log(`${LOG_PREFIX} 联机：“${them.name}”（${them.id}）用邀请码来配对，等它确认`);
      return { device: me, token: tokenForThem };
    },

    receiveDeviceList(from, body) {
      const raw = parseStrictBody(deviceListBodySchema, body);
      const devices = raw.devices.map((d) => parsePeerDevice(d, opts.allowLoopback));
      if (devices.some((d) => d === null)) throw invalid("devices 里有不对的设备");
      const sender = store.get(from);
      if (sender === undefined) return;
      for (const d of devices as Array<Omit<PeerDevice, "url"> & { url: string | null }>) {
        if (d.id === from) {
          // 隧道设备的地址只来自本机隧道表，永远不从对方发来的清单里取
          const allowUrlUpdate = sender.transport !== "ssh-tunnel" && d.url !== null;
          store.update(from, { name: d.name, platform: d.platform, ...(allowUrlUpdate ? { url: d.url! } : {}) });
          continue;
        }
        if (d.id === selfId || store.get(d.id) !== undefined || store.isRemoved(d.id) || d.url === null) continue;
        // 编号小的去配（两边都得有 tailnet 网址才能直接介绍配对；隧道设备 url 为空已在上面跳过）
        if (selfId < d.id && opts.selfUrl() !== null) introduceVia(sender, d.id);
      }
    },

    receiveUnpair(from) {
      if (store.remove(from)) {
        clearTunnelBinding(from);
        log(`${LOG_PREFIX} 联机：对方（${from}）把这台移除了，这边也删掉`);
      }
    },

    inviteFor(from, body) {
      const raw = parseStrictBody(deviceIdBodySchema, body);
      if (typeof raw.deviceId !== "string" || !isDeviceId(raw.deviceId) || raw.deviceId === selfId || raw.deviceId === from) {
        throw invalid("deviceId 不对");
      }
      if (store.isRemoved(raw.deviceId)) throw new PeerError(403, "这台设备已经被移除了", "forbidden");
      // 只替本机还不认得的设备要：认得的编号不发，免得已配对的设备拿它冒充那台
      if (store.get(raw.deviceId) !== undefined) throw new PeerError(403, "这台设备已经配对过", "forbidden");
      const invite = invites.create({ for: raw.deviceId, via: from });
      if (invite === null) throw new PeerError(403, "邀请码错太多次，已经锁住", "forbidden");
      return { code: invite.code, url: opts.selfUrl(), expiresAt: invite.expiresAt };
    },

    async introduce(from, body) {
      const raw = parseStrictBody(deviceIdBodySchema, body);
      if (typeof raw.deviceId !== "string" || raw.deviceId === from) throw notFound();
      const target = requirePaired(raw.deviceId);
      if (target.transport === "ssh-tunnel" || target.url === "") {
        throw new PeerError(403, "隧道连接的设备不支持直接介绍配对", "forbidden");
      }
      const res = await callPeer(target, API_PATHS.peerInvites, { method: "POST", body: { deviceId: from } });
      const code = (res.body as { code?: unknown } | null)?.code;
      if (res.status !== 201 || typeof code !== "string") throw new PeerError(res.status >= 500 ? 502 : 403, res.error ?? `HTTP ${res.status}`);
      return { device: deviceOf(target), code };
    },

    renameSelf,

    async rename(id, body) {
      if (id === selfId) return renameSelf(body);
      const name = parseName(body);
      const peer = requirePaired(id);
      // 名字归那台自己管：请它改，它再同步给大家
      const res = await callPeer(peer, API_PATHS.peerName, { method: "PUT", body: { name } });
      if (res.status !== 204) throw new PeerError(res.status >= 500 ? 502 : 400, res.error ?? `HTTP ${res.status}`);
      return infoOf(store.update(peer.id, { name }) ?? { ...peer, name });
    },

    remove(id) {
      if (id === selfId) throw invalid("不能移除本机");
      const peer = isDeviceId(id) ? store.get(id) : undefined;
      if (peer === undefined) throw notFound();
      const targetBeforeRemove = resolveRecordTarget(peer);
      store.remove(peer.id);
      clearTunnelBinding(peer.id, { closeSocket: targetBeforeRemove?.kind !== "unix" });
      log(`${LOG_PREFIX} 联机：移除了“${peer.name}”（${peer.id}）`);
      // 通知对方也删；它离线就只删本机，它上线后来访会被拒（401），它那边自己删
      if (targetBeforeRemove !== null) {
        run(`通知“${peer.name}”移除`, async () => {
          try {
            await call(targetBeforeRemove, API_PATHS.peerUnpair, { method: "POST", token: peer.outboundToken });
          } finally {
            if (targetBeforeRemove.kind === "unix") unixPool.closeSocket(targetBeforeRemove.socketPath);
          }
        });
      }
    },

    forget,
    announce,

    async idle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },

    close() {
      closing.abort();
      unixPool.closeAll();
    },
  };
}
