// 几家厂商驱动共用的协议小函数（docs/vendor-plugin-design.md 的 A12：原来和 claude 的 stream-json 协议放在一个文件，P3 拆开）。
// claude 自己的协议在 src/vendors/claude/protocol.ts。
import { createHash } from "node:crypto";
import {
  MAX_STREAMING_TOOL_BLOCKS,
  MAX_STREAMING_TOOL_JSON_CHARS,
  type AgentStepInput,
  type AgentToolPreviewEvent,
  type TokenUsage,
} from "../../shared/index.ts";
import { STEP_INPUT_KEYS } from "../../shared/step-labels.ts";
import { VENDOR_PATHS } from "../../vendors/paths-registry.ts";
import { VENDOR_LIST } from "../../vendors/registry.ts";

/**
 * 一条用户消息的 content（claude、codex 的 composer 的 buildUserContent 就是它，驱动层经厂商接口调）：我们加的字每项一个 text 块在前，用户原文单独放最后一块。
 * claude 只看最后一个 text 块是不是以 / 开头，前面的块模型照样看得到（docs/composer-commands.md 的 T4）。
 * 空白的块不放（API 不收空的 text 块）；全是空白时留一块，写入前的校验会按“文字是空的”拒绝。
 */
export function userContent(prefixes: readonly string[], text: string): Array<{ type: "text"; text: string }> {
  const blocks = prefixes.filter((p) => p.trim() !== "");
  if (text.trim() !== "" || blocks.length === 0) blocks.push(text);
  return blocks.map((t) => ({ type: "text", text: t }));
}

/**
 * 忙时用户连发的几条拼成一条（设计第 7.3 节）：“【用户连发了 N 条】”和每条（带编号）各一个 text 块，最后一条放 text。
 * 以命令开头的不拼（驱动层的 #takeBatch 挑），所以这里不用管命令。只有一条时原样。
 */
export function mergeUserTexts(texts: string[]): { prefixes: string[]; text: string } {
  if (texts.length === 1) return { prefixes: [], text: texts[0]! };
  const items = texts.map((t, i) => `${i + 1}. ${t}`);
  return { prefixes: [`【用户连发了 ${texts.length} 条】`, ...items.slice(0, -1)], text: items.at(-1)! };
}

/** 去重用的 uuid：原始事件有就照抄，没有就 `line:<原始那一行的 sha256 前 32 位>`（driver.ts 的约定）。 */
export function lineUuid(obj: { uuid?: unknown }, rawLine: string): string {
  if (typeof obj.uuid === "string" && obj.uuid !== "") return obj.uuid;
  return `line:${createHash("sha256").update(rawLine).digest("hex").slice(0, 32)}`;
}

const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** claude 的 usage 对象（result.usage、assistant 的 message.usage）里的四个数，缺了或不是数字当 0。 */
export function parseUsage(usage: unknown): Omit<TokenUsage, "context"> {
  const u = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  return {
    input: tokenCount(u.input_tokens),
    cacheRead: tokenCount(u.cache_read_input_tokens),
    cacheWrite: tokenCount(u.cache_creation_input_tokens),
    output: tokenCount(u.output_tokens),
  };
}

/**
 * 一个 assistant 事件的上下文大小：这次请求的 input + 缓存读 + 缓存写。子 agent 的消息（parent_tool_use_id 不是 null）
 * 和没带 usage 的返回 null，不更新。
 */
export function assistantContext(obj: Record<string, unknown>): number | null {
  if (obj.parent_tool_use_id !== undefined && obj.parent_tool_use_id !== null) return null;
  const usage = (obj.message as { usage?: unknown } | undefined)?.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const { input, cacheRead, cacheWrite } = parseUsage(usage);
  return input + cacheRead + cacheWrite;
}

/**
 * 守护进程自己可能是在某个 agent 的会话里起的（开发时）。那家给子进程设的“父会话”变量会让子 agent 以为自己是嵌套的子会话，
 * 起任何厂商的子进程前都去掉：各家 paths.ts 的 parentSessionEnv 的并集，加上不属于哪一家厂商的宿主（t3code）设的。
 */
export const PARENT_SESSION_ENV: readonly string[] = [
  ...new Set([...VENDOR_LIST.flatMap(({ id }) => VENDOR_PATHS[id].parentSessionEnv ?? []), "T3CODE_THREAD_ID", "T3CODE_CLI_PATH"]),
];

export function buildChildEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !PARENT_SESSION_ENV.includes(k)) env[k] = v;
  return { ...env, ...extra };
}

const MAX_PREVIEW_ARG_CHARS = 300;

/** 从任意对象中提取状态文案所需的路径 / skill 字段（与 stepOfTool 一致，只留非空字符串）。 */
export function pickToolStepInput(input: unknown): AgentStepInput {
  const out: AgentStepInput = {};
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    for (const key of STEP_INPUT_KEYS) {
      const v = rec[key];
      if (typeof v === "string" && v.trim() !== "") {
        out[key] = [...v].slice(0, MAX_PREVIEW_ARG_CHARS).join("");
      }
    }
  }
  return out;
}

/** 计算工具步骤的去重签名（工具名 + STEP_INPUT_KEYS 字段值），签名未变时不重复发预览事件。 */
export function toolStepSignature(name: string, input: unknown): string {
  const kept = pickToolStepInput(input);
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
    if (ch === 0x5c /* \ */) {
      if (i + 1 >= src.length) return null;
      if (src.charCodeAt(i + 1) === 0x75 /* u */) {
        if (i + 5 >= src.length) return null;
        i += 6;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === 0x22 /* " */) {
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

/**
 * 从流式半截 JSON 对象前缀中提取所有已闭合的顶层 STEP_INPUT_KEYS 字符串字段：
 * 引号尚未闭合的半截字符串不提取，JSON 转义序列（\"、\\、\uXXXX 等）经标准 JSON.parse 精确还原。
 */
export function extractStreamingToolStepInput(partialJson: string): AgentStepInput {
  const out: AgentStepInput = {};
  let i = skipWs(partialJson, 0);
  if (i >= partialJson.length || partialJson.charCodeAt(i) !== 0x7b /* { */) return out;
  i += 1;

  while (i < partialJson.length) {
    i = skipWs(partialJson, i);
    if (i < partialJson.length && partialJson.charCodeAt(i) === 0x2c /* , */) {
      i = skipWs(partialJson, i + 1);
    }
    if (i >= partialJson.length || partialJson.charCodeAt(i) === 0x7d /* } */) break;
    if (partialJson.charCodeAt(i) !== 0x22 /* " */) break;

    const keyTok = readCompleteJsonString(partialJson, i);
    if (keyTok === null) break;
    i = skipWs(partialJson, keyTok.nextIdx);
    if (i >= partialJson.length || partialJson.charCodeAt(i) !== 0x3a /* : */) break;
    i = skipWs(partialJson, i + 1);
    if (i >= partialJson.length) break;

    const vCh = partialJson.charCodeAt(i);
    if (vCh === 0x22 /* " */) {
      const wantValue = (STEP_INPUT_KEYS as readonly string[]).includes(keyTok.value);
      const valTok = readCompleteJsonString(partialJson, i, wantValue);
      if (valTok === null) break;
      i = valTok.nextIdx;
      if (wantValue && valTok.value.trim() !== "") {
        out[keyTok.value as keyof AgentStepInput] = [...valTok.value].slice(0, MAX_PREVIEW_ARG_CHARS).join("");
      }
    } else if (vCh === 0x7b /* { */ || vCh === 0x5b /* [ */) {
      let depth = 1;
      i += 1;
      while (i < partialJson.length && depth > 0) {
        const c = partialJson.charCodeAt(i);
        if (c === 0x22 /* " */) {
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

/**
 * 单会话有界的流式工具调用参数跟踪器（Claude stream_event 与 Pi toolcall_start/delta 共用）：
 * - 单块 JSON 缓冲上限 MAX_STREAMING_TOOL_JSON_CHARS（8 KB），块数上限 MAX_STREAMING_TOOL_BLOCKS（32）；
 * - 工具起点立即发一次预览，之后仅在提取到新的路径 / skill 字段（step 签名变化）时再发一次预览，后续大段正文参数零刷屏。
 */
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
    const keptInput = pickToolStepInput(opts.initialInput);
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
    const merged: AgentStepInput = { ...b.keptInput, ...pickToolStepInput(patch.input) };
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
