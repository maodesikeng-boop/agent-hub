// Invariant: BugHuntService serializes runs on one lane, never writes to hub.sqlite, and cancels cleanly on daemon shutdown before db.close().
import type { BugHuntRequest, BugHuntResponseData } from "../../shared/bug-hunt.ts";
import type { RawTelemetryCollectorDeps } from "./collector.ts";

export interface BugHuntServiceDeps extends RawTelemetryCollectorDeps {
  readonly stateFile: string;
  readonly testerBenchRoot?: string | null;
}

export interface BugHuntService {
  /**
   * Precondition: request is validated against the bug-hunt request schema.
   * Postcondition: runs a serialized read-only scan or lifecycle mutation, checks signal across awaits, and returns formatted text plus structured data within BUG_HUNT_REPORT_MAX_BYTES.
   */
  run(request: BugHuntRequest, signal?: AbortSignal): Promise<{ text: string; data: BugHuntResponseData }>;

  /**
   * Precondition: none.
   * Postcondition: aborts any in-flight scan and resolves only after all queued work stops touching deps.db.
   */
  close(): Promise<void>;
}

/**
 * Precondition: deps provides a ReadonlyDb handle and stateFile under HubPaths.stateDir.
 * Postcondition: returns a single-flight BugHuntService safe to wire into the daemon and agent API.
 */
export function createBugHuntService(_deps: BugHuntServiceDeps): BugHuntService {
  throw new Error("Not implemented");
}
