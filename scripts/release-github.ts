// Reads release facts from git and GitHub, and carries out release plans with the gh CLI.
// Invariant: with dryRun set, nothing writes to GitHub; each command that would write is logged instead.
import type { ReleaseFacts, ReleasePlan } from "./release-plan.ts";

/** Runs a command and returns its stdout. Throws when the command exits non-zero. */
export type CommandRunner = (file: string, args: readonly string[]) => string;

export interface ReleaseContext {
  /** owner/name of the GitHub repository. */
  repo: string;
  run: CommandRunner;
  dryRun: boolean;
  log: (line: string) => void;
}

/**
 * Postcondition: returns the facts planRelease needs for tag. Reads every release of repo, drafts included, and checks
 * whether origin/main contains the tag commit. When the tag does not exist yet, as in a dry run on a branch, uses HEAD.
 */
export function readReleaseFacts(tag: string, appVersion: string, ctx: ReleaseContext): ReleaseFacts {
  throw new Error("Not implemented");
}

/**
 * Precondition: plan came from planRelease for the same tag. For a build plan, assetsDir holds every REQUIRED_RELEASE_ASSETS file.
 * Postcondition: for a promote plan, first downloads fromTag's assets into assetsDir and checks each .sha256 and the
 * build provenance attestation signed by release.yml. Then creates the release as a draft, uploads every asset, and
 * publishes it, as a prerelease for a build plan and as latest for a promote plan.
 * Never uploads to, edits, or deletes an existing release. Throws on the first failed check, before anything is published.
 */
export function publishRelease(plan: ReleasePlan, opts: { assetsDir: string; notesFile: string }, ctx: ReleaseContext): void {
  throw new Error("Not implemented");
}

/**
 * Precondition: tag is a published formal release, and at least one other published formal release exists.
 * Postcondition: marks tag as a prerelease that is not latest, marks the highest remaining formal release as latest, and
 * confirms that the releases/latest API now returns that release. Leaves every asset and tag unchanged.
 * Returns the tag that is latest afterwards. Throws when no other formal release exists or the confirmation fails.
 */
export function yankRelease(tag: string, ctx: ReleaseContext): string {
  throw new Error("Not implemented");
}
