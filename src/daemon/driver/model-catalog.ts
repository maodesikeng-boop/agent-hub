// 模型名单：按厂商分别问本机 CLI 它能用哪些模型（claude 发 stream-json 的 initialize 控制请求；
// agy 跑 `agy --output-format json models`；codex 起 `codex app-server --listen stdio://` 发 model/list）。
// 第一次有人要（网页打开资料页、新建弹窗）时问一次并缓存，旧了在后台再问；问不到（没装、超时、报错、回的不对）
// 用 vendors.ts 打包的名单，不报错。厂商相关的取值（思考程度、模型名规则）仍以 vendors.ts 为准。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  AGENT_VENDORS,
  KILL_WAIT_MS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_FRESH_MS,
  MODEL_CATALOG_RETRY_MS,
  MODEL_CATALOG_TIMEOUT_MS,
  bundledModelCatalog,
  checkModel,
  truncateChars,
  type AgentVendor,
  type CatalogModel,
  type ModelCatalog,
} from "../../shared/index.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { forceKill } from "./process.ts";
import { INITIALIZE_QUERY_ARGS, buildChildEnv, buildInitializeLine } from "./protocol.ts";

/** claude 回应里“默认”那一项的 value：不进名单，它支持的思考程度给“默认”用。 */
const DEFAULT_VALUE = "default";
/** 失败原因里带多少标准错误。 */
const STDERR_TAIL_CHARS = 500;
/** agy 查模型名单的固定参数。 */
export const AGY_MODELS_QUERY_ARGS: readonly string[] = ["--output-format", "json", "models"];
/** agy 查可用 skills 的固定参数。 */
export const AGY_SKILLS_QUERY_ARGS: readonly string[] = ["-p", "/skills", "--output-format", "json"];
/** codex 起 app-server 的固定参数。 */
export const CODEX_APP_SERVER_ARGS: readonly string[] = ["app-server", "--listen", "stdio://"];
const CODEX_CLIENT_INFO = { name: "agent-hub", version: "0.1.0" } as const;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 一项的思考程度：给了列表就按列表（去掉不是字符串的、重复的）；明说不支持是空的；没说是 null。 */
function effortsOf(entry: Record<string, unknown>): string[] | null {
  if (Array.isArray(entry.supportedEffortLevels)) {
    return [...new Set(entry.supportedEffortLevels.filter((e): e is string => typeof e === "string"))];
  }
  return entry.supportsEffort === false ? [] : null;
}

/**
 * initialize 回应里的 models → 名单。value 要是合规的模型名（vendors.ts 的 checkModel），不合规、重复的跳过；
 * 一个能用的都没有（或者根本不是数组）返回 null，调用方用打包的名单。
 */
export function parseInitializeModels(raw: unknown): ModelCatalog | null {
  if (!Array.isArray(raw)) return null;
  const models: CatalogModel[] = [];
  let defaultEfforts: string[] | null = null;
  // “默认”实际用哪个模型：default 那项的 resolvedModel，对上名单里哪项（同一个 resolvedModel）就用它的名字
  let defaultResolved: string | null = null;
  const labelOfResolved = new Map<string, string>();
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
    if (resolved !== null && !labelOfResolved.has(resolved)) labelOfResolved.set(resolved, label);
    models.push({
      id,
      label,
      description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS),
      efforts: effortsOf(entry),
    });
    if (models.length === MAX_CATALOG_MODELS) break;
  }
  if (models.length === 0) return null;
  const defaultModel = defaultResolved === null ? null : (labelOfResolved.get(defaultResolved) ?? truncateChars(defaultResolved, MAX_CATALOG_LABEL_CHARS));
  return { ...bundledModelCatalog("claude"), source: "vendor", models, defaultEfforts, defaultModel };
}

function extractAgyModels(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as {
    models?: unknown;
    data?: { models?: unknown };
    command?: { data?: { models?: unknown } };
  };
  if (Array.isArray(r.command?.data?.models)) return r.command.data.models;
  if (Array.isArray(r.data?.models)) return r.data.models;
  if (Array.isArray(r.models)) return r.models;
  return null;
}

/**
 * `agy --output-format json models` 的输出 → 名单。支持完整外层对象 `{ command: { data: { models: [...] } } }` 或直接传数组。
 * 若 `currently_selected === true` 则将其 `label` 记为 `defaultModel`。
 */
export function parseAgyModels(raw: unknown): ModelCatalog | null {
  const list = extractAgyModels(raw);
  if (list === null) return null;
  const models: CatalogModel[] = [];
  let defaultModel: string | null = null;
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.value === "string" ? entry.value : null;
    if (id === null || checkModel("agy", id) !== null || models.some((m) => m.id === id)) continue;
    const label = truncateChars(nonEmptyString(entry.label) ?? nonEmptyString(entry.displayName) ?? id, MAX_CATALOG_LABEL_CHARS);
    const description = nonEmptyString(entry.description);
    if (entry.currently_selected === true || entry.isDefault === true) defaultModel ??= label;
    models.push({
      id,
      label,
      description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS),
      efforts: effortsOf(entry),
    });
    if (models.length === MAX_CATALOG_MODELS) break;
  }
  if (models.length === 0) return null;
  return { ...bundledModelCatalog("agy"), source: "vendor", models, defaultModel };
}

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
  if (Array.isArray(entry.supportedReasoningEfforts)) {
    const out: string[] = [];
    for (const item of entry.supportedReasoningEfforts) {
      const effort =
        typeof item === "string"
          ? nonEmptyString(item)
          : typeof item === "object" && item !== null
            ? nonEmptyString((item as Record<string, unknown>).reasoningEffort)
            : null;
      if (effort !== null && !out.includes(effort)) out.push(effort);
    }
    return out;
  }
  return effortsOf(entry);
}

/**
 * `codex app-server` 的 `model/list` 回应 → 名单。跳过 `hidden === true` 的项；
 * 从 `supportedReasoningEfforts` 提取思考程度；`isDefault === true` 记为 `defaultModel`。
 */
export function parseCodexModels(raw: unknown): ModelCatalog | null {
  const list = extractCodexModels(raw);
  if (list === null) return null;
  const models: CatalogModel[] = [];
  let defaultModel: string | null = null;
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.hidden === true) continue;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : null;
    if (id === null || checkModel("codex", id) !== null || models.some((m) => m.id === id)) continue;
    const label = truncateChars(nonEmptyString(entry.displayName) ?? nonEmptyString(entry.label) ?? id, MAX_CATALOG_LABEL_CHARS);
    const description = nonEmptyString(entry.description);
    if (entry.isDefault === true) defaultModel ??= label;
    models.push({
      id,
      label,
      description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS),
      efforts: codexEffortsOf(entry),
    });
    if (models.length === MAX_CATALOG_MODELS) break;
  }
  if (models.length === 0) return null;
  return { ...bundledModelCatalog("codex"), source: "vendor", models, defaultModel };
}

export interface ClaudeModelQueryOptions {
  claudePath: string;
  /** 在哪个目录起 claude（守护进程用用户主目录：不带任何项目的设置）。 */
  cwd: string;
  /** 附加文件夹（--add-dir）：问命令列表时和会话一样带上。 */
  addDirs?: readonly string[];
  timeoutMs?: number;
  /** 起 claude 的环境变量，默认守护进程自己的（去掉父会话那几个，见 buildChildEnv）。 */
  env?: Record<string, string | undefined>;
  /** 关机时取消：结束 claude，Promise 失败。 */
  signal?: AbortSignal;
}

export interface AgyModelQueryOptions {
  agyPath: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
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

/** 起一个 claude，发 initialize 控制请求，返回回应里的 models（原样，交给 parseInitializeModels）。失败同 queryClaudeInitialize。 */
export async function queryClaudeModels(options: ClaudeModelQueryOptions): Promise<unknown> {
  return (await queryClaudeInitialize(options)).models;
}

/**
 * 起一个 claude，发 initialize 控制请求，返回回应（response.response：models、commands……，原样）。
 * 模型名单和会话没在跑时的命令列表（vendors/claude.ts）都用它。
 * 拿到回应就关标准输入让它自己退出，KILL_WAIT_MS 内没退出连同后代强制结束；超时、出错、取消都强制结束。
 * claude 不存在、没回就退出、回了错误、超时都是 Promise 失败（带原因）。
 */
export function queryClaudeInitialize(options: ClaudeModelQueryOptions): Promise<Record<string, unknown>> {
  const { claudePath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  const args = [...INITIALIZE_QUERY_ARGS];
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const child = spawn(claudePath, args, {
      cwd,
      env: buildChildEnv(options.env ?? process.env, undefined),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const requestId = `initialize-${randomUUID()}`;
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
        void forceKill(child);
        reject(error);
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
    child.stdin.on("error", () => {}); // 进程先退出时写入会 EPIPE，以 exit 为准
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, sig) => {
      // 留一点时间把标准输出最后几行读完再判“没回就退出”
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
      if (o.response.subtype === "success") finish(null, typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});
      else finish(new Error(`claude 回了错误：${typeof o.response.error === "string" ? o.response.error : JSON.stringify(o.response)}`));
    });
    child.stdin.write(`${buildInitializeLine(requestId)}\n`);
  });
}

function parseJsonOutput(stdout: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = stdout.trim();
  if (trimmed === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const lines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return { ok: true, value: JSON.parse(lines[i]!) };
      } catch {
        // 跳过非 JSON 行
      }
    }
    return { ok: false };
  }
}

function runAgyJsonCommand(options: AgyModelQueryOptions, args: readonly string[], label: string): Promise<unknown> {
  const { agyPath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const child = spawn(agyPath, [...args], {
      cwd,
      env: buildChildEnv(options.env ?? process.env, undefined),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        void forceKill(child);
        reject(error);
        return;
      }
      if (!exited()) {
        killTimer = setTimeout(() => void forceKill(child), KILL_WAIT_MS);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
      }
      resolve(result);
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error(`agy 超时（${timeoutMs} ms 没回 ${label}）`)), timeoutMs);

    child.once("error", (error) => finish(new Error(`${agyPath}: ${error.message}`)));
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("close", (code, sig) => {
      if (code === 0) {
        const parsed = parseJsonOutput(stdout);
        if (parsed.ok) {
          finish(null, parsed.value);
          return;
        }
        finish(new Error(`agy 没回有效 JSON（${label}）${stderr.trim() ? `：${stderr.trim()}` : ""}`));
        return;
      }
      finish(new Error(`agy 没回 ${label} 就退出了（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`));
    });
  });
}

/** 起 `agy --output-format json models`，返回解析后的 JSON（原样交给 parseAgyModels）。 */
export function queryAgyModels(options: AgyModelQueryOptions): Promise<unknown> {
  return runAgyJsonCommand(options, AGY_MODELS_QUERY_ARGS, "models");
}

/** 起 `agy -p "/skills" --output-format json`，返回解析后的 JSON（原样交给 parseAgyCommands）。 */
export function queryAgySkills(options: AgyModelQueryOptions): Promise<unknown> {
  return runAgyJsonCommand(options, AGY_SKILLS_QUERY_ARGS, "skills");
}

function queryCodexAppServer(options: CodexModelQueryOptions, method: string, params: Record<string, unknown>): Promise<unknown> {
  const { codexPath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const child = spawn(codexPath, [...CODEX_APP_SERVER_ARGS], {
      cwd,
      env: buildChildEnv(options.env ?? process.env, undefined),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        void forceKill(child);
        reject(error);
        return;
      }
      child.stdin.end();
      if (!exited()) {
        killTimer = setTimeout(() => void forceKill(child), KILL_WAIT_MS);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
      }
      resolve(result);
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error(`codex 超时（${timeoutMs} ms 没回 ${method}）`)), timeoutMs);

    child.once("error", (error) => finish(new Error(`${codexPath}: ${error.message}`)));
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, sig) => {
      setTimeout(() => finish(new Error(`codex 没回 ${method} 就退出了（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`)), 50);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof obj !== "object" || obj === null) return;
      const o = obj as { id?: unknown; result?: unknown; error?: { message?: unknown } | unknown };
      if (o.id === 1 && o.error !== undefined) {
        const msg = typeof (o.error as { message?: unknown })?.message === "string" ? (o.error as { message: string }).message : JSON.stringify(o.error);
        finish(new Error(`codex 回了错误：${msg}`));
        return;
      }
      if (o.id !== 2) return;
      if (o.error !== undefined) {
        const msg = typeof (o.error as { message?: unknown })?.message === "string" ? (o.error as { message: string }).message : JSON.stringify(o.error);
        finish(new Error(`codex 回了错误：${msg}`));
        return;
      }
      const res = o.result;
      const data = typeof res === "object" && res !== null && Array.isArray((res as { data?: unknown }).data) ? (res as { data: unknown[] }).data : res;
      finish(null, data ?? {});
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: CODEX_CLIENT_INFO } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })}\n`);
  });
}

/** 起 `codex app-server --listen stdio://`，发 initialize → initialized → model/list，返回模型列表数据。 */
export function queryCodexModels(options: CodexModelQueryOptions): Promise<unknown> {
  return queryCodexAppServer(options, "model/list", {});
}

/** 起 `codex app-server --listen stdio://`，发 initialize → initialized → skills/list，返回 skills 数据。 */
export function queryCodexSkills(options: CodexModelQueryOptions): Promise<unknown> {
  const cwds = [options.cwd, ...(options.addDirs ?? [])];
  return queryCodexAppServer(options, "skills/list", { cwds });
}

export interface ModelCatalogsOptions {
  /** 问一次 claude，返回 initialize 回应里的 models（守护进程接 queryClaudeModels）。 */
  queryClaude: (signal: AbortSignal) => Promise<unknown>;
  /** 问一次 agy，返回 models 的回应（守护进程接 queryAgyModels）。没传就不问，直接用打包的。 */
  queryAgy?: (signal: AbortSignal) => Promise<unknown>;
  /** 问一次 codex，返回 model/list 的回应（守护进程接 queryCodexModels）。没传就不问，直接用打包的。 */
  queryCodex?: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ModelCatalogs {
  /** 每家厂商一份（按 AGENT_VENDORS 的顺序），不会失败。refresh：不管新不新都重新问一次，问完再回。 */
  list(options?: { refresh?: boolean }): Promise<ModelCatalog[]>;
  /** 现在缓存着的那份（不问厂商、不等），还没问到过是 null。账本写系统消息时用。 */
  current(vendor: AgentVendor): ModelCatalog | null;
  /** 关机：取消在问的那次，之后不再问。 */
  close(): void;
}

interface VendorCatalogSlot {
  readonly vendor: AgentVendor;
  readonly query: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  readonly parse: (raw: unknown) => ModelCatalog | null;
  cached: ModelCatalog | null;
  cachedAt: number;
  failedAt: number | null;
  inflight: Promise<void> | null;
}

/**
 * 模型名单的缓存（三家厂商各自独立缓存、并行查询）：
 * - 没配查询函数的厂商：不发请求，直接回打包的名单，current 返回 null；
 * - 还没问到过：第一次要时问，等它问完（同时来的几次只问一次）；
 * - 问到了：直接给；超过 MODEL_CATALOG_FRESH_MS 就在后台再问，先给旧的；后台没问到继续用旧的；
 * - 没问到：用打包的名单，MODEL_CATALOG_RETRY_MS 之后有人要时再问。
 */
export function createModelCatalogs(options: ModelCatalogsOptions): ModelCatalogs {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let closed = false;
  const controller = new AbortController();

  const slots: Record<AgentVendor, VendorCatalogSlot> = {
    claude: {
      vendor: "claude",
      query: options.queryClaude,
      parse: parseInitializeModels,
      cached: null,
      cachedAt: 0,
      failedAt: null,
      inflight: null,
    },
    agy: {
      vendor: "agy",
      query: options.queryAgy,
      parse: parseAgyModels,
      cached: null,
      cachedAt: 0,
      failedAt: null,
      inflight: null,
    },
    codex: {
      vendor: "codex",
      query: options.queryCodex,
      parse: parseCodexModels,
      cached: null,
      cachedAt: 0,
      failedAt: null,
      inflight: null,
    },
  };

  const ask = (slot: VendorCatalogSlot): Promise<void> => {
    if (!slot.query) return Promise.resolve();
    const query = slot.query;
    slot.inflight ??= (async () => {
      let reason: string;
      try {
        const catalog = slot.parse(await query(controller.signal));
        if (catalog !== null) {
          slot.cached = catalog;
          slot.cachedAt = now();
          slot.failedAt = null;
          return;
        }
        reason = "回的名单是空的或者认不出";
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      slot.failedAt = now();
      if (!closed) log(`${LOG_PREFIX} 没问到 ${slot.vendor} 的模型名单（${reason}），先用打包的`);
    })().finally(() => {
      slot.inflight = null;
    });
    return slot.inflight;
  };

  const catalogOf = async (slot: VendorCatalogSlot, refresh: boolean): Promise<ModelCatalog> => {
    if (!slot.query) return bundledModelCatalog(slot.vendor);
    if (closed) return slot.cached ?? bundledModelCatalog(slot.vendor);
    if (refresh) await ask(slot);
    else if (slot.cached === null) {
      if (slot.inflight || slot.failedAt === null || now() - slot.failedAt >= MODEL_CATALOG_RETRY_MS) await ask(slot);
    } else if (
      !slot.inflight &&
      now() - slot.cachedAt >= MODEL_CATALOG_FRESH_MS &&
      (slot.failedAt === null || now() - slot.failedAt >= MODEL_CATALOG_RETRY_MS)
    ) {
      void ask(slot);
    }
    return slot.cached ?? bundledModelCatalog(slot.vendor);
  };

  return {
    async list(opts = {}) {
      const refresh = opts.refresh === true;
      return Promise.all(AGENT_VENDORS.map((vendor) => catalogOf(slots[vendor], refresh)));
    },
    current(vendor) {
      return slots[vendor]?.cached ?? null;
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
}
