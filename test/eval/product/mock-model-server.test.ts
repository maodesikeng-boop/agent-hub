import { describe, expect, it } from "vitest";
import {
  PRODUCT_EVAL_MAX_RECORDED_REQUESTS,
  PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES,
} from "./limits.ts";
import {
  checkPromptPrefixStability,
  normalizeContextSnapshot,
  startMockModelServer,
} from "./mock-model-server.ts";
import type {
  ContextNormalizeOptions,
  MockFaultSpec,
  MockModelServerHandle,
  MockModelServerOptions,
  MockTurnReply,
  NormalizedMessageItem,
  PrefixStabilityReport,
  PrefixViolation,
  PrefixViolationKind,
  RecordedModelRequest,
} from "./types.ts";

function makeRecordedRequest(overrides: Partial<RecordedModelRequest>): RecordedModelRequest {
  const inputMessages: readonly NormalizedMessageItem[] = overrides.inputMessages ?? [
    { role: "user", content: "turn one" },
  ];
  return {
    turnIndex: 0,
    protocol: "openai_responses",
    path: "/v1/responses",
    model: "test-model",
    systemText: "You are a project manager.",
    toolNames: ["Bash", "Read"],
    promptCacheKey: "cache-session-1",
    inputMessages,
    rawBytes: 256,
    ...overrides,
  };
}

describe("mock model server (Tier 1 harness)", () => {
  it("serves two consecutive OpenAI Responses SSE turns on loopback and records normalized requests", async () => {
    const turns: readonly MockTurnReply[] = [
      { text: "mock reply 1" },
      { text: "mock reply 2" },
    ];
    const options: MockModelServerOptions = { turns };
    const handle: MockModelServerHandle = await startMockModelServer(options);
    try {
      expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.port).toBeGreaterThan(0);

      const first = await fetch(`${handle.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          instructions: "Stay concise.",
          prompt_cache_key: "sess-1",
          tools: [{ type: "function", name: "Bash" }],
          input: [{ role: "user", content: "hello one" }],
        }),
      });
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      expect(firstBody).toContain("mock reply 1");
      expect(firstBody).toContain("response.completed");

      const second = await fetch(`${handle.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          instructions: "Stay concise.",
          prompt_cache_key: "sess-1",
          tools: [{ type: "function", name: "Bash" }],
          input: [
            { role: "user", content: "hello one" },
            { role: "assistant", content: "mock reply 1" },
            { role: "user", content: "hello two" },
          ],
        }),
      });
      expect(second.status).toBe(200);
      const secondBody = await second.text();
      expect(secondBody).toContain("mock reply 2");

      const recorded = handle.requests();
      expect(recorded).toHaveLength(2);
      const report: PrefixStabilityReport = checkPromptPrefixStability(recorded);
      expect(report.stable).toBe(true);
      expect(report.instructionsStable).toBe(true);
      expect(report.toolsStable).toBe(true);
      expect(report.cacheKeyStable).toBe(true);
      expect(report.inputPrefixStable).toBe(true);
      expect(report.firstDivergenceTurn).toBeNull();
      expect(report.violations).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("serves two consecutive Anthropic Messages SSE turns and preserves prefix stability", async () => {
    const handle = await startMockModelServer({
      turns: [{ text: "anthropic reply 1" }, { text: "anthropic reply 2" }],
    });
    try {
      const first = await fetch(`${handle.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-test",
          system: "System rules.",
          tools: [{ name: "Read" }, { name: "Bash" }],
          messages: [{ role: "user", content: "turn 1" }],
        }),
      });
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("anthropic reply 1");

      const second = await fetch(`${handle.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-test",
          system: "System rules.",
          tools: [{ name: "Read" }, { name: "Bash" }],
          messages: [
            { role: "user", content: "turn 1" },
            { role: "assistant", content: "anthropic reply 1" },
            { role: "user", content: "turn 2" },
          ],
        }),
      });
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("anthropic reply 2");

      const report = checkPromptPrefixStability(handle.requests());
      expect(report.stable).toBe(true);
      expect(report.firstDivergenceTurn).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("rejects HTTP bodies above maxBodyBytes with 413 and enforces maxRequests cap", async () => {
    const smallCap = Math.min(2048, PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES);
    const maxReqs = Math.min(2, PRODUCT_EVAL_MAX_RECORDED_REQUESTS);
    const handle = await startMockModelServer({
      turns: [{ text: "ok" }],
      maxBodyBytes: smallCap,
      maxRequests: maxReqs,
    });
    try {
      const oversize = await fetch(`${handle.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(smallCap + 512) }] }),
      });
      expect(oversize.status).toBe(413);

      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${handle.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m", messages: [{ role: "user", content: `msg ${i}` }] }),
        });
        expect(res.status).toBe(200);
      }
      expect(handle.requests().length).toBeLessThanOrEqual(maxReqs);
    } finally {
      await handle.close();
    }
  });

  it("injects configured HTTP error and truncated SSE faults for resilience testing", async () => {
    const httpFault: MockFaultSpec = { kind: "http_error", statusCode: 429, body: '{"error":"rate_limit"}' };
    const truncatedFault: MockFaultSpec = { kind: "truncated_sse", body: "event: message_start\ndata: {\"partial\":" };
    const handle = await startMockModelServer({
      turns: [
        { text: "", fault: httpFault },
        { text: "", fault: truncatedFault },
      ],
    });
    try {
      const first = await fetch(`${handle.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "a" }] }),
      });
      expect(first.status).toBe(429);

      const second = await fetch(`${handle.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "b" }] }),
      });
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("partial");
    } finally {
      await handle.close();
    }
  });
});

describe("prompt-cache prefix stability checker", () => {
  it("flags system prompt edits, tool list changes, cache key resets, and prepended messages", () => {
    const base = makeRecordedRequest({ turnIndex: 0 });
    const mutated = makeRecordedRequest({
      turnIndex: 1,
      systemText: "You are a project manager. Extra mid-session rule.",
      toolNames: ["Bash", "Read", "Edit"],
      promptCacheKey: "cache-session-2",
      inputMessages: [
        { role: "system", content: "prepended notice" },
        { role: "user", content: "turn one" },
        { role: "user", content: "turn two" },
      ],
    });

    const report = checkPromptPrefixStability([base, mutated]);
    expect(report.stable).toBe(false);
    expect(report.instructionsStable).toBe(false);
    expect(report.toolsStable).toBe(false);
    expect(report.cacheKeyStable).toBe(false);
    expect(report.inputPrefixStable).toBe(false);
    expect(report.firstDivergenceTurn).toBe(1);

    const kinds: readonly PrefixViolationKind[] = report.violations.map((v: PrefixViolation) => v.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "system_changed",
        "tools_changed",
        "cache_key_changed",
        "input_prefix_mutated",
      ]),
    );
  });
});

describe("model-visible context snapshot normalization", () => {
  it("redacts macOS, Linux, and Windows user paths, dynamic roots, UUIDs, and ISO timestamps", () => {
    const req = makeRecordedRequest({
      systemText: [
        "Mac: /Users/alice/workspace/repo",
        "Linux: /home/bob/work/repo",
        "Win: C:\\Users\\carol\\project\\src\\index.ts",
        "Root: /private/tmp/eval-run-99/work",
        "Id: 550e8400-e29b-41d4-a716-446655440000",
        "At: 2026-11-28T02:30:00.000Z",
      ].join("\n"),
    });
    const opts: ContextNormalizeOptions = { dynamicRoots: ["/private/tmp/eval-run-99"] };
    const snapshot = normalizeContextSnapshot(req, opts);

    expect(snapshot).not.toContain("/Users/alice");
    expect(snapshot).not.toContain("/home/bob");
    expect(snapshot).not.toContain("C:\\Users\\carol");
    expect(snapshot).not.toContain("/private/tmp/eval-run-99");
    expect(snapshot).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(snapshot).not.toContain("2026-11-28T02:30:00.000Z");
    expect(snapshot).toContain("<USER_HOME>");
    expect(snapshot).toContain("<WORK_ROOT>");
    expect(snapshot).toContain("<UUID>");
    expect(snapshot).toContain("<TIMESTAMP>");
  });
});
