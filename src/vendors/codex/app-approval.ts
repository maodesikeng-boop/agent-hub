// Codex forwards Computer Use app approvals as mcpServer/elicitation/request with
// _meta.codex_approval_kind "mcp_tool_call", _meta.connector_id "computer-use", and _meta.tool_params.app.
import type { AppApprovalAnswer, AppApprovalGate, AppApprovalRequest, SessionId } from "../../shared/index.ts";

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
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns an AppApprovalRequest only for a form-mode elicitation from a mounted Computer Use server whose
 * _meta names connector "computer-use", approval kind "mcp_tool_call", and a valid tool_params.app; returns null for
 * every other elicitation (audio recording, node_repl execution, other connectors) so the existing decline path applies.
 */
export function parseCodexAppApprovalRequest(_params: Record<string, unknown>, _context: CodexAppApprovalContext): AppApprovalRequest | null {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns one JSON-RPC response line answering requestId with the given action and null content and _meta.
 * Never sets _meta.persist, so codex and the plugin store no approval outside this Bellwood process.
 */
export function buildCodexAppApprovalResponse(_requestId: number | string, _answer: AppApprovalAnswer): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: request came from parseCodexAppApprovalRequest on this process.
 * Postcondition: registers a wait under requestId, asks the gate, and writes exactly one response line unless the wait
 * was aborted first (serverRequest/resolved or process exit), in which case nothing is written.
 */
export function answerCodexAppApproval(_input: {
  gate: AppApprovalGate;
  state: CodexAppApprovalState;
  request: AppApprovalRequest;
  requestId: number | string;
  write: (line: string) => void;
}): Promise<void> {
  throw new Error("Not implemented");
}

/** Postcondition: aborts the wait for a serverRequest/resolved notification's requestId; ignores unknown ids. */
export function onCodexServerRequestResolved(_state: CodexAppApprovalState, _params: Record<string, unknown>): void {
  throw new Error("Not implemented");
}
