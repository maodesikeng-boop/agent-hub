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

/** 调用方给的东西不对（名字、公钥、连接码、重复公钥、槽位满）：管理 socket 回 400，消息给人看。 */
export class TunnelInputError extends Error {}

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

/** 加 / 更新一个槽位：同名保留端口和设备编号、换钥匙指纹；新名字取最小的空端口。changed：表变没变。重复公钥或端口用完了抛 TunnelInputError。 */
export function upsertSlot(table: TunnelTable, name: string, fingerprint: string): { table: TunnelTable; slot: TunnelSlot; changed: boolean } {
  const other = table.slots.find((s) => s.name !== name && s.keyFingerprint === fingerprint);
  if (other !== undefined) throw new TunnelInputError(`这把公钥已经给 ${other.name} 用了`);
  const existing = table.slots.find((s) => s.name === name);
  if (existing !== undefined) {
    if (existing.keyFingerprint === fingerprint) return { table, slot: existing, changed: false };
    const slot = { ...existing, keyFingerprint: fingerprint };
    return { table: { ...table, slots: table.slots.map((s) => (s.name === name ? slot : s)) }, slot, changed: true };
  }
  const used = new Set(table.slots.map((s) => s.port));
  let port = TUNNEL_FIRST_SLOT_PORT;
  while (used.has(port)) port++;
  if (port > TUNNEL_LAST_SLOT_PORT) throw new TunnelInputError(`没有空的槽位了（${TUNNEL_FIRST_SLOT_PORT}–${TUNNEL_LAST_SLOT_PORT} 都用了）`);
  const slot: TunnelSlot = { name, port, keyFingerprint: fingerprint, deviceId: null };
  return { table: { ...table, slots: [...table.slots, slot] }, slot, changed: true };
}

export function removeSlot(table: TunnelTable, name: string): { table: TunnelTable; removed: TunnelSlot | null } {
  const removed = table.slots.find((s) => s.name === name) ?? null;
  if (removed === null) return { table, removed: null };
  return { table: { ...table, slots: table.slots.filter((s) => s.name !== name) }, removed };
}

/** 中心配对成功：把来配对的 deviceId 写进对应 slotPort 的槽位。若该槽位之前绑了别的旧 deviceId，返回 previousDeviceId 供调用方清掉。 */
export function bindSlotDevice(
  table: TunnelTable,
  port: number,
  deviceId: string,
): { table: TunnelTable; slot: TunnelSlot | null; previousDeviceId: string | null } {
  const current = table.slots.find((s) => s.port === port) ?? null;
  if (current === null) return { table, slot: null, previousDeviceId: null };
  const previousDeviceId = current.deviceId !== null && current.deviceId !== deviceId ? current.deviceId : null;
  const updated: TunnelSlot = { ...current, deviceId };
  const slots = table.slots.map((s) => {
    if (s.port === port) return updated;
    if (s.deviceId === deviceId) return { ...s, deviceId: null };
    return s;
  });
  return { table: { ...table, slots }, slot: updated, previousDeviceId };
}

/** 连入方配对成功：把中心的 deviceId 写进 hub.deviceId 并清掉已用掉的 hub.invite。 */
export function bindHubDevice(
  table: TunnelTable,
  deviceId: string,
): { table: TunnelTable; previousDeviceId: string | null } {
  if (table.hub === null) return { table, previousDeviceId: null };
  const previousDeviceId = table.hub.deviceId !== null && table.hub.deviceId !== deviceId ? table.hub.deviceId : null;
  return {
    table: { ...table, hub: { ...table.hub, deviceId, invite: null } },
    previousDeviceId,
  };
}

/** 从 peers 移除设备时同步清掉槽位或 hub 上的 deviceId（保留槽位端口和钥匙指纹）。 */
export function clearTunnelDevice(table: TunnelTable, deviceId: string): { table: TunnelTable; changed: boolean } {
  let changed = false;
  const slots = table.slots.map((s) => {
    if (s.deviceId !== deviceId) return s;
    changed = true;
    return { ...s, deviceId: null };
  });
  let hub = table.hub;
  if (hub !== null && hub.deviceId === deviceId) {
    changed = true;
    hub = { ...hub, deviceId: null };
  }
  return changed ? { table: { ...table, slots, hub }, changed: true } : { table, changed: false };
}
