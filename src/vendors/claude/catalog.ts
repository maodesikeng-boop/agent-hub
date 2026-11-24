import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import spec from "./spec.ts";
import {
  STDERR_TAIL_CHARS,
  effortsOf,
  killThenSettle,
  nonEmptyString,
  parseJsonOutput,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import { forceKill, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";
import { INITIALIZE_QUERY_ARGS, buildInitializeLine } from "./protocol.ts";

const DEFAULT_VALUE = "default";

export function parseInitializeModels(raw: unknown): ModelCatalog | null {
  if (!Array.isArray(raw)) return null;
  const models: CatalogModel[] = [];
  let defaultEfforts: string[] | null = null;
  let defaultResolved: string | null = null;
  const labelOfResolved = new Map<string, string>();
  const effortsOfResolved = new Map<string, string[]>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.value === "string" ? entry.value : null;
    if (id === null) continue;
    const resolved = nonEmptyString(entry.resolvedModel);
    if (id === DEFAULT_VALUE) {
      defaultEfforts = effortsOf(entry);
      defaultResolved = resolved;
      continue;
    }
    if (checkModel("claude", id) !== null || models.some((m) => m.id === id)) continue;
    const description = nonEmptyString(entry.description);
    const label = truncateChars(nonEmptyString(entry.displayName) ?? id, MAX_CATALOG_LABEL_CHARS);
    const efforts = effortsOf(entry);
    if (resolved !== null) {
      if (!labelOfResolved.has(resolved)) labelOfResolved.set(resolved, label);
      if (efforts !== null && !effortsOfResolved.has(resolved)) effortsOfResolved.set(resolved, efforts);
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
  if (defaultEfforts === null && defaultResolved !== null) defaultEfforts = effortsOfResolved.get(defaultResolved) ?? null;
  const defaultModel = defaultResolved === null ? null : (labelOfResolved.get(defaultResolved) ?? truncateChars(defaultResolved, MAX_CATALOG_LABEL_CHARS));
  const efforts = mergeCatalogEfforts(spec.models.efforts, models, defaultEfforts);
  return { ...bundledModelCatalog("claude"), source: "vendor", efforts, models, defaultEfforts, defaultModel };
}

export interface ClaudeModelQueryOptions {
  claudePath: string;
  cwd: string;
  addDirs?: readonly string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export async function queryClaudeModels(options: ClaudeModelQueryOptions): Promise<unknown> {
  return (await queryClaudeInitialize(options)).models;
}

export function queryClaudeInitialize(options: ClaudeModelQueryOptions): Promise<Record<string, unknown>> {
  return queryClaudeControl(options);
}

export function queryClaudeControl(options: ClaudeModelQueryOptions, afterInitialize?: "get_usage"): Promise<Record<string, unknown>> {
  const { claudePath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  const args = [...INITIALIZE_QUERY_ARGS];
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      spawned = spawnOwnedProcess(claudePath, args, {
        cwd,
        env: buildChildEnv(options.env ?? process.env, undefined),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(err);
    }
    const { child, detached } = spawned;
    trackChild(child, "probe:claude-initialize", { detached });
    let requestId = `initialize-${randomUUID()}`;
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const finish = (error: Error | null, response?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      resolve(response ?? {});
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error(`claude 超时（${timeoutMs} ms 没回 initialize）`)), timeoutMs);

    child.once("error", (error) => finish(new Error(`${claudePath}: ${error.message}`)));
    child.stdin.on("error", () => {}); // Writing after the process exits throws EPIPE; the exit event decides.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, sig) => {
      termGroupAfterExit(child);
      // Let stdout drain before treating an exit as no reply.
      setTimeout(() => finish(new Error(`claude 没回 initialize 就退出了（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`)), 50);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      const o = obj as { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; error?: unknown; response?: unknown } };
      if (o?.type !== "control_response" || o.response?.request_id !== requestId) return;
      const body = o.response.response;
      if (o.response.subtype !== "success") {
        finish(new Error(`claude 回了错误：${typeof o.response.error === "string" ? o.response.error : JSON.stringify(o.response)}`));
      } else if (afterInitialize && requestId.startsWith("initialize-")) {
        requestId = afterInitialize;
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: afterInitialize } })}\n`);
      } else {
        finish(null, typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});
      }
    });
    child.stdin.write(`${buildInitializeLine(requestId)}\n`);
  });
}

const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = ["auth", "status", "--json"];

export function queryClaudeAuthStatus(options: ClaudeModelQueryOptions): Promise<VendorAvailability> {
  const { claudePath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("unknown");
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      spawned = spawnOwnedProcess(claudePath, [...CLAUDE_AUTH_STATUS_ARGS], {
        cwd,
        env: buildChildEnv(options.env ?? process.env, undefined),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return resolve("unknown");
    }
    const { child, detached } = spawned;
    trackChild(child, "probe:claude-auth-status", { detached });
    child.once("exit", () => termGroupAfterExit(child));
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.stderr.resume();
    let stdout = "";
    let settled = false;
    const finish = (result: VendorAvailability) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) killThenSettle(child, () => resolve(result));
      else resolve(result);
    };
    const onAbort = () => finish("unknown");
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish("unknown"), timeoutMs);
    child.once("error", (error) => finish((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_installed" : "unknown"));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("close", () => {
      const parsed = parseJsonOutput(stdout);
      const loggedIn = parsed.ok ? (parsed.value as { loggedIn?: unknown } | null)?.loggedIn : undefined;
      finish(loggedIn === true ? "available" : loggedIn === false ? "signed_out" : "unknown");
    });
  });
}

const CLAUDE_MANAGED_KEY_ENVS: readonly string[] = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

function hasClaudeKeyEnv(env: Record<string, string | undefined> | undefined): boolean {
  if (!env) return false;
  return CLAUDE_MANAGED_KEY_ENVS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

export const claudeCatalogProbe: VendorCatalogProbe = {
  parse: (raw) => parseInitializeModels((raw as { models?: unknown } | null)?.models),
  availabilityOf() {
    // initialize reads oauthAccount from .claude.json even when credentials are missing or failed to save.
    return "unknown";
  },
};

export function createClaudeCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  const resolveEnv = () => (typeof options.env === "function" ? options.env() : options.env);
  const resolveOpts = () => {
    const claudePath = typeof options.path === "function" ? options.path() : options.path;
    const env = resolveEnv();
    return { claudePath, cwd: options.cwd, ...(env ? { env } : {}) };
  };
  return {
    ...claudeCatalogProbe,
    availabilityOf: () => (hasClaudeKeyEnv(resolveEnv()) ? "available" : "unknown"),
    query: (signal) => queryClaudeInitialize({ ...resolveOpts(), signal }),
    confirm: (signal) => queryClaudeAuthStatus({ ...resolveOpts(), signal }),
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}
