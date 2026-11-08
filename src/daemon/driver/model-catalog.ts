// 模型名单：按厂商分别问本机 CLI 它能用哪些模型（claude 发 stream-json 的 initialize 控制请求；
// agy 跑 `agy --output-format json models`；codex 起 `codex app-server --listen stdio://` 发 model/list）。
// 第一次有人要（网页打开资料页、新建弹窗）时问一次并缓存，旧了在后台再问；问不到（没装、超时、报错、回的不对）
// 用 vendors.ts 打包的名单，不报错。厂商相关的取值（思考程度、模型名规则）仍以 vendors.ts 为准。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  AGENT_VENDORS,
  CODEX_OPTIONAL_RPC_GRACE_MS,
  KILL_WAIT_MS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_FRESH_MS,
  MODEL_CATALOG_RETRY_MS,
  MODEL_CATALOG_TIMEOUT_MS,
  VENDOR_SPECS,
  bundledModelCatalog,
  checkModel,
  isSelectable,
  splitEffortSuffix,
  truncateChars,
  type AgentVendor,
  type CatalogModel,
  type ModelCatalog,
  type VendorAvailability,
  vendorFailureOf,
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

/** 名字末尾的“(Medium)”：拆成 { base: 不带档位的名字, tier: 小写的档位词 }。 */
function splitLabelTier(label: string): { base: string; tier: string } | null {
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(label);
  return m === null ? null : { base: m[1]!, tier: m[2]!.trim().toLowerCase() };
}

/**
 * `agy --output-format json models` 的输出 → 名单。支持完整外层对象 `{ command: { data: { models: [...] } } }` 或直接传数组。
 * agy 把思考程度写在模型 ID 里（gemini-4-argon-high / 名字 Gemini 4 Argon (High)），按 Antigravity 软件的做法拆成
 * “模型 + 思考程度”：ID 末尾是 VENDOR_SPECS.agy.efforts 里的档位词（-low、-medium、-high），并且名字末尾括号里是同一个词，
 * 才拆（不看模型名，agy 出新模型照样拆）；同一个不带档位的模型下各档位合成一项，efforts 按清单里的顺序。
 * 拆不开的（不带档位、对不上）原样留着，efforts 是空的：界面不出思考程度下拉，启动时原样传 ID。
 * 若 `currently_selected === true` 则将其不带档位的名字记为 `defaultModel`。
 */
export function parseAgyModels(raw: unknown): ModelCatalog | null {
  const list = extractAgyModels(raw);
  if (list === null) return null;
  const tiers = VENDOR_SPECS.agy.efforts;
  // 不带档位的模型（按第一次出现的顺序）→ 名字、说明、报了哪些档位
  const found = new Map<string, { label: string; description: string | null; efforts: Set<string> }>();
  const seen = new Set<string>();
  let defaultModel: string | null = null;
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.value === "string" ? entry.value : null;
    if (id === null || checkModel("agy", id) !== null || seen.has(id)) continue;
    seen.add(id);
    const fullLabel = nonEmptyString(entry.label) ?? nonEmptyString(entry.displayName) ?? id;
    const idSplit = splitEffortSuffix(id, tiers);
    const labelSplit = splitLabelTier(fullLabel);
    const tiered = idSplit !== null && labelSplit !== null && labelSplit.tier === idSplit.effort;
    const baseId = tiered ? idSplit.base : id;
    const label = truncateChars(tiered ? labelSplit.base : fullLabel, MAX_CATALOG_LABEL_CHARS);
    if (entry.currently_selected === true || entry.isDefault === true) defaultModel ??= label;
    let model = found.get(baseId);
    if (model === undefined) {
      if (found.size === MAX_CATALOG_MODELS) continue;
      const description = nonEmptyString(entry.description);
      model = { label, description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS), efforts: new Set() };
      found.set(baseId, model);
    }
    if (tiered) model.efforts.add(idSplit.effort);
  }
  if (found.size === 0) return null;
  const models: CatalogModel[] = [...found].map(([id, m]) => ({
    id,
    label: m.label,
    description: m.description,
    efforts: tiers.filter((t) => m.efforts.has(t)),
  }));
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
  let defaultModelId: string | null = null;
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.hidden === true) continue;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : null;
    if (id === null || checkModel("codex", id) !== null || models.some((m) => m.id === id)) continue;
    const label = truncateChars(nonEmptyString(entry.displayName) ?? nonEmptyString(entry.label) ?? id, MAX_CATALOG_LABEL_CHARS);
    const description = nonEmptyString(entry.description);
    if (entry.isDefault === true && defaultModelId === null) {
      defaultModel = label;
      defaultModelId = id;
    }
    models.push({
      id,
      label,
      description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS),
      efforts: codexEffortsOf(entry),
    });
    if (models.length === MAX_CATALOG_MODELS) break;
  }
  if (models.length === 0) return null;
  return { ...bundledModelCatalog("codex"), source: "vendor", models, defaultModel, defaultModelId };
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
        // 没登录时 agy 退出码也是 0，打印的是一段话（不是 JSON）：原话带上，判断登录状态要看它
        const said = `${stdout.trim().slice(-STDERR_TAIL_CHARS)} ${stderr.trim()}`.trim();
        finish(new Error(`agy 没回有效 JSON（${label}）${said ? `：${said}` : ""}`));
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
      resolve(results);
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error(`codex 超时（${timeoutMs} ms 没回 ${label}）`)), timeoutMs);
    const errorText = (error: unknown) =>
      typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : JSON.stringify(error);

    child.once("error", (error) => finish(new Error(`${codexPath}: ${error.message}`)));
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, sig) => {
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

/** `claude auth status --json` 的固定参数。 */
export const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = ["auth", "status", "--json"];

/**
 * claude 的补充判断（initialize 回应里看不出登录时才用）：跑 `claude auth status --json`，看 loggedIn。
 * 不会失败：找不到程序是 not_installed，超时、认不出是 unknown。
 */
export function queryClaudeAuthStatus(options: ClaudeModelQueryOptions): Promise<VendorAvailability> {
  const { claudePath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("unknown");
    const child = spawn(claudePath, [...CLAUDE_AUTH_STATUS_ARGS], {
      cwd,
      env: buildChildEnv(options.env ?? process.env, undefined),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
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
      if (child.exitCode === null && child.signalCode === null) void forceKill(child);
      resolve(result);
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

/**
 * 一家厂商的名单从哪来、怎么看它在这台设备上能不能用（各家的实现在 daemon/vendors/<厂商>.ts，按 AGENT_VENDORS 登记在
 * vendors/index.ts 的 createVendorCatalogSources）。登录状态从名单那次查询的回应里看，不另起进程。
 */
export interface VendorCatalogSource {
  /** 问一次（起进程），返回原样的回应。 */
  query: (signal: AbortSignal) => Promise<unknown>;
  /** 回应 → 名单；认不出是 null（用打包的）。 */
  parse: (raw: unknown) => ModelCatalog | null;
  /** 问到了：同一次回应里的登录状态。不写当 available。 */
  availabilityOf?: (raw: unknown) => VendorAvailability;
  /** 没问到：从错误看。不写按通用的认（defaultAvailabilityOfError）。 */
  availabilityOfError?: (error: unknown) => VendorAvailability;
  /** 上面两步给 unknown 时的补充判断（读凭证文件、跑自带的状态命令）。 */
  confirm?: (signal: AbortSignal) => Promise<VendorAvailability>;
  /** 装没装（只查文件在不在，每次要都查）。不写当装了。 */
  installed?: () => boolean;
}

/** 没问到时通用的认法：程序不存在 → 没装；报错是认证类（VENDOR_FAILURE_SIGNS 的 auth）→ 没登录；别的认不出。 */
export function defaultAvailabilityOfError(vendor: AgentVendor, error: unknown): VendorAvailability {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b/.test(message)) return "not_installed";
  return vendorFailureOf(message, vendor)?.kind === "auth" ? "signed_out" : "unknown";
}

export interface ModelCatalogsOptions {
  /** 每家厂商的来源（守护进程接 vendors/index.ts 的 createVendorCatalogSources）。没给的厂商不问，直接用打包的、状态 unknown。 */
  sources: Partial<Record<AgentVendor, VendorCatalogSource>>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ModelCatalogs {
  /**
   * 每家厂商一份（按 AGENT_VENDORS 的顺序），带这台设备上的状态，不会失败。
   * refresh：true 不管新不新都重新问一次；"unusable" 只重问现在不能用（没登录、没装）的那几家。都是问完再回。
   */
  list(options?: { refresh?: boolean | "unusable" }): Promise<ModelCatalog[]>;
  /** 现在缓存着的那份（不问厂商、不等），还没问到过是 null。账本写系统消息时用。 */
  current(vendor: AgentVendor): ModelCatalog | null;
  /** 现在的状态（不问厂商、不等；装没装每次查文件）。提示词用。 */
  availability(vendor: AgentVendor): VendorAvailability;
  /** hub worker start 用：现在不能用的先重问这一家一次（等它问完），再给状态；能用的不问。 */
  ensureUsable(vendor: AgentVendor): Promise<VendorAvailability>;
  /** 真跑的结果（会话起来了、认证失败、找不到程序）直接更新状态，不用等缓存过期。 */
  report(vendor: AgentVendor, availability: VendorAvailability): void;
  /** 关机：取消在问的那次，之后不再问。 */
  close(): void;
}

interface VendorCatalogSlot {
  readonly vendor: AgentVendor;
  readonly source: VendorCatalogSource | undefined;
  cached: ModelCatalog | null;
  cachedAt: number;
  /** 上次问出来的状态，还没问过是 null。 */
  availability: VendorAvailability | null;
  /** 上次没问到、或问出来不能用的时候（之后隔 MODEL_CATALOG_RETRY_MS 才再问）。 */
  failedAt: number | null;
  inflight: Promise<void> | null;
}

/**
 * 模型名单和厂商状态的缓存（每家厂商各自独立缓存、并行查询；状态和名单同一次问、同一个缓存）：
 * - 没配来源的厂商：不发请求，直接回打包的名单、状态 unknown，current 返回 null；
 * - 没装（只查文件）：不问，状态 not_installed；装上以后下次要时就问；
 * - 还没问到过：第一次要时问，等它问完（同时来的几次只问一次）；
 * - 问到了：直接给；超过 MODEL_CATALOG_FRESH_MS 就在后台再问，先给旧的；后台没问到继续用旧的；
 * - 没问到、或问出来不能用（没登录）：名单用打包的（问到了就用问到的），MODEL_CATALOG_RETRY_MS 之后有人要时再问。
 * 不轮询：都是有人要时才问。
 */
export function createModelCatalogs(options: ModelCatalogsOptions): ModelCatalogs {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let closed = false;
  const controller = new AbortController();

  const slots = Object.fromEntries(
    AGENT_VENDORS.map((vendor): [AgentVendor, VendorCatalogSlot] => [
      vendor,
      { vendor, source: options.sources[vendor], cached: null, cachedAt: 0, availability: null, failedAt: null, inflight: null },
    ]),
  ) as Record<AgentVendor, VendorCatalogSlot>;

  const installed = (slot: VendorCatalogSlot) => slot.source?.installed?.() ?? true;
  const settle = (slot: VendorCatalogSlot, availability: VendorAvailability) => {
    slot.availability = availability;
    if (!isSelectable(availability)) slot.failedAt = now();
  };

  const ask = (slot: VendorCatalogSlot): Promise<void> => {
    const source = slot.source;
    if (!source) return Promise.resolve();
    slot.inflight ??= (async () => {
      if (!installed(slot)) return; // 没装不问（状态看 installed，每次都查）
      let availability: VendorAvailability;
      let reason: string | null = null;
      try {
        const raw = await source.query(controller.signal);
        availability = source.availabilityOf?.(raw) ?? "available";
        const catalog = source.parse(raw);
        if (catalog !== null) {
          slot.cached = catalog;
          slot.cachedAt = now();
          slot.failedAt = null;
        } else {
          reason = "回的名单是空的或者认不出";
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        availability = source.availabilityOfError?.(error) ?? defaultAvailabilityOfError(slot.vendor, error);
      }
      if (availability === "unknown" && source.confirm && !closed) availability = await source.confirm(controller.signal);
      if (reason !== null) {
        slot.failedAt = now();
        if (!closed) log(`${LOG_PREFIX} 没问到 ${slot.vendor} 的模型名单（${reason}），先用打包的`);
      }
      settle(slot, availability);
    })().finally(() => {
      slot.inflight = null;
    });
    return slot.inflight;
  };

  const availabilityOf = (slot: VendorCatalogSlot): VendorAvailability => {
    if (!slot.source) return "unknown";
    if (!installed(slot)) return "not_installed";
    return slot.availability ?? "unknown";
  };
  const retryDue = (slot: VendorCatalogSlot) => slot.failedAt === null || now() - slot.failedAt >= MODEL_CATALOG_RETRY_MS;
  const result = (slot: VendorCatalogSlot): ModelCatalog => ({ ...(slot.cached ?? bundledModelCatalog(slot.vendor)), availability: availabilityOf(slot) });

  const catalogOf = async (slot: VendorCatalogSlot, refresh: boolean | "unusable"): Promise<ModelCatalog> => {
    if (!slot.source || closed || !installed(slot)) return result(slot);
    const usable = slot.availability === null || isSelectable(slot.availability);
    if (refresh === true || (refresh === "unusable" && !usable)) await ask(slot);
    else if (slot.cached === null) {
      if (slot.inflight || slot.availability === null || retryDue(slot)) await ask(slot);
    } else if (!slot.inflight && (now() - slot.cachedAt >= MODEL_CATALOG_FRESH_MS || !usable) && retryDue(slot)) {
      void ask(slot);
    }
    return result(slot);
  };

  return {
    async list(opts = {}) {
      const refresh = opts.refresh ?? false;
      return Promise.all(AGENT_VENDORS.map((vendor) => catalogOf(slots[vendor], refresh)));
    },
    current(vendor) {
      return slots[vendor]?.cached ?? null;
    },
    availability(vendor) {
      return availabilityOf(slots[vendor]);
    },
    async ensureUsable(vendor) {
      const slot = slots[vendor];
      if (slot.source && !closed && installed(slot) && !isSelectable(availabilityOf(slot))) await ask(slot);
      return availabilityOf(slot);
    },
    report(vendor, availability) {
      const slot = slots[vendor];
      if (slot.availability === availability) return;
      slot.availability = availability;
      slot.failedAt = isSelectable(availability) ? null : now();
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
}
