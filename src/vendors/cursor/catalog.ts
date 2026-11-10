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
const TRAILING_MARKER_RE = /\s*\((?:current|default)(?:,\s*(?:current|default))*\)\s*$/iu;
const VARIANT_SUFFIX_RE = /-(?:fast|thinking|extra-high|xhigh|high|medium|low|max|minimal|none)$/iu;
const LABEL_VARIANT_RE = /\s+(?:fast|thinking|extra high|xhigh|high|medium|low|max|minimal|none)$/iu;
const LEGACY_CLAUDE_RE = /^claude-(\d+)(?:\.(\d+))?-(opus|sonnet|haiku|fable)$/u;

/** Fusa 未选模型时用的 Cursor 自动路由（ACP 里是 default[]）。 */
export const CURSOR_AUTO_MODEL = "auto";

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

function stripTrailing(text: string, re: RegExp): string {
  let out = text;
  for (let next = out.replace(re, ""); next !== out && next !== ""; next = out.replace(re, "")) out = next;
  return out;
}

/**
 * CLI 模型 ID 归到 ACP 模型项的家族名（ACP options[].name）：去 `cursor-` 前缀与档位/Fast 后缀，
 * 旧式 claude-4.6-sonnet 改成 ACP 的 claude-sonnet-4-6（claude-opus-5-5-high -> claude-opus-5-5）。
 */
export function cursorModelFamily(modelId: string): string {
  const base = stripTrailing(modelId.trim().toLowerCase().replace(/^cursor-/u, ""), VARIANT_SUFFIX_RE);
  const legacy = LEGACY_CLAUDE_RE.exec(base);
  if (!legacy) return base;
  const [, major, minor, family] = legacy;
  return minor ? `claude-${family}-${major}-${minor}` : `claude-${family}-${major}`;
}

/**
 * 解析 `cursor-agent models` 的纯文本输出；认不出或无合法模型时返回 null。
 * CLI 把档位和 Fast 展开成约 275 个 ID，但 ACP 只能选每个家族的一个预设（options[] 约 47 项，实测
 * session/set_config_option 拒收其余组合），所以按家族归并成一项一个，ID 用家族名；打包名单里的家族排前面。
 */
export function parseCursorModelsText(text: string): ModelCatalog | null {
  const families = new Map<string, CatalogModel>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = cleanLine(rawLine);
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const rawId = line.slice(0, sep).trim();
    if (/\s/u.test(rawId) || rawId.toLowerCase() === CURSOR_AUTO_MODEL) continue;
    const id = cursorModelFamily(rawId);
    if (families.has(id) || checkModel("cursor", id) !== null) continue;
    const label = stripTrailing(line.slice(sep + 3).replace(/\s+/gu, " ").replace(TRAILING_MARKER_RE, "").trim(), LABEL_VARIANT_RE);
    if (label === "") continue;
    families.set(id, { id, label: truncateChars(label, MAX_CATALOG_LABEL_CHARS), description: null, efforts: [] });
  }
  if (families.size === 0) return null;

  const base = bundledModelCatalog("cursor");
  const bundledFirst = [
    ...base.models.flatMap((m) => families.get(m.id) ?? []),
    ...[...families.values()].filter((m) => !base.models.some((b) => b.id === m.id)),
  ];
  return {
    ...base,
    source: "vendor",
    models: bundledFirst.slice(0, MAX_CATALOG_MODELS),
    defaultEfforts: [],
    defaultModel: "Auto",
    defaultModelId: CURSOR_AUTO_MODEL,
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
