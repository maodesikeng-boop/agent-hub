// Invariant: permanent auth, permission, not-found, and schema errors are never classified as transient.

/**
 * Classifies whether a failed `gh` CLI invocation is a transient network or transport error eligible for retry.
 * Postcondition: returns true for timeouts, HTTP 5xx, DNS/TCP/TLS resets, HTTP/2 stream/connection drops,
 * and Go net/http EOF failures (including GraphQL EOF); returns false for missing binaries, HTTP 4xx, auth
 * failures, not-found errors, and unknown non-network errors.
 */
export function isTransientGhError(_stderr: string, _timedOut = false): boolean {
  throw new Error("Not implemented");
}
