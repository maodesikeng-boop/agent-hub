import { existsSync, readFileSync, rmSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { isDeviceId, type DeviceId } from "../../shared/api.ts";
import { GITHUB_DEVICE_POLL_DEFAULT_MS, GITHUB_WEB_ORIGIN, MESH_ACCOUNT_FILE_MODE } from "../../shared/limits.ts";
import { ACCOUNT_PROVIDERS, parseAccountId, type AccountId, type AccountLogin, type MeshDeviceState } from "../../shared/mesh.ts";
import { GITHUB_API_ORIGIN, verifyGithubToken } from "../../relay/auth.ts";
import type { MeshIdentity } from "./identity.ts";
import { registerWithRelay } from "./relay-client.ts";

export interface GithubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}

export interface GithubOptions {
  fetch?: typeof fetch;
  now?: () => number;
  webOrigin?: string;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const GITHUB_ERRORS: Record<string, string> = {
  device_flow_disabled: "GitHub 应用没开设备码登录",
  incorrect_client_credentials: "GitHub 应用的 Client ID 不对",
  incorrect_device_code: "GitHub 登录码不对，请重新登录",
  unsupported_grant_type: "GitHub 登录请求不对",
};
const githubError = (code: unknown) => new Error(typeof code === "string" && code in GITHUB_ERRORS ? GITHUB_ERRORS[code] : "GitHub 登录失败，请稍后再试");

async function postGithub(path: string, fields: Record<string, string>, options?: GithubOptions): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (options?.fetch ?? fetch)(`${options?.webOrigin ?? GITHUB_WEB_ORIGIN}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form(fields),
    });
  } catch {
    throw new Error("连不上 GitHub，请检查网络");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null) throw new Error(`GitHub 回了 HTTP ${res.status}`);
  return body as Record<string, unknown>;
}

export async function requestGithubDeviceCode(clientId: string, options?: GithubOptions): Promise<GithubDeviceCode> {
  const body = await postGithub("/login/device/code", { client_id: clientId, scope: "" }, options);
  if (typeof body.error === "string") throw githubError(body.error);
  const { device_code, user_code, verification_uri, expires_in, interval } = body;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string" || typeof expires_in !== "number") {
    throw new Error("GitHub 回的登录码不对");
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    expiresAt: (options?.now ?? Date.now)() + expires_in * 1000,
    intervalMs: typeof interval === "number" ? interval * 1000 : GITHUB_DEVICE_POLL_DEFAULT_MS,
  };
}

export type GithubPollResult =
  | { kind: "pending" }
  | { kind: "slow_down"; intervalMs: number }
  | { kind: "token"; accessToken: string }
  | { kind: "denied" }
  | { kind: "expired" };

export async function pollGithubDeviceToken(clientId: string, deviceCode: string, options?: GithubOptions): Promise<GithubPollResult> {
  const body = await postGithub(
    "/login/oauth/access_token",
    { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
    options,
  );
  if (typeof body.access_token === "string") return { kind: "token", accessToken: body.access_token };
  switch (body.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down", intervalMs: typeof body.interval === "number" ? body.interval * 1000 : GITHUB_DEVICE_POLL_DEFAULT_MS * 2 };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
    default:
      throw githubError(body.error);
  }
}

export interface AccountFile {
  version: 1;
  relayUrl: string;
  accountId: AccountId;
  login: AccountLogin;
  state: MeshDeviceState;
}

const accountFileSchema = z.strictObject({
  version: z.literal(1),
  relayUrl: z.string().url(),
  accountId: z.string().refine((v) => parseAccountId(v) !== null),
  login: z.strictObject({ provider: z.enum(ACCOUNT_PROVIDERS), userId: z.string().regex(/^\d+$/), login: z.string().min(1).max(128) }),
  state: z.enum(["pending", "active"]),
});

export function readAccountFile(file: string): AccountFile | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`账号文件坏了：${file}。删掉它后重新登录`);
  }
  const parsed = accountFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`账号文件内容不对：${file}。删掉它后重新登录`);
  return parsed.data as AccountFile;
}

export function writeAccountFile(file: string, data: AccountFile): void {
  writeFileAtomic.sync(file, `${JSON.stringify(accountFileSchema.parse(data), null, 2)}\n`, { mode: MESH_ACCOUNT_FILE_MODE });
}

export type AccountLoginState =
  | { kind: "signed_out" }
  | { kind: "signing_in"; userCode: string; verificationUri: string; expiresAt: number }
  | { kind: "signed_in"; account: AccountFile };

export interface AccountServiceOptions {
  file: string;
  identity: MeshIdentity;
  device: { id: DeviceId; name: string; platform: string };
  relayUrl: string;
  githubClientId: string;
  fetch?: typeof fetch;
  now?: () => number;
  githubWebOrigin?: string;
  githubApiOrigin?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
}

export interface AccountService {
  state(): AccountLoginState;
  startLogin(input?: { relayUrl?: string; githubClientId?: string }): Promise<AccountLoginState>;
  cancelLogin(): void;
  markState(state: MeshDeviceState): void;
  logout(): Promise<void>;
  lastError(): string | null;
  onChange(listener: (state: AccountLoginState) => void): () => void;
  close(): void;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function createAccountService(options: AccountServiceOptions): AccountService {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const listeners = new Set<(state: AccountLoginState) => void>();
  const stored = readAccountFile(options.file);
  let current: AccountLoginState = stored === null ? { kind: "signed_out" } : { kind: "signed_in", account: stored };
  let error: string | null = null;
  let polling: AbortController | null = null;
  const github: GithubOptions = { ...(options.fetch ? { fetch: options.fetch } : {}), now, ...(options.githubWebOrigin ? { webOrigin: options.githubWebOrigin } : {}) };

  const set = (next: AccountLoginState) => {
    current = next;
    for (const listener of listeners) listener(next);
  };

  const finish = async (accessToken: string, relayUrl: string) => {
    const login = await verifyGithubToken(accessToken, { ...(options.fetch ? { fetch: options.fetch } : {}), apiOrigin: options.githubApiOrigin ?? GITHUB_API_ORIGIN });
    if (login === null) throw new Error("GitHub 授权没成，请重新登录");
    const registered = await registerWithRelay({ relayUrl, githubToken: accessToken, identity: options.identity, device: options.device, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const account: AccountFile = { version: 1, relayUrl, accountId: registered.accountId, login, state: registered.state };
    writeAccountFile(options.file, account);
    return account;
  };

  const poll = async (code: GithubDeviceCode, relayUrl: string, clientId: string, signal: AbortSignal) => {
    let interval = code.intervalMs;
    for (;;) {
      await sleep(interval, signal);
      if (now() > code.expiresAt) throw new Error("登录码过期了，请重新登录");
      const result = await pollGithubDeviceToken(clientId, code.deviceCode, github);
      if (signal.aborted) return;
      if (result.kind === "pending") continue;
      if (result.kind === "slow_down") {
        interval = result.intervalMs;
        continue;
      }
      if (result.kind === "denied") throw new Error("你在 GitHub 上拒绝了授权");
      if (result.kind === "expired") throw new Error("登录码过期了，请重新登录");
      const account = await finish(result.accessToken, relayUrl);
      if (signal.aborted) return;
      polling = null;
      options.log(`账号：已登录 ${account.login.login}（${account.state === "active" ? "可用" : "等批准"}）`);
      set({ kind: "signed_in", account });
      return;
    }
  };

  return {
    state: () => current,
    async startLogin(input) {
      if (current.kind === "signed_in") throw new Error("已经登录了，先退出再换账号");
      if (current.kind === "signing_in") return current;
      const relayUrl = input?.relayUrl ?? options.relayUrl;
      const clientId = input?.githubClientId?.trim() || options.githubClientId;
      if (relayUrl === "") throw new Error("还没配中继网址：在设置里填自建中继的网址");
      if (clientId === "") throw new Error("这个版本还没配 GitHub 登录：请设环境变量 FUSA_GITHUB_CLIENT_ID 或在登录时指定 clientId");
      try {
        new URL(relayUrl);
      } catch {
        throw new Error("中继网址不对");
      }
      error = null;
      const code = await requestGithubDeviceCode(clientId, github);
      const controller = new AbortController();
      polling = controller;
      set({ kind: "signing_in", userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: code.expiresAt });
      poll(code, relayUrl, clientId, controller.signal).catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        polling = null;
        error = failure instanceof Error ? failure.message : "登录失败";
        options.log(`账号：登录没成：${error}`);
        set({ kind: "signed_out" });
      });
      return current;
    },
    cancelLogin() {
      if (polling === null) return;
      polling.abort();
      polling = null;
      set({ kind: "signed_out" });
    },
    markState(state) {
      if (current.kind !== "signed_in" || current.account.state === state) return;
      const account = { ...current.account, state };
      writeAccountFile(options.file, account);
      set({ kind: "signed_in", account });
    },
    async logout() {
      polling?.abort();
      polling = null;
      rmSync(options.file, { force: true });
      set({ kind: "signed_out" });
    },
    lastError: () => error,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      polling?.abort();
      polling = null;
      listeners.clear();
    },
  };
}
