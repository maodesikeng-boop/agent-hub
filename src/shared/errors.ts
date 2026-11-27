import { MAX_WORKER_MAX_TIME_MS, MIN_WORKER_MAX_TIME_MS } from "./limits.ts";
import { PRODUCT_NAME } from "./names.ts";
import { vendorFailureOf, type AgentVendor, type FailureKind } from "./vendors.ts";

export const WORKER_MAX_TIME_ERRORS = {
  format: "--max-time 格式不对：请写 30s、15m、2h、1h30m 这样的时长（最短 10s，最长 24h）",
  nonInteger: "最大时间要是整数毫秒",
  tooShort: `最大时间最短 ${MIN_WORKER_MAX_TIME_MS / 1_000} 秒（10s）`,
  tooLong: `最大时间最长 ${MAX_WORKER_MAX_TIME_MS / 3_600_000} 小时（24h）`,
} as const;

export const API_ERRORS = {
  invalid: { status: 400, text: "请求内容不对" },
  not_found: { status: 404, text: "要找的东西不在了", hint: "刷新页面再试" },
  forbidden: { status: 403, text: "没有权限做这件事" },
  conflict: { status: 409, text: "状态变了，这一步做不了", hint: "刷新页面再试" },
  unauthorized: { status: 401, text: "登录过期了", hint: "重新登录" },
  forbidden_host: { status: 403, text: `这个网址不能打开 ${PRODUCT_NAME}`, hint: `换成本机 ${PRODUCT_NAME} 的网址打开` },
  forbidden_origin: { status: 403, text: "请求来源不对，已拦下", hint: `直接在 ${PRODUCT_NAME} 页面里操作` },
  forbidden_identity: { status: 403, text: "这台设备的主人不是你", hint: "换成这台设备主人的账号" },
  forbidden_peer: { status: 403, text: "别的设备不能调这个接口" },
  peer_unauthorized: { status: 401, text: "这台设备没有配对或已被移除", hint: "到设备页重新配对" },
  device_not_found: { status: 404, text: "没有这台设备", hint: "到设备页刷新设备清单" },
  device_offline: { status: 502, text: "那台设备连不上", hint: "看那台设备开没开机、联没联网" },
  too_large: { status: 413, text: "内容太大，发不出去" },
  busy: { status: 429, text: "太忙了，稍后再试" },
  unavailable: { status: 501, text: "这台机器不支持这个操作" },
  git_failed: { status: 409, text: "git 没跑成", hint: "可以重试；或加 --no-worktree 在主文件夹里干" },
  internal: { status: 500, text: "守护进程出了意外的错，已记进日志", hint: "重试一次；还不行看日志" },
  shutting_down: { status: 503, text: "守护进程正在关闭，这次没有处理", hint: "等它重新启动后再试" },
} as const satisfies Record<string, { status: number; text: string; hint?: string }>;

export const LOCAL_ERRORS = {
  network: { text: "连不上守护进程", hint: "看守护进程有没有在跑" },
  timeout: { text: "请求超时", hint: "网络可能断了，稍后再试" },
  port_in_use: { text: "端口被占了", hint: "可能已经开了一个；或设 AGENT_HUB_PORT 换端口" },
  bad_port: { text: "AGENT_HUB_PORT 不是端口号", hint: "改成 0–65535 的整数" },
  ledger_locked: { text: "账本数据库正被别的程序打开着", hint: "关掉打开 hub.sqlite 的程序（比如 sqlite3 或数据库查看器）再启动" },
  sandbox_unavailable: {
    text: "这台机器的 OS 沙箱起不来，不能启动 Worker",
    hint: "Linux 上先跑一次 sudo scripts/linux-sandbox-setup.sh 配置 bubblewrap 与 AppArmor；Windows 上请确认 NTFS/ReFS 权限正常且已构建 fusa-win-helper（cargo build --release --manifest-path apps/windows/Cargo.toml -p fusa-win-helper）",
  },
} as const satisfies Record<string, { text: string; hint?: string }>;

export type ApiErrorCode = keyof typeof API_ERRORS;
export type LocalErrorCode = keyof typeof LOCAL_ERRORS;
export type ErrorCode = ApiErrorCode | LocalErrorCode;

export interface ApiErrorBody {
  code: ErrorCode;
  error: string;
}

export const GENERIC_ERROR_TEXT = "出错了";

export interface HumanError {
  code: ErrorCode | null;
  text: string;
  hint?: string;
  raw: string;
}

const TABLE: Readonly<Record<string, { text: string; hint?: string }>> = { ...API_ERRORS, ...LOCAL_ERRORS };
const LEGACY_CODES: Readonly<Record<string, ErrorCode>> = { internal_error: "internal" };
const HAS_CJK = /[一-鿿]/;
const LOOKS_LIKE_CODE = /^[a-z_]+$/;

const lookup = (code: string): ErrorCode | null => {
  const canonical = Object.hasOwn(LEGACY_CODES, code) ? LEGACY_CODES[code]! : code;
  return Object.hasOwn(TABLE, canonical) ? (canonical as ErrorCode) : null;
};

export function errorBody(code: ApiErrorCode, reason?: string): ApiErrorBody {
  return { code, error: reason ?? API_ERRORS[code].text };
}

function fromCode(code: ErrorCode, text: string | undefined, raw: string): HumanError {
  const entry: { text: string; hint?: string } = TABLE[code]!;
  return { code, text: text ?? entry.text, ...(entry.hint === undefined ? {} : { hint: entry.hint }), raw };
}

export function humanize(body: unknown, status: number): HumanError {
  const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { code?: unknown; error?: unknown }) : {};
  const error = typeof fields.error === "string" ? fields.error : undefined;
  const raw = error ?? (typeof body === "string" ? body : "");

  const code = typeof fields.code === "string" ? lookup(fields.code) : null;
  if (code !== null) return fromCode(code, error !== undefined && HAS_CJK.test(error) ? error : undefined, raw);

  if (error !== undefined) {
    if (LOOKS_LIKE_CODE.test(error)) {
      const legacy = lookup(error);
      if (legacy !== null) return fromCode(legacy, undefined, raw);
    } else if (HAS_CJK.test(error)) {
      return { code: null, text: error, raw };
    }
  }
  return { code: null, text: `${GENERIC_ERROR_TEXT}（${status}）`, raw };
}

type FailureCategory = FailureKind | "unknown";

export interface Failure {
  kind: FailureCategory;
  text: string;
  raw: string;
}

const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|connection error|unable to connect/i;

const TEXT: Readonly<Record<FailureKind, (serviceName: string) => string>> = {
  busy: (name) => `${name} 服务繁忙，稍后重试`,
  quota: (name) => `${name} 额度用完了`,
  network: () => "网络断了，稍后重试",
  missing: (name) => `找不到 ${name}`,
  start: (name) => `${name} 没能启动`,
  auth: (name) => `${name} 未登录或鉴权失败`,
  context: (name) => `${name} 上下文超长`,
};

const UNKNOWN_TEXT = "出错了";

export const MACOS_NESTED_SANDBOX_MESSAGE =
  "macOS 不支持嵌套沙箱（sandbox-exec 退出码 71：sandbox_apply: Operation not permitted）。当前进程已在 macOS 沙箱内，请在宿主终端（沙箱外）运行，或关闭内层程序自带沙箱。";

/**
 * Precondition: raw is an error or stderr string; exitCode is the process exit code when known.
 * Postcondition: returns true only when raw (and optional exitCode) indicates a macOS nested
 * sandbox-exec failure (sandbox_apply: Operation not permitted or sandbox-exec exit 71), and false
 * for unrelated exit 71 failures or non-sandbox errors.
 */
export function isNestedMacOsSandboxError(_raw: string, _exitCode?: number | null): boolean {
  throw new Error("Not implemented");
}

export function describeFailure(raw: string, options: { unknown?: "generic" | "raw"; vendor?: AgentVendor } = {}): Failure {
  const vendor = vendorFailureOf(raw, options.vendor);
  if (NETWORK.test(raw) && vendor?.kind !== "start" && vendor?.kind !== "missing") return { kind: "network", text: TEXT.network(""), raw };
  if (vendor) return { kind: vendor.kind, text: TEXT[vendor.kind](vendor.serviceName), raw };
  const text = options.unknown === "raw" && raw.trim() !== "" && !raw.trimStart().startsWith("{") ? raw : UNKNOWN_TEXT;
  return { kind: "unknown", text, raw };
}
