// Invariant: prefix checks compare semantic model prefixes per wire dialect and strip only cache-neutral transport markers.
import type { MockLlmDialect, PrefixDiff, PrefixStabilityResult, RecordedLlmRequest } from "./types.ts";

interface ExtractedPrefixView {
  system: unknown;
  tools: unknown;
  cacheKey: string | undefined;
  messages: unknown[] | null;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripKeyRecursive(value: unknown, omitKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => stripKeyRecursive(item, omitKeys));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (omitKeys.has(key)) continue;
    out[key] = stripKeyRecursive(value[key], omitKeys);
  }
  return out;
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

const ANTHROPIC_OMIT = new Set(["cache_control"]);
const RESPONSES_OMIT = new Set(["id"]);

// Claude CLI 2.1.332 wraps the tail user turn in a single text block with cache_control,
// then collapses it to a plain string on the next turn when cache_control slides forward.
function canonicalizeAnthropicContent(content: unknown): unknown {
  const stripped = stripKeyRecursive(content, ANTHROPIC_OMIT);
  if (typeof stripped === "string") return stripped;
  if (
    Array.isArray(stripped) &&
    stripped.length === 1 &&
    isRecord(stripped[0]) &&
    stripped[0].type === "text" &&
    typeof stripped[0].text === "string" &&
    Object.keys(stripped[0]).length === 2
  ) {
    return stripped[0].text;
  }
  return stripped;
}

function canonicalizeAnthropicSystem(system: unknown): unknown {
  if (system === undefined || system === null) return "";
  return canonicalizeAnthropicContent(system);
}

function canonicalizeAnthropicMessage(msg: unknown): unknown {
  if (!isRecord(msg)) return stripKeyRecursive(msg, ANTHROPIC_OMIT);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(msg).sort()) {
    if (key === "cache_control") continue;
    out[key] = key === "content" ? canonicalizeAnthropicContent(msg[key]) : stripKeyRecursive(msg[key], ANTHROPIC_OMIT);
  }
  return out;
}

function extractView(req: RecordedLlmRequest): ExtractedPrefixView {
  if (!isRecord(req.body)) {
    return { system: null, tools: null, cacheKey: undefined, messages: null, error: "Request body is not a JSON object" };
  }
  const body = req.body;
  switch (req.dialect) {
    case "anthropic-messages": {
      if (!Array.isArray(body.messages)) {
        return { system: null, tools: null, cacheKey: undefined, messages: null, error: "Anthropic request missing messages array" };
      }
      return {
        system: canonicalizeAnthropicSystem(body.system),
        tools: stripKeyRecursive(body.tools ?? [], ANTHROPIC_OMIT),
        cacheKey: undefined,
        messages: body.messages.map(canonicalizeAnthropicMessage),
      };
    }
    case "openai-responses": {
      if (!Array.isArray(body.input)) {
        return { system: null, tools: null, cacheKey: undefined, messages: null, error: "OpenAI Responses request missing input array" };
      }
      return {
        system: body.instructions ?? "",
        tools: body.tools ?? [],
        cacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
        messages: body.input.map((item) => stripKeyRecursive(item, RESPONSES_OMIT)),
      };
    }
    case "openai-chat-completions": {
      if (!Array.isArray(body.messages)) {
        return { system: null, tools: null, cacheKey: undefined, messages: null, error: "Chat Completions request missing messages array" };
      }
      const leadingSystem: unknown[] = [];
      let firstNonSystem = 0;
      while (firstNonSystem < body.messages.length) {
        const m = body.messages[firstNonSystem];
        if (isRecord(m) && (m.role === "system" || m.role === "developer")) {
          leadingSystem.push(m);
          firstNonSystem++;
        } else {
          break;
        }
      }
      return {
        system: leadingSystem,
        tools: body.tools ?? [],
        cacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
        messages: body.messages.slice(firstNonSystem),
      };
    }
    case "gemini-generate-content": {
      if (!Array.isArray(body.contents)) {
        return { system: null, tools: null, cacheKey: undefined, messages: null, error: "Gemini request missing contents array" };
      }
      return {
        system: body.systemInstruction ?? body.system_instruction ?? null,
        tools: body.tools ?? [],
        cacheKey: typeof body.cachedContent === "string" ? body.cachedContent : undefined,
        messages: body.contents,
      };
    }
    default:
      return { system: null, tools: null, cacheKey: undefined, messages: null, error: `Unsupported dialect: ${req.dialect}` };
  }
}

export function checkPrefixStability(
  requests: readonly RecordedLlmRequest[],
  options?: { requireCacheKeyStable?: boolean },
): PrefixStabilityResult {
  const dialect: MockLlmDialect | "unknown" = requests[0]?.dialect ?? "unknown";
  if (requests.length < 2) {
    return { stable: true, dialect, checkedPairs: 0, diffs: [] };
  }

  const diffs: PrefixDiff[] = [];
  const views = requests.map(extractView);
  const checkedPairs = requests.length - 1;

  for (let i = 0; i < checkedPairs; i++) {
    const prev = views[i]!;
    const next = views[i + 1]!;
    if (prev.error || next.error || prev.messages === null || next.messages === null) {
      diffs.push({
        fromIndex: i,
        toIndex: i + 1,
        field: "messages",
        detail: prev.error ?? next.error ?? "Malformed request payload",
      });
      continue;
    }

    if (stableJson(prev.system) !== stableJson(next.system)) {
      diffs.push({
        fromIndex: i,
        toIndex: i + 1,
        field: "system",
        detail: "System prompt/instructions mutated between consecutive requests",
      });
    }

    if (stableJson(prev.tools) !== stableJson(next.tools)) {
      diffs.push({
        fromIndex: i,
        toIndex: i + 1,
        field: "tools",
        detail: "Tool definitions mutated between consecutive requests",
      });
    }

    const checkCacheKey = options?.requireCacheKeyStable === true || prev.cacheKey !== undefined || next.cacheKey !== undefined;
    if (checkCacheKey) {
      if (options?.requireCacheKeyStable && (prev.cacheKey === undefined || next.cacheKey === undefined)) {
        diffs.push({
          fromIndex: i,
          toIndex: i + 1,
          field: "cache_key",
          detail: `Expected stable cache key, got ${JSON.stringify(prev.cacheKey)} -> ${JSON.stringify(next.cacheKey)}`,
        });
      } else if (prev.cacheKey !== next.cacheKey) {
        diffs.push({
          fromIndex: i,
          toIndex: i + 1,
          field: "cache_key",
          detail: `Cache key changed from ${JSON.stringify(prev.cacheKey)} to ${JSON.stringify(next.cacheKey)}`,
        });
      }
    }

    if (next.messages.length < prev.messages.length) {
      diffs.push({
        fromIndex: i,
        toIndex: i + 1,
        field: "messages",
        firstMessageDiffIndex: next.messages.length,
        detail: `Message prefix shrank from ${prev.messages.length} to ${next.messages.length}`,
      });
      continue;
    }

    for (let j = 0; j < prev.messages.length; j++) {
      if (stableJson(prev.messages[j]) !== stableJson(next.messages[j])) {
        diffs.push({
          fromIndex: i,
          toIndex: i + 1,
          field: "messages",
          firstMessageDiffIndex: j,
          detail: `Message prefix diverged at index ${j}`,
        });
        break;
      }
    }
  }

  return {
    stable: diffs.length === 0,
    dialect,
    checkedPairs,
    diffs,
  };
}

export function expectPrefixStable(
  requests: readonly RecordedLlmRequest[],
  options?: { requireCacheKeyStable?: boolean },
): void {
  if (requests.length < 2) {
    throw new Error(`expectPrefixStable requires at least 2 recorded requests, got ${requests.length}`);
  }
  const result = checkPrefixStability(requests, options);
  if (!result.stable) {
    const details = result.diffs
      .map(
        (d) =>
          `[${d.fromIndex}->${d.toIndex}] ${d.field}${d.firstMessageDiffIndex !== undefined ? `@${d.firstMessageDiffIndex}` : ""}: ${d.detail}`,
      )
      .join("; ");
    throw new Error(`Prompt-cache prefix instability detected (${result.dialect}): ${details}`);
  }
}
