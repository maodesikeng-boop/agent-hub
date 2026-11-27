import { afterEach, describe, expect, it } from "vitest";
import { API_PATHS, type AgentVendor } from "../../src/shared/index.ts";
import { startRealCliDaemon } from "./harness.ts";
import { MOCK_LLM_CLI_TURN_TIMEOUT_MS } from "./limits.ts";
import { expectPrefixStable } from "./prefix-cache.ts";
import { normalizeModelContext } from "./protocol-snapshot.ts";
import type { RealCliSessionHandle } from "./types.ts";
import { probeRealCli, resolveRequiredRealCliVendors } from "./vendors.ts";

const handles: RealCliSessionHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
});

const SUPPORTED_VENDORS: readonly AgentVendor[] = ["claude", "codex", "agy", "pi", "deepseek", "opencode", "kimi"];

function ensureAvailableOrSkip(vendor: AgentVendor): boolean {
  const required = new Set(resolveRequiredRealCliVendors());
  const probe = probeRealCli(vendor);
  if (probe.installed && probe.support === "full") return true;
  if (required.has(vendor)) {
    throw new Error(`Required real CLI vendor "${vendor}" is unavailable: ${probe.reason}`);
  }
  return false;
}

describe("real vendor CLI + local mock LLM through real Bellwood daemon", () => {
  it.each(SUPPORTED_VENDORS)(
    "completes two consecutive turns with stable prompt-cache prefix and normalized context snapshot (%s)",
    async (vendor) => {
      if (!ensureAvailableOrSkip(vendor)) return;

      const handle = await startRealCliDaemon({
        vendor,
        script: {
          turns: [{ text: `mock-turn-1-${vendor}` }, { text: `mock-turn-2-${vendor}` }],
        },
      });
      handles.push(handle);

      const t1 = await handle.sendAndWait("say turn 1", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      const t2 = await handle.sendAndWait("say turn 2", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(t1.replies.join("\n")).toContain(`mock-turn-1-${vendor}`);
      expect(t2.replies.join("\n")).toContain(`mock-turn-2-${vendor}`);

      const reqs = handle.mock.requests();
      expect(reqs.length).toBeGreaterThanOrEqual(2);
      expectPrefixStable(reqs);

      const ctx1 = normalizeModelContext(reqs[0]!, { replacements: { [handle.isolated.rootDir]: "<ROOT>" } });
      expect(ctx1.messages.length).toBeGreaterThan(0);
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
  );

  it(
    "resumes a real CLI session across a Bellwood daemon restart without losing prefix stability",
    async () => {
      const candidate: AgentVendor = probeRealCli("codex").installed ? "codex" : "claude";
      if (!ensureAvailableOrSkip(candidate)) return;

      const handle = await startRealCliDaemon({
        vendor: candidate,
        script: {
          turns: [{ text: "before-restart" }, { text: "after-restart" }],
        },
      });
      handles.push(handle);

      const r1 = await handle.sendAndWait("first message", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(r1.replies.join("\n")).toContain("before-restart");

      await handle.restartDaemon();

      const r2 = await handle.sendAndWait("second message", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(r2.replies.join("\n")).toContain("after-restart");

      expectPrefixStable(handle.mock.requests(), { requireCacheKeyStable: candidate === "codex" });
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
  );

  it(
    "preserves prompt-cache prefix when PM persona changes between turns (append-only update)",
    async () => {
      const candidate: AgentVendor = probeRealCli("claude").installed ? "claude" : "codex";
      if (!ensureAvailableOrSkip(candidate)) return;

      const handle = await startRealCliDaemon({
        vendor: candidate,
        persona: "Initial persona.",
        script: {
          turns: [{ text: "reply-before-persona" }, { text: "reply-after-persona" }],
        },
      });
      handles.push(handle);

      await handle.sendAndWait("turn 1", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });

      const putRes = await handle.client.putJson(API_PATHS.persona(handle.pmId), {
        text: "Updated persona with extra guidance.",
      });
      expect(putRes.status).toBe(200);

      const r2 = await handle.sendAndWait("turn 2", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(r2.replies.join("\n")).toContain("reply-after-persona");
      expectPrefixStable(handle.mock.requests());
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
  );

  it(
    "surfaces an injected mock HTTP 500 error cleanly without leaking child processes",
    async () => {
      const candidate: AgentVendor = probeRealCli("claude").installed ? "claude" : "codex";
      if (!ensureAvailableOrSkip(candidate)) return;

      const handle = await startRealCliDaemon({
        vendor: candidate,
        script: {
          defaultTurn: { httpError: { status: 500, body: { error: { type: "api_error", message: "mock server boom" } } } },
        },
      });
      handles.push(handle);

      const messageId = await handle.client.post(handle.conversationId, "trigger mock 500");
      await handle.mock.waitForRequests(1, { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(messageId).toBeGreaterThan(0);
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
  );

  it(
    "executes hub status from a real CLI tool call scripted by the mock LLM server",
    async () => {
      const candidate: AgentVendor = probeRealCli("claude").installed ? "claude" : "codex";
      if (!ensureAvailableOrSkip(candidate)) return;

      const toolName = candidate === "claude" ? "Bash" : "exec_command";
      const toolArgs = candidate === "claude" ? { command: "hub status" } : { cmd: "hub status" };
      const handle = await startRealCliDaemon({
        vendor: candidate,
        script: {
          turns: [
            { toolCalls: [{ id: "tool_hub_1", name: toolName, arguments: toolArgs }] },
            { text: "hub-status-checked" },
          ],
        },
      });
      handles.push(handle);

      const res = await handle.sendAndWait("check hub status", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(res.replies.join("\n")).toContain("hub-status-checked");
      expect(handle.mock.requests().length).toBeGreaterThanOrEqual(2);
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
  );

  it("refuses cursor explicitly as unsupported_protocol instead of skipping silently", async () => {
    const probe = probeRealCli("cursor");
    expect(probe.support).toBe("unsupported_protocol");
    expect(probe.reason).toMatch(/aiserver\.v1|protobuf/i);
    await expect(startRealCliDaemon({ vendor: "cursor" })).rejects.toThrow(/unsupported|proprietary/i);
  });
});
