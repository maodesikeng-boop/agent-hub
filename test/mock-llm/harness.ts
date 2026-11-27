// Invariant: always boots the unmodified Bellwood daemon inside an isolated HOME with non-target vendors pinned to nonexistent paths, isolated ports/relay, background catalog turns segregated from PM turns, and full child-process exit verification before removing temp files.
import type { RealCliDaemonOptions, RealCliSessionHandle } from "./types.ts";

/**
 * Precondition: options.vendor has support === "full" and an installed real CLI binary.
 * Postcondition: starts the local mock LLM server, provisions an isolated temporary HOME for options.vendor, pins non-target vendor env vars to nonexistent paths, sets AGENT_HUB_PORT=0 / FUSA_MESH_PORT=0 / FUSA_RELAY_URL=http://127.0.0.1:1, boots the real Bellwood daemon, creates a PM with the explicit provisioned model, isolates background project-catalog requests from pmRequests(), and returns a handle whose close() verifies zero surviving children before removing temp files.
 */
export async function startRealCliDaemon(_options: RealCliDaemonOptions): Promise<RealCliSessionHandle> {
  throw new Error("Not implemented");
}
