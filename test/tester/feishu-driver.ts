// Acts as the bench owner in Feishu. Sending uses a separate driver app with a user_access_token
// (scopes im:message and im:message.send_as_user); reading uses the test bot's tenant token, which already holds
// im:message:readonly and im:message.group_msg.
// Invariant: sendAsUser posts only into chats the test bot belongs to, because a user token can post anywhere the owner can,
// including the owner's real project groups.
// Invariant: Feishu rotates the refresh token on every refresh and voids the old one, so the new token is written to disk
// before the new access token is used, and only one process refreshes at a time.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import writeFileAtomic from "write-file-atomic";
import { TESTER_FEISHU_LOCK_STALE_MS, TESTER_FEISHU_PAGE_SIZE, TESTER_FEISHU_REQUEST_MS, TESTER_FEISHU_TOKEN_SKEW_MS, TESTER_POLL_MS } from "./limits.ts";

export interface DriverTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

/** The driver secrets file: the driver app's secret, and its tokens once the owner authorized it. */
export interface DriverSecrets {
  appSecret: string;
  brand?: "feishu" | "lark";
  tokens?: DriverTokens;
}

export interface FeishuDriverOptions {
  driverAppId: string;
  /** File holding the driver app secret and DriverTokens, mode 0600. */
  driverSecretsFile: string;
  testBotAppId: string;
  /** The test bot's credentials file inside a test instance's data dir. */
  botSecretsFile: string;
  /** Router chats (the owner's 1-on-1 chat with the test bot) that the test instances report; Feishu lists only groups. */
  routerChatIds?: () => Promise<string[]>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  senderType: "user" | "app";
  senderId: string;
  msgType: string;
  createTime: number;
  updateTime: number;
  deleted: boolean;
  updated: boolean;
  /** Raw content; for cards, the original card JSON (card_msg_content_type=user_card_content). */
  content: string;
}

export interface TestChat {
  chatId: string;
  kind: "router" | "project";
  /** From the group description marker, for project groups. */
  deviceId?: string;
  pmId?: number;
}

export class FeishuGuardError extends Error {}
export class FeishuReplyTimeout extends Error {
  readonly seen: FeishuMessage[];
  constructor(message: string, seen: FeishuMessage[]) {
    super(message);
    this.seen = seen;
  }
}
export class FeishuApiError extends Error {
  readonly status: number;
  readonly code: number;
  constructor(message: string, status: number, code: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Feishu's code for an expired or revoked refresh token. */
export const FEISHU_REFRESH_EXPIRED = 20037;
const RECALLED_PLACEHOLDERS = new Set(["This message was recalled", "该消息已撤回", "此消息已撤回"]);
const CHAT_NOT_JOINED = 232011;
const MARKER = /fusa:([^:\s]+):pm:(\d+)/;
const MEDIA_TYPES = new Set(["image", "file", "audio", "media", "sticker"]);
const DRIVER_SCOPES = ["im:message", "im:message.send_as_user", "offline_access"];

export interface FeishuDriver {
  /** Postcondition: chats the test bot is a member of: its 1-on-1 chat with the owner and its project groups. */
  testChats(): Promise<TestChat[]>;
  /** Throws FeishuGuardError when `chatId` is not in testChats(). Postcondition: the id of the message Feishu stored, sent as the owner. */
  sendAsUser(chatId: string, text: string): Promise<string>;
  /** Postcondition: messages created at or after `sinceMs`, oldest first, including deleted ones with deleted=true. */
  listMessages(chatId: string, sinceMs: number): Promise<FeishuMessage[]>;
  /** Postcondition: the first message from the test bot after `afterMessageId` that satisfies `done`; rejects on timeout with the messages seen so far. */
  waitForBotMessage(chatId: string, afterMessageId: string, done: (m: FeishuMessage) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<FeishuMessage>;
  /** Ensures access and returns the saved refresh token's expiration time in milliseconds. */
  ensureUserToken(): Promise<number>;
}

export function openApiBase(brand: "feishu" | "lark" | undefined): string {
  return brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

interface FeishuEnvelope<T> {
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  data?: T;
}

async function call<T>(doFetch: typeof fetch, url: string, init: { method: string; token?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const timeout = AbortSignal.timeout(TESTER_FEISHU_REQUEST_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  let text: string;
  try {
    res = await doFetch(url, { method: init.method, headers, signal, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    text = await res.text();
  } catch (error) {
    init.signal?.throwIfAborted();
    throw new FeishuApiError(`Feishu ${init.method} ${new URL(url).pathname}: ${String(error)}`, 0, -1);
  }
  let body: FeishuEnvelope<T> & Record<string, unknown>;
  try {
    body = JSON.parse(text) as FeishuEnvelope<T> & Record<string, unknown>;
  } catch {
    throw new FeishuApiError(`Feishu ${init.method} ${new URL(url).pathname}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status, -1);
  }
  const code = typeof body.code === "number" ? body.code : 0;
  if (!res.ok || code !== 0) throw new FeishuApiError(`Feishu ${init.method} ${new URL(url).pathname}: HTTP ${res.status} code ${code} ${body.msg ?? body.error_description ?? body.error ?? ""}`.trim(), res.status, code);
  return (body.data ?? body) as T;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function writeDriverSecrets(file: string, secrets: DriverSecrets): void {
  writeFileAtomic.sync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}

/** Takes the refresh lock or waits until whoever holds it finishes; a lock older than TESTER_FEISHU_LOCK_STALE_MS is taken over. */
async function withRefreshLock<T>(lockFile: string, now: () => number, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      closeSync(openSync(lockFile, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (existsSync(lockFile) && now() - statSync(lockFile).mtimeMs > TESTER_FEISHU_LOCK_STALE_MS) rmSync(lockFile, { force: true });
      else await delay(200);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockFile, { force: true });
  }
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
}

function tokensFrom(res: OAuthTokenResponse, at: number): DriverTokens {
  return { accessToken: res.access_token, accessExpiresAt: at + res.expires_in * 1000, refreshToken: res.refresh_token, refreshExpiresAt: at + res.refresh_token_expires_in * 1000 };
}

interface RawMessage {
  message_id: string;
  chat_id: string;
  msg_type: string;
  create_time: string;
  update_time: string;
  deleted?: boolean;
  updated?: boolean;
  sender?: { id?: string; sender_type?: string };
  body?: { content?: string };
}

function toMessage(raw: RawMessage): FeishuMessage {
  return {
    messageId: raw.message_id,
    chatId: raw.chat_id,
    senderType: raw.sender?.sender_type === "app" ? "app" : "user",
    senderId: raw.sender?.id ?? "",
    msgType: raw.msg_type,
    createTime: Number(raw.create_time),
    updateTime: Number(raw.update_time),
    deleted: raw.deleted === true,
    updated: raw.updated === true,
    content: raw.body?.content ?? "",
  };
}

/**
 * Precondition: the driver secrets file holds tokens from authorizeDriver.
 * Postcondition: a driver whose access token is valid for at least TESTER_FEISHU_TOKEN_SKEW_MS.
 * Throws FeishuApiError with code 20037 when the refresh token has expired or been revoked.
 */
export async function createFeishuDriver(options: FeishuDriverOptions): Promise<FeishuDriver> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const bot = readJson<{ brand: "feishu" | "lark"; appId: string; appSecret: string }>(options.botSecretsFile);
  if (bot.appId !== options.testBotAppId) throw new FeishuGuardError(`${options.botSecretsFile} holds app ${bot.appId}, not the test bot ${options.testBotAppId}`);
  const base = openApiBase(bot.brand);
  let tenant: { token: string; expiresAt: number } | null = null;

  const tenantToken = async (): Promise<string> => {
    if (tenant !== null && tenant.expiresAt - TESTER_FEISHU_TOKEN_SKEW_MS > now()) return tenant.token;
    const res = await call<{ tenant_access_token: string; expire: number }>(doFetch, `${base}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", body: { app_id: bot.appId, app_secret: bot.appSecret } });
    tenant = { token: res.tenant_access_token, expiresAt: now() + res.expire * 1000 };
    return tenant.token;
  };

  const reauthorize = "the owner runs `node test/tester/cli.ts authorize-feishu`";
  const requireTokens = ({ tokens }: DriverSecrets): DriverTokens => {
    if (tokens === undefined) throw new FeishuApiError(`the Feishu driver is not authorized; ${reauthorize}`, 401, FEISHU_REFRESH_EXPIRED);
    if (tokens.refreshExpiresAt <= now()) throw new FeishuApiError(`the Feishu driver refresh token expired; ${reauthorize}`, 400, FEISHU_REFRESH_EXPIRED);
    return tokens;
  };
  const refresh = async (secrets: DriverSecrets, tokens: DriverTokens): Promise<DriverTokens> => {
    const at = now();
    const res = await call<OAuthTokenResponse>(doFetch, `${base}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      body: { grant_type: "refresh_token", client_id: options.driverAppId, client_secret: secrets.appSecret, refresh_token: tokens.refreshToken },
    }).catch((error: unknown) => {
      if (error instanceof FeishuApiError && error.code === FEISHU_REFRESH_EXPIRED) throw new FeishuApiError(`the Feishu driver refresh token was rejected; ${reauthorize}`, error.status, error.code);
      throw error;
    });
    const next = tokensFrom(res, at);
    writeDriverSecrets(options.driverSecretsFile, { ...secrets, tokens: next });
    return next;
  };

  const userTokens = async (): Promise<DriverTokens> => {
    const fresh = (t: DriverTokens) => t.accessExpiresAt - TESTER_FEISHU_TOKEN_SKEW_MS > now();
    const current = requireTokens(readJson<DriverSecrets>(options.driverSecretsFile));
    if (fresh(current)) return current;
    return withRefreshLock(`${options.driverSecretsFile}.lock`, now, async () => {
      const latest = readJson<DriverSecrets>(options.driverSecretsFile);
      const tokens = requireTokens(latest);
      return fresh(tokens) ? tokens : refresh(latest, tokens);
    });
  };

  const groupChats = async (): Promise<TestChat[]> => {
    const chats: TestChat[] = [];
    let pageToken = "";
    do {
      const res = await call<{ items?: Array<{ chat_id: string; description?: string }>; page_token?: string; has_more?: boolean }>(
        doFetch,
        `${base}/open-apis/im/v1/chats?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
        { method: "GET", token: await tenantToken() },
      );
      for (const item of res.items ?? []) {
        const marker = MARKER.exec(item.description ?? "");
        chats.push({ chatId: item.chat_id, kind: "project", ...(marker ? { deviceId: marker[1]!, pmId: Number(marker[2]) } : {}) });
      }
      pageToken = res.has_more ? (res.page_token ?? "") : "";
    } while (pageToken !== "");
    return chats;
  };

  const routerChats = async (): Promise<TestChat[]> => {
    const ids = [...new Set((await options.routerChatIds?.()) ?? [])];
    const token = await tenantToken();
    const found: TestChat[] = [];
    for (const chatId of ids) {
      try {
        await call(doFetch, `${base}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { method: "GET", token });
        found.push({ chatId, kind: "router" });
      } catch (error) {
        if (!(error instanceof FeishuApiError) || (error.status !== 404 && error.code !== CHAT_NOT_JOINED)) throw error;
      }
    }
    return found;
  };

  const testChats = async () => [...(await routerChats()), ...(await groupChats())];

  const listMessages = async (chatId: string, sinceMs: number, signal?: AbortSignal): Promise<FeishuMessage[]> => {
    const out: FeishuMessage[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({
        container_id_type: "chat",
        container_id: chatId,
        start_time: String(Math.floor(sinceMs / 1000)),
        sort_type: "ByCreateTimeAsc",
        page_size: String(TESTER_FEISHU_PAGE_SIZE),
        card_msg_content_type: "user_card_content",
      });
      if (pageToken) query.set("page_token", pageToken);
      const res = await call<{ items?: RawMessage[]; page_token?: string; has_more?: boolean }>(doFetch, `${base}/open-apis/im/v1/messages?${query}`, { method: "GET", token: await tenantToken(), ...(signal ? { signal } : {}) });
      out.push(...(res.items ?? []).map(toMessage).filter((m) => m.createTime >= sinceMs));
      pageToken = res.has_more ? (res.page_token ?? "") : "";
    } while (pageToken !== "");
    return out;
  };

  const driver: FeishuDriver = {
    testChats,
    async sendAsUser(chatId, text) {
      if (!(await testChats()).some((c) => c.chatId === chatId)) throw new FeishuGuardError(`chat ${chatId} is not a chat of the test bot ${options.testBotAppId}; refusing to post as the owner`);
      const res = await call<{ message_id: string }>(doFetch, `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        token: (await userTokens()).accessToken,
        body: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
      });
      return res.message_id;
    },
    listMessages,
    async waitForBotMessage(chatId, afterMessageId, done, timeoutMs, signal) {
      const deadline = now() + timeoutMs;
      const anchor = await call<{ items?: RawMessage[] }>(doFetch, `${base}/open-apis/im/v1/messages/${encodeURIComponent(afterMessageId)}`, { method: "GET", token: await tenantToken(), ...(signal ? { signal } : {}) });
      const since = Number(anchor.items?.[0]?.create_time ?? now() - timeoutMs);
      let seen: FeishuMessage[] = [];
      for (;;) {
        signal?.throwIfAborted();
        seen = await listMessages(chatId, since, signal);
        const after = seen.slice(seen.findIndex((m) => m.messageId === afterMessageId) + 1);
        const hit = after.find((m) => m.senderType === "app" && m.senderId === options.testBotAppId && done(m));
        if (hit !== undefined) return hit;
        if (now() >= deadline) throw new FeishuReplyTimeout(`no matching test bot message in ${chatId} within ${timeoutMs / 1000} s`, seen);
        await delay(Math.min(TESTER_POLL_MS, Math.max(0, deadline - now())), undefined, { signal });
      }
    },
    async ensureUserToken() {
      return (await userTokens()).refreshExpiresAt;
    },
  };
  await driver.ensureUserToken();
  return driver;
}

/**
 * One-time authorization, run by the owner outside any sandbox: opens the Feishu consent page with
 * scopes im:message, im:message.send_as_user, offline_access, receives the code on a loopback redirect, and writes DriverTokens.
 * Postcondition: the secrets file exists with mode 0600 and its refresh token is fresh.
 */
export async function authorizeDriver(options: { driverAppId: string; driverSecretsFile: string; redirectPort: number; openUrl: (url: string) => void; fetch?: typeof fetch }): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const secrets = readJson<DriverSecrets>(options.driverSecretsFile);
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://127.0.0.1:${options.redirectPort}/callback`;
  const accounts = secrets.brand === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn";
  const query = new URLSearchParams({ client_id: options.driverAppId, response_type: "code", redirect_uri: redirectUri, scope: DRIVER_SCOPES.join(" "), state });
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" }).end(ok ? "Bellwood tester authorized. You can close this tab." : "Authorization failed.");
      server.close();
      if (ok) resolve(url.searchParams.get("code")!);
      else reject(new Error(`authorization was refused: ${url.searchParams.get("error") ?? "state mismatch"}`));
    });
    server.once("error", reject);
    server.listen(options.redirectPort, "127.0.0.1", () => options.openUrl(`${accounts}/open-apis/authen/v1/authorize?${query}`));
  });
  const at = Date.now();
  const res = await call<OAuthTokenResponse>(doFetch, `${openApiBase(secrets.brand)}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    body: { grant_type: "authorization_code", client_id: options.driverAppId, client_secret: secrets.appSecret, code, redirect_uri: redirectUri },
  });
  writeDriverSecrets(options.driverSecretsFile, { ...secrets, tokens: tokensFrom(res, at) });
}

/** Postcondition: true for a message the client shows as "recalled": deleted, or content equal to Feishu's recalled placeholder. */
export function isRecalled(message: Pick<FeishuMessage, "deleted" | "content">): boolean {
  if (message.deleted) return true;
  return RECALLED_PLACEHOLDERS.has(visibleText({ msgType: "text", content: message.content }).trim());
}

function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "content" || key === "text") && typeof value === "string") out.push(value);
    else collectText(value, out);
  }
}

const stripMarkdown = (text: string) => text.replace(/\*\*|__|`|^#+\s*/gm, "").replace(/<[^>]+>/g, "");

/** Postcondition: the visible text of a card or text message, with markdown and card structure removed; empty for media. */
export function visibleText(message: Pick<FeishuMessage, "msgType" | "content">): string {
  if (MEDIA_TYPES.has(message.msgType)) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    return stripMarkdown(message.content).trim();
  }
  const parts: string[] = [];
  collectText(parsed, parts);
  return stripMarkdown(parts.filter((p) => p.trim() !== "").join("\n")).trim();
}
