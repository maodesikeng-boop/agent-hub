// HTTP access to one test computer: the local test daemon directly, the remote one through the local daemon's
// /d/<deviceId>/ mesh proxy with the same session cookie, exactly as the workbench in a browser reaches it.
import { setTimeout as delay } from "node:timers/promises";
import { API_PATHS, type AccountStatusView, type DeviceRouterDigest, type Message, type MessagesPage, type StateSnapshot } from "../../src/shared/index.ts";
import { TESTER_POLL_MS } from "./limits.ts";
import type { InstanceClient } from "./bench.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ApiClient {
  readonly origin: string;
  /** "" for the local instance, "/d/<deviceId>" for a computer reached through the mesh proxy. */
  readonly prefix: string;
  readonly cookie: string;
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response>;
  /** Rejects with ApiError on any status outside 2xx, naming the method, path, and response text. */
  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  /** A client for another computer in the same account, through this computer's mesh proxy. `before` runs before every request. */
  forDevice(deviceId: string, before?: () => Promise<void>): ApiClient;
}

export function createApiClient(options: { origin: string; cookie: string; prefix?: string; before?: () => Promise<void> }): ApiClient {
  const prefix = options.prefix ?? "";
  const request = async (method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> => {
    await options.before?.();
    const headers: Record<string, string> = { cookie: options.cookie, origin: options.origin };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${options.origin}${prefix}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  };
  return {
    origin: options.origin,
    prefix,
    cookie: options.cookie,
    request,
    async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
      const res = await request(method, path, body, signal);
      const text = await res.text();
      if (res.status < 200 || res.status > 299) throw new ApiError(`${method} ${prefix}${path}: HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
      return (text === "" ? undefined : JSON.parse(text)) as T;
    },
    forDevice: (deviceId, before) => createApiClient({ origin: options.origin, cookie: options.cookie, prefix: `/d/${encodeURIComponent(deviceId)}`, ...(before ? { before } : {}) }),
  };
}

/** Postcondition: the session cookie the daemon sets for its passwordless login link. */
export async function loginCookie(origin: string, uiToken: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${origin}${API_PATHS.auth}?token=${encodeURIComponent(uiToken)}`, { redirect: "manual", ...(signal ? { signal } : {}) });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  if (res.status !== 302 || cookie === "") throw new ApiError(`login at ${origin}: HTTP ${res.status}`, res.status);
  return cookie;
}

export class ReplyTimeoutError extends Error {}
export class TurnFailedError extends Error {}

const NEWEST = Number.MAX_SAFE_INTEGER;

/** Postcondition: the messages of `conversationId` after `afterMessageId` within the newest page, oldest first. */
export async function messagesAfter(api: ApiClient, conversationId: number, afterMessageId: number, signal?: AbortSignal): Promise<Message[]> {
  const page = await api.json<MessagesPage>("GET", `${API_PATHS.messages(conversationId)}?before=${NEWEST}`, undefined, signal);
  return page.messages.filter((m) => m.id > afterMessageId);
}

/** Postcondition: the account view; `githubLogin` is null unless the instance is signed in or awaiting approval. */
export function accountOf(view: AccountStatusView): { githubLogin: string | null; deviceId: string | null } {
  if (view.state === "signed_in") return { githubLogin: view.login.login, deviceId: view.devices.find((d) => d.self)?.id ?? null };
  if (view.state === "awaiting_approval") return { githubLogin: view.login.login, deviceId: null };
  return { githubLogin: null, deviceId: null };
}

export function createInstanceClient(name: string, api: ApiClient): InstanceClient {
  return {
    name,
    api,
    async health() {
      if (api.prefix === "") return api.json<{ ok: boolean }>("GET", API_PATHS.health);
      const digest = await api.json<DeviceRouterDigest>("GET", API_PATHS.routerDigest);
      return { ok: Array.isArray(digest.pms) };
    },
    state: () => api.json<StateSnapshot>("GET", API_PATHS.state),
    async send(conversationId, text) {
      const res = await api.json<{ messageId: number }>("POST", API_PATHS.messages(conversationId), { clientId: crypto.randomUUID(), text });
      return res.messageId;
    },
    async waitForReply(conversationId, afterMessageId, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        signal?.throwIfAborted();
        const messages = await messagesAfter(api, conversationId, afterMessageId - 1, signal);
        const failed = messages.find((m) => m.id === afterMessageId && m.status === "failed");
        if (failed !== undefined) throw new TurnFailedError(failed.failureReason ?? "the PM turn failed");
        const reply = messages.find((m) => m.id > afterMessageId && m.sender === "agent" && m.kind === "text" && m.text.trim() !== "");
        if (reply !== undefined) return reply;
        if (Date.now() >= deadline) throw new ReplyTimeoutError(`no reply in conversation ${conversationId} after message ${afterMessageId} within ${timeoutMs / 1000} s`);
        await delay(Math.min(TESTER_POLL_MS, Math.max(0, deadline - Date.now())), undefined, { signal });
      }
    },
    async account() {
      return accountOf(await api.json<AccountStatusView>("GET", API_PATHS.account));
    },
  };
}
