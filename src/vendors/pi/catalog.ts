// Pi 的模型目录与登录状态探测（docs/vendors/pi.md 第 2 节）：
// 运行 `pi --offline --list-models`（纯本地离线读凭据与内置/缓存模型库，不发网络请求、不建会话）：
// - 输出 "No models available..." 或列表为空 → signed_out，parse 返回 null（使用打包兜底模型）；
// - 输出非空表格 → available；超过 MAX_CATALOG_MODELS（50）时先按 provider 分组、每组按新旧优先排，再跨模型商轮询截取前 50 项。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
import {
  STDERR_TAIL_CHARS,
  killThenSettle,
  nonEmptyString,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import { forceKill, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";
import { PI_NO_PROJECT_TRUST_ARGS } from "./composer.ts";
import { MAX_PI_PROBE_STDOUT_CHARS } from "./limits.ts";
import spec from "./spec.ts";

// --no-approve：探测的工作目录也可能是不信任的仓库，不带时项目 `.pi/extensions` 会在 --list-models 里执行（见 composer.ts 的 PI_NO_PROJECT_TRUST_ARGS）
const PI_LIST_MODELS_ARGS: readonly string[] = ["--offline", ...PI_NO_PROJECT_TRUST_ARGS, "--list-models"];
const NO_MODELS_RE = /^no models available\b/i;
const HEADER_RE = /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/i;
const DATE_SUFFIX_RE = /-(?:20\d{6}|\d{4}-\d{2}-\d{2})$/;

interface ParsedProviderModel {
  provider: string;
  bareModel: string;
  originalIndex: number;
  catalogModel: CatalogModel;
}

/**
 * 提取模型名里的主/次版本号用于同模型商内部比新旧（忽略 20250514 这类 8 位日期和 70b/120b 参数量）：
 * 如 claude-opus-5-5 → [5, 5]，deepseek-v4-pro → [4, 0]，gpt-5.4 → [5, 4]，grok-4.7 → [4, 7]。
 */
function extractModelVersionTuple(bareModel: string): readonly number[] {
  const withoutDate = bareModel.replace(DATE_SUFFIX_RE, "");
  const dotOrDash = /(?:^|[-_])v?(\d{1,2})(?:[.-](\d{1,2}))?(?=$|[-_])/i.exec(withoutDate);
  if (!dotOrDash) return [];
  const major = Number.parseInt(dotOrDash[1]!, 10);
  const minor = dotOrDash[2] !== undefined ? Number.parseInt(dotOrDash[2], 10) : 0;
  return [major, minor];
}

/** 同一个 provider 内部排序：主次版本号高的优先；同版本优先不带日期后缀的正式别名；其余倒置原字典序（Pi 原输出升序，新版本在后）。 */
function compareWithinProvider(a: ParsedProviderModel, b: ParsedProviderModel): number {
  const va = extractModelVersionTuple(a.bareModel);
  const vb = extractModelVersionTuple(b.bareModel);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const da = va[i] ?? -1;
    const db = vb[i] ?? -1;
    if (da !== db) return db - da;
  }
  const aDated = DATE_SUFFIX_RE.test(a.bareModel);
  const bDated = DATE_SUFFIX_RE.test(b.bareModel);
  if (aDated !== bDated) return aDated ? 1 : -1;
  return b.originalIndex - a.originalIndex;
}

function buildModelLabel(provider: string, bareModel: string, fullId: string): string {
  const bundled = spec.models.bundled.find((m) => m.id === fullId);
  const baseLabel = bundled?.label ?? spec.models.shortName?.(fullId) ?? bareModel;
  const withProvider = baseLabel.toLowerCase().includes(provider.toLowerCase())
    ? baseLabel
    : `${baseLabel} (${provider})`;
  return truncateChars(withProvider, MAX_CATALOG_LABEL_CHARS);
}

/** 按 provider 分组、每组按新旧排好后，若总数超过 MAX_CATALOG_MODELS，跨 provider 轮询挑最新模型再按 provider 顺序收拢。 */
function selectTopProviderModels(items: readonly ParsedProviderModel[], limit: number): CatalogModel[] {
  const groups = new Map<string, ParsedProviderModel[]>();
  for (const item of items) {
    let list = groups.get(item.provider);
    if (!list) {
      list = [];
      groups.set(item.provider, list);
    }
    list.push(item);
  }
  for (const list of groups.values()) {
    list.sort(compareWithinProvider);
  }

  if (items.length <= limit) {
    const all: CatalogModel[] = [];
    for (const list of groups.values()) {
      for (const item of list) all.push(item.catalogModel);
    }
    return all;
  }

  const pickedByProvider = new Map<string, CatalogModel[]>();
  for (const provider of groups.keys()) pickedByProvider.set(provider, []);

  let total = 0;
  let depth = 0;
  const providerEntries = [...groups.entries()];
  while (total < limit) {
    let addedInRound = false;
    for (const [provider, list] of providerEntries) {
      if (depth >= list.length) continue;
      pickedByProvider.get(provider)!.push(list[depth]!.catalogModel);
      total += 1;
      addedInRound = true;
      if (total >= limit) break;
    }
    if (!addedInRound) break;
    depth += 1;
  }

  const out: CatalogModel[] = [];
  for (const list of pickedByProvider.values()) {
    for (const model of list) out.push(model);
  }
  return out;
}

function parseTableRows(stdout: string): ParsedProviderModel[] | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return null;
  if (NO_MODELS_RE.test(lines[0]!)) return [];

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i]!)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return null;

  const seen = new Set<string>();
  const parsed: ParsedProviderModel[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i]!.split(/\s+/);
    if (cols.length < 6) continue;
    const [provider, bareModel, context, maxOut, thinking, images] = cols as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const fullId = `${provider}/${bareModel}`;
    if (seen.has(fullId) || checkModel("pi", fullId) !== null) continue;
    seen.add(fullId);
    const efforts = thinking.toLowerCase() === "yes" ? [...spec.models.efforts] : ["off"];
    const descParts = [`上下文 ${context}`, `最大输出 ${maxOut}`];
    if (images.toLowerCase() === "yes") descParts.push("支持图片");
    parsed.push({
      provider,
      bareModel,
      originalIndex: parsed.length,
      catalogModel: {
        id: fullId,
        label: buildModelLabel(provider, bareModel, fullId),
        description: truncateChars(descParts.join(" · "), MAX_CATALOG_DESCRIPTION_CHARS),
        efforts,
      },
    });
  }
  return parsed;
}

function parseJsonModels(list: readonly unknown[]): ParsedProviderModel[] {
  const seen = new Set<string>();
  const parsed: ParsedProviderModel[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const provider = nonEmptyString(entry.provider) ?? "custom";
    const rawId = nonEmptyString(entry.id) ?? nonEmptyString(entry.model);
    if (!rawId) continue;
    const bareModel = rawId.includes("/") ? rawId.slice(rawId.indexOf("/") + 1) : rawId;
    const fullId = rawId.includes("/") ? rawId : `${provider}/${rawId}`;
    if (seen.has(fullId) || checkModel("pi", fullId) !== null) continue;
    seen.add(fullId);
    const reasoning = entry.reasoning !== false;
    const mapObj =
      typeof entry.thinkingLevelMap === "object" && entry.thinkingLevelMap !== null
        ? (entry.thinkingLevelMap as Record<string, unknown>)
        : null;
    let efforts: string[];
    if (!reasoning) {
      efforts = ["off"];
    } else if (mapObj) {
      const supported = spec.models.efforts.filter((lvl) => lvl === "off" || mapObj[lvl] !== null);
      efforts = supported.length > 0 ? supported : [...spec.models.efforts];
    } else {
      efforts = [...spec.models.efforts];
    }
    const rawName = nonEmptyString(entry.name) ?? nonEmptyString(entry.label);
    const label = rawName
      ? truncateChars(
          rawName.toLowerCase().includes(provider.toLowerCase()) ? rawName : `${rawName} (${provider})`,
          MAX_CATALOG_LABEL_CHARS,
        )
      : buildModelLabel(provider, bareModel, fullId);
    parsed.push({
      provider,
      bareModel,
      originalIndex: parsed.length,
      catalogModel: {
        id: fullId,
        label,
        description: null,
        efforts,
      },
    });
  }
  return parsed;
}

function extractParsedModels(raw: unknown): { kind: "unrecognized" } | { kind: "ok"; items: ParsedProviderModel[] } {
  if (typeof raw === "string") {
    const rows = parseTableRows(raw);
    return rows === null ? { kind: "unrecognized" } : { kind: "ok", items: rows };
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as { stdout?: unknown; models?: unknown; data?: { models?: unknown } };
    if (typeof obj.stdout === "string") {
      const rows = parseTableRows(obj.stdout);
      return rows === null ? { kind: "unrecognized" } : { kind: "ok", items: rows };
    }
    if (Array.isArray(obj.models)) return { kind: "ok", items: parseJsonModels(obj.models) };
    if (Array.isArray(obj.data?.models)) return { kind: "ok", items: parseJsonModels(obj.data.models) };
  }
  if (Array.isArray(raw)) return { kind: "ok", items: parseJsonModels(raw) };
  return { kind: "unrecognized" };
}

/** 解析 `pi --offline --list-models` 输出（或模型数组）为 ModelCatalog；为空或不可识别时返回 null。 */
export function parsePiModels(raw: unknown): ModelCatalog | null {
  const extracted = extractParsedModels(raw);
  if (extracted.kind === "unrecognized" || extracted.items.length === 0) return null;
  const models = selectTopProviderModels(extracted.items, MAX_CATALOG_MODELS);
  if (models.length === 0) return null;
  const efforts = mergeCatalogEfforts(spec.models.efforts, models, null);
  return {
    ...bundledModelCatalog("pi"),
    source: "vendor",
    efforts,
    models,
    defaultEfforts: null,
    defaultModel: null,
    defaultModelId: null,
  };
}

interface PiCatalogQueryOptions {
  piPath: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** 运行 `pi --offline --list-models` 并返回标准输出文本。 */
function queryPiListModels(options: PiCatalogQueryOptions): Promise<{ stdout: string }> {
  const { piPath, cwd, timeoutMs = MODEL_CATALOG_TIMEOUT_MS, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    let spawned: { child: ChildProcessWithoutNullStreams; detached: boolean };
    try {
      spawned = spawnOwnedProcess(piPath, [...PI_LIST_MODELS_ARGS], {
        cwd,
        env: buildChildEnv(options.env ?? process.env, undefined),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(err);
    }
    const { child, detached } = spawned;
    trackChild(child, "probe:pi-list-models", { detached });
    child.once("exit", () => termGroupAfterExit(child));
    child.stdin.on("error", () => {});
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        killThenSettle(child, () => reject(error));
        return;
      }
      if (!exited()) {
        killTimer = setTimeout(() => void forceKill(child), KILL_WAIT_MS);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
      }
      resolve({ stdout });
    };

    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => finish(new Error(`pi 超时（${timeoutMs} ms 没回 --list-models）`)),
      timeoutMs,
    );

    child.once("error", (error) => finish(new Error(`${piPath}: ${error.message}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_PI_PROBE_STDOUT_CHARS) {
        stdout += chunk.slice(0, MAX_PI_PROBE_STDOUT_CHARS - stdout.length);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // 等 close（标准输出读完）再判：exit 时管道里可能还有没读到的几行，名单会被截掉
    child.once("close", (code, sig) => {
      if (code === 0) {
        finish(null);
      } else {
        finish(
          new Error(
            `pi --list-models 退出异常（${sig ?? `退出码 ${code}`}）${stderr.trim() ? `：${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

export const piCatalogProbe: VendorCatalogProbe = {
  parse: parsePiModels,
  availabilityOf(raw): VendorAvailability {
    const extracted = extractParsedModels(raw);
    if (extracted.kind === "unrecognized") return "unknown";
    return extracted.items.length === 0 ? "signed_out" : "available";
  },
};

export function createPiCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...piCatalogProbe,
    query: (signal) =>
      queryPiListModels({
        piPath: options.path,
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
        signal,
      }),
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}
