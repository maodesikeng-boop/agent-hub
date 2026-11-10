// Cursor 模型名单与设备登录状态探测：
// 并行运行 `cursor-agent models` 与 `cursor-agent status --format json`（不创建会话、不消耗额度），
// 超时或中止时强制按进程组清理（killThenSettle + termGroupAfterExit），输出受 CURSOR_PROBE_MAX_STDOUT_BYTES 与 MAX_CATALOG_MODELS 保护。
import { spawn } from "node:child_process";
import {
  MAX_CATALOG_LABEL_CHARS,
  MAX_CATALOG_MODELS,
  MODEL_CATALOG_TIMEOUT_MS,
  bundledModelCatalog,
  checkModel,
  truncateChars,
  vendorFailureOf,
  vendorSpec,
  type CatalogModel,
  type ModelCatalog,
  type VendorAvailability,
} from "../../shared/index.ts";
import {
  STDERR_TAIL_CHARS,
  defaultAvailabilityOfError,
  killThenSettle,
  parseJsonOutput,
  type VendorCatalogSource,
} from "../../daemon/driver/model-catalog.ts";
import { streamClosed, termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "../../daemon/vendors/types.ts";
import { CURSOR_PROBE_MAX_STDOUT_BYTES } from "./limits.ts";

// 剥离 ANSI 控制序列与零宽字符（实测 cursor-agent models 部分行尾带 \u200b）。
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/gu;
const TRAILING_MARKER_RE = /\s*\((current|default)\)\s*$/iu;
const VARIANT_SUFFIX_RE = /-(?:fast|thinking|extra-high|xhigh|high|medium|low|max|minimal|none|1m)$/iu;

export interface CursorCatalogRaw {
  modelsText: string | null;
  statusJson: unknown;
  modelsError?: string | null;
  statusError?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanLine(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, "").replace(ZERO_WIDTH_RE, "").trim();
}

/** 归一化模型家族键，用于在超过 MAX_CATALOG_MODELS 时先按家族轮询挑出代表项。 */
export function cursorModelFamilyKey(modelId: string): string {
  let base = modelId.trim().toLowerCase().replace(/^cursor-/u, "");
  for (let i = 0; i < 4; i++) {
    const next = base.replace(VARIANT_SUFFIX_RE, "");
    if (next === base || next === "") break;
    base = next;
  }
  return base;
}

function tierPriority(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.endsWith("-high") && !lower.includes("-thinking-")) return 0;
  if (!VARIANT_SUFFIX_RE.test(lower)) return 1;
  if (lower.endsWith("-medium")) return 2;
  if (lower.endsWith("-high-fast")) return 3;
  if (lower.endsWith("-thinking-high")) return 4;
  if (lower.endsWith("-xhigh") || lower.endsWith("-extra-high")) return 5;
  if (lower.endsWith("-fast")) return 6;
  return 7;
}

function cursorProviderBucket(familyKey: string): string {
  if (/^o\d\b/u.test(familyKey)) return "gpt";
  const head = familyKey.split(/[-._]/u, 1)[0] ?? familyKey;
  return head || familyKey;
}

/**
 * 在候选模型数超过 MAX_CATALOG_MODELS 时，优先保住：
 * 1. spec.models.bundled 中的精选代表项（按原出现顺序）；
 * 2. 按上游厂商桶（composer / claude / gpt / gemini / grok / deepseek / kimi 等）轮询，为每个模型家族挑出优先级最高的一项，
 *    避免单一厂商几十个历史版本与思考档位挤占全部 50 个名额；
 * 3. 剩余名额按 CLI 原始顺序补齐至 MAX_CATALOG_MODELS。
 */
function selectRepresentativeModels(all: readonly CatalogModel[]): CatalogModel[] {
  if (all.length <= MAX_CATALOG_MODELS) return [...all];

  const picked = new Map<string, CatalogModel>();
  const bundledIds = new Set(vendorSpec("cursor").models.bundled.map((m) => m.id));

  for (const m of all) {
    if (bundledIds.has(m.id) && picked.size < MAX_CATALOG_MODELS) {
      picked.set(m.id, m);
    }
  }

  const byFamily = new Map<string, CatalogModel[]>();
  for (const m of all) {
    const fam = cursorModelFamilyKey(m.id);
    let list = byFamily.get(fam);
    if (!list) {
      list = [];
      byFamily.set(fam, list);
    }
    list.push(m);
  }

  const providerQueues = new Map<string, CatalogModel[]>();
  for (const [fam, list] of byFamily.entries()) {
    if (list.some((m) => picked.has(m.id))) continue;
    const best = [...list].sort((a, b) => tierPriority(a.id) - tierPriority(b.id))[0];
    if (!best) continue;
    const bucket = cursorProviderBucket(fam);
    let queue = providerQueues.get(bucket);
    if (!queue) {
      queue = [];
      providerQueues.set(bucket, queue);
    }
    queue.push(best);
  }

  const queues = [...providerQueues.values()];
  let cursor = 0;
  let progressed = true;
  while (picked.size < MAX_CATALOG_MODELS && progressed) {
    progressed = false;
    for (const q of queues) {
      if (picked.size >= MAX_CATALOG_MODELS) break;
      if (cursor < q.length) {
        const candidate = q[cursor]!;
        picked.set(candidate.id, candidate);
        progressed = true;
      }
    }
    cursor += 1;
  }

  for (const m of all) {
    if (picked.size >= MAX_CATALOG_MODELS) break;
    if (!picked.has(m.id)) picked.set(m.id, m);
  }

  // 按 picked 插入顺序输出（精选代表与各厂商家族主力靠前，其余按 CLI 顺序补齐）
  return [...picked.values()].slice(0, MAX_CATALOG_MODELS);
}

/** 解析 `cursor-agent models` 的纯文本输出；认不出或无合法模型时返回 null。 */
export function parseCursorModelsText(text: string): ModelCatalog | null {
  const lines = text.split(/\r?\n/u);
  const parsed: CatalogModel[] = [];
  const seen = new Set<string>();

  let currentDefault: { id: string; label: string } | null = null;
  let fallbackDefault: { id: string; label: string } | null = null;

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (line === "" || /^available models\b/iu.test(line) || /^tip:/iu.test(line) || /^loading\b/iu.test(line)) {
      continue;
    }
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;

    const id = line.slice(0, sep).trim();
    if (id === "" || /\s/u.test(id) || seen.has(id)) continue;
    if (checkModel("cursor", id) !== null) continue;

    let rawLabel = line.slice(sep + 3).replace(/\s+/gu, " ").trim();
    let marker: "current" | "default" | null = null;
    for (;;) {
      const m = TRAILING_MARKER_RE.exec(rawLabel);
      if (!m) break;
      const kind = m[1]!.toLowerCase();
      if (kind === "current") marker = "current";
      else if (marker === null) marker = "default";
      rawLabel = rawLabel.slice(0, m.index).trim();
    }
    if (rawLabel === "") continue;

    const label = truncateChars(rawLabel, MAX_CATALOG_LABEL_CHARS);
    seen.add(id);

    if (marker === "current" && currentDefault === null) {
      currentDefault = { id, label };
    } else if (marker === "default" && fallbackDefault === null) {
      fallbackDefault = { id, label };
    }

    // "auto" 对应 Cursor 的默认自动路由，已在下拉首项显示为“Auto（默认）”，不再重复塞进候选列表。
    if (id.toLowerCase() === "auto") {
      if (fallbackDefault === null) fallbackDefault = { id, label };
      continue;
    }

    parsed.push({
      id,
      label,
      description: null,
      efforts: [],
    });
  }

  const chosenDefault = currentDefault ?? fallbackDefault;
  if (parsed.length === 0) return null;

  const models = selectRepresentativeModels(parsed);
  const base = bundledModelCatalog("cursor");
  return {
    ...base,
    source: "vendor",
    models,
    defaultEfforts: [],
    defaultModel: chosenDefault?.label ?? null,
    defaultModelId: chosenDefault?.id ?? null,
  };
}

function extractModelsText(raw: unknown): string | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  if (typeof obj.modelsText === "string") return obj.modelsText;
  return null;
}

export function parseStatusAvailability(statusJson: unknown): VendorAvailability | null {
  const obj = asRecord(statusJson);
  if (!obj) return null;
  if (obj.isAuthenticated === true || obj.authenticated === true || obj.loggedIn === true) return "available";
  if (obj.isAuthenticated === false || obj.authenticated === false || obj.loggedIn === false) return "signed_out";
  const status = typeof obj.status === "string" ? obj.status.trim().toLowerCase() : "";
  if (status === "authenticated" || status === "logged_in") return "available";
  if (status === "unauthenticated" || status === "logged_out" || status === "not_logged_in") {
    return "signed_out";
  }
  return null;
}

export const cursorCatalogProbe: VendorCatalogProbe = {
  parse(raw: unknown): ModelCatalog | null {
    const text = extractModelsText(raw);
    if (text === null) return null;
    return parseCursorModelsText(text);
  },

  availabilityOf(raw: unknown): VendorAvailability {
    const obj = asRecord(raw);
    if (!obj) return "unknown";

    const fromStatus = parseStatusAvailability(obj.statusJson);
    if (fromStatus !== null) return fromStatus;

    for (const errField of [obj.statusError, obj.modelsError]) {
      if (typeof errField === "string" && errField.trim() !== "") {
        if (/\bENOENT\b/u.test(errField)) return "not_installed";
        if (vendorFailureOf(errField, "cursor")?.kind === "auth") return "signed_out";
      }
    }

    const modelsText = extractModelsText(raw);
    if (modelsText !== null && parseCursorModelsText(modelsText) !== null) {
      return "available";
    }
    return "unknown";
  },

  availabilityOfError(error: unknown): VendorAvailability {
    return defaultAvailabilityOfError("cursor", error);
  },
};

interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCursorSubcommand(
  executablePath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs = MODEL_CATALOG_TIMEOUT_MS,
): Promise<CommandRunResult> {
  if (signal.aborted) {
    return Promise.reject(new Error("cursor catalog query aborted"));
  }

  return new Promise<CommandRunResult>((resolve, reject) => {
    let settled = false;
    const finishResolve = (res: CommandRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executablePath, [...args], {
        cwd,
        env: buildChildEnv(env, { NO_COLOR: "1" }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!child.stdout || !child.stderr) {
      reject(new Error("cursor probe stdio unavailable"));
      return;
    }

    const tracked = child as Parameters<typeof killThenSettle>[0];
    trackChild(tracked, "probe:cursor", { detached: true });

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdoutBytes >= CURSOR_PROBE_MAX_STDOUT_BYTES) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes + bytes <= CURSOR_PROBE_MAX_STDOUT_BYTES) {
        stdout += chunk;
        stdoutBytes += bytes;
      } else {
        const remain = Math.max(0, CURSOR_PROBE_MAX_STDOUT_BYTES - stdoutBytes);
        stdout += Buffer.from(chunk, "utf8").subarray(0, remain).toString("utf8");
        stdoutBytes = CURSOR_PROBE_MAX_STDOUT_BYTES;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });

    const onAbort = () => {
      killThenSettle(tracked, () => finishReject(new Error("cursor catalog query aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      killThenSettle(tracked, () =>
        finishReject(new Error(`cursor ${args[0] ?? "probe"} timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);
    timer.unref();

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    child.once("error", (err) => {
      finishReject(err instanceof Error ? err : new Error(String(err)));
    });

    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    child.once("exit", (code, sig) => {
      termGroupAfterExit(child);
      const drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 200);
      drainTimer.unref();
      void drained.then(() => {
        clearTimeout(drainTimer);
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim().slice(0, STDERR_TAIL_CHARS) || `exit=${code} signal=${sig}`;
          finishReject(new Error(`cursor-agent ${args.join(" ")} failed: ${detail}`));
          return;
        }
        finishResolve({ stdout, stderr, exitCode: code });
      });
    });
  });
}

export function createCursorCatalogSource(
  options: VendorCatalogSourceOptions & { timeoutMs?: number },
): VendorCatalogSource {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS;

  return {
    installed: options.installed,
    fingerprint: options.fingerprint,
    parse: cursorCatalogProbe.parse,
    availabilityOf: cursorCatalogProbe.availabilityOf,
    availabilityOfError: cursorCatalogProbe.availabilityOfError,
    async query(signal: AbortSignal): Promise<CursorCatalogRaw> {
      const [modelsSettled, statusSettled] = await Promise.allSettled([
        runCursorSubcommand(options.path, ["models"], options.cwd, env, signal, timeoutMs),
        runCursorSubcommand(options.path, ["status", "--format", "json"], options.cwd, env, signal, timeoutMs),
      ]);

      const modelsText = modelsSettled.status === "fulfilled" ? modelsSettled.value.stdout : null;
      const modelsError =
        modelsSettled.status === "rejected"
          ? modelsSettled.reason instanceof Error
            ? modelsSettled.reason.message
            : String(modelsSettled.reason)
          : null;

      let statusJson: unknown = null;
      let statusError: string | null = null;
      if (statusSettled.status === "fulfilled") {
        const parsed = parseJsonOutput(statusSettled.value.stdout);
        if (parsed.ok) {
          statusJson = parsed.value;
        } else {
          statusError = statusSettled.value.stderr.trim() || statusSettled.value.stdout.trim() || "invalid status json";
        }
      } else {
        statusError =
          statusSettled.reason instanceof Error ? statusSettled.reason.message : String(statusSettled.reason);
      }

      if (modelsText === null && statusJson === null) {
        const primaryErr = modelsSettled.status === "rejected" ? modelsSettled.reason : statusError;
        throw primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr ?? "cursor probe failed"));
      }

      return {
        modelsText,
        statusJson,
        modelsError,
        statusError,
      };
    },
  };
}

export interface QueryCursorCatalogOptions {
  cursorPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function queryCursorCatalog(options: QueryCursorCatalogOptions): Promise<CursorCatalogRaw> {
  const source = createCursorCatalogSource({
    path: options.cursorPath,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    installed: () => true,
  });
  return (await source.query(options.signal ?? new AbortController().signal)) as CursorCatalogRaw;
}
