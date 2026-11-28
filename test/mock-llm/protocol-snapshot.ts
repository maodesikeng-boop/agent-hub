// Invariant: normalized snapshots strip volatile paths, ports, UUIDs, and timestamps and stay bounded by MOCK_LLM_SNAPSHOT_MAX_BYTES.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { DriverEvent } from "../../src/shared/index.ts";
import { MOCK_LLM_SNAPSHOT_MAX_BYTES } from "./limits.ts";
import type {
  JsonSchemaTreeDiff,
  NormalizedDriverEvent,
  NormalizedModelContext,
  RecordedLlmRequest,
  SchemaDriftEvaluation,
} from "./types.ts";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu;
const LOOPBACK_PORT_RE = /((?:https?:\/\/)?(?:127\.0\.0\.1|localhost)):\d+\b/giu;

const VOLATILE_EVENT_KEYS = new Set([
  "at",
  "uuid",
  "durationMs",
  "messageIds",
  "vendorSessionId",
  "pid",
  "toolUseId",
  "parentToolUseId",
  "requestId",
  "stepId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}...<truncated>`;
}

export function normalizeVolatileText(
  text: string,
  replacements?: Readonly<Record<string, string>>,
): string {
  let out = text;
  if (replacements) {
    const pairs = Object.entries(replacements).sort((a, b) => b[0].length - a[0].length);
    for (const [needle, token] of pairs) {
      if (needle !== "") out = out.split(needle).join(token);
    }
  }
  out = out.replace(UUID_RE, "<UUID>");
  out = out.replace(ISO_TS_RE, "<TIMESTAMP>");
  out = out.replace(LOOPBACK_PORT_RE, "$1:<PORT>");
  return out;
}

function flattenContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (isRecord(item)) {
      if (typeof item.text === "string") parts.push(item.text);
      else if (typeof item.content === "string") parts.push(item.content);
      else if (item.type === "tool_use" && typeof item.name === "string") parts.push(`[tool:${item.name}]`);
      else if (isRecord(item.functionCall) && typeof item.functionCall.name === "string") parts.push(`[tool:${item.functionCall.name}]`);
    }
  }
  return parts.join("\n");
}

function extractToolNames(dialect: RecordedLlmRequest["dialect"], tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names = new Set<string>();
  for (const t of tools) {
    if (!isRecord(t)) continue;
    if (dialect === "gemini-generate-content" && Array.isArray(t.functionDeclarations)) {
      for (const decl of t.functionDeclarations) {
        if (isRecord(decl) && typeof decl.name === "string" && decl.name !== "") names.add(decl.name);
      }
      continue;
    }
    if (isRecord(t.function) && typeof t.function.name === "string" && t.function.name !== "") {
      names.add(t.function.name);
      continue;
    }
    if (typeof t.name === "string" && t.name !== "") {
      names.add(t.name);
    } else if (typeof t.type === "string" && t.type !== "") {
      names.add(t.type);
    }
  }
  return [...names].sort();
}

export function normalizeModelContext(
  request: RecordedLlmRequest,
  options?: { replacements?: Readonly<Record<string, string>> },
): NormalizedModelContext {
  const norm = (s: string) => normalizeVolatileText(s, options?.replacements);
  if (!isRecord(request.body)) {
    return { dialect: request.dialect, model: null, system: "", toolNames: [], messages: [] };
  }
  const body = request.body;
  let model: string | null = typeof body.model === "string" && body.model.trim() !== "" ? body.model : null;
  let systemRaw = "";
  const messages: { role: string; text: string }[] = [];

  if (request.dialect === "anthropic-messages") {
    systemRaw = flattenContent(body.system);
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!isRecord(m)) continue;
        messages.push({ role: typeof m.role === "string" ? m.role : "unknown", text: norm(flattenContent(m.content)) });
      }
    }
  } else if (request.dialect === "openai-responses") {
    systemRaw = typeof body.instructions === "string" ? body.instructions : "";
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!isRecord(item)) continue;
        const role = typeof item.role === "string" ? item.role : typeof item.type === "string" ? item.type : "unknown";
        const text =
          flattenContent(item.content) ||
          (typeof item.output === "string" ? item.output : "") ||
          (typeof item.arguments === "string" ? item.arguments : "");
        messages.push({ role, text: norm(text) });
      }
    }
  } else if (request.dialect === "openai-chat-completions") {
    const sysParts: string[] = [];
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!isRecord(m)) continue;
        const role = typeof m.role === "string" ? m.role : "unknown";
        const text = flattenContent(m.content);
        if (role === "system" || role === "developer") sysParts.push(text);
        else messages.push({ role, text: norm(text) });
      }
    }
    systemRaw = sysParts.join("\n");
  } else if (request.dialect === "gemini-generate-content") {
    if (model === null) {
      const m = /\/models\/([^/:?]+):/u.exec(request.path);
      model = m?.[1] ?? null;
    }
    const sysObj = isRecord(body.systemInstruction)
      ? body.systemInstruction
      : isRecord(body.system_instruction)
        ? body.system_instruction
        : null;
    systemRaw = sysObj ? flattenContent(sysObj.parts) : "";
    if (Array.isArray(body.contents)) {
      for (const entry of body.contents) {
        if (!isRecord(entry)) continue;
        messages.push({
          role: typeof entry.role === "string" ? entry.role : "user",
          text: norm(flattenContent(entry.parts)),
        });
      }
    }
  }

  let system = norm(systemRaw);
  const toolNames = extractToolNames(request.dialect, body.tools);
  const perFieldCap = Math.floor(MOCK_LLM_SNAPSHOT_MAX_BYTES / 2);
  system = truncateUtf8(system, perFieldCap);

  const boundedMessages: { role: string; text: string }[] = [];
  let usedBytes = Buffer.byteLength(system, "utf8");
  for (const msg of messages) {
    const remaining = MOCK_LLM_SNAPSHOT_MAX_BYTES - usedBytes;
    if (remaining <= 0) break;
    const text = truncateUtf8(msg.text, Math.min(remaining, perFieldCap));
    usedBytes += Buffer.byteLength(text, "utf8") + msg.role.length + 16;
    boundedMessages.push({ role: msg.role, text });
  }

  return {
    dialect: request.dialect,
    model,
    system,
    toolNames,
    messages: boundedMessages,
  };
}

function normalizeEventValue(value: unknown, replacements?: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") return normalizeVolatileText(value, replacements);
  if (Array.isArray(value)) return value.map((item) => normalizeEventValue(item, replacements));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_EVENT_KEYS.has(key)) continue;
    out[key] = normalizeEventValue(value[key], replacements);
  }
  return out;
}

export function normalizeDriverEvents(
  events: readonly DriverEvent[],
  options?: { replacements?: Readonly<Record<string, string>> },
): readonly NormalizedDriverEvent[] {
  const out: NormalizedDriverEvent[] = [];
  let totalBytes = 0;
  for (const event of events) {
    const record = event as unknown as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const semantic: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === "type" || VOLATILE_EVENT_KEYS.has(key)) continue;
      semantic[key] = normalizeEventValue(record[key], options?.replacements);
    }
    const summary = truncateUtf8(stableJson(semantic), Math.max(256, MOCK_LLM_SNAPSHOT_MAX_BYTES - totalBytes));
    totalBytes += Buffer.byteLength(summary, "utf8") + event.type.length + 32;
    out.push({ type: event.type, keys, summary });
    if (totalBytes >= MOCK_LLM_SNAPSHOT_MAX_BYTES) break;
  }
  return out;
}

function collectJsonFiles(rootDir: string, currentDir = rootDir): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      for (const [rel, abs] of collectJsonFiles(rootDir, full)) files.set(rel, abs);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const rel = relative(rootDir, full).split("\\").join("/");
      files.set(rel, full);
    }
  }
  return files;
}

function canonicalJsonFile(filePath: string): string {
  const raw = readFileSync(filePath, "utf8");
  try {
    return stableJson(JSON.parse(raw));
  } catch {
    return raw.trim();
  }
}

export function diffJsonSchemaTrees(baselineDir: string, currentDir: string): JsonSchemaTreeDiff {
  const baseFiles = collectJsonFiles(baselineDir);
  const currFiles = collectJsonFiles(currentDir);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const rel of currFiles.keys()) {
    if (!baseFiles.has(rel)) added.push(rel);
  }
  for (const [rel, basePath] of baseFiles) {
    const currPath = currFiles.get(rel);
    if (currPath === undefined) {
      removed.push(rel);
    } else if (canonicalJsonFile(basePath) !== canonicalJsonFile(currPath)) {
      changed.push(rel);
    }
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

export function evaluateJsonSchemaDrift(diff: JsonSchemaTreeDiff): SchemaDriftEvaluation {
  const breaking = diff.removed.length > 0 || diff.changed.length > 0;
  const summary = breaking
    ? `Breaking JSON Schema drift detected: ${diff.removed.length} removed, ${diff.changed.length} changed, ${diff.added.length} added`
    : `No breaking JSON Schema drift (${diff.added.length} added, 0 removed, 0 changed)`;
  return {
    breaking,
    exitCode: breaking ? 1 : 0,
    summary,
    diff,
  };
}
