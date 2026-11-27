// Invariant: bug-hunt-store.ts is the sole reader and atomic writer of state/bug-hunt-state.json, enforcing retention, entry, and byte caps from src/shared/limits.ts.
import type {
  BugHuntClassifiedFinding,
  BugHuntFinding,
  BugHuntMutationResult,
  BugHuntRunResult,
  BugHuntStateFile,
} from "../../shared/bug-hunt.ts";
import type { SourceHealthEntry } from "../../shared/raw-telemetry.ts";

export interface BugHuntStoreLoadResult {
  readonly state: BugHuntStateFile;
  readonly recovered: boolean;
}

export interface ApplyBugHuntRunInput {
  readonly runId: string;
  readonly runKey: string | null;
  readonly dryRun: boolean;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly ranAt: number;
  readonly findings: readonly BugHuntFinding[];
  readonly sources: readonly SourceHealthEntry[];
}

export interface BugHuntStore {
  /**
   * Precondition: none.
   * Postcondition: loads state/bug-hunt-state.json using stat identity validation, recovering cleanly with recovered: true when missing or corrupt without throwing.
   */
  load(): BugHuntStoreLoadResult;

  /**
   * Precondition: input carries findings from one bounded window.
   * Postcondition: replays prior result on duplicate runKey, deduplicates repeats, escalates spikes, flips post-fix recurrences to regressed, enforces retention and byte caps, and atomically writes state unless dryRun is true.
   */
  applyRun(input: ApplyBugHuntRunInput): BugHuntRunResult;

  /**
   * Precondition: fingerprint identifies a tracked finding in state/bug-hunt-state.json.
   * Postcondition: updates finding status to acknowledged, muted, or fixed (recording fixedAt and optional commit) atomically; throws LedgerRequestError("not_found") when absent.
   */
  mutateFinding(
    action: "ack" | "mute" | "fix",
    fingerprint: string,
    options?: { readonly reason?: string; readonly commit?: string },
  ): BugHuntMutationResult;

  /**
   * Precondition: findings is a candidate list already scored by severity.
   * Postcondition: returns the non-suppressed alert list capped at BUG_HUNT_MAX_FINDINGS_PER_RUN alongside suppressed and omitted counts.
   */
  classifyPreview(findings: readonly BugHuntFinding[]): {
    readonly alerts: readonly BugHuntClassifiedFinding[];
    readonly suppressedCount: number;
    readonly omittedCount: number;
  };
}

/**
 * Precondition: stateFile is an absolute path under HubPaths.stateDir.
 * Postcondition: returns a BugHuntStore that validates stat identity before reusing cached state and writes atomically with 0o600 permissions.
 */
export function createBugHuntStore(_stateFile: string, _options?: { readonly now?: () => number }): BugHuntStore {
  throw new Error("Not implemented");
}
