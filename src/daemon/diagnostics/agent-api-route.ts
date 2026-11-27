// Invariant: enforces PM-only access, request validation, and shutdown abort on POST /v1/diag.bug-hunt outside ledger write transactions.
import type { BugHuntRequest, BugHuntResponseData } from "../../shared/bug-hunt.ts";
import type { AgentRole, SessionId } from "../../shared/domain.ts";

export type BugHuntRouteHandler = (
  request: BugHuntRequest,
  signal: AbortSignal,
) => Promise<{ text: string; data: BugHuntResponseData }>;

export interface DiagBugHuntRouteInput {
  readonly sessionId: SessionId;
  readonly role: AgentRole | null;
  readonly body: unknown;
  readonly handler: BugHuntRouteHandler | undefined;
  readonly signal: AbortSignal;
}

/**
 * Precondition: sessionId has been authenticated by agent-api's bearer token hook.
 * Postcondition: rejects non-PM sessions with LedgerRequestError("forbidden"), validates request semantics, delegates to handler with signal, and returns { text, data }.
 */
export async function handleDiagBugHuntRoute(
  _input: DiagBugHuntRouteInput,
): Promise<{ text: string; data: BugHuntResponseData }> {
  throw new Error("Not implemented");
}
