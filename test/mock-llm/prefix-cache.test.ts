import { describe, expect, it } from "vitest";
import { checkPrefixStability, expectPrefixStable } from "./prefix-cache.ts";
import type { MockLlmDialect, RecordedLlmRequest } from "./types.ts";

function makeReq(seq: number, dialect: MockLlmDialect, body: unknown): RecordedLlmRequest {
  const pathByDialect: Record<MockLlmDialect, string> = {
    "anthropic-messages": "/v1/messages",
    "openai-responses": "/v1/responses",
    "openai-chat-completions": "/v1/chat/completions",
    "gemini-generate-content": "/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
  };
  return {
    seq,
    receivedAt: seq * 1000,
    method: "POST",
    path: pathByDialect[dialect],
    dialect,
    headers: { "content-type": "application/json" },
    body,
    rawBytes: JSON.stringify(body ?? "").length,
    truncated: false,
  };
}

describe("prompt-cache prefix stability across all 4 wire dialects", () => {
  it("accepts valid Anthropic Messages extensions even when sliding cache_control collapses a single text block to a string", () => {
    const req1 = makeReq(1, "anthropic-messages", {
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "turn 1", cache_control: { type: "ephemeral" } }] },
      ],
    });
    const req2 = makeReq(2, "anthropic-messages", {
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
        { role: "user", content: [{ type: "text", text: "turn 2", cache_control: { type: "ephemeral" } }] },
      ],
    });

    const result = checkPrefixStability([req1, req2]);
    expect(result.stable).toBe(true);
    expect(result.dialect).toBe("anthropic-messages");
    expect(result.checkedPairs).toBe(1);
    expect(result.diffs).toEqual([]);
    expect(() => expectPrefixStable([req1, req2])).not.toThrow();
  });

  it("rejects Anthropic Messages when system prompt, tools, or an earlier message mutates", () => {
    const base = makeReq(1, "anthropic-messages", {
      system: "system A",
      tools: [{ name: "Read" }],
      messages: [{ role: "user", content: "turn 1" }],
    });
    const mutatedSystem = makeReq(2, "anthropic-messages", {
      system: "system B",
      tools: [{ name: "Read" }],
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "turn 2" },
      ],
    });
    const prependedMessage = makeReq(2, "anthropic-messages", {
      system: "system A",
      tools: [{ name: "Read" }],
      messages: [
        { role: "user", content: "injected-before-turn-1" },
        { role: "user", content: "turn 1" },
      ],
    });

    const sysResult = checkPrefixStability([base, mutatedSystem]);
    expect(sysResult.stable).toBe(false);
    expect(sysResult.diffs.some((d) => d.field === "system")).toBe(true);
    expect(() => expectPrefixStable([base, mutatedSystem])).toThrow(/system/i);

    const msgResult = checkPrefixStability([base, prependedMessage]);
    expect(msgResult.stable).toBe(false);
    expect(msgResult.diffs.some((d) => d.field === "messages" && d.firstMessageDiffIndex === 0)).toBe(true);
  });

  it("verifies OpenAI Responses prefix, ignores transient item ids, and catches prompt_cache_key rotation", () => {
    const r1 = makeReq(1, "openai-responses", {
      instructions: "Be concise.",
      tools: [{ type: "function", name: "shell" }],
      prompt_cache_key: "thread-abc",
      input: [{ id: "item-1", type: "message", role: "user", content: [{ type: "input_text", text: "turn 1" }] }],
    });
    const r2Stable = makeReq(2, "openai-responses", {
      instructions: "Be concise.",
      tools: [{ type: "function", name: "shell" }],
      prompt_cache_key: "thread-abc",
      input: [
        { id: "item-1-reissued", type: "message", role: "user", content: [{ type: "input_text", text: "turn 1" }] },
        { id: "msg-1", type: "message", role: "assistant", content: [{ type: "output_text", text: "reply 1" }] },
        { id: "item-2", type: "message", role: "user", content: [{ type: "input_text", text: "turn 2" }] },
      ],
    });
    const r2RotatedKey = makeReq(2, "openai-responses", {
      ...((r2Stable.body as Record<string, unknown>)),
      prompt_cache_key: "thread-new-fresh-session",
    });

    expect(checkPrefixStability([r1, r2Stable], { requireCacheKeyStable: true }).stable).toBe(true);
    const rotated = checkPrefixStability([r1, r2RotatedKey], { requireCacheKeyStable: true });
    expect(rotated.stable).toBe(false);
    expect(rotated.diffs.some((d) => d.field === "cache_key")).toBe(true);
    expect(() => expectPrefixStable([r1, r2RotatedKey], { requireCacheKeyStable: true })).toThrow(/cache_key/i);
  });

  it("verifies OpenAI Chat Completions and Gemini GenerateContent prefixes and catches mutations", () => {
    const chat1 = makeReq(1, "openai-chat-completions", {
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    const chat2 = makeReq(2, "openai-chat-completions", {
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "next" },
      ],
    });
    expect(checkPrefixStability([chat1, chat2]).stable).toBe(true);

    const gem1 = makeReq(1, "gemini-generate-content", {
      systemInstruction: { parts: [{ text: "sys" }] },
      tools: [{ functionDeclarations: [{ name: "run_command" }] }],
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const gem2 = makeReq(2, "gemini-generate-content", {
      systemInstruction: { parts: [{ text: "sys" }] },
      tools: [{ functionDeclarations: [{ name: "run_command" }] }],
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "world" }] },
        { role: "user", parts: [{ text: "follow-up" }] },
      ],
    });
    const gem2BadTools = makeReq(2, "gemini-generate-content", {
      systemInstruction: { parts: [{ text: "sys" }] },
      tools: [{ functionDeclarations: [{ name: "run_command" }, { name: "extra_tool" }] }],
      contents: (gem2.body as { contents: unknown[] }).contents,
    });
    expect(checkPrefixStability([gem1, gem2]).stable).toBe(true);
    expect(checkPrefixStability([gem1, gem2BadTools]).diffs.some((d) => d.field === "tools")).toBe(true);
  });

  it("handles malformed or dirty request payloads gracefully without throwing unhandled TypeErrors", () => {
    const dirty1 = makeReq(1, "anthropic-messages", "not-an-object");
    const dirty2 = makeReq(2, "anthropic-messages", { messages: null });
    const res = checkPrefixStability([dirty1, dirty2]);
    expect(res.stable).toBe(false);
    expect(res.diffs.length).toBeGreaterThan(0);
  });
});
