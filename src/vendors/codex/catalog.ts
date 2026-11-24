import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import {
  KILL_WAIT_MS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
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
  killThenSettle,
  nonEmptyString,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import { forceKill, termGroupAfterExit } from "../../daemon/driver/process.ts";
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
  const models: CatalogModel[] = [];
  let defaultModel: string | null = null;
  let defaultModelId: string | null = null;
  let defaultEfforts: string[] | null = null;
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.hidden === true || entry.visibility === "hide" || entry.visibility === "none") continue;
    const id = nonEmptyString(entry.id) ?? nonEmptyString(entry.model) ?? nonEmptyString(entry.slug);
    if (id === null || checkModel("codex", id) !== null || models.some((m) => m.id === id)) continue;
    const label = truncateChars(
      nonEmptyString(entry.displayName) ?? nonEmptyString(entry.display_name) ?? nonEmptyString(entry.label) ?? id,
      MAX_CATALOG_LABEL_CHARS,
    );
    const description = nonEmptyString(entry.description);
    const efforts = codexEffortsOf(entry);
    if (entry.isDefault === true && defaultModelId === null) {
      defaultModel = label;
      defaultModelId = id;
      defaultEfforts = efforts;
    }
    models.push({
      id,
      label,
      description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS),
      efforts,
    });
    if (models.length === MAX_CATALOG_MODELS) break;
  }
  if (models.length === 0) return null;
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

export function queryCodexAppServer(options: CodexModelQueryOptions, calls: readonly CodexCall[]): Promise<unknown[]> {
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
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const results: unknown[] = new Array(calls.length);
    let pending = calls.length;
    let requiredPending = calls.filter((c) => !c.optional).length;
    let graceTimer: NodeJS.Timeout | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        killThenSettle(child, () => reject(error));
        return;
      }
      child.stdin.end();
      if (!exited()) {
        killTimer = setTimeout(() => void forceKill(child), KILL_WAIT_MS);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
      }
      resolve(results);
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
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, sig) => {
      termGroupAfterExit(child);
      setTimeout(() => finish(new Error(`codex 没回 ${label} 就退出了（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`)), 50);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
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
          finish(new Error(`codex 回了错误：${errorText(o.error)}`));
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

export async function queryCodexModels(options: CodexModelQueryOptions): Promise<unknown> {
  return (await queryCodexAppServer(options, [{ method: "model/list", params: {} }]))[0];
}

export async function queryCodexCatalog(options: CodexModelQueryOptions): Promise<{ models: unknown; account: unknown }> {
  const [models, account] = await queryCodexAppServer(options, [
    { method: "model/list", params: {} },
    { method: "account/read", params: {}, optional: true },
  ]);
  return { models, account };
}

export async function queryCodexSkills(options: CodexModelQueryOptions): Promise<unknown> {
  const cwds = [options.cwd, ...(options.addDirs ?? [])];
  return (await queryCodexAppServer(options, [{ method: "skills/list", params: { cwds } }]))[0];
}

export const codexCatalogProbe: VendorCatalogProbe = {
  parse: (raw) => parseCodexModels((raw as { models?: unknown } | null)?.models),
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
