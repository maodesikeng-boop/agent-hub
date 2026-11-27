// Invariant: prefix checks compare semantic model prefixes per wire dialect and strip only cache-neutral transport markers.
import type { PrefixStabilityResult, RecordedLlmRequest } from "./types.ts";

/**
 * Precondition: requests is an ordered list of recorded mock LLM requests from one conversation.
 * Postcondition: returns stable=true iff every consecutive request pair preserves system/instructions, tools, cache key (when present or required), and canonicalized prior messages without throwing on malformed bodies.
 */
export function checkPrefixStability(
  _requests: readonly RecordedLlmRequest[],
  _options?: { requireCacheKeyStable?: boolean },
): PrefixStabilityResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: requests contains at least two recorded requests from one conversation.
 * Postcondition: returns normally when checkPrefixStability succeeds; otherwise throws an Error listing every PrefixDiff.
 */
export function expectPrefixStable(
  _requests: readonly RecordedLlmRequest[],
  _options?: { requireCacheKeyStable?: boolean },
): void {
  throw new Error("Not implemented");
}
