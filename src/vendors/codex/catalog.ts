import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import {
  CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MAX_CODEX_MODELS_CACHE_BYTES,
  MODEL_CATALOG_TIMEOUT_MS,
  bundledModelCatalog,
  checkModel,
  mergeCatalogEfforts,
  truncateChars,
  type CatalogModel,
  type ModelCatalog,
  type VendorAvailability,
} from "../../shared/index.ts";
import { CODEX_OPTIONAL_RPC_GRACE_MS } from "./limits.ts";
import spec from "./spec.ts";
import { vendorConfigHome } from "../../shared/paths.ts";
import {
  STDERR_TAIL_CHARS,
  effortsOf,
  nonEmptyString,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import { closeAndWaitChild, killChildAndWait, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";
import { buildCodexArgs, CODEX_CLIENT_INFO } from "./protocol.ts";

function extractCodexModels(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as {
    data?: unknown;
    models?: unknown;
    result?: { data?: unknown; models?: unknown };
  };
  if (Array.isArray(r.data)) return r.data;
  if (Array.isArray(r.models)) return r.models;
  if (Array.isArray(r.result?.data)) return r.result.data;
  if (Array.isArray(r.result?.models)) return r.result.models;
  return null;
}

function codexEffortsOf(entry: Record<string, unknown>): string[] | null {
  const levels = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
      : null;
  if (levels !== null) {
    const out: string[] = [];
    for (const item of levels) {
      const effort =
        typeof item === "string"
          ? nonEmptyString(item)
          : typeof item === "object" && item !== null
            ? (nonEmptyString((item as Record<string, unknown>).reasoningEffort) ??
              nonEmptyString((item as Record<string, unknown>).effort))
            : null;
      if (effort !== null && !out.includes(effort)) out.push(effort);
    }
    return out;
  }
  return effortsOf(entry);
}

export function parseCodexModels(raw: unknown): ModelCatalog | null {
  const list = extractCodexModels(raw);
  if (list === null) return null;
  const parsed: Array<{
    readonly model: CatalogModel;
    readonly isDefault: boolean;
    readonly priority: number | null;
    readonly index: number;
  }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.hidden === true || entry.visibility === "hide" || entry.visibility === "none") continue;
    const id = nonEmptyString(entry.id) ?? nonEmptyString(entry.model) ?? nonEmptyString(entry.slug);
    if (id === null || checkModel("codex", id) !== null || seen.has(id)) continue;
    seen.add(id);
    const label = truncateChars(
      nonEmptyString(entry.displayName) ?? nonEmptyString(entry.display_name) ?? nonEmptyString(entry.label) ?? id,
      MAX_CATALOG_LABEL_CHARS,
    );
    const description = nonEmptyString(entry.description);
    const efforts = codexEffortsOf(entry);
    const priority = typeof entry.priority === "number" && Number.isFinite(entry.priority) ? entry.priority : null;
    parsed.push({
      model: {
        id,
        label,
        description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS),
        efforts,
      },
      isDefault: entry.isDefault === true,
      priority,
      index: i,
    });
  }
  if (parsed.length === 0) return null;
  if (parsed.some((item) => item.priority !== null)) {
    parsed.sort((a, b) => {
      const pa = a.priority ?? Number.POSITIVE_INFINITY;
      const pb = b.priority ?? Number.POSITIVE_INFINITY;
      return pa !== pb ? pa - pb : a.index - b.index;
    });
  }
  const limited = parsed.slice(0, MAX_CATALOG_MODELS);
  const chosen = limited.find((item) => item.isDefault) ?? (limited[0]!.priority !== null ? limited[0] : undefined);
  const models = limited.map((item) => item.model);
  const defaultModel = chosen?.model.label ?? null;
  const defaultModelId = chosen?.model.id ?? null;
  const defaultEfforts = chosen?.model.efforts ?? null;
  const efforts = mergeCatalogEfforts(spec.models.efforts, models, defaultEfforts);
  return { ...bundledModelCatalog("codex"), source: "vendor", efforts, models, defaultEfforts, defaultModel, defaultModelId };
}

export interface CodexModelQueryOptions {
  codexPath: string;
  cwd: string;
  addDirs?: readonly string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

interface CodexCall {
  method: string;
  params: Record<string, unknown>;
  optional?: boolean;
}

export class CodexRpcError extends Error {
  readonly rpcMessage: string;

  constructor(rpcMessage: string) {
    super(`codex 回了错误：${rpcMessage}`);
    this.rpcMessage = rpcMessage;
  }
}

interface CodexAppServerOutcome {
  readonly results: unknown[];
  readonly remoteRefreshFailed: boolean;
}

function runCodexAppServer(options: CodexModelQueryOptions, calls: readonly CodexCall[]): Promise<CodexAppServerOutcome> {
  const { codexPath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  const label = calls.map((c) => c.method).join("、");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      spawned = spawnOwnedProcess(codexPath, buildCodexArgs(), {
        cwd,
        env: buildChildEnv(options.env ?? process.env, undefined),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(err);
    }
    const { child, detached } = spawned;
    trackChild(child, "probe:codex-app-server", { detached });
    let stderr = "";
    let remoteRefreshFailed = false;
    let settled = false;
    let exitTimer: NodeJS.Timeout | undefined;
    const rl = createInterface({ input: child.stdout });
    const results: unknown[] = new Array(calls.length);
    let pending = calls.length;
    let requiredPending = calls.filter((c) => !c.optional).length;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(exitTimer);
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      if (error) {
        void killChildAndWait(child).finally(() => reject(error));
        return;
      }
      void closeAndWaitChild(child, { signal }).finally(() => resolve({ results, remoteRefreshFailed }));
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error(`codex 超时（${timeoutMs} ms 没回 ${label}）`)), timeoutMs);
    const errorText = (error: unknown) => {
      const { message, code } = (typeof error === "object" && error !== null ? error : {}) as { message?: unknown; code?: unknown };
      if (typeof message === "string" && message !== "") return message;
      return typeof code === "number" || typeof code === "string" ? `未知错误（错误码 ${code}）` : "未知错误";
    };

    child.once("error", (error) => finish(new Error(`${codexPath}: ${error.message}`)));
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const combined = stderr + chunk;
      if (!remoteRefreshFailed && isCodexRemoteRefreshFailure(combined)) remoteRefreshFailed = true;
      stderr = combined.slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, sig) => {
      termGroupAfterExit(child);
      exitTimer = setTimeout(() => finish(new Error(`codex 没回 ${label} 就退出了（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`)), 50);
    });
    rl.on("line", (line) => {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof obj !== "object" || obj === null) return;
      const o = obj as { id?: unknown; result?: unknown; error?: unknown };
      if (o.id === 1 && o.error !== undefined) {
        finish(new Error(`codex 回了错误：${errorText(o.error)}`));
        return;
      }
      const index = typeof o.id === "number" ? o.id - 2 : -1;
      const call = calls[index];
      if (call === undefined || index in results) return;
      if (o.error !== undefined) {
        if (!call.optional) {
          finish(new CodexRpcError(errorText(o.error)));
          return;
        }
        results[index] = undefined;
      } else {
        const res = o.result;
        results[index] = typeof res === "object" && res !== null && Array.isArray((res as { data?: unknown }).data) ? (res as { data: unknown[] }).data : (res ?? {});
      }
      pending -= 1;
      if (!call.optional) requiredPending -= 1;
      if (pending === 0) finish(null);
      // Older versions may never answer optional methods; wait briefly, then give up.
      else if (requiredPending === 0) graceTimer ??= setTimeout(() => finish(null), CODEX_OPTIONAL_RPC_GRACE_MS);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: CODEX_CLIENT_INFO } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    calls.forEach((call, i) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: call.method, params: call.params })}\n`));
  });
}

export async function queryCodexAppServer(options: CodexModelQueryOptions, calls: readonly CodexCall[]): Promise<unknown[]> {
  return (await runCodexAppServer(options, calls)).results;
}

export async function queryCodexModels(options: CodexModelQueryOptions): Promise<unknown> {
  return (await queryCodexAppServer(options, [{ method: "model/list", params: {} }]))[0];
}

export interface CodexCatalogQueryResult {
  models: unknown;
  account: unknown;
  degraded?: boolean;
}

export interface CodexModelsCacheFallbackOptions {
  codexHome: string;
  account: unknown;
  nowMs?: number;
  maxAgeMs?: number;
  maxBytes?: number;
}

const ANSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const CODEX_REMOTE_REFRESH_ERROR = /failed to refresh available models:/i;

export function isCodexRemoteRefreshFailure(stderr: string): boolean {
  if (stderr === "") return false;
  return CODEX_REMOTE_REFRESH_ERROR.test(stderr.replace(ANSI_ESCAPE, ""));
}

function isChatGptAccount(accountResult: unknown): boolean {
  if (typeof accountResult !== "object" || accountResult === null) return false;
  const inner = (accountResult as { account?: unknown }).account;
  return typeof inner === "object" && inner !== null && (inner as { type?: unknown }).type === "chatgpt";
}

function readBoundedCacheFile(cachePath: string, authPath: string, maxBytes: number): { text: string; mtimeMs: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(cachePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
    try {
      if (statSync(authPath).mtimeMs > st.mtimeMs) return null;
    } catch {
      // auth.json may be absent when credentials live in the OS keyring.
    }
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return { text: buf.subarray(0, offset).toString("utf8"), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}

export function readCodexModelsCacheFallback(options: CodexModelsCacheFallbackOptions): unknown | null {
  if (!isChatGptAccount(options.account)) return null;
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? CODEX_MODELS_CACHE_FALLBACK_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? MAX_CODEX_MODELS_CACHE_BYTES;
  const file = readBoundedCacheFile(join(options.codexHome, "models_cache.json"), join(options.codexHome, "auth.json"), maxBytes);
  if (file === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fetchedAt = (parsed as { fetched_at?: unknown }).fetched_at;
  if (fetchedAt !== undefined) {
    if (typeof fetchedAt !== "string") return null;
    const fetchedMs = Date.parse(fetchedAt);
    if (!Number.isFinite(fetchedMs) || nowMs - fetchedMs > maxAgeMs) return null;
  } else if (nowMs - file.mtimeMs > maxAgeMs) {
    return null;
  }
  return parseCodexModels(parsed) === null ? null : parsed;
}

export async function queryCodexCatalog(options: CodexModelQueryOptions): Promise<CodexCatalogQueryResult> {
  const { results: [models, account], remoteRefreshFailed } = await runCodexAppServer(options, [
    { method: "model/list", params: {} },
    { method: "account/read", params: {}, optional: true },
  ]);
  if (!remoteRefreshFailed) return { models, account };
  const env = options.env ?? process.env;
  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || options.cwd;
  const codexHome = vendorConfigHome("codex", homeDir, env);
  const fallback = codexHome === null ? null : readCodexModelsCacheFallback({ codexHome, account });
  return { models: fallback ?? models, account, degraded: true };
}

export async function queryCodexSkills(options: CodexModelQueryOptions): Promise<unknown> {
  const cwds = [options.cwd, ...(options.addDirs ?? [])];
  return (await queryCodexAppServer(options, [{ method: "skills/list", params: { cwds } }]))[0];
}

export const codexCatalogProbe: VendorCatalogProbe = {
  parse: (raw) => parseCodexModels((raw as { models?: unknown } | null)?.models),
  isDegraded: (raw) => (raw as { degraded?: unknown } | null)?.degraded === true,
  availabilityOf(raw) {
    const read = (raw as { account?: unknown } | null)?.account;
    if (typeof read !== "object" || read === null || !("account" in read)) return "unknown";
    const { account, requiresOpenaiAuth } = read as { account: unknown; requiresOpenaiAuth?: unknown };
    if (typeof account === "object" && account !== null) return "available";
    return requiresOpenaiAuth === false ? "available" : "signed_out";
  },
};

function codexCredentialsStore(codexHome: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) return null;
    const match = /^cli_auth_credentials_store\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(trimmed);
    if (match) return match[1] ?? match[2] ?? null;
  }
  return null;
}

// auth.json may be absent when cli_auth_credentials_store is keyring or auto.
export function codexAuthFileAvailability(env: NodeJS.ProcessEnv, homeDir: string): VendorAvailability {
  const codexHome = vendorConfigHome("codex", homeDir, env)!;
  if (existsSync(join(codexHome, "auth.json"))) return "available";
  const store = codexCredentialsStore(codexHome);
  return store === "keyring" || store === "auto" ? "unknown" : "signed_out";
}

export function createCodexCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...codexCatalogProbe,
    query: (signal) => {
      const codexPath = typeof options.path === "function" ? options.path() : options.path;
      const env = typeof options.env === "function" ? options.env() : options.env;
      return queryCodexCatalog({ codexPath, cwd: options.cwd, ...(env ? { env } : {}), signal });
    },
    confirm: async () => {
      const env = typeof options.env === "function" ? options.env() : (options.env ?? process.env);
      return codexAuthFileAvailability(env, options.cwd);
    },
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}
