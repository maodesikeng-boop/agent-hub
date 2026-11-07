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
} from "../../shared/index.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { createInviteBook, type InviteBook } from "./invites.ts";
import { isPlatform, openPeerStore, type PeerRecord, type PeerStore } from "./store.ts";
import { PEER_TOKEN_PATTERN, matchesHash, newPeerToken, sha256Hex } from "./tokens.ts";
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
const notFound = () => new PeerError(404, "没有这台设备", "not_found");
export const offline = (name?: string) => new PeerError(502, `连不上${name === undefined ? "那台设备" : `“${name}”`}：对方可能关机、睡眠或没开 Tailscale`, "device_offline");

/** 请求体：必须是 JSON 对象，只许出现 allowed 里的字段。 */
function objectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("body must be a JSON object");
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw invalid(`unknown field: ${extra[0]}`);
  return body as Record<string, unknown>;
}

/** 对方发来的设备身份：编号、名字、系统要合规；网址按 normalizePeerUrl（不认的回 null，调用方决定怎么办）。 */
function parsePeerDevice(value: unknown, allowLoopback: boolean): (Omit<PeerDevice, "url"> & { url: string | null }) | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name, platform, url } = value as Record<string, unknown>;
  const normalized = typeof name === "string" ? normalizeName(name) : null;
  if (typeof id !== "string" || !isDeviceId(id) || normalized === null || !isPlatform(platform)) return null;
  return { id, name: normalized, platform, url: normalizePeerUrl(url, allowLoopback) };
}

export interface PeersOptions {
  /** state/peers.json。 */
  file: string;
  /** 本机身份（state/device.json）。 */
  device: { id: DeviceId; name: string };
  /** 本机的 process.platform。 */
  platform?: string;
  /** 本机改名：写 state/device.json。 */
  saveName: (name: string) => void;
  /** 本机的设备网址：https://<tailnet 名字>；没有 Tailscale 时 null（ENV_ALLOW_LOOPBACK_PEERS 时是 http://127.0.0.1:<端口>）。 */
  selfUrl: () => string | null;
  /** 认不认本机回环网址（ENV_ALLOW_LOOPBACK_PEERS）。 */
  allowLoopback: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Peers {
  readonly selfId: DeviceId;
  /** GET /api/devices：本机排第一，后面是已配对的（pending 的不算）。 */
  list(): DeviceInfo[];
  /** 转发目标：已配对的才有。 */
  target(id: string): { name: string; url: string; token: string } | null;
  /** 带设备令牌来的请求：X-Agent-Hub-Device + Authorization: Bearer。认得回那台的记录（pending 的顺手确认），不认得回 null。 */
  authenticate(deviceHeader: unknown, authorization: unknown): PeerRecord | null;
  createInvite(): DeviceInviteResponse;
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
  const closing = new AbortController();
  const background = new Set<Promise<unknown>>();
  /** 正在配对（介绍）的设备：同一台不同时发两次。 */
  const pairing = new Set<DeviceId>();

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

  const selfDevice = (): PeerDevice => {
    const url = opts.selfUrl();
    if (url === null) throw new PeerError(409, "这台还没有 tailnet 网址：先装好 Tailscale 并登录，再配对", "conflict");
    return { id: selfId, name: selfName, platform, url };
  };
  const selfInfo = (): DeviceInfo => ({ id: selfId, name: selfName, platform, self: true, url: opts.selfUrl() });
  const infoOf = (r: PeerRecord): DeviceInfo => ({ id: r.id, name: r.name, platform: r.platform, self: false, url: r.url });
  const deviceOf = (r: PeerRecord): PeerDevice => ({ id: r.id, name: r.name, platform: r.platform, url: r.url });

  /** 设备之间的控制请求。连不上、超时 → device_offline。 */
  const call = async (url: string, path: string, init: { method: string; token?: string; body?: unknown }) => {
    const headers: Record<string, string> = { [PEER_DEVICE_HEADER]: selfId };
    if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url + path, {
        method: init.method,
        headers,
        redirect: "manual",
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.any([AbortSignal.timeout(PEER_REQUEST_TIMEOUT_MS), closing.signal]),
      });
      text = await res.text();
    } catch {
      throw offline();
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const error = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : null;
    return { status: res.status, body, error };
  };

  /** 带本机令牌找已配对的那台。对方说不认本机了：本机也删掉它，回 404。 */
  const callPeer = async (peer: PeerRecord, path: string, init: { method: string; body?: unknown }) => {
    let result;
    try {
      result = await call(peer.url, path, { ...init, token: peer.outboundToken });
    } catch (error) {
      throw error instanceof PeerError && error.code === "device_offline" ? offline(peer.name) : error;
    }
    if (result.status === 401 && result.error === PEER_UNAUTHORIZED) {
      forget(peer.id);
      throw new PeerError(404, `“${peer.name}”已经把这台移除了`, "not_found");
    }
    return result;
  };

  const forget = (id: DeviceId) => {
    if (store.remove(id)) log(`${LOG_PREFIX} 联机：对方已经不认这台了，删掉 ${id}`);
  };

  const announce = () => {
    const url = opts.selfUrl();
    const targets = paired();
    if (url === null || targets.length === 0) return;
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
    const res = await call(url, API_PATHS.peerPair, { method: "POST", body: { inviteCode: code, device: me, token: tokenForThem } });
    if (res.status >= 500) throw offline();
    if (res.status !== 200) throw invalid(res.error ?? `对方拒绝了配对（HTTP ${res.status}）`);
    const body = res.body as { device?: unknown; token?: unknown } | null;
    const them = parsePeerDevice(body?.device, opts.allowLoopback);
    if (them === null || typeof body?.token !== "string" || !PEER_TOKEN_PATTERN.test(body.token)) throw invalid("对方回的配对信息不对");
    if (them.id === selfId) throw invalid("这是本机自己，不用配对");
    if (expectedId !== undefined && them.id !== expectedId) throw invalid("对方不是要配对的那台设备");
    // 网址用本机实际连上的那个（对方自报的只做参考）
    const record: PeerRecord = {
      id: them.id,
      name: them.name,
      platform: them.platform,
      url,
      state: "paired",
      since: now(),
      inboundTokenSha256: sha256Hex(tokenForThem),
      outboundToken: body.token,
    };
    store.clearRemoved(record.id);
    store.put(record);
    log(`${LOG_PREFIX} 联机：和“${record.name}”（${record.id}）配好了`);
    announce();
    return record;
  };

  /** 请 via 把本机介绍给 targetId，拿到邀请码后直接去配对。 */
  const introduceVia = (via: PeerRecord, targetId: DeviceId) => {
    if (pairing.has(targetId)) return;
    pairing.add(targetId);
    run(`经“${via.name}”和 ${targetId} 配对`, async () => {
      try {
        const res = await callPeer(via, API_PATHS.peerIntroductions, { method: "POST", body: { deviceId: targetId } });
        if (res.status !== 200) throw new Error(res.error ?? `HTTP ${res.status}`);
        const body = res.body as { device?: unknown; code?: unknown } | null;
        const target = parsePeerDevice(body?.device, opts.allowLoopback);
        if (target === null || target.id !== targetId || target.url === null || typeof body?.code !== "string") throw new Error("介绍回来的信息不对");
        if (store.get(targetId) !== undefined || store.isRemoved(targetId)) return;
        await pairWith(target.url, body.code, targetId);
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

  const parseName = (body: unknown): string => {
    const raw = objectBody(body, ["name"]);
    const name = typeof raw.name === "string" ? normalizeName(raw.name) : null;
    if (name === null) throw invalid("名字不能为空，也不能太长");
    return name;
  };

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
      return record === undefined ? null : { name: record.name, url: record.url, token: record.outboundToken };
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

    async add(body) {
      const raw = objectBody(body, ["url", "code"]);
      const url = normalizePeerUrl(raw.url, opts.allowLoopback);
      if (url === null) throw invalid("设备网址要是那台的 tailnet 网址：https://<机器>.<tailnet>.ts.net");
      if (typeof raw.code !== "string" || raw.code.trim() === "" || raw.code.length > MAX_INVITE_CODE_CHARS) throw invalid("请填那台设备给的邀请码");
      return infoOf(await pairWith(url, raw.code.trim()));
    },

    acceptPair(body) {
      const raw = objectBody(body, ["inviteCode", "device", "token"]);
      const them = parsePeerDevice(raw.device, opts.allowLoopback);
      if (them === null || them.url === null) throw invalid("device 不对（网址要是 https://<机器>.<tailnet>.ts.net）");
      if (typeof raw.token !== "string" || !PEER_TOKEN_PATTERN.test(raw.token)) throw invalid("token 不对");
      if (them.id === selfId) throw invalid("这是本机自己，不用配对");
      const me = selfDevice();
      const consumed = invites.consume(raw.inviteCode, them.id);
      if (!consumed.ok) {
        throw new PeerError(
          403,
          consumed.reason === "locked" ? "邀请码错太多次，已经锁住：请在新设备上重新生成邀请码" : "邀请码不对、过期了或已经用过",
          "forbidden",
        );
      }
      // 用户亲手发的邀请码：以前移除过也重新认；替别的设备要的（介绍）要求不是移除过的（发邀请码时查过，这里再查一次）
      if (consumed.by === "user") store.clearRemoved(them.id);
      else if (store.isRemoved(them.id)) throw new PeerError(403, "这台设备已经被移除了", "forbidden");
      const tokenForThem = newPeerToken();
      store.put({
        id: them.id,
        name: them.name,
        platform: them.platform,
        url: them.url,
        state: "pending",
        since: now(),
        inboundTokenSha256: sha256Hex(tokenForThem),
        outboundToken: raw.token,
      });
      log(`${LOG_PREFIX} 联机：“${them.name}”（${them.id}）用邀请码来配对，等它确认`);
      return { device: me, token: tokenForThem };
    },

    receiveDeviceList(from, body) {
      const raw = objectBody(body, ["devices"]);
      if (!Array.isArray(raw.devices) || raw.devices.length > MAX_PEERS) throw invalid("devices must be an array");
      const devices = raw.devices.map((d) => parsePeerDevice(d, opts.allowLoopback));
      if (devices.some((d) => d === null)) throw invalid("devices 里有不对的设备");
      const sender = store.get(from);
      if (sender === undefined) return;
      for (const d of devices as Array<Omit<PeerDevice, "url"> & { url: string | null }>) {
        if (d.id === from) {
          // 只认它说它自己的（名字、系统、网址）；别人的网址不收，免得被指到别处去
          store.update(from, { name: d.name, platform: d.platform, ...(d.url === null ? {} : { url: d.url }) });
          continue;
        }
        if (d.id === selfId || store.get(d.id) !== undefined || store.isRemoved(d.id) || d.url === null) continue;
        // 编号小的去配
        if (selfId < d.id) introduceVia(sender, d.id);
      }
    },

    receiveUnpair(from) {
      if (store.remove(from)) log(`${LOG_PREFIX} 联机：对方（${from}）把这台移除了，这边也删掉`);
    },

    inviteFor(from, body) {
      const raw = objectBody(body, ["deviceId"]);
      if (typeof raw.deviceId !== "string" || !isDeviceId(raw.deviceId) || raw.deviceId === selfId || raw.deviceId === from) {
        throw invalid("deviceId 不对");
      }
      if (store.isRemoved(raw.deviceId)) throw new PeerError(403, "这台设备已经被移除了", "forbidden");
      const invite = invites.create(raw.deviceId);
      if (invite === null) throw new PeerError(403, "邀请码错太多次，已经锁住", "forbidden");
      return { code: invite.code, url: opts.selfUrl(), expiresAt: invite.expiresAt };
    },

    async introduce(from, body) {
      const raw = objectBody(body, ["deviceId"]);
      if (typeof raw.deviceId !== "string" || raw.deviceId === from) throw notFound();
      const target = requirePaired(raw.deviceId);
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
      store.remove(peer.id);
      log(`${LOG_PREFIX} 联机：移除了“${peer.name}”（${peer.id}）`);
      // 通知对方也删；它离线就只删本机，它上线后来访会被拒（401），它那边自己删
      run(`通知“${peer.name}”移除`, async () => {
        await call(peer.url, API_PATHS.peerUnpair, { method: "POST", token: peer.outboundToken });
      });
    },

    forget,
    announce,

    async idle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },

    close() {
      closing.abort();
    },
  };
}
