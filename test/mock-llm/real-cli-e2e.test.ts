import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/daemon/store/index.ts";
import {
  API_PATHS,
  REPORT_END,
  REPORT_START,
  workerEventOf,
  type AgentVendor,
} from "../../src/shared/index.ts";
import { agentTexts, messageById, messagesOf, waitUntil } from "../e2e/harness.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";
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

      const reqs = handle.pmRequests();
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

      expectPrefixStable(handle.pmRequests(), { requireCacheKeyStable: candidate === "codex" });
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
      expectPrefixStable(handle.pmRequests());
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
  );

  it(
    "surfaces an injected mock HTTP error cleanly into the Bellwood ledger without leaking child processes",
    async () => {
      const candidate: AgentVendor = probeRealCli("claude").installed ? "claude" : "codex";
      if (!ensureAvailableOrSkip(candidate)) return;

      const handle = await startRealCliDaemon({
        vendor: candidate,
        script: {
          defaultTurn: {
            httpError: {
              status: 400,
              body: { error: { type: "invalid_request_error", message: "mock server boom" } },
            },
          },
        },
      });
      handles.push(handle);

      const beforeTexts = agentTexts(await handle.client.state(), handle.conversationId);
      const messageId = await handle.client.post(handle.conversationId, "trigger mock error");
      const pmReqs = await handle.waitForPmRequests(1, { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(pmReqs.length).toBeGreaterThanOrEqual(1);
      expect(messageId).toBeGreaterThan(0);

      const settled = await waitUntil(
        `real CLI (${candidate}) error message ${messageId} to reach terminal state`,
        async () => {
          const state = await handle.client.state();
          const message = messageById(state, messageId);
          if (!message) return undefined;
          if (message.status === "failed" || message.status === "stopped" || message.status === "cancelled") {
            return { state, message, replies: agentTexts(state, handle.conversationId).slice(beforeTexts.length) };
          }
          if (message.status === "replied") {
            const replies = agentTexts(state, handle.conversationId).slice(beforeTexts.length);
            if (replies.length > 0) return { state, message, replies };
          }
          return undefined;
        },
        MOCK_LLM_CLI_TURN_TIMEOUT_MS,
      );

      if (settled.message.status === "failed") {
        expect(settled.message.failureReason ?? "").toMatch(/mock server boom|400/i);
      } else {
        expect(settled.message.status).toBe("replied");
        expect(settled.replies.join("\n")).toMatch(/mock server boom|400/i);
      }

      const db = openDatabase(join(handle.isolated.dataDir, "state", "hub.sqlite"));
      try {
        const turnRow = db.get<{ status: string; outcome: string | null; failure_reason: string | null }>(
          "SELECT t.status, t.outcome, t.failure_reason FROM turns t JOIN turn_inputs ti ON ti.turn_id = t.id WHERE ti.message_id = ? ORDER BY t.id DESC LIMIT 1",
          messageId,
        );
        expect(turnRow).toMatchObject({ status: "ended", outcome: "failed" });
      } finally {
        db.close();
      }
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
      expect(handle.pmRequests().length).toBeGreaterThanOrEqual(2);
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
  );

  it.skipIf(!sandboxAllowsNestedSandbox())(
    "runs a real CLI Worker inside Bellwood's OS sandbox and reports back to the PM",
    async () => {
      const candidate: AgentVendor = probeRealCli("claude").installed ? "claude" : "codex";
      if (!ensureAvailableOrSkip(candidate)) return;

      const toolName = candidate === "claude" ? "Bash" : "exec_command";
      const startWorkerCmd = "echo verify-worker-sandbox | hub worker start --title sandbox-probe --no-worktree --stdin";
      const startWorkerArgs = candidate === "claude" ? { command: startWorkerCmd } : { cmd: startWorkerCmd };
      const workerHubArgs = candidate === "claude" ? { command: "hub status" } : { cmd: "hub status" };
      const workerReport = [
        "sandbox-worker-completed",
        "",
        REPORT_START,
        "状态: 做完了",
        "摘要: sandbox-worker-ok",
        "PR: 无",
        "提交: 无",
        "测试: 无",
        "偏离: 无",
        "交棒: 无",
        "文件: 无",
        "问题: 无",
        REPORT_END,
      ].join("\n");

      const handle = await startRealCliDaemon({
        vendor: candidate,
        script: {
          turns: [
            { toolCalls: [{ id: "tool_dispatch_worker", name: toolName, arguments: startWorkerArgs }] },
            { text: "pm-dispatched-worker" },
          ],
          matchers: [
            {
              whenLastUserContains: "verify-worker-sandbox",
              once: true,
              turn: { toolCalls: [{ id: "tool_worker_status", name: toolName, arguments: workerHubArgs }] },
            },
            { whenLastUserContains: "你是 Worker #", turn: { text: workerReport } },
            { whenLastUserContains: "verify-worker-sandbox", turn: { text: workerReport } },
          ],
          defaultTurn: { text: "pm-received-worker-report" },
        },
      });
      handles.push(handle);

      const dispatched = await handle.sendAndWait("dispatch sandbox worker", { timeoutMs: MOCK_LLM_CLI_TURN_TIMEOUT_MS });
      expect(dispatched.replies.join("\n")).toContain("pm-dispatched-worker");

      const reported = await waitUntil(
        `real CLI (${candidate}) sandboxed Worker report`,
        async () => {
          const state = await handle.client.state();
          const events = messagesOf(state, handle.conversationId)
            .map((m) => workerEventOf(m))
            .filter((meta) => meta !== null);
          const reportEvent = events.find((e) => e.event === "report" && e.summary === "sandbox-worker-ok");
          if (!reportEvent) return undefined;
          const workerConversation = state.conversations.find((c) => c.conversation.kind === "worker");
          if (!workerConversation) return undefined;
          const workerSession = state.sessions.find((s) => s.conversationId === workerConversation.conversation.id);
          if (!workerSession) return undefined;
          return { state, reportEvent, workerConversation, workerSession };
        },
        MOCK_LLM_CLI_TURN_TIMEOUT_MS * 2,
      );

      expect(reported.reportEvent.status).toBe("done");
      expect(reported.workerConversation.conversation.kind).toBe("worker");
      expect(reported.workerSession.conversationId).toBe(reported.workerConversation.conversation.id);
      const workerMessages = messagesOf(reported.state, reported.workerConversation.conversation.id);
      expect(workerMessages.some((m) => m.sender === "agent" && m.kind === "tool")).toBe(true);
      expect(JSON.stringify(handle.pmRequests())).toContain("你是 Worker #");
    },
    MOCK_LLM_CLI_TURN_TIMEOUT_MS * 3,
  );

  it("refuses cursor explicitly as unsupported_protocol instead of skipping silently", async () => {
    const probe = probeRealCli("cursor");
    expect(probe.support).toBe("unsupported_protocol");
    expect(probe.reason).toMatch(/aiserver\.v1|protobuf/i);
    await expect(startRealCliDaemon({ vendor: "cursor" })).rejects.toThrow(/unsupported|proprietary/i);
  });
});
