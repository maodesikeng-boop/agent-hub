// Web Push 的 VAPID 密钥对（联机 P4，docs/multi-device-design.md 第 6.2 节）：存在 state/push-vapid.json（0600），第一次启动生成，
// 之后不变（换了，手机上已有的订阅全部作废，要重新开一次通知），不进仓库。
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";

export interface VapidKeys {
  /** base64url，网页订阅时当 applicationServerKey（GET /api/push/key）。 */
  publicKey: string;
  privateKey: string;
}

const VAPID_FILE_MODE = 0o600;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** 读 vapidFile；没有就生成。内容不对抛错，说清楚是哪个文件。 */
export function loadOrCreateVapidKeys(vapidFile: string): VapidKeys {
  let raw: string | null = null;
  try {
    raw = readFileSync(vapidFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw === null) {
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    const keys: VapidKeys = { publicKey, privateKey };
    mkdirSync(dirname(vapidFile), { recursive: true });
    writeFileSync(vapidFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: VAPID_FILE_MODE });
    if ((statSync(vapidFile).mode & 0o777) !== VAPID_FILE_MODE) chmodSync(vapidFile, VAPID_FILE_MODE);
    return keys;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const { publicKey, privateKey } = (parsed ?? {}) as Partial<Record<keyof VapidKeys, unknown>>;
  if (typeof publicKey !== "string" || !BASE64URL.test(publicKey) || typeof privateKey !== "string" || !BASE64URL.test(privateKey)) {
    throw new Error(`推送密钥文件 ${vapidFile}（push-vapid.json）内容不对。删掉它重启会生成新的，手机上要重新开一次通知。`);
  }
  if ((statSync(vapidFile).mode & 0o777) !== VAPID_FILE_MODE) chmodSync(vapidFile, VAPID_FILE_MODE);
  return { publicKey, privateKey };
}
