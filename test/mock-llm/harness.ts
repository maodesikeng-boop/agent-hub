// Invariant: always boots the unmodified Bellwood daemon inside an isolated HOME, wires only the selected real vendor CLI, and waits for daemon and child exit before removing temp files.
import type { RealCliDaemonOptions, RealCliSessionHandle } from "./types.ts";

/**
 * Precondition: options.vendor has support === "full" and an installed real CLI binary.
 * Postcondition: starts the local mock LLM server, provisions an isolated temporary HOME for options.vendor, boots the real Bellwood daemon, creates a PM on options.vendor, and returns a handle whose close() cleanly shuts down daemon, children, server, and temp files.
 */
export async function startRealCliDaemon(_options: RealCliDaemonOptions): Promise<RealCliSessionHandle> {
  throw new Error("Not implemented");
}
