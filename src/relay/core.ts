// Web-standard APIs only. Data channels forward binary frames verbatim and are never parsed or persisted.
import type { DeviceId } from "../shared/api.ts";
import {
  MESH_LEASE_TTL_MS,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  MESH_TRUST_TOMBSTONES_MAX,
  RELAY_ACCOUNT_DAILY_BYTES,
  RELAY_CHANNEL_ACCEPT_TIMEOUT_MS,
  RELAY_CHANNEL_IDLE_MS,
  RELAY_CHANNEL_PENDING_BYTES,
  RELAY_CONTROL_FRAMES_PER_SECOND,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_MAX_CHANNELS_PER_DEVICE,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_MAX_UNAUTH_CONTROLS_PER_ACCOUNT,
  RELAY_PENDING_DEVICE_TTL_MS,
  RELAY_REMOVED_DEVICES_MAX,
  RELAY_REVOCATIONS_PAGE_SIZE,
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
import { fingerprintOfPem, verifyCertPublicKey, verifyDeviceSignature } from "./auth.ts";
import {
  RELAY_PROTOCOL_VERSION,
  encodeRelayFrame,
  newRelayToken,
  parseLenientPresenceFrame,
  parseRelayClientFrame,
  relayControlMessage,
  relayRegisterMessage,
  type RelayClientFrame,
  type RelayDeviceView,
  type RelayErrorCode,
  type RelayLeaseCheckpointRecord,
  type RelayPresenceView,
  type RelayRegisterRequest,
  type RelayRegisterResponse,
  type RelayRevocationEnvelope,
  type RelayServerFrame,
} from "./protocol.ts";
import {
  readLeaseCheckpoint,
  writeLeaseCheckpoint,
  type RelayLeaseCheckpointAuth,
  type RelayLeaseCheckpointContext,
  type RelayLeaseCheckpointPutInput,
  type RelayLeaseCheckpointReadResult,
  type RelayLeaseCheckpointWriteResult,
} from "./lease-checkpoint.ts";

export interface RelayDeviceRecord {
  id: DeviceId;
  name: string;
  platform: string;
  certPem: string;
  fingerprint: DeviceFingerprint;
  publicKey: string;
  state: MeshDeviceState;
  addedAt: number;
}

export interface RelayAccountRecord {
  accountId: AccountId;
  login: AccountLogin;
  devices: RelayDeviceRecord[];
  priority: DeviceId[];
  removed: DeviceId[];
  revocations?: RelayRevocationEnvelope[];
  leaseEpochs: Partial<Record<MeshLeaseName, number>>;
  leaseCheckpoints?: Partial<Record<MeshLeaseName, RelayLeaseCheckpointRecord>>;
  usage: { day: string; bytes: number };
}

export interface RelayAccountStorage {
  load(): Promise<RelayAccountRecord | null>;
  save(record: RelayAccountRecord): Promise<void>;
}

export interface RelaySocket {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface RelayControlAttachment {
  device: DeviceId | null;
  session: string | null;
  nonce: string;
  openedAt?: number;
  candidates: MeshCandidate[];
  lastClaimAt: Partial<Record<MeshLeaseName, number>>;
  held: { name: MeshLeaseName; epoch: number; renewedAt: number }[];
}

export interface RelayControlHandle {
  receive(text: string): Promise<void>;
  closed(): Promise<void>;
  attachment(): RelayControlAttachment;
}

export interface RelayChannelHandle {
  receive(data: Uint8Array): void;
  closed(): void;
}

export interface RelayAccountRoomOptions {
  accountId: AccountId;
  relayOrigin: string;
  storage: RelayAccountStorage;
  now?: () => number;
  randomToken?: () => string;
}

export interface RelayAccountRoom {
  register(login: AccountLogin, request: RelayRegisterRequest): Promise<RelayRegisterResponse | { error: RelayErrorCode }>;
  openControl(socket: RelaySocket, restored?: RelayControlAttachment): RelayControlHandle;
  openChannel(query: { channel: string; device: DeviceId; session: string }, socket: RelaySocket): RelayChannelHandle | { error: RelayErrorCode };
  getLeaseCheckpoint(auth: RelayLeaseCheckpointAuth): Promise<RelayLeaseCheckpointReadResult>;
  putLeaseCheckpoint(input: RelayLeaseCheckpointPutInput): Promise<RelayLeaseCheckpointWriteResult>;
  sweep(): Promise<void>;
}

export function createRelayAccountRoom(options: RelayAccountRoomOptions): RelayAccountRoom {
  return new AccountRoom(options);
}

class AccountRoom implements RelayAccountRoom {
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly accountId: AccountId;
  private readonly relayOrigin: string;
  private readonly storage: RelayAccountStorage;
  private record: RelayAccountRecord | null = null;
  private loaded: Promise<void> | null = null;
  private lastUsageSave = 0;
  private usageDirty = false;
  private readonly controls = new Map<DeviceId, ControlConn>();
  private readonly unauthenticated = new Set<ControlConn>();
  private readonly lastSeenAt = new Map<DeviceId, number>();
  private readonly leases = new Map<MeshLeaseName, LeaseState>();
  private readonly dials = new Map<string, DialRecord>();

  constructor(options: RelayAccountRoomOptions) {
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? newRelayToken;
    this.accountId = options.accountId;
    this.relayOrigin = options.relayOrigin;
    this.storage = options.storage;
  }

  async register(login: AccountLogin, request: RelayRegisterRequest): Promise<RelayRegisterResponse | { error: RelayErrorCode }> {
    await this.ensureLoaded();
    let fingerprint: DeviceFingerprint;
    try {
      fingerprint = await fingerprintOfPem(request.device.certPem);
    } catch {
      return { error: "unauthorized" };
    }
    if (!(await verifyCertPublicKey(request.device.certPem, request.device.publicKey))) return { error: "unauthorized" };
    const message = relayRegisterMessage({ relayOrigin: this.relayOrigin, provider: request.provider, device: request.device.id, fingerprint });
    if (!(await verifyDeviceSignature(request.device.publicKey, message, request.signature))) return { error: "unauthorized" };
    const current: RelayAccountRecord = this.record ?? { accountId: this.accountId, login, devices: [], priority: [], removed: [], revocations: [], leaseEpochs: {}, usage: { day: "", bytes: 0 } };
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
      addedAt: existing !== undefined && sameCert ? existing.addedAt : this.now(),
    };
    current.login = login;
    current.devices = existing === undefined ? [...current.devices, device] : current.devices.map((d) => (d.id === device.id ? device : d));
    current.removed = current.removed.filter((id) => id !== device.id);
    if (state === "active" && current.revocations !== undefined) {
      current.revocations = current.revocations.filter((r) => r.statement.fingerprint !== fingerprint);
    }
    if (state === "active" && !current.priority.includes(device.id)) current.priority.push(device.id);
    if (state === "pending") current.priority = current.priority.filter((id) => id !== device.id);
    this.record = current;
    await this.save();
    const conn = this.controls.get(device.id);
    if (conn !== undefined && !sameCert) {
      this.closeConn(conn, WS_CLOSE_REPLACED, "replaced");
      this.detach(conn);
    }
    this.broadcastDevices();
    this.broadcastPresence();
    return { accountId: this.accountId, login: login.login, state };
  }

  openControl(socket: RelaySocket, restored?: RelayControlAttachment): RelayControlHandle {
    const conn: ControlConn = {
      socket,
      device: null,
      session: null,
      nonce: restored?.nonce ?? this.randomToken(),
      openedAt: restored?.openedAt ?? this.now(),
      candidates: restored?.candidates ?? [],
      lastClaimAt: { ...(restored?.lastClaimAt ?? {}) },
      frameTimes: [],
      closed: false,
      queue: Promise.resolve(),
    };
    if (restored?.device != null && restored.session !== null) {
      conn.device = restored.device;
      conn.session = restored.session;
      this.controls.set(restored.device, conn);
      for (const held of restored.held) {
        const lease = this.leases.get(held.name);
        if (lease === undefined || lease.epoch <= held.epoch) {
          this.leases.set(held.name, { holder: restored.device, epoch: held.epoch, renewedAt: held.renewedAt, yielding: false });
        }
      }
    } else if (this.unauthenticated.size >= RELAY_MAX_UNAUTH_CONTROLS_PER_ACCOUNT) {
      this.fail(conn, "rate_limited");
    } else {
      this.unauthenticated.add(conn);
      if (restored === undefined) this.send(conn, { type: "challenge", nonce: conn.nonce });
    }
    return {
      receive: (text) => this.enqueue(conn, () => this.receiveControl(conn, text)),
      closed: () => {
        conn.closed = true;
        this.unauthenticated.delete(conn);
        return this.enqueue(conn, () => this.controlClosed(conn));
      },
      attachment: () => this.attachmentOf(conn),
    };
  }

  openChannel(query: { channel: string; device: DeviceId; session: string }, socket: RelaySocket): RelayChannelHandle | { error: RelayErrorCode } {
    const dial = this.dials.get(query.channel);
    const conn = this.controls.get(query.device);
    if (dial === undefined || conn === undefined || conn.session !== query.session) return { error: "unauthorized" };
    const side = query.device === dial.from ? "dialer" : query.device === dial.to ? "acceptor" : null;
    if (side === null || dial[side] !== undefined) return { error: "unauthorized" };
    if (this.overQuota()) return { error: "quota_exceeded" };
    const end: ChannelEnd = { socket, closed: false };
    dial[side] = end;
    const otherOf = () => (side === "dialer" ? dial.acceptor : dial.dialer);
    if (isPaired(dial)) {
      dial.lastDataAt = this.now();
      for (const chunk of dial.pending.splice(0)) socket.send(chunk);
      dial.pendingBytes = 0;
      this.sendTo(dial.from, { type: "dial.connected", to: dial.to, channel: query.channel });
    }
    return {
      receive: (data) => {
        if (end.closed || this.dials.get(query.channel) !== dial) return;
        if (data.length > RELAY_MAX_DATA_FRAME_BYTES) return this.closeDial(query.channel);
        this.rollUsage();
        if (this.record !== null) {
          this.record.usage.bytes += data.length;
          this.usageDirty = true;
        }
        dial.lastDataAt = this.now();
        const other = otherOf();
        if (other !== undefined && !other.closed) {
          other.socket.send(data);
          return;
        }
        dial.pendingBytes += data.length;
        if (dial.pendingBytes > RELAY_CHANNEL_PENDING_BYTES) return this.closeDial(query.channel);
        dial.pending.push(data);
      },
      closed: () => {
        end.closed = true;
        if (this.dials.get(query.channel) === dial) this.closeDial(query.channel);
        if (this.usageDirty) void this.save();
      },
    };
  }

  async getLeaseCheckpoint(auth: RelayLeaseCheckpointAuth): Promise<RelayLeaseCheckpointReadResult> {
    await this.ensureLoaded();
    return readLeaseCheckpoint(this.checkpointContext(), auth);
  }

  async putLeaseCheckpoint(input: RelayLeaseCheckpointPutInput): Promise<RelayLeaseCheckpointWriteResult> {
    await this.ensureLoaded();
    return writeLeaseCheckpoint(this.checkpointContext(), input);
  }

  private checkpointContext(): RelayLeaseCheckpointContext {
    return {
      sessionOf: (id) => this.controls.get(id)?.session ?? null,
      isActive: (id) => this.isActive(id),
      currentHolder: (name) => {
        const lease = this.leases.get(name);
        return lease?.holder != null && this.now() - lease.renewedAt <= MESH_LEASE_TTL_MS ? { holder: lease.holder, epoch: lease.epoch } : null;
      },
      latestEpoch: (name) => this.record?.leaseEpochs[name] ?? 0,
      storedCheckpoint: (name) => this.record?.leaseCheckpoints?.[name] ?? null,
      storeCheckpoint: async (name, value) => {
        if (this.record === null) throw new Error("Missing relay account");
        (this.record.leaseCheckpoints ??= {})[name] = value;
        await this.save();
      },
      now: this.now,
    };
  }

  async sweep(): Promise<void> {
    await this.ensureLoaded();
    const t = this.now();
    for (const conn of [...this.unauthenticated]) {
      if (t - conn.openedAt > RELAY_HELLO_TIMEOUT_MS) this.fail(conn, "unauthorized");
    }
    for (const [channel, dial] of this.dials) {
      const expired = isPaired(dial) ? t - dial.lastDataAt > RELAY_CHANNEL_IDLE_MS : t - dial.createdAt > RELAY_CHANNEL_ACCEPT_TIMEOUT_MS;
      if (expired) this.closeDial(channel);
    }
    if (this.record !== null) {
      for (const device of this.record.devices) {
        if (device.state === "pending" && t - device.addedAt > RELAY_PENDING_DEVICE_TTL_MS) await this.removeDevice(device.id);
      }
    }
    await this.arbitrateAll();
    if (this.usageDirty && t - this.lastUsageSave >= RELAY_USAGE_SAVE_MS) await this.save();
  }

  private ensureLoaded(): Promise<void> {
    return (this.loaded ??= this.storage.load().then((stored) => void (this.record = stored === null ? null : normalizeRecord(stored))));
  }

  private async save(): Promise<void> {
    if (this.record === null) return;
    this.usageDirty = false;
    this.lastUsageSave = this.now();
    await this.storage.save(this.record);
  }

  private deviceOf(id: DeviceId): RelayDeviceRecord | undefined {
    return this.record?.devices.find((d) => d.id === id);
  }

  private isActive(id: DeviceId): boolean {
    return this.deviceOf(id)?.state === "active";
  }

  private send(conn: ControlConn, frame: RelayServerFrame): void {
    if (!conn.closed) conn.socket.send(encodeRelayFrame(frame));
  }

  private sendTo(id: DeviceId, frame: RelayServerFrame): void {
    const conn = this.controls.get(id);
    if (conn !== undefined) this.send(conn, frame);
  }

  private closeConn(conn: ControlConn, code: number, reason: string): void {
    this.unauthenticated.delete(conn);
    if (conn.closed) return;
    conn.closed = true;
    conn.socket.close(code, reason);
  }

  private fail(conn: ControlConn, code: RelayErrorCode): void {
    this.send(conn, { type: "error", code });
    this.closeConn(conn, WS_CLOSE_POLICY, code);
    this.detach(conn);
  }

  private deviceViews(): RelayDeviceView[] {
    return (this.record?.devices ?? []).map((d) => ({ id: d.id, name: d.name, platform: d.platform, fingerprint: d.fingerprint, state: d.state, addedAt: d.addedAt }));
  }

  private sendRevocations(conn: ControlConn, list: readonly RelayRevocationEnvelope[]): void {
    for (let i = 0; i < list.length; i += RELAY_REVOCATIONS_PAGE_SIZE) {
      this.send(conn, { type: "revocations", revocations: list.slice(i, i + RELAY_REVOCATIONS_PAGE_SIZE) });
    }
  }

  private presenceFor(viewer: DeviceId): RelayPresenceView[] {
    return (this.record?.devices ?? []).map((d) => {
      const conn = this.controls.get(d.id);
      const shareCandidates = d.state === "active" && this.isActive(viewer) && conn !== undefined;
      return { id: d.id, online: conn !== undefined, candidates: shareCandidates ? conn.candidates : [], lastSeenAt: this.lastSeenAt.get(d.id) ?? null };
    });
  }

  private broadcastDevices(): void {
    const devices = this.deviceViews();
    for (const conn of this.controls.values()) this.send(conn, { type: "devices", devices, priority: this.record?.priority ?? [] });
  }

  private broadcastPresence(): void {
    for (const [id, conn] of this.controls) this.send(conn, { type: "presence", presence: this.presenceFor(id) });
  }

  private leaseFrame(name: MeshLeaseName): RelayServerFrame {
    const lease = this.leases.get(name);
    return { type: "lease", name, grant: lease?.holder ? { name, holder: lease.holder, epoch: lease.epoch, ttlMs: MESH_LEASE_TTL_MS } : null };
  }

  private broadcastLease(name: MeshLeaseName): void {
    const frame = this.leaseFrame(name);
    for (const [id, conn] of this.controls) if (this.isActive(id)) this.send(conn, frame);
  }

  private releaseLeasesOf(id: DeviceId): void {
    for (const name of MESH_LEASE_NAMES) {
      const lease = this.leases.get(name);
      if (lease?.holder === id) {
        lease.holder = null;
        lease.yielding = false;
        this.broadcastLease(name);
      }
    }
  }

  private async arbitrate(name: MeshLeaseName): Promise<void> {
    const t = this.now();
    const record = this.record;
    const lease = this.leases.get(name) ?? { holder: null, epoch: record?.leaseEpochs[name] ?? 0, renewedAt: 0, yielding: false };
    this.leases.set(name, lease);
    const priority = record?.priority ?? [];
    if (lease.holder !== null && (t - lease.renewedAt > MESH_LEASE_TTL_MS || !this.isActive(lease.holder) || !this.controls.has(lease.holder))) {
      lease.holder = null;
      lease.yielding = false;
      this.broadcastLease(name);
    }
    const candidates = new Set<DeviceId>();
    for (const [id, conn] of this.controls) {
      const claimed = conn.lastClaimAt[name];
      if (this.isActive(id) && claimed !== undefined && t - claimed <= MESH_LEASE_TTL_MS) candidates.add(id);
    }
    const best = pickCenter(priority, candidates);
    if (lease.holder === null) {
      if (best === null || this.record === null) return;
      lease.epoch = Math.max(lease.epoch, this.record.leaseEpochs[name] ?? 0) + 1;
      lease.holder = best;
      lease.renewedAt = t;
      lease.yielding = false;
      this.record.leaseEpochs[name] = lease.epoch;
      await this.save();
      this.broadcastLease(name);
      return;
    }
    const holderRank = priority.indexOf(lease.holder);
    const outranked = best !== null && best !== lease.holder && (holderRank === -1 || priority.indexOf(best) < holderRank);
    if ((outranked || holderRank === -1) && !lease.yielding) {
      lease.yielding = true;
      this.sendTo(lease.holder, { type: "lease.yield", name, epoch: lease.epoch });
    }
  }

  private async arbitrateAll(): Promise<void> {
    for (const name of MESH_LEASE_NAMES) await this.arbitrate(name);
  }

  private channelsOf(id: DeviceId): number {
    let count = 0;
    for (const dial of this.dials.values()) {
      if (dial.from === id) count++;
      if (dial.to === id) count++;
    }
    return count;
  }

  private rollUsage(): void {
    if (this.record === null) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.record.usage.day !== day) {
      this.record.usage = { day, bytes: 0 };
      this.usageDirty = true;
    }
  }

  private overQuota(): boolean {
    this.rollUsage();
    return (this.record?.usage.bytes ?? 0) >= RELAY_ACCOUNT_DAILY_BYTES;
  }

  private closeDial(channel: string): void {
    const dial = this.dials.get(channel);
    if (dial === undefined) return;
    this.dials.delete(channel);
    // The dialer learns of a pairing only through dial.connected, so without this it waits out its whole dial budget.
    if (!isPaired(dial)) this.sendTo(dial.from, { type: "dial.failed", to: dial.to, channel, code: "offline" });
    for (const end of [dial.dialer, dial.acceptor]) {
      if (end !== undefined && !end.closed) {
        end.closed = true;
        end.socket.close(1000, "closed");
      }
    }
  }

  private closeDialsOf(id: DeviceId): void {
    for (const [channel, dial] of this.dials) if (dial.from === id || dial.to === id) this.closeDial(channel);
  }

  private detach(conn: ControlConn): boolean {
    this.unauthenticated.delete(conn);
    if (conn.device === null || this.controls.get(conn.device) !== conn) return false;
    this.controls.delete(conn.device);
    this.lastSeenAt.set(conn.device, this.now());
    return true;
  }

  private async removeDevice(id: DeviceId, revocation?: RelayRevocationEnvelope): Promise<void> {
    const record = this.record;
    if (record === null) return;
    record.devices = record.devices.filter((d) => d.id !== id);
    record.priority = record.priority.filter((p) => p !== id);
    record.removed = [...record.removed.filter((r) => r !== id), id].slice(-RELAY_REMOVED_DEVICES_MAX);
    if (revocation !== undefined) {
      const prev = record.revocations ?? [];
      record.revocations = [...prev.filter((r) => r.statement.fingerprint !== revocation.statement.fingerprint), revocation].slice(-MESH_TRUST_TOMBSTONES_MAX);
    }
    this.lastSeenAt.delete(id);
    await this.save();
    const conn = this.controls.get(id);
    if (conn !== undefined) {
      this.send(conn, { type: "removed" });
      this.closeConn(conn, 1000, "removed");
      this.detach(conn);
    }
    this.closeDialsOf(id);
    this.releaseLeasesOf(id);
    this.broadcastDevices();
    if (revocation !== undefined) {
      for (const other of this.controls.values()) this.sendRevocations(other, [revocation]);
    }
    this.broadcastPresence();
    await this.arbitrateAll();
  }

  private welcome(conn: ControlConn, device: RelayDeviceRecord): void {
    this.unauthenticated.delete(conn);
    const previous = this.controls.get(device.id);
    if (previous !== undefined && previous !== conn) {
      this.closeConn(previous, WS_CLOSE_REPLACED, "replaced");
      this.controls.delete(device.id);
    }
    conn.device = device.id;
    conn.session = this.randomToken();
    this.controls.set(device.id, conn);
    this.send(conn, {
      type: "welcome",
      accountId: this.accountId,
      self: device.state,
      session: conn.session,
      devices: this.deviceViews(),
      priority: this.record?.priority ?? [],
      presence: this.presenceFor(device.id),
    });
    if (this.record?.revocations !== undefined && this.record.revocations.length > 0) this.sendRevocations(conn, this.record.revocations);
    if (device.state === "active") for (const name of MESH_LEASE_NAMES) this.send(conn, this.leaseFrame(name));
    this.broadcastPresence();
  }

  private enqueue(conn: ControlConn, run: () => Promise<void>): Promise<void> {
    conn.queue = conn.queue.then(run, run);
    return conn.queue;
  }

  private allowFrame(conn: ControlConn): boolean {
    const t = this.now();
    conn.frameTimes = conn.frameTimes.filter((at) => t - at < 1_000);
    conn.frameTimes.push(t);
    return conn.frameTimes.length <= RELAY_CONTROL_FRAMES_PER_SECOND;
  }

  private async receiveControl(conn: ControlConn, text: string): Promise<void> {
    if (conn.closed) return;
    if (!this.allowFrame(conn)) return this.fail(conn, "rate_limited");
    if (conn.device === null && this.now() - conn.openedAt > RELAY_HELLO_TIMEOUT_MS) return this.fail(conn, "unauthorized");
    let frame = parseRelayClientFrame(text);
    if (frame === null && conn.device !== null) frame = parseLenientPresenceFrame(text);
    if (frame === null) return this.fail(conn, "bad_frame");
    await this.ensureLoaded();
    if (conn.device === null) {
      if (frame.type !== "hello") return this.fail(conn, "unauthorized");
      return this.handleHello(conn, frame);
    }
    if (this.controls.get(conn.device) !== conn) return this.fail(conn, "unauthorized");
    return this.handleFrame(conn, conn.device, frame);
  }

  private async controlClosed(conn: ControlConn): Promise<void> {
    await this.ensureLoaded();
    const was = conn.device;
    if (!this.detach(conn) || was === null) return;
    this.broadcastPresence();
    this.releaseLeasesOf(was);
    await this.arbitrateAll();
  }

  private attachmentOf(conn: ControlConn): RelayControlAttachment {
    const held: RelayControlAttachment["held"] = [];
    for (const [name, lease] of this.leases) {
      if (conn.device !== null && lease.holder === conn.device) held.push({ name, epoch: lease.epoch, renewedAt: lease.renewedAt });
    }
    return { device: conn.device, session: conn.session, nonce: conn.nonce, openedAt: conn.openedAt, candidates: conn.candidates, lastClaimAt: { ...conn.lastClaimAt }, held };
  }

  private async handleHello(conn: ControlConn, frame: Extract<RelayClientFrame, { type: "hello" }>): Promise<void> {
    await this.ensureLoaded();
    if (frame.version !== RELAY_PROTOCOL_VERSION) return this.fail(conn, "bad_frame");
    if (this.record?.removed.includes(frame.device)) {
      this.send(conn, { type: "removed" });
      return this.closeConn(conn, 1000, "removed");
    }
    const device = this.deviceOf(frame.device);
    if (device === undefined) return this.fail(conn, "unknown_device");
    const message = relayControlMessage({ relayOrigin: this.relayOrigin, accountId: this.accountId, device: device.id, nonce: conn.nonce });
    if (!(await verifyDeviceSignature(device.publicKey, message, frame.signature))) return this.fail(conn, "unauthorized");
    if (conn.closed) return;
    this.welcome(conn, device);
  }

  private async handleFrame(conn: ControlConn, self: DeviceId, frame: RelayClientFrame): Promise<void> {
    const selfRecord = this.deviceOf(self);
    if (selfRecord === undefined) return this.fail(conn, "removed");
    const selfActive = selfRecord.state === "active";
    switch (frame.type) {
      case "hello":
        return this.fail(conn, "bad_frame");
      case "presence": {
        conn.candidates = frame.candidates;
        if (selfActive) this.broadcastPresence();
        return;
      }
      case "lease.claim":
      case "lease.release":
        return this.handleLeaseFrame(conn, self, selfActive, frame);
      case "dial":
        return this.handleDial(conn, self, selfActive, frame);
      case "signal": {
        const target = this.deviceOf(frame.to);
        if (target === undefined || frame.to === self) return;
        if (!selfActive && target.state !== "active") return;
        this.sendTo(frame.to, { type: "signal", from: self, payload: frame.payload });
        return;
      }
      case "device.activate":
      case "device.remove":
      case "priority.set":
        if (!selfActive) return this.fail(conn, "not_active");
        return this.handleDeviceFrame(self, frame);
    }
  }

  private async handleLeaseFrame(
    conn: ControlConn,
    self: DeviceId,
    selfActive: boolean,
    frame: Extract<RelayClientFrame, { type: "lease.claim" | "lease.release" }>,
  ): Promise<void> {
    if (frame.type === "lease.claim") {
      if (!selfActive) return;
      conn.lastClaimAt[frame.name] = this.now();
      const lease = this.leases.get(frame.name);
      if (lease?.holder === self && !lease.yielding && this.now() - lease.renewedAt <= MESH_LEASE_TTL_MS) {
        lease.renewedAt = this.now();
        this.send(conn, this.leaseFrame(frame.name));
        return;
      }
      return this.arbitrate(frame.name);
    }
    const lease = this.leases.get(frame.name);
    if (lease?.holder !== self || lease.epoch !== frame.epoch) return;
    lease.holder = null;
    lease.yielding = false;
    delete conn.lastClaimAt[frame.name];
    this.broadcastLease(frame.name);
    return this.arbitrate(frame.name);
  }

  private handleDial(conn: ControlConn, self: DeviceId, selfActive: boolean, frame: Extract<RelayClientFrame, { type: "dial" }>): void {
    const failDial = (code: RelayErrorCode) => this.send(conn, { type: "dial.failed", to: frame.to, channel: frame.channel, code });
    if (!selfActive) return failDial("not_active");
    const target = this.deviceOf(frame.to);
    if (target === undefined || frame.to === self) return failDial("unknown_device");
    if (target.state !== "active") return failDial("not_active");
    const targetConn = this.controls.get(frame.to);
    if (targetConn === undefined) return failDial("offline");
    if (this.dials.has(frame.channel)) return failDial("bad_frame");
    if (this.channelsOf(self) >= RELAY_MAX_CHANNELS_PER_DEVICE || this.channelsOf(frame.to) >= RELAY_MAX_CHANNELS_PER_DEVICE) return failDial("rate_limited");
    if (this.overQuota()) return failDial("quota_exceeded");
    this.dials.set(frame.channel, { from: self, to: frame.to, createdAt: this.now(), lastDataAt: this.now(), pending: [], pendingBytes: 0 });
    this.send(targetConn, { type: "incoming", from: self, channel: frame.channel });
  }

  private async handleDeviceFrame(self: DeviceId, frame: Extract<RelayClientFrame, { type: "device.activate" | "device.remove" | "priority.set" }>): Promise<void> {
    const record = this.record;
    if (frame.type === "priority.set") {
      if (record === null) return;
      record.priority = frame.priority.filter((id) => this.isActive(id));
      await this.save();
      this.broadcastDevices();
      return this.arbitrateAll();
    }
    const target = this.deviceOf(frame.id);
    if (frame.type === "device.remove") {
      if (target === undefined) return;
      const validRevocation =
        frame.revocation !== undefined &&
        frame.revocation.statement.device === target.id &&
        frame.revocation.statement.fingerprint === target.fingerprint &&
        frame.revocation.statement.by === self
          ? frame.revocation
          : undefined;
      return this.removeDevice(frame.id, validRevocation);
    }
    if (target === undefined || target.state === "active") return;
    target.state = "active";
    if (record !== null && !record.priority.includes(target.id) && record.priority.length < MESH_MAX_DEVICES_PER_ACCOUNT) record.priority.push(target.id);
    if (record?.revocations !== undefined) {
      record.revocations = record.revocations.filter((r) => r.statement.fingerprint !== target.fingerprint);
    }
    await this.save();
    this.broadcastDevices();
    this.broadcastPresence();
    const targetConn = this.controls.get(target.id);
    if (targetConn !== undefined) for (const name of MESH_LEASE_NAMES) this.send(targetConn, this.leaseFrame(name));
  }
}

interface ControlConn {
  socket: RelaySocket;
  device: DeviceId | null;
  session: string | null;
  nonce: string;
  openedAt: number;
  candidates: MeshCandidate[];
  lastClaimAt: Partial<Record<MeshLeaseName, number>>;
  frameTimes: number[];
  closed: boolean;
  queue: Promise<void>;
}

interface LeaseState {
  holder: DeviceId | null;
  epoch: number;
  renewedAt: number;
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
  pending: Uint8Array[];
  pendingBytes: number;
}

const isPaired = (dial: DialRecord) => dial.dialer !== undefined && dial.acceptor !== undefined;

const WS_CLOSE_POLICY = 1008;
const WS_CLOSE_REPLACED = 4000;

function normalizeRecord(stored: RelayAccountRecord): RelayAccountRecord {
  return {
    ...stored,
    removed: stored.removed ?? [],
    revocations: (stored.revocations ?? []).slice(-MESH_TRUST_TOMBSTONES_MAX),
    leaseEpochs: stored.leaseEpochs ?? {},
    usage: stored.usage ?? { day: "", bytes: 0 },
  };
}
