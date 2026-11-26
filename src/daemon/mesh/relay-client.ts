// One control connection with backoff reconnect; data channels hand raw bytes to dialer.ts, which owns TLS.
import { Duplex } from "node:stream";
import { WebSocket } from "ws";
import type { DeviceId } from "../../shared/api.ts";
import {
  MESH_DIAL_TIMEOUT_MS,
  MESH_RELAY_BACKOFF_MAX_MS,
  MESH_RELAY_BACKOFF_MIN_MS,
  MESH_RELAY_PING_MS,
  MESH_RELAY_STABLE_MS,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_MAX_SERVER_FRAME_BYTES,
} from "../../shared/limits.ts";
import { parseAccountId, type AccountId, type MeshCandidate, type MeshDeviceState, type MeshLeaseGrant, type MeshLeaseName, type RelayConnectionState } from "../../shared/mesh.ts";
import {
  RELAY_PATHS,
  RELAY_PROTOCOL_VERSION,
  encodeRelayFrame,
  newRelayToken,
  parseRelayServerFrame,
  relayControlMessage,
  relayRegisterMessage,
  type RelayClientFrame,
  type RelayDeviceView,
  type RelayErrorCode,
  type RelayPresenceView,
  type RelayRegisterRequest,
  type RelayRegisterResponse,
  type RelayRevocationEnvelope,
} from "../../relay/protocol.ts";
import type { MeshIdentity } from "./identity.ts";
import { createRelayCheckpoints, type RelayCheckpoints } from "./relay-checkpoint.ts";

export async function registerWithRelay(input: {
  relayUrl: string;
  githubToken: string;
  identity: MeshIdentity;
  device: { id: DeviceId; name: string; platform: string };
  fetch?: typeof fetch;
}): Promise<RelayRegisterResponse> {
  const relayOrigin = new URL(input.relayUrl).origin;
  const body: RelayRegisterRequest = {
    provider: "github",
    token: input.githubToken,
    device: { ...input.device, certPem: input.identity.certPem, publicKey: input.identity.publicKey },
    signature: input.identity.sign(relayRegisterMessage({ relayOrigin, provider: "github", device: input.device.id, fingerprint: input.identity.fingerprint })),
  };
  let res: Response;
  try {
    res = await (input.fetch ?? fetch)(new URL(RELAY_PATHS.register, relayOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("连不上中继，请检查网络或中继网址");
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.status === 200) {
    const ok = parsed as Partial<RelayRegisterResponse> | null;
    const accountId = parseAccountId(ok?.accountId);
    if (accountId !== null && (ok?.state === "active" || ok?.state === "pending") && typeof ok.login === "string") {
      return { accountId, login: ok.login, state: ok.state };
    }
    throw new Error("中继回的登记结果不对");
  }
  const code = (parsed as { error?: unknown } | null)?.error;
  throw new Error(REGISTER_ERRORS[typeof code === "string" ? code : ""] ?? `中继拒绝了登记（HTTP ${res.status}）`);
}

const REGISTER_ERRORS: Record<string, string> = {
  unauthorized: "中继没认这次 GitHub 登录，请重新登录",
  too_many_devices: "这个账号的设备已经满了，先在别的设备上移除一台",
  rate_limited: "登记太频繁，请一分钟后再试",
  github_unreachable: "中继连不上 GitHub，请稍后再试",
  bad_frame: "这台的版本和中继不匹配，请升级",
};

export interface RelayClientEvents {
  devices: (devices: RelayDeviceView[], priority: DeviceId[]) => void;
  revocations: (revocations: RelayRevocationEnvelope[]) => void;
  presence: (presence: RelayPresenceView[]) => void;
  self: (state: MeshDeviceState) => void;
  lease: (name: MeshLeaseName, grant: MeshLeaseGrant | null) => void;
  leaseYield: (name: MeshLeaseName, epoch: number) => void;
  signal: (from: DeviceId, payload: string) => void;
  incoming: (from: DeviceId, channel: string) => void;
  removed: () => void;
  state: (state: RelayConnectionState) => void;
}

export interface RelayClientOptions {
  relayUrl: string;
  accountId: AccountId;
  identity: MeshIdentity;
  candidates: () => MeshCandidate[];
  now?: () => number;
  log: (line: string) => void;
}

export interface RelayClient {
  state(): RelayConnectionState;
  checkpoints?: RelayCheckpoints;
  start(): void;
  send(frame: RelayClientFrame): boolean;
  refreshCandidates(): void;
  openChannel(to: DeviceId): Promise<Duplex>;
  acceptChannel(from: DeviceId, channel: string): Promise<Duplex>;
  on<K extends keyof RelayClientEvents>(event: K, listener: RelayClientEvents[K]): () => void;
  close(): Promise<void>;
}

export class RelayDialError extends Error {
  readonly code: RelayErrorCode | "timeout";
  constructor(code: RelayErrorCode | "timeout", message: string) {
    super(message);
    this.code = code;
  }
}

const wsOrigin = (relayUrl: string) => new URL(relayUrl).origin.replace(/^http/, "ws");

/** Frames align to whole TLS records so a record is never split across frames. */
function splitRelayFrames(chunk: Buffer, maxBytes: number): Buffer[] {
  if (chunk.length <= maxBytes) return [chunk];
  const frames: Buffer[] = [];
  let start = 0;
  while (start < chunk.length) {
    if (chunk.length - start <= maxBytes) {
      frames.push(chunk.subarray(start));
      break;
    }
    let end = start;
    while (end + 5 <= chunk.length) {
      const type = chunk[end]!;
      const major = chunk[end + 1]!;
      const recLen = 5 + chunk.readUInt16BE(end + 3);
      if (type < 0x14 || type > 0x17 || major !== 0x03 || recLen > maxBytes || end + recLen - start > maxBytes) break;
      end += recLen;
    }
    if (end === start) end = Math.min(start + maxBytes, chunk.length);
    frames.push(chunk.subarray(start, end));
    start = end;
  }
  return frames;
}

/** OpenSSL's ring buffer can split one TLS record across writes, so halves are joined before framing. */
export function relayByteStream(ws: WebSocket): Duplex {
  let tlsMode: boolean | null = null;
  let carry: Buffer = Buffer.alloc(0);

  const sendFrames = (parts: Buffer[], callback: (error?: Error | null) => void) => {
    if (parts.length === 0) return callback();
    let pending = 0;
    let failed = false;
    for (const part of parts) {
      pending++;
      ws.send(part, { binary: true }, (error) => {
        if (failed) return;
        if (error) {
          failed = true;
          return callback(error);
        }
        if (--pending === 0) callback();
      });
    }
  };

  const stream = new Duplex({
    read() {
      if (ws.isPaused) ws.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (ws.readyState !== WebSocket.OPEN) return callback(new Error("中继通道已关闭"));
      if (tlsMode === null) {
        tlsMode = chunk.length >= 3 && chunk[0] === 0x16 && chunk[1] === 0x03 && (chunk[2] === 0x01 || chunk[2] === 0x03);
      }
      if (!tlsMode) {
        sendFrames(splitRelayFrames(chunk, RELAY_MAX_DATA_FRAME_BYTES), callback);
        return;
      }
      const buf = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let offset = 0;
      while (offset + 5 <= buf.length) {
        const type = buf[offset]!;
        const major = buf[offset + 1]!;
        const recLen = 5 + buf.readUInt16BE(offset + 3);
        if (type < 0x14 || type > 0x17 || major !== 0x03 || recLen > RELAY_MAX_DATA_FRAME_BYTES) {
          tlsMode = false;
          carry = Buffer.alloc(0);
          sendFrames(splitRelayFrames(buf.subarray(offset), RELAY_MAX_DATA_FRAME_BYTES), callback);
          return;
        }
        if (offset + recLen > buf.length) break;
        offset += recLen;
      }
      const ready = offset === 0 ? Buffer.alloc(0) : buf.subarray(0, offset);
      carry = offset === buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(offset));
      sendFrames(ready.length === 0 ? [] : splitRelayFrames(ready, RELAY_MAX_DATA_FRAME_BYTES), callback);
    },
    final(callback) {
      const tail = carry;
      carry = Buffer.alloc(0);
      if (tail.length > 0 && ws.readyState === WebSocket.OPEN) {
        sendFrames(splitRelayFrames(tail, RELAY_MAX_DATA_FRAME_BYTES), (err) => {
          ws.close(1000);
          callback(err);
        });
        return;
      }
      ws.close(1000);
      callback();
    },
    destroy(error, callback) {
      carry = Buffer.alloc(0);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
      callback(error);
    },
  });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return stream.destroy(new Error("中继通道收到了文本帧"));
    if (!stream.push(data)) ws.pause();
  });
  ws.once("close", () => {
    stream.push(null);
    stream.end();
  });
  ws.once("error", (error) => stream.destroy(error));
  return stream;
}

function createRelayEvents() {
  const listeners = new Map<keyof RelayClientEvents, Set<(...args: never[]) => void>>();
  const emit = <K extends keyof RelayClientEvents>(event: K, ...args: Parameters<RelayClientEvents[K]>) => {
    for (const listener of listeners.get(event) ?? []) (listener as (...a: Parameters<RelayClientEvents[K]>) => void)(...args);
  };
  return { listeners, emit };
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const now = options.now ?? Date.now;
  const relayOrigin = new URL(options.relayUrl).origin;
  const { listeners, emit } = createRelayEvents();
  let state: RelayConnectionState = "connecting";
  let socket: WebSocket | null = null;
  let session: string | null = null;
  let stopped = false;
  let backoff = MESH_RELAY_BACKOFF_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let stableTimer: NodeJS.Timeout | null = null;
  let lastCandidates = "";
  const dials = new Map<string, { resolve: () => void; reject: (error: RelayDialError) => void }>();
  const channels = new Set<WebSocket>();

  const setState = (next: RelayConnectionState) => {
    if (state === next) return;
    state = next;
    emit("state", next);
  };
  const clearTimers = () => {
    for (const timer of [pingTimer, stableTimer]) if (timer !== null) clearTimeout(timer);
    pingTimer = null;
    stableTimer = null;
  };
  const sendRaw = (frame: RelayClientFrame) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(encodeRelayFrame(frame));
    return true;
  };
  const reportCandidates = (force: boolean) => {
    const candidates = options.candidates();
    const key = JSON.stringify(candidates);
    if (!force && key === lastCandidates) return;
    if (state === "connected" && sendRaw({ type: "presence", candidates })) lastCandidates = key;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MESH_RELAY_BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(wsOrigin(options.relayUrl) + RELAY_PATHS.control(options.accountId), {
      perMessageDeflate: false,
      handshakeTimeout: MESH_DIAL_TIMEOUT_MS,
      maxPayload: RELAY_MAX_SERVER_FRAME_BYTES,
    });
    socket = ws;
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary || socket !== ws) return;
      const frame = parseRelayServerFrame(data.toString("utf8"));
      if (frame === null) {
        options.log("中继：收到不认识的消息，断开重连");
        ws.terminate();
        return;
      }
      switch (frame.type) {
        case "challenge":
          sendRaw({
            type: "hello",
            device: options.identity.deviceId,
            version: RELAY_PROTOCOL_VERSION,
            signature: options.identity.sign(relayControlMessage({ relayOrigin, accountId: options.accountId, device: options.identity.deviceId, nonce: frame.nonce })),
          });
          return;
        case "welcome":
          session = frame.session;
          setState("connected");
          stableTimer = setTimeout(() => {
            backoff = MESH_RELAY_BACKOFF_MIN_MS;
          }, MESH_RELAY_STABLE_MS);
          stableTimer.unref?.();
          pingTimer = setInterval(() => {
            if (!alive) {
              options.log("中继：心跳没回，断开重连");
              ws.terminate();
              return;
            }
            alive = false;
            ws.ping();
          }, MESH_RELAY_PING_MS);
          pingTimer.unref?.();
          emit("self", frame.self);
          emit("devices", frame.devices, frame.priority);
          emit("presence", frame.presence);
          reportCandidates(true);
          return;
        case "devices": {
          emit("devices", frame.devices, frame.priority);
          const self = frame.devices.find((d) => d.id === options.identity.deviceId);
          if (self !== undefined) emit("self", self.state);
          return;
        }
        case "revocations":
          emit("revocations", frame.revocations);
          return;
        case "presence":
          emit("presence", frame.presence);
          return;
        case "lease":
          emit("lease", frame.name, frame.grant);
          return;
        case "lease.yield":
          emit("leaseYield", frame.name, frame.epoch);
          return;
        case "incoming":
          emit("incoming", frame.from, frame.channel);
          return;
        case "dial.connected": {
          const dial = dials.get(frame.channel);
          dials.delete(frame.channel);
          dial?.resolve();
          return;
        }
        case "dial.failed": {
          const dial = dials.get(frame.channel);
          dials.delete(frame.channel);
          dial?.reject(new RelayDialError(frame.code, DIAL_ERRORS[frame.code] ?? "经中继连不上对方"));
          return;
        }
        case "signal":
          emit("signal", frame.from, frame.payload);
          return;
        case "removed":
          stopped = true;
          options.log("中继：本机已被移出账号");
          emit("removed");
          ws.close(1000);
          return;
        case "error":
          options.log(`中继：报错 ${frame.code}`);
          return;
      }
    });
    ws.once("close", () => {
      if (socket !== ws) return;
      socket = null;
      session = null;
      clearTimers();
      for (const [channel, dial] of dials) {
        dials.delete(channel);
        dial.reject(new RelayDialError("offline", "和中继断开了"));
      }
      lastCandidates = "";
      setState("unreachable");
      scheduleReconnect();
    });
    ws.on("error", () => {
    });
  };

  const openChannelSocket = (channel: string): WebSocket => {
    const url = `${wsOrigin(options.relayUrl)}${RELAY_PATHS.channel(options.accountId, channel)}?device=${options.identity.deviceId}&session=${session ?? ""}`;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: MESH_DIAL_TIMEOUT_MS, maxPayload: RELAY_MAX_DATA_FRAME_BYTES });
    channels.add(ws);
    ws.once("close", () => channels.delete(ws));
    return ws;
  };

  const waitOpen = (ws: WebSocket, onFail: () => RelayDialError) =>
    new Promise<Duplex>((resolve, reject) => {
      ws.once("open", () => resolve(relayByteStream(ws)));
      ws.once("unexpected-response", (request) => {
        request.destroy();
        reject(onFail());
      });
      ws.once("error", () => reject(onFail()));
    });

  return {
    state: () => state,
    checkpoints: createRelayCheckpoints(relayOrigin, options.accountId, options.identity.deviceId, () => state === "connected" ? session : null),
    start() {
      if (socket !== null || stopped) return;
      setState("connecting");
      connect();
    },
    send: (frame) => state === "connected" && sendRaw(frame),
    refreshCandidates: () => reportCandidates(false),
    async openChannel(to) {
      if (state !== "connected" || session === null) throw new RelayDialError("offline", "没连上中继");
      const channel = newRelayToken();
      let timer: NodeJS.Timeout | undefined;
      const accepted = new Promise<void>((resolve, reject) => {
        dials.set(channel, { resolve, reject });
        timer = setTimeout(() => reject(new RelayDialError("timeout", "经中继拨号超时")), MESH_DIAL_TIMEOUT_MS);
      });
      sendRaw({ type: "dial", to, channel });
      const ws = openChannelSocket(channel);
      const opened = waitOpen(ws, () => new RelayDialError("offline", "经中继连不上对方"));
      try {
        const [stream] = await Promise.all([opened, accepted]);
        return stream;
      } catch (error) {
        ws.terminate();
        opened.then((stream) => stream.destroy(), () => {});
        throw error;
      } finally {
        clearTimeout(timer);
        dials.delete(channel);
      }
    },
    async acceptChannel(_from, channel) {
      if (state !== "connected" || session === null) throw new RelayDialError("offline", "没连上中继");
      const ws = openChannelSocket(channel);
      return waitOpen(ws, () => new RelayDialError("offline", "中继通道已过期"));
    },
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
    async close() {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearTimers();
      for (const ws of channels) ws.terminate();
      channels.clear();
      const ws = socket;
      socket = null;
      if (ws !== null && ws.readyState !== WebSocket.CLOSED) {
        const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
        ws.close(1000);
        const timer = setTimeout(() => ws.terminate(), 1_000);
        await closed;
        clearTimeout(timer);
      }
    },
  };
}

const DIAL_ERRORS: Partial<Record<RelayErrorCode, string>> = {
  offline: "对方不在线",
  not_active: "对方还没被批准",
  unknown_device: "账号里没有这台设备",
  rate_limited: "经中继的连接太多了",
  quota_exceeded: "今天经中继的流量用完了",
};
