// Invariant: binds exclusively on 127.0.0.1 and enforces request count and body byte caps.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  MOCK_LLM_DEFAULT_WAIT_TIMEOUT_MS,
  MOCK_LLM_MAX_CONCURRENT_REQUESTS,
  MOCK_LLM_MAX_RECORDED_REQUESTS,
  MOCK_LLM_MAX_REQUEST_BODY_BYTES,
} from "./limits.ts";
import type {
  MockLlmDialect,
  MockLlmScript,
  MockLlmServer,
  MockLlmServerOptions,
  MockLlmToolCall,
  MockLlmTurn,
  MockLlmUsage,
  RecordedLlmRequest,
} from "./types.ts";

const DEFAULT_USAGE: Required<MockLlmUsage> = {
  inputTokens: 100,
  outputTokens: 12,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

export function detectDialect(method: string, path: string): MockLlmDialect | "unknown" {
  if (method.toUpperCase() !== "POST") return "unknown";
  const pathname = (path.split("?", 1)[0] ?? "").replace(/\/+$/, "");
  if (/^\/(?:v1\/)?messages$/u.test(pathname)) return "anthropic-messages";
  if (/^\/(?:v1\/)?responses$/u.test(pathname)) return "openai-responses";
  if (/^\/(?:v1\/)?chat\/completions$/u.test(pathname)) return "openai-chat-completions";
  if (/^\/v1(?:beta|alpha)?\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/u.test(pathname)) {
    return "gemini-generate-content";
  }
  return "unknown";
}

function flattenTextParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (isRecord(item)) {
      if (typeof item.text === "string") parts.push(item.text);
      else if (typeof item.content === "string") parts.push(item.content);
    }
  }
  return parts.join("\n");
}

function extractLastUserText(dialect: MockLlmDialect, body: unknown): string {
  if (!isRecord(body)) return "";
  if (dialect === "anthropic-messages" || dialect === "openai-chat-completions") {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (isRecord(m) && m.role === "user") return flattenTextParts(m.content);
    }
    return "";
  }
  if (dialect === "openai-responses") {
    const input = Array.isArray(body.input) ? body.input : [];
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (isRecord(item) && item.role === "user") return flattenTextParts(item.content);
    }
    return "";
  }
  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const entry = contents[i];
    if (isRecord(entry) && (entry.role === "user" || entry.role === undefined)) {
      return flattenTextParts(entry.parts);
    }
  }
  return "";
}

function resolveUsage(usage?: MockLlmUsage): Required<MockLlmUsage> {
  return {
    inputTokens: usage?.inputTokens ?? DEFAULT_USAGE.inputTokens,
    outputTokens: usage?.outputTokens ?? DEFAULT_USAGE.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens ?? DEFAULT_USAGE.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens ?? DEFAULT_USAGE.cacheWriteTokens,
    reasoningTokens: usage?.reasoningTokens ?? DEFAULT_USAGE.reasoningTokens,
  };
}

function resolveTextDeltas(turn: MockLlmTurn): readonly string[] {
  if (turn.textDeltas && turn.textDeltas.length > 0) return turn.textDeltas;
  if (turn.text !== undefined) return [turn.text];
  if ((turn.toolCalls?.length ?? 0) === 0 && !turn.thinking) return [""];
  return [];
}

function requestModel(body: unknown, path: string): string {
  if (isRecord(body) && typeof body.model === "string" && body.model.trim() !== "") return body.model;
  const m = /\/models\/([^/:?]+):/u.exec(path);
  return m?.[1] ?? "mock-model";
}

function sseFrame(event: string | null, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return event === null ? `data: ${payload}\n\n` : `event: ${event}\ndata: ${payload}\n\n`;
}

function encodeAnthropicSse(seq: number, model: string, turn: MockLlmTurn): string[] {
  const usage = resolveUsage(turn.usage);
  const deltas = resolveTextDeltas(turn);
  const toolCalls: readonly MockLlmToolCall[] = turn.toolCalls ?? [];
  const frames: string[] = [];
  let blockIndex = 0;

  frames.push(
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: `msg_mock_${seq}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.inputTokens,
          cache_creation_input_tokens: usage.cacheWriteTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
          output_tokens: 1,
        },
      },
    }),
  );

  if (turn.thinking) {
    const idx = blockIndex++;
    frames.push(sseFrame("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } }));
    frames.push(sseFrame("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: turn.thinking } }));
    frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: idx }));
  }

  if (deltas.length > 0) {
    const idx = blockIndex++;
    frames.push(sseFrame("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }));
    for (const delta of deltas) {
      frames.push(sseFrame("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: delta } }));
    }
    frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: idx }));
  }

  toolCalls.forEach((tc, tcIdx) => {
    const idx = blockIndex++;
    const id = tc.id ?? `toolu_mock_${seq}_${tcIdx + 1}`;
    frames.push(
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: idx,
        content_block: { type: "tool_use", id, name: tc.name, input: {} },
      }),
    );
    frames.push(
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: idx,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.arguments) },
      }),
    );
    frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: idx }));
  });

  frames.push(
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.outputTokens },
    }),
  );
  frames.push(sseFrame("message_stop", { type: "message_stop" }));
  return frames;
}

function encodeAnthropicJson(seq: number, model: string, turn: MockLlmTurn): Record<string, unknown> {
  const usage = resolveUsage(turn.usage);
  const fullText = turn.text ?? resolveTextDeltas(turn).join("");
  const toolCalls: readonly MockLlmToolCall[] = turn.toolCalls ?? [];
  const content: unknown[] = [];
  if (turn.thinking) content.push({ type: "thinking", thinking: turn.thinking });
  if (fullText !== "" || toolCalls.length === 0) content.push({ type: "text", text: fullText });
  toolCalls.forEach((tc, idx) => {
    content.push({ type: "tool_use", id: tc.id ?? `toolu_mock_${seq}_${idx + 1}`, name: tc.name, input: tc.arguments });
  });
  return {
    id: `msg_mock_${seq}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      output_tokens: usage.outputTokens,
    },
  };
}

function encodeOpenAiResponsesSse(seq: number, model: string, turn: MockLlmTurn): string[] {
  const usage = resolveUsage(turn.usage);
  const deltas = resolveTextDeltas(turn);
  const fullText = deltas.join("");
  const toolCalls: readonly MockLlmToolCall[] = turn.toolCalls ?? [];
  const responseId = `resp_mock_${seq}`;
  const frames: string[] = [];
  const outputItems: unknown[] = [];
  let outputIndex = 0;

  frames.push(
    sseFrame("response.created", {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", model, output: [] },
    }),
  );

  if (turn.thinking) {
    const idx = outputIndex++;
    const itemId = `rs_mock_${seq}`;
    const doneItem = { id: itemId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: turn.thinking }] };
    frames.push(sseFrame("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { id: itemId, type: "reasoning", summary: [] } }));
    frames.push(sseFrame("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: itemId, output_index: idx, summary_index: 0, delta: turn.thinking }));
    frames.push(sseFrame("response.output_item.done", { type: "response.output_item.done", output_index: idx, item: doneItem }));
    outputItems.push(doneItem);
  }

  if (deltas.length > 0) {
    const idx = outputIndex++;
    const msgId = `msg_mock_${seq}`;
    const part = { type: "output_text", text: fullText, annotations: [] };
    const doneItem = { id: msgId, type: "message", status: "completed", role: "assistant", content: [part] };
    frames.push(sseFrame("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] } }));
    frames.push(sseFrame("response.content_part.added", { type: "response.content_part.added", item_id: msgId, output_index: idx, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    for (const delta of deltas) {
      frames.push(sseFrame("response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: idx, content_index: 0, delta }));
    }
    frames.push(sseFrame("response.output_text.done", { type: "response.output_text.done", item_id: msgId, output_index: idx, content_index: 0, text: fullText }));
    frames.push(sseFrame("response.content_part.done", { type: "response.content_part.done", item_id: msgId, output_index: idx, content_index: 0, part }));
    frames.push(sseFrame("response.output_item.done", { type: "response.output_item.done", output_index: idx, item: doneItem }));
    outputItems.push(doneItem);
  }

  toolCalls.forEach((tc, tcIdx) => {
    const idx = outputIndex++;
    const callId = tc.id ?? `call_mock_${seq}_${tcIdx + 1}`;
    const itemId = `fc_mock_${seq}_${tcIdx + 1}`;
    const argsJson = JSON.stringify(tc.arguments);
    const doneItem = { id: itemId, type: "function_call", status: "completed", call_id: callId, name: tc.name, arguments: argsJson };
    frames.push(sseFrame("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { id: itemId, type: "function_call", status: "in_progress", call_id: callId, name: tc.name, arguments: "" } }));
    frames.push(sseFrame("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: itemId, output_index: idx, delta: argsJson }));
    frames.push(sseFrame("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: itemId, output_index: idx, arguments: argsJson }));
    frames.push(sseFrame("response.output_item.done", { type: "response.output_item.done", output_index: idx, item: doneItem }));
    outputItems.push(doneItem);
  });

  frames.push(
    sseFrame("response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        model,
        output: outputItems,
        usage: {
          input_tokens: usage.inputTokens,
          input_tokens_details: { cached_tokens: usage.cacheReadTokens },
          output_tokens: usage.outputTokens,
          output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
      },
    }),
  );
  return frames;
}

function encodeOpenAiChatSse(seq: number, model: string, turn: MockLlmTurn): string[] {
  const usage = resolveUsage(turn.usage);
  const deltas = resolveTextDeltas(turn);
  const toolCalls: readonly MockLlmToolCall[] = turn.toolCalls ?? [];
  const id = `chatcmpl_mock_${seq}`;
  const created = Math.floor(Date.now() / 1000);
  const frames: string[] = [];

  frames.push(
    sseFrame(null, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    }),
  );

  if (turn.thinking) {
    frames.push(
      sseFrame(null, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { reasoning_content: turn.thinking }, finish_reason: null }],
      }),
    );
  }

  for (const delta of deltas) {
    frames.push(
      sseFrame(null, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      }),
    );
  }

  toolCalls.forEach((tc, idx) => {
    frames.push(
      sseFrame(null, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: idx,
                  id: tc.id ?? `call_mock_${seq}_${idx + 1}`,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  });

  frames.push(
    sseFrame(null, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
      },
    }),
  );
  frames.push(sseFrame(null, "[DONE]"));
  return frames;
}

function encodeOpenAiChatJson(seq: number, model: string, turn: MockLlmTurn): Record<string, unknown> {
  const usage = resolveUsage(turn.usage);
  const fullText = turn.text ?? resolveTextDeltas(turn).join("");
  const toolCalls: readonly MockLlmToolCall[] = turn.toolCalls ?? [];
  return {
    id: `chatcmpl_mock_${seq}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length > 0 && fullText === "" ? null : fullText,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((tc, idx) => ({
                  id: tc.id ?? `call_mock_${seq}_${idx + 1}`,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
              }
            : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
    },
  };
}

function encodeGeminiSse(turn: MockLlmTurn): string[] {
  const usage = resolveUsage(turn.usage);
  const toolCalls: readonly MockLlmToolCall[] = turn.toolCalls ?? [];
  const usageMetadata = {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    totalTokenCount: usage.inputTokens + usage.outputTokens,
    cachedContentTokenCount: usage.cacheReadTokens,
    thoughtsTokenCount: usage.reasoningTokens,
  };
  const frames: string[] = [];

  if (turn.thinking) {
    frames.push(
      sseFrame(null, {
        candidates: [{ content: { role: "model", parts: [{ text: turn.thinking, thought: true }] }, index: 0 }],
      }),
    );
  }

  // Emit full text in one chunk unless chunked abort testing explicitly splits deltas.
  const textChunks =
    turn.streamAbortAfterChunk !== undefined
      ? resolveTextDeltas(turn)
      : turn.text !== undefined
        ? [turn.text]
        : resolveTextDeltas(turn);

  for (let i = 0; i < textChunks.length; i++) {
    const isLast = i === textChunks.length - 1 && toolCalls.length === 0;
    frames.push(
      sseFrame(null, {
        candidates: [
          {
            content: { role: "model", parts: [{ text: textChunks[i]! }] },
            index: 0,
            ...(isLast ? { finishReason: "STOP" } : {}),
          },
        ],
        ...(isLast ? { usageMetadata } : {}),
      }),
    );
  }

  if (toolCalls.length > 0) {
    frames.push(
      sseFrame(null, {
        candidates: [
          {
            content: {
              role: "model",
              parts: toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.arguments } })),
            },
            index: 0,
            finishReason: "STOP",
          },
        ],
        usageMetadata,
      }),
    );
  }

  if (frames.length === 0) {
    frames.push(
      sseFrame(null, {
        candidates: [{ content: { role: "model", parts: [{ text: "" }] }, index: 0, finishReason: "STOP" }],
        usageMetadata,
      }),
    );
  }
  return frames;
}

function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ rawBytes: number; truncated: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let rawBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      rawBytes += chunk.length;
      if (rawBytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        cleanup();
        // Stop pulling from the socket immediately; absorb follow-up errors while 413 flushes and closes the socket.
        req.pause();
        req.on("error", () => {});
        resolve({ rawBytes, truncated: true, text: "" });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ rawBytes, truncated: false, text: Buffer.concat(chunks).toString("utf8") });
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Request stream aborted before completing"));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function normalizeHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(", ");
  }
  return out;
}

function writeTurnResponse(
  req: IncomingMessage,
  res: ServerResponse,
  dialect: MockLlmDialect,
  seq: number,
  path: string,
  body: unknown,
  turn: MockLlmTurn,
): void {
  if (turn.httpError) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (turn.httpError.retryAfterSec !== undefined) headers["retry-after"] = String(turn.httpError.retryAfterSec);
    res.writeHead(turn.httpError.status, headers);
    res.end(JSON.stringify(turn.httpError.body ?? { error: { message: `mock HTTP ${turn.httpError.status}` } }));
    return;
  }

  const model = requestModel(body, path);
  const wantsNonStreamJson =
    (dialect === "anthropic-messages" || dialect === "openai-chat-completions") &&
    isRecord(body) &&
    body.stream === false;

  if (wantsNonStreamJson) {
    const payload =
      dialect === "anthropic-messages"
        ? encodeAnthropicJson(seq, model, turn)
        : encodeOpenAiChatJson(seq, model, turn);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  let frames: string[];
  switch (dialect) {
    case "anthropic-messages":
      frames = encodeAnthropicSse(seq, model, turn);
      break;
    case "openai-responses":
      frames = encodeOpenAiResponsesSse(seq, model, turn);
      break;
    case "openai-chat-completions":
      frames = encodeOpenAiChatSse(seq, model, turn);
      break;
    case "gemini-generate-content":
      frames = encodeGeminiSse(turn);
      break;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  if (turn.streamAbortAfterChunk !== undefined) {
    const count = Math.max(1, Math.min(turn.streamAbortAfterChunk, frames.length));
    for (let i = 0; i < count; i++) res.write(frames[i]!);
    res.flushHeaders?.();
    req.socket.destroy();
    return;
  }

  for (const frame of frames) res.write(frame);
  res.end();
}

export async function createMockLlmServer(options: MockLlmServerOptions = {}): Promise<MockLlmServer> {
  const maxRecorded = options.maxRecordedRequests ?? MOCK_LLM_MAX_RECORDED_REQUESTS;
  const maxBodyBytes = options.maxRequestBodyBytes ?? MOCK_LLM_MAX_REQUEST_BODY_BYTES;
  assertPositiveInt("maxRecordedRequests", maxRecorded);
  assertPositiveInt("maxRequestBodyBytes", maxBodyBytes);

  let script: MockLlmScript = options.script ?? {};
  let turnCursor = 0;
  let seq = 0;
  let inFlight = 0;
  let closed = false;
  const consumedMatchers = new Set<number>();
  const recorded: RecordedLlmRequest[] = [];
  const openedGates = new Set<string>();
  const gateWaiters = new Map<string, Set<() => void>>();
  const requestWaiters = new Set<() => void>();

  const notifyRequestWaiters = () => {
    for (const notify of [...requestWaiters]) notify();
  };

  const waitForGate = (name: string): Promise<void> => {
    if (openedGates.has(name) || closed) return Promise.resolve();
    return new Promise((resolve) => {
      let set = gateWaiters.get(name);
      if (!set) {
        set = new Set();
        gateWaiters.set(name, set);
      }
      set.add(resolve);
    });
  };

  const recordRequest = (entry: RecordedLlmRequest): void => {
    recorded.push(entry);
    while (recorded.length > maxRecorded) recorded.shift();
    notifyRequestWaiters();
  };

  const selectTurn = (dialect: MockLlmDialect, body: unknown): MockLlmTurn => {
    if (script.matchers && script.matchers.length > 0) {
      const lastUser = extractLastUserText(dialect, body);
      for (let i = 0; i < script.matchers.length; i++) {
        if (consumedMatchers.has(i)) continue;
        const matcher = script.matchers[i]!;
        if (lastUser.includes(matcher.whenLastUserContains)) {
          if (matcher.once) consumedMatchers.add(i);
          return matcher.turn;
        }
      }
    }
    if (script.turns && turnCursor < script.turns.length) {
      return script.turns[turnCursor++]!;
    }
    if (script.defaultTurn) return script.defaultTurn;
    return { text: "mock-ok" };
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (inFlight >= MOCK_LLM_MAX_CONCURRENT_REQUESTS) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock server concurrency limit reached" } }));
      return;
    }
    inFlight++;
    try {
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      const dialect = detectDialect(method, path);
      const { rawBytes, truncated, text } = await readBoundedBody(req, maxBodyBytes);
      let body: unknown = null;
      if (!truncated && text.trim() !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const entry: RecordedLlmRequest = {
        seq: ++seq,
        receivedAt: Date.now(),
        method,
        path,
        dialect,
        headers: normalizeHeaders(req.headers),
        body,
        rawBytes,
        truncated,
      };
      recordRequest(entry);

      if (truncated) {
        res.writeHead(413, {
          "content-type": "application/json",
          connection: "close",
        });
        res.end(
          JSON.stringify({ error: { message: `request body exceeded ${maxBodyBytes} bytes` } }),
          () => {
            req.socket.destroy();
          },
        );
        return;
      }

      if (dialect === "unknown") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `unsupported mock LLM route: ${method} ${path}` } }));
        return;
      }

      const turn = selectTurn(dialect, body);
      if (turn.waitForGate) {
        await waitForGate(turn.waitForGate);
        if (closed) {
          res.destroy();
          return;
        }
      }

      writeTurnResponse(req, res, dialect, entry.seq, path, body, turn);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock server internal error" } }));
      } else {
        res.destroy();
      }
    } finally {
      inFlight--;
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock LLM server failed to bind to a TCP loopback port");
  }
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  const filteredRequests = (filter?: {
    dialect?: MockLlmDialect;
    predicate?: (req: RecordedLlmRequest) => boolean;
  }): readonly RecordedLlmRequest[] => {
    let out: readonly RecordedLlmRequest[] = recorded;
    if (filter?.dialect) out = out.filter((r) => r.dialect === filter.dialect);
    if (filter?.predicate) out = out.filter(filter.predicate);
    return [...out];
  };

  return {
    url,
    port,
    setScript(nextScript: MockLlmScript) {
      script = nextScript;
      turnCursor = 0;
      consumedMatchers.clear();
    },
    openGate(name: string) {
      openedGates.add(name);
      const waiters = gateWaiters.get(name);
      if (waiters) {
        gateWaiters.delete(name);
        for (const wake of waiters) wake();
      }
    },
    requests: filteredRequests,
    clearRequests() {
      recorded.length = 0;
    },
    waitForRequests(
      count: number,
      waitOptions?: {
        timeoutMs?: number;
        dialect?: MockLlmDialect;
        predicate?: (req: RecordedLlmRequest) => boolean;
      },
    ) {
      const filter = { dialect: waitOptions?.dialect, predicate: waitOptions?.predicate };
      const current = filteredRequests(filter);
      if (current.length >= count) return Promise.resolve(current);
      const timeoutMs = waitOptions?.timeoutMs ?? MOCK_LLM_DEFAULT_WAIT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          requestWaiters.delete(onUpdate);
          const got = filteredRequests(filter).length;
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${count} mock LLM request(s); got ${got}`));
        }, timeoutMs);
        timer.unref?.();
        const onUpdate = () => {
          if (closed) {
            clearTimeout(timer);
            requestWaiters.delete(onUpdate);
            reject(new Error("Mock LLM server closed while waiting for requests"));
            return;
          }
          const latest = filteredRequests(filter);
          if (latest.length >= count) {
            clearTimeout(timer);
            requestWaiters.delete(onUpdate);
            resolve(latest);
          }
        };
        requestWaiters.add(onUpdate);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const waiters of gateWaiters.values()) {
        for (const wake of waiters) wake();
      }
      gateWaiters.clear();
      notifyRequestWaiters();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
