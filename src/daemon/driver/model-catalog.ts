// 模型名单：直接问 claude 它能用哪些模型（和 Claude Agent SDK 的 supportedModels() 一样，在 stream-json 协议里发
// initialize 控制请求，回应里有 models：value、displayName、description、supportedEffortLevels……，实测见 docs/model-catalog.md）。
// 第一次有人要（网页打开资料页、新建弹窗）时问一次并缓存，旧了在后台再问；问不到（claude 没装、超时、报错、回的不对）
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
import { MODEL_QUERY_ARGS, buildChildEnv, buildInitializeLine } from "./protocol.ts";

/** claude 回应里“默认”那一项的 value：不进名单，它支持的思考程度给“默认”用。 */
const DEFAULT_VALUE = "default";
/** 失败原因里带多少标准错误。 */
const STDERR_TAIL_CHARS = 500;

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
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.value === "string" ? entry.value : null;
    if (id === null) continue;
    if (id === DEFAULT_VALUE) {
      defaultEfforts = effortsOf(entry);
      continue;
    }
    if (checkModel("claude", id) !== null || models.some((m) => m.id === id)) continue;
    const description = nonEmptyString(entry.description);
    models.push({
      id,
      label: truncateChars(nonEmptyString(entry.displayName) ?? id, MAX_CATALOG_LABEL_CHARS),
      description: description === null ? null : truncateChars(description, MAX_CATALOG_DESCRIPTION_CHARS),
      efforts: effortsOf(entry),
    });
    if (models.length === MAX_CATALOG_MODELS) break;
  }
  return models.length === 0 ? null : { vendor: "claude", source: "vendor", models, defaultEfforts };
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
  const args = [...MODEL_QUERY_ARGS];
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

export interface ModelCatalogsOptions {
  /** 问一次 claude，返回 initialize 回应里的 models（守护进程接 queryClaudeModels）。 */
  queryClaude: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ModelCatalogs {
  /** 每家厂商一份（按 AGENT_VENDORS 的顺序），不会失败。refresh：不管新不新都重新问一次，问完再回。 */
  list(options?: { refresh?: boolean }): Promise<ModelCatalog[]>;
  /** 现在缓存着的那份（不问 claude、不等），还没问到过是 null。账本写系统消息时用。 */
  current(vendor: AgentVendor): ModelCatalog | null;
  /** 关机：取消在问的那次，之后不再问。 */
  close(): void;
}

/**
 * 模型名单的缓存：
 * - 还没问到过：第一次要时问，等它问完（同时来的几次只问一次）；
 * - 问到了：直接给；超过 MODEL_CATALOG_FRESH_MS 就在后台再问，先给旧的；后台没问到继续用旧的；
 * - 没问到：用打包的名单，MODEL_CATALOG_RETRY_MS 之后有人要时再问。
 */
export function createModelCatalogs(options: ModelCatalogsOptions): ModelCatalogs {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let cached: ModelCatalog | null = null;
  let cachedAt = 0;
  let failedAt: number | null = null;
  let inflight: Promise<void> | null = null;
  let closed = false;
  const controller = new AbortController();

  const ask = (): Promise<void> => {
    inflight ??= (async () => {
      let reason: string;
      try {
        const catalog = parseInitializeModels(await options.queryClaude(controller.signal));
        if (catalog !== null) {
          cached = catalog;
          cachedAt = now();
          failedAt = null;
          return;
        }
        reason = "回的名单是空的或者认不出";
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      failedAt = now();
      if (!closed) log(`${LOG_PREFIX} 没问到 claude 的模型名单（${reason}），先用打包的`);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const claudeCatalog = async (refresh: boolean): Promise<ModelCatalog> => {
    if (closed) return cached ?? bundledModelCatalog("claude");
    if (refresh) await ask();
    else if (cached === null) {
      if (inflight || failedAt === null || now() - failedAt >= MODEL_CATALOG_RETRY_MS) await ask();
    } else if (!inflight && now() - cachedAt >= MODEL_CATALOG_FRESH_MS && (failedAt === null || now() - failedAt >= MODEL_CATALOG_RETRY_MS)) {
      void ask();
    }
    return cached ?? bundledModelCatalog("claude");
  };

  return {
    async list(opts = {}) {
      const claude = await claudeCatalog(opts.refresh === true);
      return AGENT_VENDORS.map((vendor) => (vendor === "claude" ? claude : bundledModelCatalog(vendor)));
    },
    current(vendor) {
      return vendor === "claude" ? cached : null;
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
}
