// Claude Code 的模型名单和登录状态（docs/vendor-availability-design.md 第 3 节、docs/vendor-plugin-design.md 的 C5）：
// 起 claude 发 stream-json 的 initialize 控制请求（不跑钩子、不连 MCP，protocol.ts 的 INITIALIZE_QUERY_ARGS），看不出登录时另跑
// `claude auth status --json`。单独一个文件：composer.ts 给账本用，不能引入起进程的代码（composer.test.ts 查）。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
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

/** claude 回应里“默认”那一项的 value：不进名单，它支持的思考程度给“默认”用。 */
const DEFAULT_VALUE = "default";

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
 * 模型名单和会话没在跑时的命令列表（composer.ts）都用它。
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
    trackChild(child, "probe:claude-initialize", { detached: true });
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
    child.stdin.on("error", () => {}); // 进程先退出时写入会 EPIPE，以 exit 为准
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("exit", (code, sig) => {
      termGroupAfterExit(child);
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

/** `claude auth status --json` 的固定参数。 */
const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = ["auth", "status", "--json"];

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
    trackChild(child, "probe:claude-auth-status", { detached: true });
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

/** initialize 回应里的 account 有身份信息（实测有 email、organization）就是登录了；没有说不清，交给 claude auth status。 */
export const claudeCatalogProbe: VendorCatalogProbe = {
  parse: (raw) => parseInitializeModels((raw as { models?: unknown } | null)?.models),
  availabilityOf(raw) {
    const account = (raw as { account?: { email?: unknown; organization?: unknown } } | null)?.account;
    // 只认身份字段：没登录时 account 里可能也有 apiProvider 这类和登录无关的
    const identity = [account?.email, account?.organization].some((v) => typeof v === "string" && v.trim() !== "");
    return identity ? "available" : "unknown";
  },
};

/** 名单那次查询：发 initialize 拿整个回应（models 和 account 一起），看不出登录时才另跑 `claude auth status`。 */
export function createClaudeCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  const query = { claudePath: options.path, cwd: options.cwd, ...(options.env ? { env: options.env } : {}) };
  return {
    ...claudeCatalogProbe,
    query: (signal) => queryClaudeInitialize({ ...query, signal }),
    confirm: (signal) => queryClaudeAuthStatus({ ...query, signal }),
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}
