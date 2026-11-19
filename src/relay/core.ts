// 一个账号的中继逻辑（docs/account-mesh-design.md「中继」「中心顺序与租约」）。Cloudflare 版每个账号一个 Durable Object 里放一个，
// Node 版每个账号一个；外壳只负责收发 WebSocket、存取 RelayAccountStorage、按时调 sweep。只用 Web 标准 API。
// 不变量：
// - 只有同账号、状态 active 的设备之间能 dial 和 signal；pending 设备只能和 active 设备互发 signal，不能被拨号；
// - 同一时刻一个租约名最多授给一台；改授前旧租约要么已过 MESH_LEASE_TTL_MS 没续约，要么旧持有者已 release 或控制连接已关；
// - 数据通道只配对 dial 里登记过的 (拨号方, 接听方, channel)，两端到齐后原样转发二进制帧，不解析、不落盘；
// - 落盘的只有设备表、中心顺序、租约 epoch 和当天流量；在线、候选地址、租约持有者、通道都在内存（Cloudflare 版靠 attachment 熬过休眠）。
import type { DeviceId } from "../shared/api.ts";
import {
  MESH_LEASE_TTL_MS,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  RELAY_ACCOUNT_DAILY_BYTES,
  RELAY_CHANNEL_ACCEPT_TIMEOUT_MS,
  RELAY_CHANNEL_IDLE_MS,
  RELAY_CHANNEL_PENDING_BYTES,
  RELAY_CONTROL_FRAMES_PER_SECOND,
  RELAY_MAX_CHANNELS_PER_DEVICE,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_PENDING_DEVICE_TTL_MS,
  RELAY_REMOVED_DEVICES_MAX,
  RELAY_USAGE_SAVE_MS,
} from "../shared/limits.ts";
import {
  MESH_LEASE_NAMES,
  pickCenter,
  type AccountId,
  type AccountLogin,
  type DeviceFingerprint,
  type MeshCandidate,
  type MeshDeviceState,
  type MeshLeaseName,
} from "../shared/mesh.ts";
import { fingerprintOfPem, verifyDeviceSignature } from "./auth.ts";
import {
  RELAY_PROTOCOL_VERSION,
  encodeRelayFrame,
  newRelayToken,
  parseRelayClientFrame,
  relayControlMessage,
  relayRegisterMessage,
  type RelayClientFrame,
  type RelayDeviceView,
  type RelayErrorCode,
  type RelayPresenceView,
  type RelayRegisterRequest,
  type RelayRegisterResponse,
  type RelayServerFrame,
} from "./protocol.ts";

/** 落盘的设备记录。 */
export interface RelayDeviceRecord {
  id: DeviceId;
  name: string;
  platform: string;
  certPem: string;
  fingerprint: DeviceFingerprint;
  /** Ed25519 公钥（SPKI DER 的 base64url）。 */
  publicKey: string;
  state: MeshDeviceState;
  addedAt: number;
}

/** 一个账号落盘的全部内容。 */
export interface RelayAccountRecord {
  accountId: AccountId;
  login: AccountLogin;
  devices: RelayDeviceRecord[];
  priority: DeviceId[];
  /** 最近被移除的设备（最多 RELAY_REMOVED_DEVICES_MAX 台）：它们再登入收到 removed，重新登记才清掉。 */
  removed: DeviceId[];
  /** 每个租约名最近一次授予的 epoch：中继重启后接着加，不回到 1。 */
  leaseEpochs: Partial<Record<MeshLeaseName, number>>;
  /** 当天（UTC）经数据通道的字节数，按 RELAY_USAGE_SAVE_MS 落盘。 */
  usage: { day: string; bytes: number };
}

/** 外壳提供的存储：Cloudflare 版是 DO 的 SQLite，Node 版是 node:sqlite。 */
export interface RelayAccountStorage {
  load(): Promise<RelayAccountRecord | null>;
  save(record: RelayAccountRecord): Promise<void>;
}

/** 外壳交进来的一条 WebSocket（控制连接收发文本，数据通道收发二进制）。 */
export interface RelaySocket {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

/** 控制连接熬过休眠要带的东西（Cloudflare 版存进 WebSocket 的 attachment，醒来交回 openControl）。 */
export interface RelayControlAttachment {
  device: DeviceId | null;
  session: string | null;
  nonce: string;
  candidates: MeshCandidate[];
  lastClaimAt: Partial<Record<MeshLeaseName, number>>;
  /** 这台持有的租约：醒来后按它恢复持有者和 epoch。 */
  held: { name: MeshLeaseName; epoch: number; renewedAt: number }[];
}

/** 一条控制连接在中继里的句柄。 */
export interface RelayControlHandle {
  /** 收到一条文本帧。 */
  receive(text: string): Promise<void>;
  /** 连接关了（正常或异常）。 */
  closed(): void;
  /** 现在该存进 attachment 的东西。 */
  attachment(): RelayControlAttachment;
}

/** 一条数据通道的一端在中继里的句柄。 */
export interface RelayChannelHandle {
  receive(data: Uint8Array): void;
  closed(): void;
}

export interface RelayAccountRoomOptions {
  accountId: AccountId;
  /** 中继自己的 origin（https://…），签名消息里要用。 */
  relayOrigin: string;
  storage: RelayAccountStorage;
  now?: () => number;
  randomToken?: () => string;
}

export interface RelayAccountRoom {
  /**
   * POST /v1/register 验过 GitHub 之后调（login 是验 token 得到的）。
   * 后置：签名对不上回 unauthorized；设备已满回 too_many_devices；账号里还没有设备时这台直接 active，否则 pending；
   * 同一设备编号再登记（换了证书）按新证书覆盖，状态回到 pending（第一台除外）。成功后推 devices 给账号里在线的设备。
   */
  register(login: AccountLogin, request: RelayRegisterRequest): Promise<RelayRegisterResponse | { error: RelayErrorCode }>;
  /**
   * 收下一条新的控制连接（或休眠醒来交回 attachment）。
   * 后置：新连接先收到 challenge；hello 签名对得上才回 welcome 并算作在线；签名不对、设备不在账号里时发 error 后关闭。
   */
  openControl(socket: RelaySocket, restored?: RelayControlAttachment): RelayControlHandle;
  /**
   * 收下一条数据通道的一端。
   * 后置：channel 没在 dial 里登记、设备或会话令牌对不上、超出 RELAY_MAX_CHANNELS_PER_DEVICE 或当天流量时回 error，外壳关掉连接；
   * 两端到齐后给拨号方的控制连接发 dial.connected，一端收到的帧原样发给另一端；一端关了另一端也关；超过 RELAY_CHANNEL_IDLE_MS 没有数据两端都关。
   */
  openChannel(query: { channel: string; device: DeviceId; session: string }, socket: RelaySocket): RelayChannelHandle | { error: RelayErrorCode };
  /** 按时间收拾：租约过期改授、等批准的设备过期删除、空闲通道关闭。外壳在每条消息后和定时器里调，可以重复调。 */
  sweep(): Promise<void>;
}

/** 后置：返回一个账号的中继逻辑；存储里没有这个账号时，第一次 register 时建。 */
export function createRelayAccountRoom(options: RelayAccountRoomOptions): RelayAccountRoom {
  const now = options.now ?? Date.now;
  const randomToken = options.randomToken ?? newRelayToken;
  const { accountId, relayOrigin, storage } = options;
  let record: RelayAccountRecord | null = null;
  let loaded: Promise<void> | null = null;
  const ensureLoaded = () => (loaded ??= storage.load().then((stored) => void (record = stored === null ? null : normalizeRecord(stored))));
  let lastUsageSave = 0;
  let usageDirty = false;

  /** 已登入的控制连接，一台设备一条。 */
  const controls = new Map<DeviceId, ControlConn>();
  const lastSeenAt = new Map<DeviceId, number>();
  const leases = new Map<MeshLeaseName, LeaseState>();
  const dials = new Map<string, DialRecord>();

  const save = async () => {
    if (record === null) return;
    usageDirty = false;
    lastUsageSave = now();
    await storage.save(record);
  };
  const deviceOf = (id: DeviceId) => record?.devices.find((d) => d.id === id);
  const isActive = (id: DeviceId) => deviceOf(id)?.state === "active";
  const send = (conn: ControlConn, frame: RelayServerFrame) => {
    if (!conn.closed) conn.socket.send(encodeRelayFrame(frame));
  };
  const sendTo = (id: DeviceId, frame: RelayServerFrame) => {
    const conn = controls.get(id);
    if (conn !== undefined) send(conn, frame);
  };
  const closeConn = (conn: ControlConn, code: number, reason: string) => {
    if (conn.closed) return;
    conn.closed = true;
    conn.socket.close(code, reason);
  };
  const fail = (conn: ControlConn, code: RelayErrorCode) => {
    send(conn, { type: "error", code });
    closeConn(conn, WS_CLOSE_POLICY, code);
    detach(conn);
  };

  const deviceViews = (): RelayDeviceView[] =>
    (record?.devices ?? []).map((d) => ({ id: d.id, name: d.name, platform: d.platform, certPem: d.certPem, fingerprint: d.fingerprint, state: d.state, addedAt: d.addedAt }));
  const presenceFor = (viewer: DeviceId): RelayPresenceView[] =>
    (record?.devices ?? []).map((d) => {
      const conn = controls.get(d.id);
      const shareCandidates = d.state === "active" && isActive(viewer) && conn !== undefined;
      return { id: d.id, online: conn !== undefined, candidates: shareCandidates ? conn.candidates : [], lastSeenAt: lastSeenAt.get(d.id) ?? null };
    });
  const broadcastDevices = () => {
    const devices = deviceViews();
    for (const conn of controls.values()) send(conn, { type: "devices", devices, priority: record?.priority ?? [] });
  };
  const broadcastPresence = () => {
    for (const [id, conn] of controls) send(conn, { type: "presence", presence: presenceFor(id) });
  };
  const leaseFrame = (name: MeshLeaseName): RelayServerFrame => {
    const lease = leases.get(name);
    return { type: "lease", name, grant: lease?.holder ? { name, holder: lease.holder, epoch: lease.epoch, ttlMs: MESH_LEASE_TTL_MS } : null };
  };
  const broadcastLease = (name: MeshLeaseName) => {
    const frame = leaseFrame(name);
    for (const [id, conn] of controls) if (isActive(id)) send(conn, frame);
  };

  // ---- 租约 ----
  const arbitrate = async (name: MeshLeaseName): Promise<void> => {
    const t = now();
    const lease = leases.get(name) ?? { holder: null, epoch: record?.leaseEpochs[name] ?? 0, renewedAt: 0, yielding: false };
    leases.set(name, lease);
    const priority = record?.priority ?? [];
    if (lease.holder !== null && (t - lease.renewedAt > MESH_LEASE_TTL_MS || !isActive(lease.holder) || !controls.has(lease.holder))) {
      lease.holder = null;
      lease.yielding = false;
      broadcastLease(name);
    }
    const candidates = new Set<DeviceId>();
    for (const [id, conn] of controls) {
      const claimed = conn.lastClaimAt[name];
      if (isActive(id) && claimed !== undefined && t - claimed <= MESH_LEASE_TTL_MS) candidates.add(id);
    }
    const best = pickCenter(priority, candidates);
    if (lease.holder === null) {
      if (best === null || record === null) return;
      lease.epoch = Math.max(lease.epoch, record.leaseEpochs[name] ?? 0) + 1;
      lease.holder = best;
      lease.renewedAt = t;
      lease.yielding = false;
      record.leaseEpochs[name] = lease.epoch;
      await save();
      broadcastLease(name);
      return;
    }
    const holderRank = priority.indexOf(lease.holder);
    const outranked = best !== null && best !== lease.holder && (holderRank === -1 || priority.indexOf(best) < holderRank);
    if ((outranked || holderRank === -1) && !lease.yielding) {
      lease.yielding = true;
      sendTo(lease.holder, { type: "lease.yield", name, epoch: lease.epoch });
    }
  };
  const arbitrateAll = async () => {
    for (const name of MESH_LEASE_NAMES) await arbitrate(name);
  };

  // ---- 数据通道 ----
  const channelsOf = (id: DeviceId) => {
    let count = 0;
    for (const dial of dials.values()) {
      if (dial.from === id) count++;
      if (dial.to === id) count++;
    }
    return count;
  };
  const rollUsage = () => {
    if (record === null) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (record.usage.day !== day) {
      record.usage = { day, bytes: 0 };
      usageDirty = true;
    }
  };
  const overQuota = () => {
    rollUsage();
    return (record?.usage.bytes ?? 0) >= RELAY_ACCOUNT_DAILY_BYTES;
  };
  const closeDial = (channel: string) => {
    const dial = dials.get(channel);
    if (dial === undefined) return;
    dials.delete(channel);
    for (const end of [dial.dialer, dial.acceptor]) {
      if (end !== undefined && !end.closed) {
        end.closed = true;
        end.socket.close(1000, "closed");
      }
    }
  };
  const closeDialsOf = (id: DeviceId) => {
    for (const [channel, dial] of dials) if (dial.from === id || dial.to === id) closeDial(channel);
  };

  // ---- 控制连接 ----
  const detach = (conn: ControlConn) => {
    if (conn.device === null || controls.get(conn.device) !== conn) return false;
    controls.delete(conn.device);
    lastSeenAt.set(conn.device, now());
    return true;
  };

  const removeDevice = async (id: DeviceId) => {
    if (record === null) return;
    record.devices = record.devices.filter((d) => d.id !== id);
    record.priority = record.priority.filter((p) => p !== id);
    record.removed = [...record.removed.filter((r) => r !== id), id].slice(-RELAY_REMOVED_DEVICES_MAX);
    await save();
    const conn = controls.get(id);
    if (conn !== undefined) {
      send(conn, { type: "removed" });
      closeConn(conn, 1000, "removed");
      detach(conn);
    }
    closeDialsOf(id);
    for (const name of MESH_LEASE_NAMES) {
      const lease = leases.get(name);
      if (lease?.holder === id) {
        lease.holder = null;
        lease.yielding = false;
        broadcastLease(name);
      }
    }
    broadcastDevices();
    broadcastPresence();
    await arbitrateAll();
  };

  const welcome = (conn: ControlConn, device: RelayDeviceRecord) => {
    const previous = controls.get(device.id);
    if (previous !== undefined && previous !== conn) {
      closeConn(previous, WS_CLOSE_REPLACED, "replaced");
      controls.delete(device.id);
    }
    conn.device = device.id;
    conn.session = randomToken();
    controls.set(device.id, conn);
    send(conn, {
      type: "welcome",
      accountId,
      self: device.state,
      session: conn.session,
      devices: deviceViews(),
      priority: record?.priority ?? [],
      presence: presenceFor(device.id),
    });
    if (device.state === "active") for (const name of MESH_LEASE_NAMES) send(conn, leaseFrame(name));
    broadcastPresence();
  };

  const handleHello = async (conn: ControlConn, frame: Extract<RelayClientFrame, { type: "hello" }>) => {
    await ensureLoaded();
    if (frame.version !== RELAY_PROTOCOL_VERSION) return fail(conn, "bad_frame");
    if (record?.removed.includes(frame.device)) {
      send(conn, { type: "removed" });
      return closeConn(conn, 1000, "removed");
    }
    const device = deviceOf(frame.device);
    if (device === undefined) return fail(conn, "unknown_device");
    const message = relayControlMessage({ relayOrigin, accountId, device: device.id, nonce: conn.nonce });
    if (!(await verifyDeviceSignature(device.publicKey, message, frame.signature))) return fail(conn, "unauthorized");
    if (conn.closed) return;
    welcome(conn, device);
  };

  const handleFrame = async (conn: ControlConn, self: DeviceId, frame: RelayClientFrame) => {
    const selfRecord = deviceOf(self);
    if (selfRecord === undefined) return fail(conn, "removed");
    const selfActive = selfRecord.state === "active";
    switch (frame.type) {
      case "hello":
        return fail(conn, "bad_frame");
      case "presence": {
        conn.candidates = frame.candidates;
        if (selfActive) broadcastPresence();
        return;
      }
      case "lease.claim": {
        if (!selfActive) return;
        conn.lastClaimAt[frame.name] = now();
        const lease = leases.get(frame.name);
        if (lease?.holder === self && !lease.yielding && now() - lease.renewedAt <= MESH_LEASE_TTL_MS) {
          lease.renewedAt = now();
          send(conn, leaseFrame(frame.name));
          return;
        }
        return arbitrate(frame.name);
      }
      case "lease.release": {
        const lease = leases.get(frame.name);
        if (lease?.holder !== self || lease.epoch !== frame.epoch) return;
        lease.holder = null;
        lease.yielding = false;
        delete conn.lastClaimAt[frame.name];
        broadcastLease(frame.name);
        return arbitrate(frame.name);
      }
      case "dial": {
        const failDial = (code: RelayErrorCode) => send(conn, { type: "dial.failed", to: frame.to, channel: frame.channel, code });
        if (!selfActive) return failDial("not_active");
        const target = deviceOf(frame.to);
        if (target === undefined || frame.to === self) return failDial("unknown_device");
        if (target.state !== "active") return failDial("not_active");
        const targetConn = controls.get(frame.to);
        if (targetConn === undefined) return failDial("offline");
        if (dials.has(frame.channel)) return failDial("bad_frame");
        if (channelsOf(self) >= RELAY_MAX_CHANNELS_PER_DEVICE || channelsOf(frame.to) >= RELAY_MAX_CHANNELS_PER_DEVICE) return failDial("rate_limited");
        if (overQuota()) return failDial("quota_exceeded");
        dials.set(frame.channel, { from: self, to: frame.to, createdAt: now(), lastDataAt: now(), pending: [], pendingBytes: 0 });
        send(targetConn, { type: "incoming", from: self, channel: frame.channel });
        return;
      }
      case "signal": {
        const target = deviceOf(frame.to);
        if (target === undefined || frame.to === self) return;
        if (!selfActive && target.state !== "active") return;
        sendTo(frame.to, { type: "signal", from: self, payload: frame.payload });
        return;
      }
      case "device.activate": {
        if (!selfActive) return fail(conn, "not_active");
        const target = deviceOf(frame.id);
        if (target === undefined || target.state === "active") return;
        target.state = "active";
        if (record !== null && !record.priority.includes(target.id) && record.priority.length < MESH_MAX_DEVICES_PER_ACCOUNT) record.priority.push(target.id);
        await save();
        broadcastDevices();
        broadcastPresence();
        const targetConn = controls.get(target.id);
        if (targetConn !== undefined) for (const name of MESH_LEASE_NAMES) send(targetConn, leaseFrame(name));
        return;
      }
      case "device.remove": {
        if (!selfActive) return fail(conn, "not_active");
        if (deviceOf(frame.id) === undefined) return;
        return removeDevice(frame.id);
      }
      case "priority.set": {
        if (!selfActive) return fail(conn, "not_active");
        if (record === null) return;
        record.priority = frame.priority.filter((id) => isActive(id));
        await save();
        broadcastDevices();
        return arbitrateAll();
      }
    }
  };

  const allowFrame = (conn: ControlConn): boolean => {
    const t = now();
    conn.frameTimes = conn.frameTimes.filter((at) => t - at < 1_000);
    conn.frameTimes.push(t);
    return conn.frameTimes.length <= RELAY_CONTROL_FRAMES_PER_SECOND;
  };

  return {
    async register(login, request) {
      await ensureLoaded();
      let fingerprint: DeviceFingerprint;
      try {
        fingerprint = await fingerprintOfPem(request.device.certPem);
      } catch {
        return { error: "unauthorized" };
      }
      const message = relayRegisterMessage({ relayOrigin, provider: request.provider, device: request.device.id, fingerprint });
      if (!(await verifyDeviceSignature(request.device.publicKey, message, request.signature))) return { error: "unauthorized" };
      const current: RelayAccountRecord = record ?? { accountId, login, devices: [], priority: [], removed: [], leaseEpochs: {}, usage: { day: "", bytes: 0 } };
      const existing = current.devices.find((d) => d.id === request.device.id);
      if (existing === undefined && current.devices.length >= MESH_MAX_DEVICES_PER_ACCOUNT) return { error: "too_many_devices" };
      const nobodyActive = !current.devices.some((d) => d.state === "active" && d.id !== request.device.id);
      const sameCert = existing !== undefined && existing.fingerprint === fingerprint;
      const state: MeshDeviceState = nobodyActive ? "active" : sameCert ? existing.state : "pending";
      const device: RelayDeviceRecord = {
        id: request.device.id,
        name: request.device.name,
        platform: request.device.platform,
        certPem: request.device.certPem,
        fingerprint,
        publicKey: request.device.publicKey,
        state,
        addedAt: existing !== undefined && sameCert ? existing.addedAt : now(),
      };
      current.login = login;
      current.devices = existing === undefined ? [...current.devices, device] : current.devices.map((d) => (d.id === device.id ? device : d));
      current.removed = current.removed.filter((id) => id !== device.id);
      if (state === "active" && !current.priority.includes(device.id)) current.priority.push(device.id);
      if (state === "pending") current.priority = current.priority.filter((id) => id !== device.id);
      record = current;
      await save();
      const conn = controls.get(device.id);
      if (conn !== undefined && !sameCert) {
        closeConn(conn, WS_CLOSE_REPLACED, "replaced");
        detach(conn);
      }
      broadcastDevices();
      broadcastPresence();
      return { accountId, login: login.login, state };
    },

    openControl(socket, restored) {
      const conn: ControlConn = {
        socket,
        device: null,
        session: null,
        nonce: restored?.nonce ?? randomToken(),
        candidates: restored?.candidates ?? [],
        lastClaimAt: { ...(restored?.lastClaimAt ?? {}) },
        frameTimes: [],
        closed: false,
        queue: Promise.resolve(),
      };
      if (restored?.device != null && restored.session !== null) {
        conn.device = restored.device;
        conn.session = restored.session;
        controls.set(restored.device, conn);
        for (const held of restored.held) {
          const lease = leases.get(held.name);
          if (lease === undefined || lease.epoch <= held.epoch) {
            leases.set(held.name, { holder: restored.device, epoch: held.epoch, renewedAt: held.renewedAt, yielding: false });
          }
        }
      } else if (restored === undefined) {
        send(conn, { type: "challenge", nonce: conn.nonce });
      }
      const handle: RelayControlHandle = {
        receive(text) {
          const run = async () => {
            if (conn.closed) return;
            if (!allowFrame(conn)) return fail(conn, "rate_limited");
            const frame = parseRelayClientFrame(text);
            if (frame === null) return fail(conn, "bad_frame");
            await ensureLoaded();
            if (conn.device === null) {
              if (frame.type !== "hello") return fail(conn, "unauthorized");
              return handleHello(conn, frame);
            }
            if (controls.get(conn.device) !== conn) return fail(conn, "unauthorized");
            return handleFrame(conn, conn.device, frame);
          };
          conn.queue = conn.queue.then(run, run);
          return conn.queue;
        },
        closed() {
          conn.closed = true;
          const run = async () => {
            const was = conn.device;
            if (!detach(conn) || was === null) return;
            broadcastPresence();
            for (const name of MESH_LEASE_NAMES) {
              const lease = leases.get(name);
              if (lease?.holder === was) {
                lease.holder = null;
                lease.yielding = false;
                broadcastLease(name);
              }
            }
            await arbitrateAll();
          };
          conn.queue = conn.queue.then(run, run);
        },
        attachment() {
          const held: RelayControlAttachment["held"] = [];
          for (const [name, lease] of leases) {
            if (conn.device !== null && lease.holder === conn.device) held.push({ name, epoch: lease.epoch, renewedAt: lease.renewedAt });
          }
          return { device: conn.device, session: conn.session, nonce: conn.nonce, candidates: conn.candidates, lastClaimAt: { ...conn.lastClaimAt }, held };
        },
      };
      return handle;
    },

    openChannel(query, socket) {
      const dial = dials.get(query.channel);
      const conn = controls.get(query.device);
      if (dial === undefined || conn === undefined || conn.session !== query.session) return { error: "unauthorized" };
      const side = query.device === dial.from ? "dialer" : query.device === dial.to ? "acceptor" : null;
      if (side === null || dial[side] !== undefined) return { error: "unauthorized" };
      if (overQuota()) return { error: "quota_exceeded" };
      const end: ChannelEnd = { socket, closed: false };
      dial[side] = end;
      const otherOf = () => (side === "dialer" ? dial.acceptor : dial.dialer);
      if (dial.dialer !== undefined && dial.acceptor !== undefined) {
        dial.lastDataAt = now();
        for (const chunk of dial.pending.splice(0)) socket.send(chunk);
        dial.pendingBytes = 0;
        sendTo(dial.from, { type: "dial.connected", to: dial.to, channel: query.channel });
      }
      return {
        receive(data) {
          if (end.closed || dials.get(query.channel) !== dial) return;
          if (data.length > RELAY_MAX_DATA_FRAME_BYTES) return closeDial(query.channel);
          rollUsage();
          if (record !== null) {
            record.usage.bytes += data.length;
            usageDirty = true;
          }
          dial.lastDataAt = now();
          const other = otherOf();
          if (other !== undefined && !other.closed) {
            other.socket.send(data);
            return;
          }
          dial.pendingBytes += data.length;
          if (dial.pendingBytes > RELAY_CHANNEL_PENDING_BYTES) return closeDial(query.channel);
          dial.pending.push(data);
        },
        closed() {
          end.closed = true;
          if (dials.get(query.channel) === dial) closeDial(query.channel);
          if (usageDirty) void save();
        },
      };
    },

    async sweep() {
      await ensureLoaded();
      const t = now();
      for (const [channel, dial] of dials) {
        const paired = dial.dialer !== undefined && dial.acceptor !== undefined;
        if (!paired && t - dial.createdAt > RELAY_CHANNEL_ACCEPT_TIMEOUT_MS) {
          sendTo(dial.from, { type: "dial.failed", to: dial.to, channel, code: "offline" });
          closeDial(channel);
        } else if (paired && t - dial.lastDataAt > RELAY_CHANNEL_IDLE_MS) {
          closeDial(channel);
        }
      }
      if (record !== null) {
        for (const device of record.devices) {
          if (device.state === "pending" && t - device.addedAt > RELAY_PENDING_DEVICE_TTL_MS) await removeDevice(device.id);
        }
      }
      await arbitrateAll();
      if (usageDirty && t - lastUsageSave >= RELAY_USAGE_SAVE_MS) await save();
    },
  };
}

interface ControlConn {
  socket: RelaySocket;
  device: DeviceId | null;
  session: string | null;
  nonce: string;
  candidates: MeshCandidate[];
  lastClaimAt: Partial<Record<MeshLeaseName, number>>;
  /** 最近一秒内收到的帧的时刻（限流）。 */
  frameTimes: number[];
  closed: boolean;
  /** 同一条连接上的帧按到达顺序一条条处理。 */
  queue: Promise<void>;
}

interface LeaseState {
  holder: DeviceId | null;
  epoch: number;
  renewedAt: number;
  /** 已经叫持有者让出：之后它的 claim 不再续约，release 或过期后改授。 */
  yielding: boolean;
}

interface ChannelEnd {
  socket: RelaySocket;
  closed: boolean;
}

interface DialRecord {
  from: DeviceId;
  to: DeviceId;
  createdAt: number;
  lastDataAt: number;
  dialer?: ChannelEnd;
  acceptor?: ChannelEnd;
  /** 另一端还没接起时先到的帧。 */
  pending: Uint8Array[];
  pendingBytes: number;
}

/** 被拒（签名不对、帧不合规、超限）时关控制连接用的码。 */
const WS_CLOSE_POLICY = 1008;
/** 同一台设备开了新的控制连接，旧的用这个码关。 */
const WS_CLOSE_REPLACED = 4000;

function normalizeRecord(stored: RelayAccountRecord): RelayAccountRecord {
  return {
    ...stored,
    removed: stored.removed ?? [],
    leaseEpochs: stored.leaseEpochs ?? {},
    usage: stored.usage ?? { day: "", bytes: 0 },
  };
}
