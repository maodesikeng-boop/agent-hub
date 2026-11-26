import { randomUUID } from "node:crypto";
import {
  APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX, APP_APPROVAL_RISK_LEVELS, APP_APPROVAL_WARNING_MAX_CHARS,
  normalizeAppId, normalizeAppName, type AppApprovalAnswer, type AppApprovalGate, type AppApprovalRequest, type SessionId,
} from "../../shared/index.ts";
import { asObject } from "./driver-state.ts";
import { buildJsonRpcResponse } from "./protocol.ts";

export const CODEX_COMPUTER_USE_CONNECTOR_ID = "computer-use";

export interface CodexAppApprovalState {
  processKey: string;
  /** Live native requests keyed by JSON-RPC id; aborted on serverRequest/resolved or process exit. */
  waits: Map<string, AbortController>;
}

export interface CodexAppApprovalContext {
  sessionId: SessionId;
  requestId: number | string;
  processKey: string;
  /** MCP server names of mounted Computer Use capabilities (for example "cua_repl"); empty unless outerSandbox is "vendor_only". */
  computerUseServers: readonly string[];
}

/** Postcondition: returns a fresh random processKey and an empty wait map for one spawned codex app-server. */
export function createCodexAppApprovalState(): CodexAppApprovalState {
  return { processKey: randomUUID(), waits: new Map() };
}

/**
 * Postcondition: returns an AppApprovalRequest only for a form-mode elicitation from a mounted Computer Use server whose
 * _meta names connector "computer-use", approval kind "mcp_tool_call", and a valid tool_params.app; returns null for
 * every other elicitation (audio recording, node_repl execution, other connectors) so the existing decline path applies.
 */
export function parseCodexAppApprovalRequest(params: Record<string, unknown>, context: CodexAppApprovalContext): AppApprovalRequest | null {
  const { serverName, mode } = params;
  if (mode !== "form" || typeof serverName !== "string" || !context.computerUseServers.includes(serverName)) return null;
  const meta = asObject(params._meta);
  if (meta?.codex_approval_kind !== "mcp_tool_call" || meta.connector_id !== CODEX_COMPUTER_USE_CONNECTOR_ID ||
      meta.tool_name === "start_audio_recording") return null;
  const appId = normalizeAppId(asObject(meta.tool_params)?.app);
  if (appId === null) return null;
  const display = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.map(asObject).find((entry) => entry?.name === "app") : null;
  const riskLevel = APP_APPROVAL_RISK_LEVELS.find((risk) => risk === meta.riskLevel) ?? null;
  const warning = typeof meta.subtitle === "string" ? [...meta.subtitle.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()].slice(0, APP_APPROVAL_WARNING_MAX_CHARS).join("") : "";
  return {
    sessionId: context.sessionId, vendor: "codex", processKey: context.processKey, requestKey: String(context.requestId),
    capability: `mcp:${serverName}`, appId, appName: normalizeAppName(display?.value, appId), riskLevel, warning: warning || null,
  };
}

/**
 * Postcondition: returns one JSON-RPC response line answering requestId with the given action and null content and _meta.
 * Never sets _meta.persist, so codex and the plugin store no approval outside this Bellwood process.
 */
export function buildCodexAppApprovalResponse(requestId: number | string, answer: AppApprovalAnswer): string {
  return buildJsonRpcResponse(requestId, { action: answer, content: null, _meta: null });
}

/**
 * Precondition: request came from parseCodexAppApprovalRequest on this process.
 * Postcondition: registers a wait under requestId, asks the gate, and writes exactly one response line unless the wait
 * was aborted first (serverRequest/resolved or process exit), in which case nothing is written.
 */
export async function answerCodexAppApproval(input: {
  gate: AppApprovalGate;
  state: CodexAppApprovalState;
  request: AppApprovalRequest;
  requestId: number | string;
  write: (line: string) => void;
}): Promise<void> {
  const { gate, state, request, requestId, write } = input;
  const key = nativeKey(requestId);
  if (state.waits.has(key)) return;
  if (state.waits.size >= APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX) {
    write(buildCodexAppApprovalResponse(requestId, "decline"));
    return;
  }
  const controller = new AbortController();
  state.waits.set(key, controller);
  try {
    const answer = await gate.request(request, controller.signal);
    if (!controller.signal.aborted) write(buildCodexAppApprovalResponse(requestId, answer));
  } finally {
    state.waits.delete(key);
  }
}

/** Postcondition: aborts the wait for a serverRequest/resolved notification's requestId; ignores unknown ids. */
export function onCodexServerRequestResolved(state: CodexAppApprovalState, params: Record<string, unknown>): void {
  const { requestId } = params;
  if (typeof requestId === "string" || typeof requestId === "number") state.waits.get(nativeKey(requestId))?.abort();
}

function nativeKey(id: number | string): string {
  return JSON.stringify(id);
}
