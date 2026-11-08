// 隧道表 state/tunnels.json（docs/hub-tunnel-design.md 第 5 节），0600，守护进程自己读写（拿着数据目录锁，只有一个在写）。
// 和 peers.json 一样不进 sqlite；文件小，每次改动整份重写（先写临时文件再改名）。
// - slots：本机当中心时，每台连入设备一个槽位（名字、-R 端口、钥匙指纹、配对后的设备编号）；
// - hub：本机当连入方时连的中心（地址、主机公钥、本机槽位端口、中心设备入口端口、配对用的邀请码、配对后中心的设备编号）。
// deviceId、invite 的用法归块 B（配对）；块 C、D 只分槽位、记中心。
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TUNNEL_FIRST_SLOT_PORT, TUNNEL_LAST_SLOT_PORT } from "../../shared/limits.ts";
import { isPort, isTunnelHost, isTunnelName, isTunnelUser, parseEd25519PublicKey } from "../../shared/tunnel.ts";

export interface TunnelSlot {
  name: string;
  port: number;
  /** 这台设备专用钥匙的指纹（SHA256:…，同 ssh-keygen -lf）。 */
  keyFingerprint: string;
  /** 配对后这台设备的编号（块 B 写）。 */
  deviceId: string | null;
}

export interface TunnelHub {
  host: string;
  sshPort: number;
  user: string;
  hostKey: string;
  listenPort: number;
  hubEntryPort: number;
  /** 配对后中心的设备编号（块 B 写）。 */
  deviceId: string | null;
  /** 连接码里的邀请码，配对用（块 B 用掉后清成 null）。 */
  invite: string | null;
}

export interface TunnelTable {
  version: 1;
  slots: TunnelSlot[];
  hub: TunnelHub | null;
}

const TABLE_FILE_MODE = 0o600;

export const emptyTunnelTable = (): TunnelTable => ({ version: 1, slots: [], hub: null });

/** 钥匙指纹：sha256(钥匙二进制) 的 base64 去掉 =，和 ssh-keygen -lf 显示的一样。 */
export const keyFingerprint = (keyBody: string): string => `SHA256:${createHash("sha256").update(Buffer.from(keyBody, "base64")).digest("base64").replace(/=+$/, "")}`;

const isDeviceIdOrNull = (v: unknown) => v === null || (typeof v === "string" && v.length > 0 && v.length <= 64);

function readSlot(value: unknown): TunnelSlot | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isTunnelName(v.name) || !isPort(v.port) || typeof v.keyFingerprint !== "string" || !isDeviceIdOrNull(v.deviceId)) return null;
  return { name: v.name, port: v.port, keyFingerprint: v.keyFingerprint, deviceId: (v.deviceId as string | null) ?? null };
}

function readHub(value: unknown): TunnelHub | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const key = parseEd25519PublicKey(v.hostKey);
  if (!isTunnelHost(v.host) || !isPort(v.sshPort) || !isTunnelUser(v.user) || key === null || !isPort(v.listenPort) || !isPort(v.hubEntryPort)) return null;
  if (!isDeviceIdOrNull(v.deviceId) || !(v.invite === null || typeof v.invite === "string")) return null;
  return {
    host: v.host,
    sshPort: v.sshPort,
    user: v.user,
    hostKey: `ssh-ed25519 ${key.body}`,
    listenPort: v.listenPort,
    hubEntryPort: v.hubEntryPort,
    deviceId: v.deviceId as string | null,
    invite: v.invite as string | null,
  };
}

/** 读表。没有文件、坏文件当空表；不合格的行丢掉（原文件不改，下次写时才覆盖）。 */
export function loadTunnelTable(file: string): TunnelTable {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return emptyTunnelTable();
  }
  if (typeof raw !== "object" || raw === null) return emptyTunnelTable();
  const v = raw as Record<string, unknown>;
  const slots = Array.isArray(v.slots) ? v.slots.map(readSlot).filter((s): s is TunnelSlot => s !== null) : [];
  return { version: 1, slots, hub: readHub(v.hub) };
}

export function saveTunnelTable(file: string, table: TunnelTable): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, { mode: TABLE_FILE_MODE });
  chmodSync(tmp, TABLE_FILE_MODE);
  renameSync(tmp, file);
}

/** 加 / 更新一个槽位：同名保留端口和设备编号、换钥匙指纹；新名字取最小的空端口。changed：表变没变。端口用完了抛。 */
export function upsertSlot(table: TunnelTable, name: string, fingerprint: string): { table: TunnelTable; slot: TunnelSlot; changed: boolean } {
  const existing = table.slots.find((s) => s.name === name);
  if (existing !== undefined) {
    if (existing.keyFingerprint === fingerprint) return { table, slot: existing, changed: false };
    const slot = { ...existing, keyFingerprint: fingerprint };
    return { table: { ...table, slots: table.slots.map((s) => (s.name === name ? slot : s)) }, slot, changed: true };
  }
  const used = new Set(table.slots.map((s) => s.port));
  let port = TUNNEL_FIRST_SLOT_PORT;
  while (used.has(port)) port++;
  if (port > TUNNEL_LAST_SLOT_PORT) throw new Error(`没有空的槽位了（${TUNNEL_FIRST_SLOT_PORT}–${TUNNEL_LAST_SLOT_PORT} 都用了）`);
  const slot: TunnelSlot = { name, port, keyFingerprint: fingerprint, deviceId: null };
  return { table: { ...table, slots: [...table.slots, slot] }, slot, changed: true };
}

export function removeSlot(table: TunnelTable, name: string): { table: TunnelTable; removed: TunnelSlot | null } {
  const removed = table.slots.find((s) => s.name === name) ?? null;
  if (removed === null) return { table, removed: null };
  return { table: { ...table, slots: table.slots.filter((s) => s.name !== name) }, removed };
}
