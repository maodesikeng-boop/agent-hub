// Loopback mock model server, deterministic prompt-cache prefix checker, and normalized context snapshotter.
// Invariant: server binds 127.0.0.1 only, caps request bodies and history, and never forwards traffic to external networks.
import type {
  ContextNormalizeOptions,
  MockModelServerHandle,
  MockModelServerOptions,
  PrefixStabilityReport,
  RecordedModelRequest,
} from "./types.ts";

/**
 * Precondition: options.turns defines scripted replies or fault injections; maxBodyBytes and maxRequests default to limits.ts caps.
 * Postcondition: starts a loopback-only HTTP server serving OpenAI Responses SSE and Anthropic Messages SSE,
 * rejects bodies above maxBodyBytes with HTTP 413 without unbounded buffering, and releases its socket on close().
 */
export async function startMockModelServer(_options: MockModelServerOptions): Promise<MockModelServerHandle> {
  throw new Error("Not implemented");
}

/**
 * Precondition: requests are ordered chronologically for one session.
 * Postcondition: returns stable: true only when systemText, toolNames, promptCacheKey (when present),
 * and inputMessages stay strictly append-only across every consecutive turn pair; otherwise records firstDivergenceTurn and every violation.
 */
export function checkPromptPrefixStability(_requests: readonly RecordedModelRequest[]): PrefixStabilityReport {
  throw new Error("Not implemented");
}

/**
 * Precondition: request is a captured RecordedModelRequest from the mock model server.
 * Postcondition: renders a deterministic human-readable context snapshot with macOS, Linux, and Windows user paths,
 * dynamic roots, UUIDs, and ISO timestamps redacted to stable placeholders.
 */
export function normalizeContextSnapshot(
  _request: RecordedModelRequest,
  _options?: ContextNormalizeOptions,
): string {
  throw new Error("Not implemented");
}
