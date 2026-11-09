// 用户看到的报错：一张表，网页、hub 命令行、agent 接口、联机转发都从这里出话（docs/user-facing-errors-design.md）。
// 表是模块常量，humanize 只查表，不发请求、不轮询。厂商失败的人话（describeFailure）在文件末尾，是第二张表。
// 暂时不从 index.ts 导出：api.ts 里还有旧的 ApiErrorBody / ApiErrorCode（B 块改完界面服务后删掉，再接进 index.ts），要用先 import 这个文件。

import { MAX_WORKER_MAX_TIME_MS, MIN_WORKER_MAX_TIME_MS } from "./limits.ts";
import { vendorFailureOf, type AgentVendor, type FailureKind } from "./vendors.ts";

/** Worker `--max-time` / `maxTimeMs` 在 CLI 与 API 边界的中文人话报错。 */
export const WORKER_MAX_TIME_ERRORS = {
  format: "--max-time 格式不对：请写 30s、15m、2h、1h30m 这样的时长（最短 10s，最长 24h）",
  nonInteger: "最大时间要是整数毫秒",
  tooShort: `最大时间最短 ${MIN_WORKER_MAX_TIME_MS / 1_000} 秒（10s）`,
  tooLong: `最大时间最长 ${MAX_WORKER_MAX_TIME_MS / 3_600_000} 小时（24h）`,
} as const;

/** 接口错误：会出现在 HTTP 应答里，status 必填。text 是一句中文；hint 是“怎么办”，只写跟连法无关的话。 */
export const API_ERRORS = {
  invalid: { status: 400, text: "请求内容不对" }, // 业务原因（中文）由抛错处给
  not_found: { status: 404, text: "要找的东西不在了", hint: "刷新页面再试" },
  forbidden: { status: 403, text: "没有权限做这件事" },
  conflict: { status: 409, text: "状态变了，这一步做不了", hint: "刷新页面再试" },
  unauthorized: { status: 401, text: "登录过期了", hint: "重新登录" }, // 网页不显示它：任何 401 直接切到登录界面
  forbidden_host: { status: 403, text: "这个网址不能打开 agent hub", hint: "换成本机 agent hub 的网址打开" },
  forbidden_origin: { status: 403, text: "请求来源不对，已拦下", hint: "直接在 agent hub 页面里操作" },
  forbidden_identity: { status: 403, text: "这台设备的主人不是你", hint: "换成这台设备主人的账号" },
  forbidden_peer: { status: 403, text: "别的设备不能调这个接口" },
  session_pending_approval: { status: 403, text: "等待已登录设备批准登录", hint: "在已登录的设备上点「允许」" },
  public_auth_locked: { status: 429, text: "公网登录尝试过多，已锁定 15 分钟后再试" },
  peer_unauthorized: { status: 401, text: "这台设备没有配对或已被移除", hint: "到设备页重新配对" },
  device_not_found: { status: 404, text: "没有这台设备", hint: "到设备页刷新设备清单" },
  device_offline: { status: 502, text: "那台设备连不上", hint: "看那台设备开没开机、联没联网" },
  too_large: { status: 413, text: "内容太大，发不出去" },
  busy: { status: 429, text: "太忙了，稍后再试" }, // 具体原因（同时上传太多、登录次数到上限）由抛错处传
  unavailable: { status: 501, text: "这台机器不支持这个操作" },
  git_failed: { status: 409, text: "git 没跑成", hint: "可以重试；或加 --no-worktree 在主文件夹里干" },
  internal: { status: 500, text: "守护进程出了意外的错，已记进日志", hint: "重试一次；还不行看日志" },
} as const satisfies Record<string, { status: number; text: string; hint?: string }>;

/** 本地错误：只在客户端、命令行、启动时用，没有 status，不可能被当成 HTTP 应答发出去。 */
export const LOCAL_ERRORS = {
  network: { text: "连不上守护进程", hint: "看守护进程有没有在跑" },
  port_in_use: { text: "端口被占了", hint: "可能已经开了一个；或设 AGENT_HUB_PORT 换端口" },
  bad_port: { text: "AGENT_HUB_PORT 不是端口号", hint: "改成 0–65535 的整数" },
  sandbox_unavailable: { text: "这台机器的 OS 沙箱起不来，不能启动 Worker", hint: "Linux 上先跑一次 sudo scripts/linux-sandbox-setup.sh 配置 bubblewrap 与 AppArmor" },
} as const satisfies Record<string, { text: string; hint?: string }>;

export type ApiErrorCode = keyof typeof API_ERRORS;
export type LocalErrorCode = keyof typeof LOCAL_ERRORS;
export type ErrorCode = ApiErrorCode | LocalErrorCode;

/** 应答体：code 给程序认，error 永远是中文、可直接显示。hint 不进应答，客户端按 code 查表拿。 */
export interface ApiErrorBody {
  code: ErrorCode;
  error: string;
}

export const GENERIC_ERROR_TEXT = "出错了";

export interface HumanError {
  code: ErrorCode | null;
  text: string;
  hint?: string;
  /** 原文（服务端给的 error，或非 JSON 的应答文本），网页放 title。 */
  raw: string;
}

const TABLE: Readonly<Record<string, { text: string; hint?: string }>> = { ...API_ERRORS, ...LOCAL_ERRORS };
/** 老服务端的英文码 → 现在的码。 */
const LEGACY_CODES: Readonly<Record<string, ErrorCode>> = { internal_error: "internal" };
const HAS_CJK = /[一-鿿]/;
const LOOKS_LIKE_CODE = /^[a-z_]+$/;

const lookup = (code: string): ErrorCode | null => {
  const canonical = Object.hasOwn(LEGACY_CODES, code) ? LEGACY_CODES[code]! : code;
  return Object.hasOwn(TABLE, canonical) ? (canonical as ErrorCode) : null;
};

/** 只收接口错误码：本地错误不可能被当成 HTTP 应答发出去。 */
export function errorBody(code: ApiErrorCode, reason?: string): ApiErrorBody {
  return { code, error: reason ?? API_ERRORS[code].text };
}

function fromCode(code: ErrorCode, text: string | undefined, raw: string): HumanError {
  const entry: { text: string; hint?: string } = TABLE[code]!;
  return { code, text: text ?? entry.text, ...(entry.hint === undefined ? {} : { hint: entry.hint }), raw };
}

/**
 * 客户端唯一入口：应答体（可能来自老版本的服务端）→ 人话。按顺序判：
 * 1. code 在表里 → error 是中文就用它，否则用表里的 text；hint 按 code 查；
 * 2. 没有 code、error 形如 `^[a-z_]+$`（老服务端的 not_found、internal_error）→ 当 code 查表；
 * 3. 没有 code、error 含中文 → 原样用（老服务端的业务原因）；
 * 4. 其余（英文原文、非 JSON、空体）→ `出错了（状态码）`。
 * body 是解析后的 JSON，或非 JSON 时的应答文本。
 */
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

// ---- 厂商失败：agent 厂商的错误原文 → 一句人话（docs/ui-standard.md 第 17 条）。各家的错误特征在 vendors.ts（VENDOR_FAILURE_SIGNS）。----

type FailureCategory = FailureKind | "unknown";

export interface Failure {
  kind: FailureCategory;
  /** 给人看的一句话。 */
  text: string;
  /** 原始错误，放 title。 */
  raw: string;
}

/** 网络断了：Node 的网络错误码和常见说法，哪家厂商都一样。 */
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

/**
 * 原始错误 → 一句人话。认不出来的默认写“出错了”；原因本来就可能是给人看的话（Worker 这一轮没做完、定时任务没跑成）时
 * 传 unknown: "raw"，认不出来就原样显示。
 */
export function describeFailure(raw: string, options: { unknown?: "generic" | "raw"; vendor?: AgentVendor } = {}): Failure {
  const vendor = vendorFailureOf(raw, options.vendor);
  // 网络断了排在厂商的“服务繁忙”前面：“Connection error” 不是对方忙
  if (NETWORK.test(raw) && vendor?.kind !== "start" && vendor?.kind !== "missing") return { kind: "network", text: TEXT.network(""), raw };
  if (vendor) return { kind: vendor.kind, text: TEXT[vendor.kind](vendor.serviceName), raw };
  const text = options.unknown === "raw" && raw.trim() !== "" && !raw.trimStart().startsWith("{") ? raw : UNKNOWN_TEXT;
  return { kind: "unknown", text, raw };
}
