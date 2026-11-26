import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { EMPTY_TOKEN_USAGE, workerWriteScope, type AgentSessionRow, type LaunchFiles } from "../../shared/index.ts";
import { createCodexDriver } from "./driver.ts";
import { describe, expect, it, vi } from "vitest";
import type { AppApprovalAnswer, AppApprovalGate, AppApprovalRequest } from "../../shared/index.ts";
import { answerCodexAppApproval, buildCodexAppApprovalResponse, createCodexAppApprovalState, onCodexServerRequestResolved, parseCodexAppApprovalRequest } from "./app-approval.ts";
import fixture from "./fixtures/app-elicitation-0.169.0.json" with { type: "json" };

const { params } = fixture.request;
const context = { sessionId: 3, requestId: fixture.request.id, processKey: "process-1", computerUseServers: ["cua_repl"] };
const appRequest: AppApprovalRequest = {
  sessionId: 3, requestKey: "9", processKey: context.processKey, vendor: "codex", capability: "mcp:cua_repl",
  appId: "com.apple.calculator", appName: "Calculator", riskLevel: "low", warning: null,
};

describe("parseCodexAppApprovalRequest", () => {
  it("maps a protocol fixture for a Computer Use app elicitation to app id, display name, risk level, and capability mcp:cua_repl", () => {
    expect(parseCodexAppApprovalRequest(params, context)).toEqual(appRequest);
  });
  it("returns null when the server is not a mounted Computer Use server", () => {
    expect(parseCodexAppApprovalRequest({ ...params, serverName: "other" }, context)).toBeNull();
  });
  it("returns null when computerUseServers is empty because the process keeps Bellwood's outer sandbox", () => {
    expect(parseCodexAppApprovalRequest(params, { ...context, computerUseServers: [] })).toBeNull();
  });
  it("returns null for audio recording, node_repl execution, url mode, and other connectors", () => {
    for (const overrides of [
      { _meta: { ...params._meta, tool_name: "start_audio_recording", tool_params: {} } },
      { _meta: { ...params._meta, codex_approval_kind: "node_repl_execution" } },
      { mode: "url" },
      { _meta: { ...params._meta, connector_id: "other" } },
    ]) expect(parseCodexAppApprovalRequest({ ...params, ...overrides }, context)).toBeNull();
  });
  it("returns null when tool_params.app is missing or invalid", () => {
    for (const tool_params of [{}, { app: "Calculator" }, { app: 42 }]) {
      expect(parseCodexAppApprovalRequest({ ...params, _meta: { ...params._meta, tool_params } }, context)).toBeNull();
    }
  });
});

describe("buildCodexAppApprovalResponse", () => {
  it("answers the original JSON-RPC id with action and null content and _meta", () => {
    expect(JSON.parse(buildCodexAppApprovalResponse("native-9", "accept"))).toEqual({
      jsonrpc: "2.0", id: "native-9", result: { action: "accept", content: null, _meta: null },
    });
  });
  it("never includes a persist value", () => {
    for (const answer of ["accept", "cancel", "decline"] as const) expect(buildCodexAppApprovalResponse(9, answer)).not.toContain("persist");
  });
});

function pendingAnswer() {
  const state = createCodexAppApprovalState();
  const write = vi.fn();
  let resolve: (answer: AppApprovalAnswer) => void = () => {};
  const answer = new Promise<AppApprovalAnswer>((done) => { resolve = done; });
  const request = vi.fn<AppApprovalGate["request"]>().mockReturnValue(answer);
  const run = answerCodexAppApproval({ state, write, request: { ...appRequest, processKey: state.processKey },
    requestId: 9, gate: { request, processEnded: vi.fn() } });
  return { state, write, request, run, resolve };
}

describe("answerCodexAppApproval", () => {
  it("writes accept after the gate allows the app", async () => {
    const pending = pendingAnswer();
    expect(pending.write).not.toHaveBeenCalled();
    pending.resolve("accept");
    await pending.run;
    expect(pending.write).toHaveBeenCalledExactlyOnceWith(buildCodexAppApprovalResponse(9, "accept"));
    expect(pending.state.waits.size).toBe(0);
  });
  it("writes nothing when serverRequest/resolved aborts the wait first", async () => {
    const pending = pendingAnswer();
    onCodexServerRequestResolved(pending.state, fixture.resolved.params);
    expect(pending.request.mock.calls[0]?.[1].aborted).toBe(true);
    pending.resolve("accept");
    await pending.run;
    expect(pending.write).not.toHaveBeenCalled();
  });
  it("writes nothing after the process exits", async () => {
    const pending = pendingAnswer();
    for (const signal of pending.state.waits.values()) signal.abort();
    pending.resolve("accept");
    await pending.run;
    expect(pending.write).not.toHaveBeenCalled();
  });
});

async function runDriver(outerSandbox: LaunchFiles["outerSandbox"], mounted: boolean, request = fixture.request) {
  const cwd = mkdtempSync(join(tmpdir(), "codex-app-approval-"));
  const log = join(cwd, "response.json");
  const executablePath = writeExecutableNodeScript(join(cwd, "fake-codex"), `
    const { createInterface } = require("node:readline");
    const { writeFileSync } = require("node:fs");
    const request = ${JSON.stringify(request)};
    const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
    createInterface({ input: process.stdin }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "codex/0.169.0" } });
      if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: request.params.threadId } } });
      if (msg.method === "turn/start") {
        send({ id: msg.id, result: { turn: { id: request.params.turnId } } });
        send(request);
      }
      if (msg.method === undefined && msg.id === request.id) {
        writeFileSync(${JSON.stringify(log)}, JSON.stringify(msg));
        process.exit(0);
      }
    });
  `);
  let row: AgentSessionRow = {
    id: 3, role: "worker", conversationId: 1, pmId: 1, workerId: 2, vendor: "codex", vendorSessionId: "",
    cwd, addDirs: [], generation: 1, model: "gpt-5.4", effort: "high", pid: null, status: "idle", hasCompletedTurn: false,
    lastEventAt: null, rateLimit: null, usage: EMPTY_TOKEN_USAGE, createdAt: 1, updatedAt: 1,
  };
  const gate: AppApprovalGate = { request: vi.fn(async () => "accept" as const), processEnded: vi.fn() };
  const scopes: Array<LaunchFiles["writeScope"] | null> = [];
  const driver = createCodexDriver({
    executablePath, appApprovals: gate,
    store: { get: () => row, update: (_id, patch) => (row = { ...row, ...patch }), listWithProcess: () => row.pid === null ? [] : [row] },
    prepareLaunch: async () => ({
      promptFile: join(cwd, "prompt.md"), env: {}, fingerprint: "fixture", outerSandbox,
      writeScope: workerWriteScope({ role: "worker", dataDir: join(cwd, "state"), cwd })!,
      capabilities: { allow: { mcp: mounted ? ["cua_repl"] : [], skills: [] },
        deny: { mcp: [], plugins: [], skills: [], connectors: [], pluginOf: { skills: {}, mcp: {} } } },
    }),
    writeScopeSpawn: (base, scope) => { scopes.push(scope); return { ...base, osSandboxed: scope !== null }; },
  });
  const exited = new Promise<void>((resolve) => {
    driver.onEvent((_id, event) => { if (event.type === "session.exited") resolve(); });
  });
  try {
    await driver.send(row.id, { messageIds: [1], source: "user", text: "Check Calculator" });
    await exited;
    return { gate, scopes, answer: JSON.parse(readFileSync(log, "utf8")).result };
  } finally {
    await driver.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("Codex driver app approval wiring", () => {
  it("routes Computer Use app elicitations to the gate only for vendor_only launches", async () => {
    const allowed = await runDriver("vendor_only", true);
    expect(allowed.scopes).toEqual([null]);
    expect(allowed.gate.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ appId: appRequest.appId }), expect.any(AbortSignal));
    expect(allowed.answer).toEqual({ action: "accept", content: null, _meta: null });
    const missing = await runDriver("vendor_only", false);
    expect(missing.gate.request).not.toHaveBeenCalled();
    expect(missing.answer).toEqual({ action: "decline" });
  });
  it("keeps declining every other elicitation for ordinary Workers", async () => {
    const normal = await runDriver("enforced", true);
    expect(normal.scopes[0]).not.toBeNull();
    expect(normal.gate.request).not.toHaveBeenCalled();
    expect(normal.answer).toEqual({ action: "decline" });
    const other = await runDriver("vendor_only", true, { ...fixture.request, params: { ...params, mode: "url" } });
    expect(other.gate.request).not.toHaveBeenCalled();
    expect(other.answer).toEqual({ action: "decline" });
  });
  it("reports processEnded with the process key when codex app-server exits", async () => {
    const { gate } = await runDriver("vendor_only", true);
    const [received] = vi.mocked(gate.request).mock.calls[0] ?? [];
    expect(received?.processKey).toBeTruthy();
    expect(gate.processEnded).toHaveBeenCalledExactlyOnceWith(3, received?.processKey);
  });
});
