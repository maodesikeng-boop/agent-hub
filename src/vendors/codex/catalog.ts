// OpenAI Codex 的模型名单和登录状态（docs/vendor-availability-design.md 第 3 节、docs/vendor-plugin-design.md 的 C5）：
// 起 `codex app-server --listen stdio://`，同一个进程里问 model/list 和 account/read；老版本没有 account/read 时读凭据文件补充判断。
// 会话没在跑时问 skills/list 也在这里（composer.ts 用）。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  CODEX_OPTIONAL_RPC_GRACE_MS,
  KILL_WAIT_MS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_TIMEOUT_MS,
  VENDOR_SPECS,
  bundledModelCatalog,
  checkModel,
  mergeCatalogEfforts,
  truncateChars,
  type CatalogModel,
  type ModelCatalog,
  type VendorAvailability,
} from "../../shared/index.ts";
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

/** codex 起 app-server 的固定参数。 */
const CODEX_APP_SERVER_ARGS: readonly string[] = ["app-server", "--listen", "stdio://"];
const CODEX_CLIENT_INFO = { name: "agent-hub", version: "0.1.0" } as const;

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

/**
 * `codex app-server` 的 `model/list` 回应（或 `models_cache.json`）→ 名单。跳过 `hidden === true` / `visibility === "hide"` 的项；
 * 从 `supportedReasoningEfforts` 提取思考程度；`isDefault === true` 记为 `defaultModel`、`defaultModelId` 与 `defaultEfforts`。
 */
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
  const efforts = mergeCatalogEfforts(VENDOR_SPECS.codex.efforts, models, defaultEfforts);
  return { ...bundledModelCatalog("codex"), source: "vendor", efforts, models, defaultEfforts, defaultModel, defaultModelId };
}

export interface CodexModelQueryOptions {
  codexPath: string;
  cwd: string;
  /** 附加文件夹：问 skills/list 时和 cwd 一起放进 cwds。 */
  addDirs?: readonly string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** app-server 里要问的一条：optional 的出错了给 undefined，不让整个查询失败。 */
interface CodexCall {
  method: string;
  params: Record<string, unknown>;
  optional?: boolean;
}

/** 起一个 `codex app-server`，initialize → initialized 之后按顺序发 calls，全部回了按顺序返回各自的结果。 */
function queryCodexAppServer(options: CodexModelQueryOptions, calls: readonly CodexCall[]): Promise<unknown[]> {
  const { codexPath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  const label = calls.map((c) => c.method).join("、");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const child = spawn(codexPath, [...CODEX_APP_SERVER_ARGS], {
      cwd,
      env: buildChildEnv(options.env ?? process.env, undefined),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    trackChild(child, "probe:codex-app-server", { detached: true });
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
    // 失败原因只取 message，不把整个错误对象 JSON.stringify 进去（用户看到的话里不出现 `{"`）
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
      // 第 i 条用的编号是 i + 2（1 是 initialize）
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
      // 必需的都回了：可有可无的（老版本不认识的方法可能根本不回）只再等一会儿，没回就是 undefined
      else if (requiredPending === 0) graceTimer ??= setTimeout(() => finish(null), CODEX_OPTIONAL_RPC_GRACE_MS);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: CODEX_CLIENT_INFO } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    calls.forEach((call, i) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: call.method, params: call.params })}\n`));
  });
}

/** 起 `codex app-server --listen stdio://`，发 initialize → initialized → model/list，返回模型列表数据。 */
export async function queryCodexModels(options: CodexModelQueryOptions): Promise<unknown> {
  return (await queryCodexAppServer(options, [{ method: "model/list", params: {} }]))[0];
}

/**
 * 模型名单那次查询（守护进程用这个）：同一个 app-server 里多问一条 account/read 看登录状态，不另起进程。
 * account/read 出错（老版本没有）不影响名单，account 是 undefined。
 */
export async function queryCodexCatalog(options: CodexModelQueryOptions): Promise<{ models: unknown; account: unknown }> {
  const [models, account] = await queryCodexAppServer(options, [
    { method: "model/list", params: {} },
    { method: "account/read", params: {}, optional: true },
  ]);
  return { models, account };
}

/** 起 `codex app-server --listen stdio://`，发 initialize → initialized → skills/list，返回 skills 数据。 */
export async function queryCodexSkills(options: CodexModelQueryOptions): Promise<unknown> {
  const cwds = [options.cwd, ...(options.addDirs ?? [])];
  return (await queryCodexAppServer(options, [{ method: "skills/list", params: { cwds } }]))[0];
}

/** 同一个 app-server 里 account/read 的回应：有账号能用；account 为 null 且要 OpenAI 登录是没登录；没问到说不清。 */
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

/** config.toml 顶层的 cli_auth_credentials_store（一行 key = "值"，到第一个 [表] 为止）；没写、读不了是 null。 */
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

/**
 * 补充判断（老版本没有 account/read、或名单超时时）：codex 登录后默认写 $CODEX_HOME/auth.json（默认 ~/.codex/auth.json），先看它在不在；
 * 不在时看 $CODEX_HOME/config.toml 的 cli_auth_credentials_store：官方文档（https://developers.openai.com/codex/auth#credential-storage）
 * 取值 file（默认）| keyring | auto | ephemeral；keyring、auto 把凭据放进系统钥匙串，auth.json 本来就不在，说不清（unknown，当能用）；
 * 没写、file 等别的值才是没登录。只读这两个文件，不起进程。
 */
export function codexAuthFileAvailability(env: NodeJS.ProcessEnv, homeDir: string): VendorAvailability {
  const codexHome = vendorConfigHome("codex", homeDir, env)!;
  if (existsSync(join(codexHome, "auth.json"))) return "available";
  const store = codexCredentialsStore(codexHome);
  return store === "keyring" || store === "auto" ? "unknown" : "signed_out";
}

export function createCodexCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...codexCatalogProbe,
    query: (signal) => queryCodexCatalog({ codexPath: options.path, cwd: options.cwd, ...(options.env ? { env: options.env } : {}), signal }),
    confirm: async () => codexAuthFileAvailability(options.env ?? process.env, options.cwd),
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}
