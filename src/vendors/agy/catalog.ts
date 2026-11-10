// Antigravity (agy) 的模型名单和登录状态（docs/vendor-availability-design.md 第 3 节、docs/vendor-plugin-design.md 的 C5）：
// 跑 `agy --output-format json models`；agy 没有状态命令，问到名单就是能用。会话没在跑时问 skills 也在这里（composer.ts 用）。
import { spawn } from "node:child_process";
import {
  ALL_EFFORTS,
  KILL_WAIT_MS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_TIMEOUT_MS,
  VENDOR_SPECS,
  bundledModelCatalog,
  checkModel,
  mergeCatalogEfforts,
  splitEffortSuffix,
  truncateChars,
  type CatalogModel,
  type ModelCatalog,
} from "../../shared/index.ts";
import {
  STDERR_TAIL_CHARS,
  defaultAvailabilityOfError,
  killThenSettle,
  nonEmptyString,
  parseJsonOutput,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import { forceKill, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";

/** agy 查模型名单的固定参数。 */
const AGY_MODELS_QUERY_ARGS: readonly string[] = ["--output-format", "json", "models"];
/** agy 查可用 skills 的固定参数。 */
const AGY_SKILLS_QUERY_ARGS: readonly string[] = ["-p", "/skills", "--output-format", "json"];

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
 * “模型 + 思考程度”：ID 末尾是已知档位词（low、medium、high 及 ALL_EFFORTS 里的扩展档位），并且名字末尾括号里是同一个词，
 * 才拆（不看模型名，agy 出新模型或新档位照样拆）；同一个不带档位的模型下各档位合成一项，efforts 按清单里的顺序。
 * 拆不开的（不带档位、对不上）原样留着，efforts 是空的：界面不出思考程度下拉，启动时原样传 ID。
 * 若 `currently_selected === true` 则将其不带档位的名字记为 `defaultModel`，并将其支持的档位赋给 `defaultEfforts`。
 */
export function parseAgyModels(raw: unknown): ModelCatalog | null {
  const list = extractAgyModels(raw);
  if (list === null) return null;
  const tiers = [...VENDOR_SPECS.agy.efforts, ...ALL_EFFORTS.filter((e) => !VENDOR_SPECS.agy.efforts.includes(e))];
  // 不带档位的模型（按第一次出现的顺序）→ 名字、说明、报了哪些档位
  const found = new Map<string, { label: string; description: string | null; efforts: Set<string> }>();
  const seen = new Set<string>();
  let defaultModel: string | null = null;
  let defaultBaseId: string | null = null;
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
    if ((entry.currently_selected === true || entry.isDefault === true) && defaultModel === null) {
      defaultModel = label;
      defaultBaseId = baseId;
    }
    const rawDesc = nonEmptyString(entry.description);
    const description = rawDesc === null ? null : truncateChars(rawDesc, MAX_CATALOG_DESCRIPTION_CHARS);
    let model = found.get(baseId);
    if (model === undefined) {
      if (found.size === MAX_CATALOG_MODELS) continue;
      model = { label, description, efforts: new Set() };
      found.set(baseId, model);
    } else if (model.description === null && description !== null) {
      model.description = description;
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
  const defaultEfforts = defaultBaseId === null ? null : (models.find((m) => m.id === defaultBaseId)?.efforts ?? null);
  const efforts = mergeCatalogEfforts(VENDOR_SPECS.agy.efforts, models, defaultEfforts);
  return { ...bundledModelCatalog("agy"), source: "vendor", efforts, models, defaultEfforts, defaultModel };
}

export interface AgyModelQueryOptions {
  agyPath: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
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
    trackChild(child, "probe:agy", { detached: true });
    child.once("exit", () => termGroupAfterExit(child));
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
        killThenSettle(child, () => reject(error));
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

/** 没登录时 agy 退出码是 0、打印一段话（东京实测：“Error: Please sign in to view available models. …”），不是 JSON。 */
const AGY_SIGNED_OUT_PATTERN = /sign in/i;

/** agy 没有状态命令：问到名单就是能用；没问到、原话里有 sign in 是没登录。 */
export const agyCatalogProbe: VendorCatalogProbe = {
  parse: parseAgyModels,
  availabilityOf: () => "available",
  availabilityOfError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return AGY_SIGNED_OUT_PATTERN.test(message) ? "signed_out" : defaultAvailabilityOfError("agy", error);
  },
};

export function createAgyCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  return {
    ...agyCatalogProbe,
    query: (signal) => queryAgyModels({ agyPath: options.path, cwd: options.cwd, ...(options.env ? { env: options.env } : {}), signal }),
    installed: options.installed,
    ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
  };
}
