// Invariant: formatted verify failures always carry a non-empty summary and bound diagnostic detail and lifecycle notes.
import { inspect } from "node:util";
import { VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS, VERIFY_SMOKE_MAX_NOTES } from "../src/shared/limits.ts";

export interface VerifyPhaseRecord {
  name: string;
  durationMs: number;
}

export interface VerifyFailure {
  phasePath: string[];
  phaseDurationMs: number;
  errorType: string;
  summary: string;
  detail: string;
}

export interface VerifyStepContext {
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  note(message: string): void;
}

export interface VerifyStepTrackerSnapshot {
  phases: VerifyPhaseRecord[];
  activePath: string[];
  activeDurationMs: number;
  notes: string[];
}

export interface VerifyStepTracker {
  runPhase<T>(name: string, fn: (ctx: VerifyStepContext) => Promise<T>): Promise<T>;
  note(message: string): void;
  snapshot(): VerifyStepTrackerSnapshot;
}

export interface VerifyErrorContext {
  phasePath?: readonly string[];
  phaseDurationMs?: number;
  notes?: readonly string[];
  daemonStderr?: string;
  maxDetailChars?: number;
}

export interface VerifyRunReportInput {
  ok: boolean;
  totalMs: number;
  budgetMs: number;
  phases: readonly VerifyPhaseRecord[];
  failure?: VerifyFailure;
}

const SUMMARY_MAX_CHARS = 500;
const MAX_TRAVERSAL_DEPTH = 4;
const TRUNCATION_MARKER = "\n...[truncated]...\n";

function safeGet(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeInspect(value: unknown, maxChars: number): string {
  let rendered: string;
  try {
    rendered = inspect(value, { depth: 3, maxArrayLength: 10, maxStringLength: maxChars, breakLength: Infinity });
  } catch {
    try {
      rendered = Object.prototype.toString.call(value);
    } catch {
      rendered = "<unprintable value>";
    }
  }
  const single = rendered.replace(/\s+/g, " ").trim();
  if (single.length === 0) return "<empty>";
  return single.length <= maxChars ? single : `${single.slice(0, Math.max(0, maxChars - 3))}...`;
}

function extractErrorType(error: unknown): string {
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  if (typeof error !== "object") return typeof error;

  const name = safeNonEmptyString(safeGet(error, "name"));
  let ctorName: string | undefined;
  try {
    const ctor = (error as { constructor?: { name?: unknown } }).constructor;
    ctorName = safeNonEmptyString(ctor?.name);
  } catch {
    ctorName = undefined;
  }

  // Playwright ProtocolError subclasses Error without overriding .name, so prefer a specific constructor name over generic "Error".
  if (name && name !== "Error") return name;
  if (ctorName && ctorName !== "Error" && ctorName !== "Object") return ctorName;
  if (name) return name;
  if (ctorName) return ctorName;
  return "Object";
}

interface ExtractedFields {
  errorType: string;
  message?: string;
  protocolType?: string;
  method?: string;
  code?: string;
  logs?: string;
  stack?: string;
  cause?: unknown;
  errors?: unknown[];
}

function extractFields(error: unknown): ExtractedFields {
  const errorType = extractErrorType(error);
  if (typeof error !== "object" || error === null) {
    return { errorType };
  }
  const rawCode = safeGet(error, "code");
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode).trim() || undefined : undefined;
  const rawErrors = safeGet(error, "errors");
  return {
    errorType,
    message: safeNonEmptyString(safeGet(error, "message")),
    protocolType: safeNonEmptyString(safeGet(error, "type")),
    method: safeNonEmptyString(safeGet(error, "method")),
    code,
    logs: safeNonEmptyString(safeGet(error, "logs")),
    stack: safeNonEmptyString(safeGet(error, "stack")),
    cause: safeGet(error, "cause"),
    errors: Array.isArray(rawErrors) ? rawErrors : undefined,
  };
}

function summarizeSingleError(error: unknown, seen: Set<object>, depth: number): string {
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  if (typeof error === "string") return error.trim() || "(empty string)";
  if (typeof error === "symbol") return error.toString();
  if (typeof error !== "object") return String(error);
  if (seen.has(error)) return "[Circular]";
  seen.add(error);

  const fields = extractFields(error);
  const metaParts: string[] = [];
  if (fields.protocolType) metaParts.push(`type=${fields.protocolType}`);
  if (fields.method) metaParts.push(`method=${fields.method}`);
  if (fields.code) metaParts.push(`code=${fields.code}`);

  if (fields.message) {
    const missingMeta = metaParts.filter((part) => !fields.message!.includes(part.split("=", 2)[1]!));
    const suffix = missingMeta.length > 0 ? ` (${missingMeta.join(", ")})` : "";
    return `${fields.errorType}: ${fields.message}${suffix}`;
  }

  if (fields.errors && fields.errors.length > 0 && depth < MAX_TRAVERSAL_DEPTH) {
    const first = summarizeSingleError(fields.errors[0], seen, depth + 1);
    const extra = fields.errors.length > 1 ? ` (+${fields.errors.length - 1} more)` : "";
    return `${fields.errorType}: ${first}${extra}`;
  }

  if (metaParts.length > 0) {
    return `${fields.errorType}: ${metaParts.join(", ")}`;
  }

  if (error instanceof Error) {
    return `${fields.errorType}: (empty message)`;
  }

  return `${fields.errorType}: ${safeInspect(error, 200)}`;
}

function trimTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length + 16) return text.slice(text.length - maxChars);
  const tailLen = maxChars - TRUNCATION_MARKER.length;
  return `${TRUNCATION_MARKER.trimStart()}${text.slice(text.length - tailLen)}`;
}

function clampText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const suffix = "\n...[truncated]";
  if (maxChars <= suffix.length) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

function appendNestedDetails(
  error: unknown,
  lines: string[],
  seen: Set<object>,
  depth: number,
  perLogBudget: number,
): void {
  if (typeof error !== "object" || error === null || depth > MAX_TRAVERSAL_DEPTH) return;
  const fields = extractFields(error);

  if (fields.errors && fields.errors.length > 0) {
    lines.push("errors:");
    for (const [index, inner] of fields.errors.entries()) {
      lines.push(`  [${index}] ${summarizeSingleError(inner, new Set(seen), depth + 1)}`);
    }
  }

  if (fields.cause !== undefined && depth < MAX_TRAVERSAL_DEPTH) {
    if (typeof fields.cause === "object" && fields.cause !== null && seen.has(fields.cause)) {
      lines.push("cause: [Circular]");
    } else {
      const nextSeen = new Set(seen);
      if (typeof fields.cause === "object" && fields.cause !== null) nextSeen.add(fields.cause);
      lines.push(`cause: ${summarizeSingleError(fields.cause, new Set(seen), depth + 1)}`);
      const causeFields = extractFields(fields.cause);
      if (causeFields.logs) lines.push(`cause.logs:\n${trimTail(causeFields.logs, perLogBudget)}`);
      if (causeFields.stack) lines.push(`cause.stack:\n${clampText(causeFields.stack, perLogBudget)}`);
      appendNestedDetails(fields.cause, lines, nextSeen, depth + 1, perLogBudget);
    }
  }
}

export function formatVerifyError(
  error: unknown,
  context: VerifyErrorContext = {},
): VerifyFailure {
  const phasePath = context.phasePath ? [...context.phasePath] : [];
  const phaseDurationMs =
    typeof context.phaseDurationMs === "number" && Number.isFinite(context.phaseDurationMs) && context.phaseDurationMs > 0
      ? context.phaseDurationMs
      : 0;
  const maxDetailChars =
    typeof context.maxDetailChars === "number" && Number.isFinite(context.maxDetailChars) && context.maxDetailChars >= 0
      ? Math.floor(context.maxDetailChars)
      : VERIFY_SMOKE_ERROR_DETAIL_MAX_CHARS;

  const fields = extractFields(error);
  const headline = summarizeSingleError(error, new Set(), 0);
  const phasePrefix = phasePath.length > 0 ? `[${phasePath.join(" > ")}] ` : "";
  const rawSummary = `${phasePrefix}${headline}`.replace(/\s+/g, " ").trim();
  const summary = rawSummary.length <= SUMMARY_MAX_CHARS
    ? rawSummary
    : `${rawSummary.slice(0, SUMMARY_MAX_CHARS - 3)}...`;

  const perLogBudget = Math.max(256, Math.floor(maxDetailChars * 0.35));
  const detailLines: string[] = [`errorType: ${fields.errorType}`];
  if (phasePath.length > 0) {
    const dur = phaseDurationMs > 0 ? ` (${(phaseDurationMs / 1000).toFixed(2)}s)` : "";
    detailLines.push(`phase: ${phasePath.join(" > ")}${dur}`);
  }
  if (fields.protocolType) detailLines.push(`type: ${fields.protocolType}`);
  if (fields.method) detailLines.push(`method: ${fields.method}`);
  if (fields.code) detailLines.push(`code: ${fields.code}`);
  if (context.notes && context.notes.length > 0) {
    detailLines.push("notes:");
    for (const note of context.notes) detailLines.push(`  - ${note}`);
  }

  const seen = new Set<object>();
  if (typeof error === "object" && error !== null) seen.add(error);
  appendNestedDetails(error, detailLines, seen, 0, perLogBudget);

  if (fields.stack) {
    detailLines.push(`stack:\n${clampText(fields.stack, perLogBudget)}`);
  } else if (typeof error === "object" && error !== null) {
    detailLines.push(`value: ${safeInspect(error, perLogBudget)}`);
  }
  if (fields.logs) {
    detailLines.push(`logs:\n${trimTail(fields.logs, perLogBudget)}`);
  }
  const stderr = safeNonEmptyString(context.daemonStderr);
  if (stderr) {
    detailLines.push(`daemonStderr:\n${trimTail(stderr, perLogBudget)}`);
  }

  return {
    phasePath,
    phaseDurationMs,
    errorType: fields.errorType,
    summary: summary || `${fields.errorType}: verify failed`,
    detail: clampText(detailLines.join("\n"), maxDetailChars),
  };
}

export function createVerifyStepTracker(
  now: () => number = () => performance.now(),
  maxNotes: number = VERIFY_SMOKE_MAX_NOTES,
): VerifyStepTracker {
  const noteCap = Math.max(1, Math.floor(maxNotes));
  const phases: VerifyPhaseRecord[] = [];
  const notes: string[] = [];
  const activeStack: string[] = [];
  let phaseStartedAt: number | null = null;
  let failedPath: string[] | null = null;
  let failedDurationMs = 0;

  const recordNote = (message: string): void => {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    if (notes.length >= noteCap) notes.shift();
    notes.push(trimmed);
  };

  const stepContext: VerifyStepContext = {
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      failedPath = null;
      activeStack.push(name);
      try {
        const result = await fn();
        activeStack.pop();
        return result;
      } catch (error) {
        if (failedPath === null) {
          failedPath = [...activeStack];
          failedDurationMs = phaseStartedAt === null ? 0 : Math.max(0, now() - phaseStartedAt);
        }
        activeStack.pop();
        throw error;
      }
    },
    note: recordNote,
  };

  return {
    async runPhase<T>(name: string, fn: (ctx: VerifyStepContext) => Promise<T>): Promise<T> {
      failedPath = null;
      failedDurationMs = 0;
      const started = now();
      phaseStartedAt = started;
      activeStack.push(name);
      try {
        const result = await fn(stepContext);
        phases.push({ name, durationMs: Math.max(0, now() - started) });
        activeStack.pop();
        phaseStartedAt = null;
        return result;
      } catch (error) {
        if (failedPath === null) {
          failedPath = [...activeStack];
          failedDurationMs = Math.max(0, now() - started);
        }
        activeStack.pop();
        phaseStartedAt = null;
        throw error;
      }
    },
    note: recordNote,
    snapshot(): VerifyStepTrackerSnapshot {
      if (failedPath !== null) {
        return {
          phases: phases.map((p) => ({ ...p })),
          activePath: [...failedPath],
          activeDurationMs: failedDurationMs,
          notes: [...notes],
        };
      }
      return {
        phases: phases.map((p) => ({ ...p })),
        activePath: [...activeStack],
        activeDurationMs: phaseStartedAt === null ? 0 : Math.max(0, now() - phaseStartedAt),
        notes: [...notes],
      };
    },
  };
}

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

export function formatVerifyRunReport(runIndex: number, result: VerifyRunReportInput): string {
  const over = result.totalMs > result.budgetMs ? `（超过 ${formatSeconds(result.budgetMs)} 的目标）` : "";
  const phaseItems = result.phases.map((p) => `${p.name} ${formatSeconds(p.durationMs)}`);

  if (result.ok) {
    const header = `第 ${runIndex} 次：${formatSeconds(result.totalMs)}${over}，通过`;
    return phaseItems.length > 0 ? `${header}\n  ${phaseItems.join("，")}` : header;
  }

  const summary = result.failure?.summary.trim() || "UnknownError: verify smoke run failed without details";
  const header = `第 ${runIndex} 次：${formatSeconds(result.totalMs)}${over}，失败：${summary}`;
  if (result.failure && result.failure.phasePath.length > 0) {
    phaseItems.push(`${result.failure.phasePath.join(" > ")} ${formatSeconds(result.failure.phaseDurationMs)}（失败）`);
  }

  const lines = [header];
  if (phaseItems.length > 0) lines.push(`  ${phaseItems.join("，")}`);
  const detail = result.failure?.detail.trim();
  if (detail) {
    for (const line of detail.split("\n")) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}
