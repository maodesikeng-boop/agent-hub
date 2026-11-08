// 公网入口配置存储（docs/mac-app-and-mobile-design.md 第 2.2 节防线 4）：
// 读写 state/public-entry.json（权限 0600，{ enabled: boolean; hostname: string | null }）。
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PublicEntryConfig {
  enabled: boolean;
  hostname: string | null;
}

const PUBLIC_ENTRY_FILE_MODE = 0o600;
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** 规范化并校验公网域名（去首尾空白、转小写、去掉可选 :443）；空串返 null，格式不合法返回 "invalid"。 */
export function normalizePublicHostname(raw: string): string | null | "invalid" {
  let clean = raw.trim().toLowerCase();
  if (clean === "") return null;
  if (clean.endsWith(":443")) clean = clean.slice(0, -4);
  if (clean.length > 253 || !HOSTNAME_PATTERN.test(clean)) return "invalid";
  return clean;
}

/** 生成开启 Tailscale Funnel 的终端命令。 */
export function funnelCommandFor(publicSock: string): string {
  return `sudo tailscale funnel --bg unix:${publicSock}`;
}

/** 读取 state/public-entry.json；不存在或内容无效时返回默认关闭状态 { enabled: false, hostname: null }。 */
export function loadPublicEntryConfig(file: string): PublicEntryConfig {
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw === null) return { enabled: false, hostname: null };
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown; hostname?: unknown } | null;
    if (typeof parsed !== "object" || parsed === null) return { enabled: false, hostname: null };
    const hostname = typeof parsed.hostname === "string" ? normalizePublicHostname(parsed.hostname) : null;
    if (hostname === "invalid") return { enabled: false, hostname: null };
    const enabled = parsed.enabled === true && hostname !== null;
    return { enabled, hostname };
  } catch {
    return { enabled: false, hostname: null };
  }
}

/** 原子写入 state/public-entry.json，权限 0600。 */
export function savePublicEntryConfig(file: string, config: PublicEntryConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload: PublicEntryConfig = {
    enabled: config.enabled === true && config.hostname !== null,
    hostname: config.hostname,
  };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: PUBLIC_ENTRY_FILE_MODE });
  if ((statSync(tmp).mode & 0o777) !== PUBLIC_ENTRY_FILE_MODE) chmodSync(tmp, PUBLIC_ENTRY_FILE_MODE);
  renameSync(tmp, file);
}
