import { createHash } from "node:crypto";
import {
  MAX_STEP_ARG_CHARS,
  MAX_STREAMING_TOOL_BLOCKS,
  MAX_STREAMING_TOOL_JSON_CHARS,
  type AgentStepInput,
  type AgentToolPreviewEvent,
  type TokenUsage,
} from "../../shared/index.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { STEP_INPUT_KEYS, pickStepInput } from "../../shared/step-labels.ts";

export { pickStepInput };
import { VENDOR_PATHS } from "../../vendors/paths-registry.ts";
import { VENDOR_LIST } from "../../vendors/registry.ts";

export function userContent(prefixes: readonly string[], text: string): Array<{ type: "text"; text: string }> {
  const blocks = prefixes.filter((p) => p.trim() !== "");
  if (text.trim() !== "" || blocks.length === 0) blocks.push(text);
  return blocks.map((t) => ({ type: "text", text: t }));
}

export function mergeUserTexts(texts: string[]): { prefixes: string[]; text: string } {
  if (texts.length === 1) return { prefixes: [], text: texts[0]! };
  const items = texts.map((t, i) => `${i + 1}. ${t}`);
  return { prefixes: [`【用户连发了 ${texts.length} 条】`, ...items.slice(0, -1)], text: items.at(-1)! };
}

export function lineUuid(obj: { uuid?: unknown }, rawLine: string): string {
  if (typeof obj.uuid === "string" && obj.uuid !== "") return obj.uuid;
  return `line:${createHash("sha256").update(rawLine).digest("hex").slice(0, 32)}`;
}

const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function parseUsage(usage: unknown): Omit<TokenUsage, "context"> {
  const u = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  return {
    input: tokenCount(u.input_tokens),
    cacheRead: tokenCount(u.cache_read_input_tokens),
    cacheWrite: tokenCount(u.cache_creation_input_tokens),
    output: tokenCount(u.output_tokens),
  };
}

export const PARENT_SESSION_ENV: readonly string[] = [
  ...new Set([
    ...VENDOR_LIST.flatMap(({ id }) => VENDOR_PATHS[id].parentSessionEnv ?? []),
    "T3CODE_THREAD_ID",
    "T3CODE_CLI_PATH",
    ENV_HUB_TOKEN,
    ENV_HUB_SOCK,
  ]),
];

export function buildChildEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const parentDenyUpper = platform === "win32" ? new Set(PARENT_SESSION_ENV.map((k) => k.toUpperCase())) : null;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (parentDenyUpper ? parentDenyUpper.has(k.toUpperCase()) : PARENT_SESSION_ENV.includes(k)) continue;
    env[k] = v;
  }
  if (!extra) return env;
  if (platform !== "win32") return { ...env, ...extra };
  for (const [ek, ev] of Object.entries(extra)) {
    const lower = ek.toLowerCase();
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toLowerCase() === lower && existingKey !== ek) {
        delete env[existingKey];
      }
    }
    env[ek] = ev;
  }
  return env;
}

export function toolStepSignature(name: string, input: unknown): string {
  const kept = pickStepInput(input);
  return `${name}\u0000${STEP_INPUT_KEYS.map((k) => kept[k] ?? "").join("\u0000")}`;
}

function readCompleteJsonString(
  src: string,
  quoteIdx: number,
  decode = true,
): { value: string; nextIdx: number } | null {
  let i = quoteIdx + 1;
  while (i < src.length) {
    const ch = src.charCodeAt(i);
    if (ch === 0x5c) {
      if (i + 1 >= src.length) return null;
      if (src.charCodeAt(i + 1) === 0x75) {
        if (i + 5 >= src.length) return null;
        i += 6;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === 0x22) {
      if (!decode) return { value: "", nextIdx: i + 1 };
      try {
        return { value: JSON.parse(src.slice(quoteIdx, i + 1)) as string, nextIdx: i + 1 };
      } catch {
        return null;
      }
    }
    i += 1;
  }
  return null;
}

function skipWs(src: string, idx: number): number {
  let i = idx;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
    else break;
  }
  return i;
}

export function extractStreamingToolStepInput(partialJson: string): AgentStepInput {
  const out: AgentStepInput = {};
  let i = skipWs(partialJson, 0);
  if (i >= partialJson.length || partialJson.charCodeAt(i) !== 0x7b) return out;
  i += 1;

  while (i < partialJson.length) {
    i = skipWs(partialJson, i);
    if (i < partialJson.length && partialJson.charCodeAt(i) === 0x2c) {
      i = skipWs(partialJson, i + 1);
    }
    if (i >= partialJson.length || partialJson.charCodeAt(i) === 0x7d) break;
    if (partialJson.charCodeAt(i) !== 0x22) break;

    const keyTok = readCompleteJsonString(partialJson, i);
    if (keyTok === null) break;
    i = skipWs(partialJson, keyTok.nextIdx);
    if (i >= partialJson.length || partialJson.charCodeAt(i) !== 0x3a) break;
    i = skipWs(partialJson, i + 1);
    if (i >= partialJson.length) break;

    const vCh = partialJson.charCodeAt(i);
    if (vCh === 0x22) {
      const wantValue = (STEP_INPUT_KEYS as readonly string[]).includes(keyTok.value);
      const valTok = readCompleteJsonString(partialJson, i, wantValue);
      if (valTok === null) break;
      i = valTok.nextIdx;
      if (wantValue && valTok.value.trim() !== "") {
        out[keyTok.value as keyof AgentStepInput] = [...valTok.value].slice(0, MAX_STEP_ARG_CHARS).join("");
      }
    } else if (vCh === 0x7b || vCh === 0x5b) {
      let depth = 1;
      i += 1;
      while (i < partialJson.length && depth > 0) {
        const c = partialJson.charCodeAt(i);
        if (c === 0x22) {
          const nestedStr = readCompleteJsonString(partialJson, i, false);
          if (nestedStr === null) return out;
          i = nestedStr.nextIdx;
          continue;
        }
        if (c === 0x7b || c === 0x5b) depth += 1;
        else if (c === 0x7d || c === 0x5d) depth -= 1;
        i += 1;
      }
      if (depth > 0) break;
    } else {
      while (i < partialJson.length) {
        const c = partialJson.charCodeAt(i);
        if (c === 0x2c || c === 0x7d || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
        i += 1;
      }
    }
  }
  return out;
}

interface StreamingToolBlockState {
  toolUseId?: string;
  name: string;
  parentToolUseId?: string;
  jsonBuf: string;
  capped: boolean;
  keptInput: AgentStepInput;
  lastSig: string;
}

/** Bounded per-session tracker for streamed tool-call JSON, shared by claude stream_event and Pi toolcall deltas. */
export class StreamingToolPreviewTracker {
  readonly #blocks = new Map<string | number, StreamingToolBlockState>();

  get size(): number {
    return this.#blocks.size;
  }

  start(
    key: string | number,
    opts: {
      toolUseId?: string;
      name: string;
      initialInput?: unknown;
      parentToolUseId?: string;
      at: number;
    },
  ): AgentToolPreviewEvent | null {
    if (opts.name === "") return null;
    if (!this.#blocks.has(key) && this.#blocks.size >= MAX_STREAMING_TOOL_BLOCKS) {
      const oldest = this.#blocks.keys().next().value;
      if (oldest !== undefined) this.#blocks.delete(oldest);
    }
    const keptInput = pickStepInput(opts.initialInput);
    const lastSig = toolStepSignature(opts.name, keptInput);
    this.#blocks.set(key, {
      toolUseId: opts.toolUseId,
      name: opts.name,
      parentToolUseId: opts.parentToolUseId,
      jsonBuf: "",
      capped: false,
      keptInput,
      lastSig,
    });
    return this.#toEvent(this.#blocks.get(key)!, opts.at);
  }

  appendJsonDelta(key: string | number, partialJson: string, at: number): AgentToolPreviewEvent | null {
    const b = this.#blocks.get(key);
    if (!b || partialJson === "" || b.capped) return null;
    const room = MAX_STREAMING_TOOL_JSON_CHARS - b.jsonBuf.length;
    if (partialJson.length >= room) {
      b.jsonBuf += partialJson.slice(0, Math.max(0, room));
      b.capped = true;
    } else {
      b.jsonBuf += partialJson;
    }
    const extracted = extractStreamingToolStepInput(b.jsonBuf);
    const merged: AgentStepInput = { ...b.keptInput, ...extracted };
    const sig = toolStepSignature(b.name, merged);
    if (sig === b.lastSig) return null;
    b.keptInput = merged;
    b.lastSig = sig;
    return this.#toEvent(b, at);
  }

  updateObject(
    key: string | number,
    patch: { toolUseId?: string; name?: string; input?: unknown },
    at: number,
  ): AgentToolPreviewEvent | null {
    let b = this.#blocks.get(key);
    if (!b) {
      if (!patch.name) return null;
      return this.start(key, { toolUseId: patch.toolUseId, name: patch.name, initialInput: patch.input, at });
    }
    if (patch.toolUseId) b.toolUseId = patch.toolUseId;
    if (patch.name) b.name = patch.name;
    const merged: AgentStepInput = { ...b.keptInput, ...pickStepInput(patch.input) };
    const sig = toolStepSignature(b.name, merged);
    if (sig === b.lastSig) return null;
    b.keptInput = merged;
    b.lastSig = sig;
    return this.#toEvent(b, at);
  }

  end(key: string | number): void {
    this.#blocks.delete(key);
  }

  clear(): void {
    this.#blocks.clear();
  }

  #toEvent(b: StreamingToolBlockState, at: number): AgentToolPreviewEvent {
    return {
      type: "agent.tool_preview",
      ...(b.toolUseId !== undefined && b.toolUseId !== "" ? { toolUseId: b.toolUseId } : {}),
      name: b.name,
      input: { ...b.keptInput },
      ...(b.parentToolUseId !== undefined ? { parentToolUseId: b.parentToolUseId } : {}),
      at,
    };
  }
}
