// 已配对的设备（docs/multi-device-design.md 第 3.2 节）：state/peers.json，权限 0600，守护进程自己读写（拿着数据目录锁，只有一个在写）。
// 不进 sqlite：令牌只给这一个模块用，不跟账本的迁移编号抢号；文件小，每次改动整份重写（先写临时文件再改名，写到一半断电不会坏）。
//
// 数据结构：
// - 设备表 devices：一行一台已配对（或待确认）的设备 —— 谁（id、name、platform）、在哪（url），加上两把令牌：
//   - inboundTokenSha256：对方来访时出示的令牌的 sha256。明文只在对方那里，本机只存哈希；
//   - outboundToken：本机去访问对方时出示的令牌（明文，对方那边只存它的哈希）。
// - removed：移除过的设备编号（墓碑）。设备清单同步、介绍不会把它们配回来；用户手动再添加时清掉。
//
// 配对状态机（一行设备的 state）：
//   （没有）──应邀 POST /api/peer/pair──▶ pending ──对方第一次带令牌来访──▶ paired
//   （没有）──本机发起配对，对方回了令牌──────────────────────────────▶ paired
//   pending ──PEER_PENDING_TTL_MS 内没等到对方──▶ （删掉）
//   paired / pending ──本机移除、对方通知移除（/api/peer/unpair）、对方拒了本机的令牌──▶ （删掉，记墓碑）
// pending 的意思是“对方可能还没存下本机”：这时只收它的请求，不主动找它（不同步、不转发、不在设备列表里）。
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MAX_REMOVED_PEERS,
  isDeviceId,
  isRemotePeerTransportKind,
  normalizeName,
  type DeviceId,
  type PeerDevice,
  type RemotePeerTransportKind,
} from "../../shared/index.ts";
import { PEER_TOKEN_PATTERN } from "./tokens.ts";

export type PeerState = "pending" | "paired";

export interface PeerRecord extends PeerDevice {
  /** 连法：不写默认 tailscale；ssh-tunnel 的设备 url 存 ""，转发地址永远从本机隧道表取。 */
  transport?: RemotePeerTransportKind;
  state: PeerState;
  /** 进入当前状态的时间（毫秒）：pending 按它过期。 */
  since: number;
  inboundTokenSha256: string;
  outboundToken: string;
}

interface PeersFile {
  version: 1;
  devices: PeerRecord[];
  removed: Array<{ id: DeviceId; at: number }>;
}

const PEERS_FILE_MODE = 0o600;
const PLATFORM_PATTERN = /^[a-z0-9]{1,32}$/;

export const isPlatform = (value: unknown): value is string => typeof value === "string" && PLATFORM_PATTERN.test(value);

function isRecord(value: unknown): value is PeerRecord {
  const r = value as Partial<Record<keyof PeerRecord, unknown>> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.id === "string" &&
    isDeviceId(r.id) &&
    typeof r.name === "string" &&
    normalizeName(r.name) !== null &&
    isPlatform(r.platform) &&
    typeof r.url === "string" &&
    (r.transport === undefined || isRemotePeerTransportKind(r.transport)) &&
    (r.state === "pending" || r.state === "paired") &&
    typeof r.since === "number" &&
    typeof r.inboundTokenSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(r.inboundTokenSha256) &&
    typeof r.outboundToken === "string" &&
    PEER_TOKEN_PATTERN.test(r.outboundToken)
  );
}

export interface PeerStore {
  list(): PeerRecord[];
  get(id: DeviceId): PeerRecord | undefined;
  /** 新增或整行替换。 */
  put(record: PeerRecord): void;
  update(id: DeviceId, patch: Partial<Omit<PeerRecord, "id">>): PeerRecord | undefined;
  /** 删掉并记墓碑（tombstone=false 只删不记，pending 过期用）。返回原来有没有。 */
  remove(id: DeviceId, opts?: { tombstone?: boolean }): boolean;
  isRemoved(id: DeviceId): boolean;
  clearRemoved(id: DeviceId): void;
}

/** 读 state/peers.json（没有就是空的）。内容不对抛错，说清楚是哪个文件。 */
export function openPeerStore(file: string, now: () => number = Date.now): PeerStore {
  let data: PeersFile = { version: 1, devices: [], removed: [] };
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== null) {
    let parsed: Partial<PeersFile> | null = null;
    try {
      parsed = JSON.parse(raw) as Partial<PeersFile>;
    } catch {
      parsed = null;
    }
    const removed = parsed?.removed;
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.devices) ||
      !parsed.devices.every(isRecord) ||
      !Array.isArray(removed) ||
      !removed.every((r) => typeof r?.id === "string" && isDeviceId(r.id) && typeof r.at === "number")
    ) {
      throw new Error(`已配对设备的文件 ${file}（peers.json）内容不对。请修好它，或者删掉后在网页“设置 → 设备”里重新配对。`);
    }
    data = { version: 1, devices: parsed.devices, removed };
  }

  const save = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: PEERS_FILE_MODE });
    if ((statSync(tmp).mode & 0o777) !== PEERS_FILE_MODE) chmodSync(tmp, PEERS_FILE_MODE);
    renameSync(tmp, file);
  };

  const index = (id: DeviceId) => data.devices.findIndex((d) => d.id === id);

  return {
    list: () => data.devices.map((d) => ({ ...d })),
    get(id) {
      const found = data.devices[index(id)];
      return found === undefined ? undefined : { ...found };
    },
    put(record) {
      const i = index(record.id);
      if (i === -1) data.devices.push({ ...record });
      else data.devices[i] = { ...record };
      save();
    },
    update(id, patch) {
      const i = index(id);
      if (i === -1) return undefined;
      const next = { ...data.devices[i]!, ...patch, id };
      data.devices[i] = next;
      save();
      return { ...next };
    },
    remove(id, opts = {}) {
      const i = index(id);
      if (i !== -1) data.devices.splice(i, 1);
      if (opts.tombstone ?? true) {
        data.removed = data.removed.filter((r) => r.id !== id);
        data.removed.push({ id, at: now() });
        if (data.removed.length > MAX_REMOVED_PEERS) data.removed.splice(0, data.removed.length - MAX_REMOVED_PEERS);
      }
      if (i !== -1 || (opts.tombstone ?? true)) save();
      return i !== -1;
    },
    isRemoved: (id) => data.removed.some((r) => r.id === id),
    clearRemoved(id) {
      if (!data.removed.some((r) => r.id === id)) return;
      data.removed = data.removed.filter((r) => r.id !== id);
      save();
    },
  };
}
