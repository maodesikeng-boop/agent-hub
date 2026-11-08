// ssh 隧道（docs/hub-tunnel-design.md 第 6、7 节）：隧道状态、连接码、公钥和设备名的校验。
// 守护进程、隧道命令（src/tunnel/）、网页都引，所以不用 node 的东西（base64 用 btoa / atob）。

/**
 * 连入方隧道的状态（内部值，进 /api/state 的 tunnel；网页上怎么说由块 E 定）：
 * - connecting：ssh 子进程起了，两条转发还没都建好；
 * - connected：-R、-L 都建好了（ssh 的 stderr 出现 remote forward success）；
 * - retrying：ssh 退出了，等退避到 retryAt 再连；
 * - auth_failed / hostkey_mismatch：钥匙不认 / 主机公钥对不上，不自动重试，等用户点重试或重新连。
 */
export const TUNNEL_STATES = ["connecting", "connected", "retrying", "auth_failed", "hostkey_mismatch"] as const;
export type TunnelState = (typeof TUNNEL_STATES)[number];

export interface TunnelStatus {
  state: TunnelState;
  /** 进入这个状态的时间（毫秒）。 */
  since: number;
  /** retrying 时下次重连的时间（毫秒），别的状态 null。 */
  retryAt: number | null;
  /** ssh 最后一行报错（不含 debug 行），没有就 null。原文，不翻译。 */
  detail: string | null;
}

/** 东京上隧道专用的系统用户（shell 是 nologin，钥匙行和 sshd 片段只放它能转发）。改名要同时改 scripts/tunnel-sshd.sh。 */
export const TUNNEL_SSH_USER = "agenthub-tunnel";

/**
 * 连接码：中心上 `add` 打出来、连入方收下的一行。`ahtun1_` + base64url(JSON)：
 * 只有 [A-Za-z0-9_-]，贴进终端、网页都不用加引号；前缀里的 1 是格式版本，以后改格式换前缀。
 * 内容：中心地址和 ssh 端口、登录用户、主机公钥（钉进 known_hosts）、本机的槽位端口（-R）、中心的设备入口端口（-L）、邀请码（10 分钟、用一次）。
 */
export interface ConnectionCode {
  host: string;
  sshPort: number;
  user: string;
  /** 中心的 ed25519 主机公钥，`ssh-ed25519 <base64>`（不带注释）。 */
  hostKey: string;
  listenPort: number;
  entryPort: number;
  invite: string;
}

export const CONNECTION_CODE_PREFIX = "ahtun1_";

/** 设备名（槽位名、钥匙行注释 agent-hub:<名>）：小写字母数字和 -，不以 - 开头，最多 32 个。 */
const TUNNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 地址：域名 / IPv4（字母数字点和 -，不以 - 开头）或 IPv6（十六进制和冒号）。以 - 开头会被 ssh 当成选项。 */
const HOST_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9A-Fa-f]*:[0-9A-Fa-f:.]+)$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const KEY_BODY_PATTERN = /^AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+={0,2}$/;
/** 邀请码：daemon/peers/tokens.ts 的 newInviteCode（base64url），这里只查字符和长度。 */
const INVITE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const isTunnelName = (value: unknown): value is string => typeof value === "string" && TUNNEL_NAME_PATTERN.test(value);
export const isTunnelHost = (value: unknown): value is string => typeof value === "string" && HOST_PATTERN.test(value);
export const isTunnelUser = (value: unknown): value is string => typeof value === "string" && USER_PATTERN.test(value);
export const isPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;

/** 解析一行 ed25519 公钥（`ssh-ed25519 <base64> [注释]`），注释丢掉。别的类型、带选项前缀、多行都不认。 */
export function parseEd25519PublicKey(text: unknown): { type: "ssh-ed25519"; body: string } | null {
  if (typeof text !== "string") return null;
  const parts = text.trim().split(/[ \t]+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519" || !KEY_BODY_PATTERN.test(parts[1]!)) return null;
  if (/[\r\n]/.test(text.trim())) return null;
  return { type: "ssh-ed25519", body: parts[1]! };
}

function isConnectionCode(value: unknown): value is ConnectionCode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const key = typeof v.hostKey === "string" ? parseEd25519PublicKey(v.hostKey) : null;
  return (
    isTunnelHost(v.host) &&
    isPort(v.sshPort) &&
    isTunnelUser(v.user) &&
    key !== null &&
    v.hostKey === `ssh-ed25519 ${key.body}` &&
    isPort(v.listenPort) &&
    isPort(v.entryPort) &&
    typeof v.invite === "string" &&
    INVITE_PATTERN.test(v.invite)
  );
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** 编码一个连接码。字段不合格直接抛（是本机代码拼的，不该发生）。 */
export function encodeConnectionCode(code: ConnectionCode): string {
  const plain: ConnectionCode = {
    host: code.host,
    sshPort: code.sshPort,
    user: code.user,
    hostKey: code.hostKey,
    listenPort: code.listenPort,
    entryPort: code.entryPort,
    invite: code.invite,
  };
  if (!isConnectionCode(plain)) throw new Error("connection code has invalid fields");
  return CONNECTION_CODE_PREFIX + toBase64Url(JSON.stringify(plain));
}

/** 解一个连接码（前后空白不算）。格式、任何字段不对都回 null。 */
export function decodeConnectionCode(text: string): ConnectionCode | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CONNECTION_CODE_PREFIX)) return null;
  const json = fromBase64Url(trimmed.slice(CONNECTION_CODE_PREFIX.length));
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isConnectionCode(value)) return null;
  const { host, sshPort, user, hostKey, listenPort, entryPort, invite } = value;
  return { host, sshPort, user, hostKey, listenPort, entryPort, invite };
}
