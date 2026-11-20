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

// SSRF guard for a pasted OAuth callback: only the exact loopback host, port, path, and state of the active login.
export function validateLoopbackCallbackUrl(
  rawInput: string,
  contract: LoopbackCallbackContract | null,
): LoopbackValidationResult {
  if (contract === null) {
    return { ok: false, reason: "Active sign-in flow does not accept a loopback callback URL" };
  }

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

  if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: "Callback URL must use http://127.0.0.1 or http://localhost" };
  }

  const port = parseValidPort(parsed.port);
  if (port === null || port !== contract.port) {
    return { ok: false, reason: "Callback URL port does not match the active sign-in listener" };
  }

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
