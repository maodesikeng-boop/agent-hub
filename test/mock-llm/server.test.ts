import { afterEach, describe, expect, it } from "vitest";
import {
  MOCK_LLM_DEFAULT_WAIT_TIMEOUT_MS,
  MOCK_LLM_MAX_CONCURRENT_REQUESTS,
  MOCK_LLM_MAX_RECORDED_REQUESTS,
  MOCK_LLM_MAX_REQUEST_BODY_BYTES,
} from "./limits.ts";
import { createMockLlmServer, detectDialect } from "./server.ts";
import type { MockLlmScript, MockLlmServer, MockLlmToolCall, MockLlmTurn, MockLlmUsage } from "./types.ts";

const servers: MockLlmServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

async function bootServer(script?: MockLlmScript, options?: { maxRecordedRequests?: number; maxRequestBodyBytes?: number }) {
  const server = await createMockLlmServer({ script, ...options });
  servers.push(server);
  return server;
}

describe("detectDialect", () => {
  it("routes all four open wire dialects and rejects unknown paths", () => {
    expect(detectDialect("POST", "/v1/messages?beta=true")).toBe("anthropic-messages");
    expect(detectDialect("POST", "/v1/responses")).toBe("openai-responses");
    expect(detectDialect("POST", "/v1/chat/completions")).toBe("openai-chat-completions");
    expect(detectDialect("POST", "/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse")).toBe(
      "gemini-generate-content",
    );
    expect(detectDialect("POST", "/aiserver.v1.DashboardService/GetUserPrivacyMode")).toBe("unknown");
    expect(detectDialect("GET", "/v1/messages")).toBe("unknown");
  });
});

describe("createMockLlmServer", () => {
  it("serves scripted SSE turns and records requests across all four wire dialects", async () => {
    const usage: MockLlmUsage = { inputTokens: 120, outputTokens: 15, cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 0 };
    const turn: MockLlmTurn = { text: "hello-from-mock", textDeltas: ["hello-", "from-mock"], usage };
    const server = await bootServer({ defaultTurn: turn });

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.port).toBeGreaterThan(0);

    const anthropicRes = await fetch(`${server.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "dummy" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(anthropicRes.status).toBe(200);
    expect(anthropicRes.headers.get("content-type")).toContain("text/event-stream");
    expect(await anthropicRes.text()).toContain("hello-");

    const responsesRes = await fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "gpt-6-luna", stream: true, input: [{ role: "user", content: "hi" }] }),
    });
    expect(responsesRes.status).toBe(200);
    expect(await responsesRes.text()).toContain("response.completed");

    const chatRes = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "kimi-k3", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chatRes.status).toBe(200);
    expect(await chatRes.text()).toContain("[DONE]");

    const geminiRes = await fetch(`${server.url}/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    expect(geminiRes.status).toBe(200);
    expect(await geminiRes.text()).toContain("hello-from-mock");

    const recorded = await server.waitForRequests(4, { timeoutMs: MOCK_LLM_DEFAULT_WAIT_TIMEOUT_MS });
    expect(recorded).toHaveLength(4);
    expect(server.requests({ dialect: "anthropic-messages" })).toHaveLength(1);
    server.clearRequests();
    expect(server.requests()).toHaveLength(0);
  });

  it("streams scripted tool calls and matches prompts dynamically", async () => {
    const toolCall: MockLlmToolCall = { id: "call_1", name: "Bash", arguments: { command: "hub status" } };
    const server = await bootServer({
      turns: [{ toolCalls: [toolCall] }, { text: "status verified" }],
    });

    const r1 = await fetch(`${server.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "check status" }] }),
    });
    const body1 = await r1.text();
    expect(body1).toContain("tool_use");
    expect(body1).toContain("hub status");

    server.setScript({
      matchers: [{ whenLastUserContains: "special", turn: { text: "matched-special" } }],
      defaultTurn: { text: "fallback" },
    });
    const r2 = await fetch(`${server.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "run special check" }] }),
    });
    expect(await r2.text()).toContain("matched-special");
  });

  it("holds gated requests until openGate fires by event without polling sleeps", async () => {
    const server = await bootServer({
      turns: [{ waitForGate: "release-turn-1", text: "after-gate" }],
    });

    const pending = fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna", stream: true, input: [{ role: "user", content: "wait" }] }),
    });
    await server.waitForRequests(1, { dialect: "openai-responses" });
    server.openGate("release-turn-1");

    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("after-gate");
  });

  it("returns 404 for unknown paths, serves injected HTTP errors, and handles malformed JSON and mid-stream aborts", async () => {
    const server = await bootServer({
      turns: [
        { httpError: { status: 429, retryAfterSec: 1, body: { error: { message: "rate limited" } } } },
        { textDeltas: ["part-1", "part-2"], streamAbortAfterChunk: 1 },
      ],
    });

    const unknownRes = await fetch(`${server.url}/aiserver.v1.DashboardService/GetUserPrivacyMode`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: "not-json",
    });
    expect(unknownRes.status).toBe(404);

    const errRes = await fetch(`${server.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad-json",
    });
    expect(errRes.status).toBe(429);
    expect(errRes.headers.get("retry-after")).toBe("1");

    await expect(
      fetch(`${server.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "abort" }] }),
      }).then((r) => r.text()),
    ).rejects.toThrow();
  });

  it("enforces bounded recorded request count and streaming body byte cap without Content-Length", async () => {
    expect(MOCK_LLM_MAX_RECORDED_REQUESTS).toBeGreaterThanOrEqual(300);
    expect(MOCK_LLM_MAX_REQUEST_BODY_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(MOCK_LLM_MAX_CONCURRENT_REQUESTS).toBeGreaterThanOrEqual(8);

    const cap = 5;
    const bodyCap = 256;
    const server = await bootServer(
      { defaultTurn: { text: "ok" } },
      { maxRecordedRequests: cap, maxRequestBodyBytes: bodyCap },
    );

    for (let i = 0; i < cap + 3; i++) {
      await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: `m-${i}` }] }),
      });
    }
    expect(server.requests()).toHaveLength(cap);
    expect(server.requests()[0]!.seq).toBe(4);

    const oversizedPayload = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(bodyCap * 4) }] });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversizedPayload));
        controller.close();
      },
    });
    const bigRes = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(bigRes.status).toBe(413);
    expect(server.requests().at(-1)?.truncated).toBe(true);
  });
});
