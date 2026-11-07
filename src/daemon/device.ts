// 这台设备的身份（联机，docs/multi-device-design.md 第 3.2 节）：state/device.json { id, name }，第一次启动生成，之后不变。
// 别的设备靠 id 认它（配对、转发 /d/<id>/），所以文件坏了不悄悄换一个新的。
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeviceId, normalizeName, type DeviceId } from "../shared/index.ts";

export interface DeviceRecord {
  id: DeviceId;
  /** 默认是主机名，以后能在设置里改。 */
  name: string;
}

const DEVICE_FILE_MODE = 0o600;
const FALLBACK_NAME = "这台设备";

/** 主机名去掉 macOS 的 .local；不合规（空的、太长）用兜底的名字。 */
export function defaultDeviceName(hostname: string): string {
  return normalizeName(hostname.replace(/\.local$/i, "")) ?? FALLBACK_NAME;
}

/** 读 deviceFile；没有就生成（id 随机 UUID，name 是 defaultName）。内容不对抛错，说清楚是哪个文件。 */
export function loadOrCreateDevice(deviceFile: string, defaultName: string): DeviceRecord {
  let raw: string | null = null;
  try {
    raw = readFileSync(deviceFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw === null) {
    const device: DeviceRecord = { id: randomUUID(), name: defaultName };
    mkdirSync(dirname(deviceFile), { recursive: true });
    writeFileSync(deviceFile, `${JSON.stringify(device, null, 2)}\n`, { mode: DEVICE_FILE_MODE });
    if ((statSync(deviceFile).mode & 0o777) !== DEVICE_FILE_MODE) chmodSync(deviceFile, DEVICE_FILE_MODE);
    return device;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const { id, name } = (parsed ?? {}) as Partial<Record<keyof DeviceRecord, unknown>>;
  if (typeof id !== "string" || !isDeviceId(id) || typeof name !== "string" || normalizeName(name) === null) {
    throw new Error(`设备身份文件 ${deviceFile}（device.json）内容不对。别的设备靠里面的 id 认这台，请修好它；这台还没和别的设备配对过的话可以删掉，重启后重新生成。`);
  }
  return { id, name };
}

/** 改名（设置 → 设备，或别的设备上替这台改）：整份重写 device.json，id 不变。先写临时文件再改名，写到一半不会坏。 */
export function saveDevice(deviceFile: string, device: DeviceRecord): void {
  const tmp = `${deviceFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(device, null, 2)}\n`, { mode: DEVICE_FILE_MODE });
  if ((statSync(tmp).mode & 0o777) !== DEVICE_FILE_MODE) chmodSync(tmp, DEVICE_FILE_MODE);
  renameSync(tmp, deviceFile);
}
