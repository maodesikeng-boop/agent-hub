// Invariant: binds exclusively on 127.0.0.1 and enforces request count and body byte caps.
import type { MockLlmDialect, MockLlmServer, MockLlmServerOptions } from "./types.ts";

/**
 * Precondition: method is an HTTP verb and path is the raw request URL path (with optional query string).
 * Postcondition: returns the matched open wire dialect or "unknown" when no dialect matches.
 */
export function detectDialect(_method: string, _path: string): MockLlmDialect | "unknown" {
  throw new Error("Not implemented");
}

/**
 * Precondition: optional caps, when given, are positive integers.
 * Postcondition: starts a loopback HTTP/SSE mock server on 127.0.0.1:0 that records requests within configured bounds and resolves only when listening.
 */
export async function createMockLlmServer(_options?: MockLlmServerOptions): Promise<MockLlmServer> {
  throw new Error("Not implemented");
}
