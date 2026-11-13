// 远端无头服务器 OAuth 回环回调解析与 6 重防 SSRF 转发原语（docs/providers-install-login-design.md 第 5.2、8.1.3 节）：
// 1. 从捕获的 `authorizeUrl` 中提取 `redirect_uri` 的回环端口、精确路径与 `state`；
// 2. 对用户粘贴提交的回调 URL 做 6 重硬安全校验（活跃契约存在、URL 无账密无锚点、仅限 http://127.0.0.1|localhost、
//    精确端口锁定、精确路径锁定、state 常量时间 timingSafeEqual 比对）；
// 3. 使用原生 node:http（agent: false、零代理、零重定向跟随、零 DNS 解析、丢弃响应体不回传客户端）向本机回环监听器单次 GET。
import { timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  PROVIDER_AUTH_INPUT_MAX_CHARS,
  PROVIDER_CALLBACK_FORWARD_TIMEOUT_MS,
} from "../../../shared/index.ts";

export interface LoopbackCallbackContract {
  readonly port: number;
  readonly pathname: string;
  readonly expectedState: string | null;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost";
}

function parseValidPort(portStr: string): number | null {
  if (!/^\d{1,5}$/u.test(portStr)) return null;
  const port = Number(portStr);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** 从 OAuth 授权 URL 中解析本机回环回调契约；非回环回调型授权 URL 返回 null。 */
export function parseLoopbackCallbackContract(authorizeUrl: string): LoopbackCallbackContract | null {
  let outer: URL;
  try {
    outer = new URL(authorizeUrl);
  } catch {
    return null;
  }
  const rawRedirect =
    outer.searchParams.get("redirect_uri") ??
    outer.searchParams.get("redirectUri") ??
    outer.searchParams.get("callback_url");
  if (!rawRedirect) return null;

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(rawRedirect);
  } catch {
    return null;
  }
  if (redirectUrl.protocol !== "http:" || !isLoopbackHost(redirectUrl.hostname)) return null;
  if (redirectUrl.username !== "" || redirectUrl.password !== "") return null;
  const port = parseValidPort(redirectUrl.port);
  if (port === null) return null;

  const expectedState =
    outer.searchParams.get("state") ?? redirectUrl.searchParams.get("state") ?? null;
  return {
    port,
    pathname: redirectUrl.pathname || "/",
    expectedState: expectedState && expectedState.length > 0 ? expectedState : null,
  };
}

export type LoopbackValidationResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 6 重防 SSRF 硬校验：
 * ① 活跃回环回调契约必须存在；
 * ② 长度合规、URL 合法且不含 username / password / 非空 fragment；
 * ③ 协议严格为 `http:` 且主机严格为 `127.0.0.1` 或 `localhost`；
 * ④ 显式端口严格等于本次登录流自己监听的 `contract.port`；
 * ⑤ 路径严格等于 `contract.pathname` 且携带单值非空 `code`（或 OAuth `error`）；
 * ⑥ `state` 通过 `timingSafeEqual` 与本次登录流的 `expectedState` 精确一致。
 */
export function validateLoopbackCallbackUrl(
  rawInput: string,
  contract: LoopbackCallbackContract | null,
): LoopbackValidationResult {
  // 校验 ①：活跃回环契约存在
  if (contract === null) {
    return { ok: false, reason: "Active sign-in flow does not accept a loopback callback URL" };
  }

  // 校验 ②：长度、URL 语法、无账密与无 fragment
  const trimmed = rawInput.trim();
  if (trimmed === "" || trimmed.length > PROVIDER_AUTH_INPUT_MAX_CHARS) {
    return { ok: false, reason: "Callback URL is empty or exceeds maximum length" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Invalid callback URL format" };
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    return { ok: false, reason: "Callback URL must not contain credentials or fragments" };
  }

  // 校验 ③：协议与回环主机硬白名单
  if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: "Callback URL must use http://127.0.0.1 or http://localhost" };
  }

  // 校验 ④：精确端口锁定
  const port = parseValidPort(parsed.port);
  if (port === null || port !== contract.port) {
    return { ok: false, reason: "Callback URL port does not match the active sign-in listener" };
  }

  // 校验 ⑤：精确路径锁定 + 必须携带 code 或 error 查询参数
  const normalizedPath = parsed.pathname || "/";
  if (normalizedPath !== contract.pathname) {
    return { ok: false, reason: "Callback URL path does not match the active sign-in listener" };
  }
  const codes = parsed.searchParams.getAll("code");
  const errors = parsed.searchParams.getAll("error");
  const hasSingleCode = codes.length === 1 && codes[0]!.trim() !== "";
  const hasSingleError = errors.length === 1 && errors[0]!.trim() !== "";
  if (!hasSingleCode && !hasSingleError) {
    return { ok: false, reason: "Callback URL is missing authorization code" };
  }

  // 校验 ⑥：state 常量时间比对
  if (contract.expectedState !== null) {
    const states = parsed.searchParams.getAll("state");
    if (states.length !== 1 || !constantTimeEquals(states[0]!, contract.expectedState)) {
      return { ok: false, reason: "Callback URL state does not match the active sign-in session" };
    }
  } else if (!hasSingleCode) {
    return { ok: false, reason: "Callback URL requires a single non-empty code parameter" };
  }

  return { ok: true, url: parsed };
}

function singleLoopbackGet(
  ipLiteral: "127.0.0.1" | "::1",
  port: number,
  requestPath: string,
  hostHeader: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let settled = false;
    const finish = (err: Error | null, statusCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(statusCode);
    };

    const req = httpRequest(
      {
        hostname: ipLiteral,
        port,
        method: "GET",
        path: requestPath,
        agent: false,
        headers: {
          host: hostHeader,
          connection: "close",
          accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
      },
      (res) => {
        // 丢弃全部响应正文，绝不回传给外部调用者，也不跟随任何 3xx 重定向
        res.resume();
        const code = res.statusCode ?? 0;
        res.once("end", () => finish(null, code));
        res.once("error", () => finish(null, code));
      },
    );

    const onAbort = () => {
      req.destroy();
      finish(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error(`Loopback callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    req.end();
  });
}

/** 向通过 6 重安全校验的本机回环端口发送无代理、无重定向、零 DNS 解析的单次 GET 请求并丢弃响应体。 */
export async function forwardValidatedLoopbackCallback(
  validatedUrl: URL,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? PROVIDER_CALLBACK_FORWARD_TIMEOUT_MS;
  const port = Number(validatedUrl.port);
  const requestPath = `${validatedUrl.pathname || "/"}${validatedUrl.search}`;
  const hostHeader = `${validatedUrl.hostname.toLowerCase()}:${port}`;

  let statusCode: number;
  try {
    statusCode = await singleLoopbackGet("127.0.0.1", port, requestPath, hostHeader, timeoutMs, options?.signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ECONNREFUSED" && validatedUrl.hostname.toLowerCase() === "localhost") {
      statusCode = await singleLoopbackGet("::1", port, requestPath, hostHeader, timeoutMs, options?.signal);
    } else {
      throw err;
    }
  }

  if (statusCode < 200 || statusCode >= 400) {
    throw new Error(`Local sign-in listener rejected callback (HTTP ${statusCode})`);
  }
}
