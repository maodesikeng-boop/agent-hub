// Loopback mock model server, deterministic prompt-cache prefix checker, and normalized context snapshotter.
// Invariant: server binds 127.0.0.1 only, caps request bodies and history, and never forwards traffic to external networks.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  PRODUCT_EVAL_MAX_RECORDED_REQUESTS,
  PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES,
} from "./limits.ts";
import type {
  ContextNormalizeOptions,
  MockModelServerHandle,
  MockModelServerOptions,
  MockTurnReply,
  NormalizedMessageItem,
  PrefixStabilityReport,
  PrefixViolation,
  RecordedModelRequest,
} from "./types.ts";

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body exceeds configured byte cap");
  }
}

function readBoundedBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const rawHeader = req.headers["content-length"];
    if (rawHeader !== undefined) {
      const declared = Number(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        req.resume();
        reject(new PayloadTooLargeError());
        return;
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buf.length;
      if (total > maxBodyBytes) {
        chunks.length = 0;
        req.resume();
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.on("error", (err) => fail(err));
  });
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

function normalizeMessageList(raw: unknown): NormalizedMessageItem[] {
  if (typeof raw === "string") {
    return [{ role: "user", content: raw }];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") {
      return { role: "user", content: item };
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const role =
        typeof obj.role === "string"
          ? obj.role
          : typeof obj.type === "string"
            ? obj.type
            : "unknown";
      const content = obj.content !== undefined ? extractTextFromContent(obj.content) : JSON.stringify(obj);
      return { role, content };
    }
    return { role: "unknown", content: JSON.stringify(item) };
  });
}

function extractToolNames(rawTools: unknown): string[] {
  if (!Array.isArray(rawTools)) return [];
  const names: string[] = [];
  for (const tool of rawTools) {
    if (!tool || typeof tool !== "object") continue;
    const obj = tool as Record<string, unknown>;
    if (typeof obj.name === "string" && obj.name !== "") {
      names.push(obj.name);
      continue;
    }
    const fn = obj.function;
    if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") {
      names.push((fn as Record<string, unknown>).name as string);
      continue;
    }
    if (typeof obj.type === "string" && obj.type !== "") {
      names.push(obj.type);
    }
  }
  return names;
}

function parseRecordedRequest(
  protocol: "anthropic_messages" | "openai_responses",
  path: string,
  turnIndex: number,
  body: Record<string, unknown>,
  rawBytes: number,
): RecordedModelRequest {
  const model = typeof body.model === "string" ? body.model : "";
  const toolNames = extractToolNames(body.tools);
  const promptCacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null;

  if (protocol === "openai_responses") {
    const systemText = typeof body.instructions === "string" ? body.instructions : "";
    const inputMessages = normalizeMessageList(body.input);
    return {
      turnIndex,
      protocol,
      path,
      model,
      systemText,
      toolNames,
      promptCacheKey,
      inputMessages,
      rawBytes,
    };
  }

  const systemText = extractTextFromContent(body.system);
  const inputMessages = normalizeMessageList(body.messages);
  return {
    turnIndex,
    protocol,
    path,
    model,
    systemText,
    toolNames,
    promptCacheKey,
    inputMessages,
    rawBytes,
  };
}

function formatSse(events: readonly { readonly event: string; readonly data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

function renderOpenAiResponsesSse(turnIndex: number, reply: MockTurnReply): string {
  const responseId = `resp-mock-${turnIndex + 1}`;
  const msgId = `msg-mock-${turnIndex + 1}`;
  const outputItems: unknown[] = [];
  const events: Array<{ event: string; data: unknown }> = [
    { event: "response.created", data: { type: "response.created", response: { id: responseId, status: "in_progress" } } },
  ];

  if (reply.toolCalls && reply.toolCalls.length > 0) {
    for (const tc of reply.toolCalls) {
      const item = {
        type: "function_call",
        id: `fc-${tc.id}`,
        call_id: tc.id,
        name: tc.name,
        arguments: tc.argumentsJson,
      };
      outputItems.push(item);
      events.push({ event: "response.output_item.done", data: { type: "response.output_item.done", item } });
    }
  }

  const msg = {
    type: "message",
    role: "assistant",
    id: msgId,
    status: "completed",
    content: [{ type: "output_text", text: reply.text }],
  };
  outputItems.push(msg);
  events.push({
    event: "response.output_text.delta",
    data: { type: "response.output_text.delta", item_id: msgId, output_index: outputItems.length - 1, content_index: 0, delta: reply.text },
  });
  events.push({ event: "response.output_item.done", data: { type: "response.output_item.done", item: msg } });
  events.push({
    event: "response.completed",
    data: {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: outputItems,
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: turnIndex > 0 ? 80 : 0 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 110,
        },
      },
    },
  });
  return formatSse(events);
}

function renderAnthropicMessagesSse(turnIndex: number, model: string, reply: MockTurnReply): string {
  const msgId = `msg_mock_${turnIndex + 1}`;
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: model || "claude-mock",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: turnIndex > 0 ? 80 : 0,
            cache_creation_input_tokens: turnIndex === 0 ? 80 : 0,
          },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
  ];

  let nextBlock = 1;
  const hasToolCalls = Boolean(reply.toolCalls && reply.toolCalls.length > 0);
  if (reply.toolCalls) {
    for (const tc of reply.toolCalls) {
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: nextBlock,
          content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
        },
      });
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: nextBlock,
          delta: { type: "input_json_delta", partial_json: tc.argumentsJson },
        },
      });
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: nextBlock },
      });
      nextBlock += 1;
    }
  }

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: hasToolCalls ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return formatSse(events);
}

function writeFaultReply(res: ServerResponse, reply: MockTurnReply): void {
  const fault = reply.fault!;
  if (fault.kind === "http_error") {
    const body = fault.body ?? JSON.stringify({ error: "mock_http_error" });
    res.writeHead(fault.statusCode ?? 500, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    });
    res.end(body);
    return;
  }
  if (fault.kind === "truncated_sse") {
    const body = fault.body ?? 'event: message_start\ndata: {"partial":';
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    });
    res.end(body);
    return;
  }
  const body = fault.body ?? '{"malformed":';
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body, "utf8")),
  });
  res.end(body);
}

export async function startMockModelServer(options: MockModelServerOptions): Promise<MockModelServerHandle> {
  const maxBodyBytes = options.maxBodyBytes ?? PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES;
  const maxRequests = options.maxRequests ?? PRODUCT_EVAL_MAX_RECORDED_REQUESTS;
  const recorded: RecordedModelRequest[] = [];
  let turnCounter = 0;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    let rawBuf: Buffer;
    try {
      rawBuf = await readBoundedBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload_too_large" }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "read_error" }));
      return;
    }

    if (pathname.endsWith("/messages/count_tokens")) {
      const payload = JSON.stringify({ input_tokens: 100 });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      res.end(payload);
      return;
    }

    const protocol: "openai_responses" | "anthropic_messages" | null = pathname.endsWith("/responses")
      ? "openai_responses"
      : pathname.endsWith("/messages")
        ? "anthropic_messages"
        : null;

    if (protocol === null) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_path", path: pathname }));
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBuf.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Body must be a JSON object");
      }
      parsedBody = parsed as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }

    const currentTurn = turnCounter;
    turnCounter += 1;

    const entry = parseRecordedRequest(protocol, pathname, currentTurn, parsedBody, rawBuf.length);
    if (recorded.length < maxRequests) {
      recorded.push(entry);
    }

    const reply: MockTurnReply =
      options.turns.length > 0
        ? options.turns[Math.min(currentTurn, options.turns.length - 1)]!
        : { text: "" };

    if (reply.fault) {
      writeFaultReply(res, reply);
      return;
    }

    if (protocol === "anthropic_messages" && parsedBody.stream === false) {
      const jsonBody = JSON.stringify({
        id: `msg_mock_${currentTurn + 1}`,
        type: "message",
        role: "assistant",
        model: entry.model || "claude-mock",
        content: [{ type: "text", text: reply.text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: currentTurn > 0 ? 80 : 0,
          cache_creation_input_tokens: currentTurn === 0 ? 80 : 0,
        },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(jsonBody, "utf8")),
      });
      res.end(jsonBody);
      return;
    }

    const sseBody =
      protocol === "openai_responses"
        ? renderOpenAiResponsesSse(currentTurn, reply)
        : renderAnthropicMessagesSse(currentTurn, entry.model, reply);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "content-length": String(Buffer.byteLength(sseBody, "utf8")),
    });
    res.end(sseBody);
  };

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let closed = false;

  return {
    baseUrl,
    port,
    requests: () => [...recorded],
    close: async () => {
      if (closed) return;
      closed = true;
      recorded.length = 0;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function checkPromptPrefixStability(requests: readonly RecordedModelRequest[]): PrefixStabilityReport {
  if (requests.length <= 1) {
    return {
      stable: true,
      instructionsStable: true,
      toolsStable: true,
      cacheKeyStable: true,
      inputPrefixStable: true,
      firstDivergenceTurn: null,
      violations: [],
    };
  }

  let instructionsStable = true;
  let toolsStable = true;
  let cacheKeyStable = true;
  let inputPrefixStable = true;
  const violations: PrefixViolation[] = [];

  for (let i = 1; i < requests.length; i += 1) {
    const prev = requests[i - 1]!;
    const curr = requests[i]!;
    const turnIndex = curr.turnIndex;

    if (curr.systemText !== prev.systemText) {
      instructionsStable = false;
      violations.push({
        turnIndex,
        kind: "system_changed",
        detail: `System instructions diverged between turn ${prev.turnIndex} and turn ${turnIndex}`,
      });
    }

    if (!sameStringList(prev.toolNames, curr.toolNames)) {
      toolsStable = false;
      violations.push({
        turnIndex,
        kind: "tools_changed",
        detail: `Tool list changed from [${prev.toolNames.join(", ")}] to [${curr.toolNames.join(", ")}]`,
      });
    }

    if ((prev.promptCacheKey !== null || curr.promptCacheKey !== null) && prev.promptCacheKey !== curr.promptCacheKey) {
      cacheKeyStable = false;
      violations.push({
        turnIndex,
        kind: "cache_key_changed",
        detail: `prompt_cache_key changed from ${String(prev.promptCacheKey)} to ${String(curr.promptCacheKey)}`,
      });
    }

    let prefixOk = curr.inputMessages.length >= prev.inputMessages.length;
    let mismatchAt = -1;
    if (prefixOk) {
      for (let j = 0; j < prev.inputMessages.length; j += 1) {
        const a = prev.inputMessages[j]!;
        const b = curr.inputMessages[j]!;
        if (a.role !== b.role || a.content !== b.content) {
          prefixOk = false;
          mismatchAt = j;
          break;
        }
      }
    }
    if (!prefixOk) {
      inputPrefixStable = false;
      violations.push({
        turnIndex,
        kind: "input_prefix_mutated",
        detail:
          mismatchAt >= 0
            ? `Input message prefix diverged at index ${mismatchAt} on turn ${turnIndex}`
            : `Input message array shrank from ${prev.inputMessages.length} to ${curr.inputMessages.length} on turn ${turnIndex}`,
      });
    }
  }

  const firstDivergenceTurn =
    violations.length === 0 ? null : violations.reduce((min, v) => Math.min(min, v.turnIndex), violations[0]!.turnIndex);

  return {
    stable: violations.length === 0,
    instructionsStable,
    toolsStable,
    cacheKeyStable,
    inputPrefixStable,
    firstDivergenceTurn,
    violations,
  };
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactText(text: string, dynamicRoots: readonly string[]): string {
  let out = text;

  const sortedRoots = [...dynamicRoots].filter((r) => r.length > 0).sort((a, b) => b.length - a.length);
  for (const root of sortedRoots) {
    const clean = root.replace(/[\\/]+$/, "");
    if (clean === "") continue;
    out = out.replace(new RegExp(escapeRegExp(clean), "g"), "<WORK_ROOT>");
    const posix = clean.replace(/\\/g, "/");
    if (posix !== clean) {
      out = out.replace(new RegExp(escapeRegExp(posix), "g"), "<WORK_ROOT>");
    }
  }

  out = out.replace(/\/Users\/[A-Za-z0-9._-]+/g, "<USER_HOME>");
  out = out.replace(/\/home\/[A-Za-z0-9._-]+/g, "<USER_HOME>");
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"'<>|]+/g, "<USER_HOME>");
  out = out.replace(/[A-Za-z]:\/Users\/[^/\s"'<>|]+/g, "<USER_HOME>");
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>");
  out = out.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g, "<TIMESTAMP>");
  return out;
}

export function normalizeContextSnapshot(
  request: RecordedModelRequest,
  options?: ContextNormalizeOptions,
): string {
  const roots = options?.dynamicRoots ?? [];
  const redact = (value: string) => redactText(value, roots);
  const lines: string[] = [
    `protocol: ${request.protocol}`,
    `path: ${request.path}`,
    `model: ${request.model}`,
    `prompt_cache_key: ${request.promptCacheKey === null ? "null" : redact(request.promptCacheKey)}`,
    `tools: ${request.toolNames.join(", ")}`,
    "",
    "=== SYSTEM ===",
    redact(request.systemText),
    "",
    "=== MESSAGES ===",
  ];

  for (const [index, msg] of request.inputMessages.entries()) {
    lines.push(`[${index}] ${msg.role}: ${redact(msg.content)}`);
  }

  return lines.join("\n");
}
