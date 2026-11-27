// Invariant: permanent auth, permission, not-found, and schema errors are never classified as transient.

const PERMANENT_GH_ERROR =
  /HTTP 4\d\d|no pull requests found|could not resolve to a |not logged into|gh auth login|bad credentials|authentication|no oauth token/iu;

const TRANSIENT_GH_ERROR =
  /network|connect|timed? out|i\/o timeout|context deadline exceeded|dns|no such host|name resolution|enotfound|econnrefused|econnreset|tls|ssl|HTTP 5\d\d|:\s*EOF\b|unexpected EOF|http2:|GOAWAY|broken pipe|socket hang up/iu;

/**
 * Classifies whether a failed `gh` CLI invocation is a transient network or transport error eligible for retry.
 * Postcondition: returns true for timeouts, HTTP 5xx, DNS/TCP/TLS resets, HTTP/2 stream/connection drops,
 * and Go net/http EOF failures (including GraphQL EOF); returns false for missing binaries, HTTP 4xx, auth
 * failures, not-found errors, and unknown non-network errors.
 */
export function isTransientGhError(stderr: string, timedOut = false): boolean {
  if (timedOut) return true;
  const trimmed = stderr.trim();
  if (trimmed === "" || PERMANENT_GH_ERROR.test(trimmed)) return false;
  return TRANSIENT_GH_ERROR.test(trimmed);
}
