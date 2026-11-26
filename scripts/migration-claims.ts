// This repository's guard against two open pull requests taking the same migration number.
// Invariant: a version belongs to main once main's manifest lists it, and otherwise to the open PR with the lowest number that adds it.
// It reads PRs and main only through the GitHub API, so it can run under pull_request with a read-only token.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GhRunOptions, GhRunResult } from "../src/daemon/git/gh.ts";

/** One page of the open-PR list; more open PRs than this fails the check closed instead of skipping some. */
export const MIGRATION_CLAIMS_MAX_OPEN_PRS = 100;

/** Matches a migration path in a PR file list and captures its version. */
export const MIGRATION_PATH = /^migrations\/(\d+)_[^/\\\s]+\.sql$/u;

export interface MigrationClaim {
  pr: number;
  version: number;
  file: string;
}

export interface OpenPrMigrations {
  pr: number;
  files: readonly string[];
  /** True when GitHub stopped listing files at its cap, so the claim list may be incomplete. */
  filesTruncated: boolean;
}

export type MigrationClaimConflict =
  | { kind: "on-main"; version: number; file: string; mainLatest: number }
  | { kind: "claimed"; version: number; file: string; otherPr: number; otherFile: string };

export type ClaimCheckResult =
  | { kind: "ok"; claims: MigrationClaim[] }
  | { kind: "conflict"; conflicts: MigrationClaimConflict[]; next: number }
  | { kind: "incomplete"; reason: string };

export interface ClaimCheckInput {
  pr: number;
  files: readonly string[];
  filesTruncated: boolean;
  /** Text of migrations/manifest.sha256 on the current main, not on the PR's merge base. */
  mainManifest: string;
  openPrs: readonly OpenPrMigrations[];
  openPrsTruncated: boolean;
}

/**
 * Postcondition: returns one claim per path in files that matches MIGRATION_PATH, in input order; other paths,
 * including migrations/manifest.sha256, are ignored.
 */
export function migrationClaimsOf(_pr: number, _files: readonly string[]): MigrationClaim[] {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns the highest version listed in the manifest, or 0 for an empty manifest.
 * Throws an error naming the line number (`line N`) when a non-empty line is not `<sha256>  <version>_<name>.sql`, so a broken manifest fails the check.
 */
export function latestManifestVersion(_manifest: string): number {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns the smallest version above mainLatest that no claim in taken uses.
 */
export function nextFreeVersion(_mainLatest: number, _taken: readonly MigrationClaim[]): number {
  throw new Error("Not implemented");
}

/**
 * Decides whether the PR in input may keep the migration numbers it adds.
 * - A version at or below main's latest is an `on-main` conflict.
 * - A version that an open PR with a lower number also adds is a `claimed` conflict; a higher-numbered PR never blocks this one.
 * - The PR's own entry in openPrs is ignored.
 * - A truncated file list for this PR or any open PR, or a truncated open-PR list, returns `incomplete`.
 * Postcondition: on `conflict`, next is nextFreeVersion over main and every other open PR's claims.
 */
export function checkMigrationClaims(_input: ClaimCheckInput): ClaimCheckResult {
  throw new Error("Not implemented");
}

/** Postcondition: returns report lines that name each conflicting file, the other PR or main, and the number to take. */
export function formatClaimReport(_pr: number, _result: ClaimCheckResult): string[] {
  throw new Error("Not implemented");
}

export interface MigrationClaimsDeps {
  execGh: (cwd: string, args: readonly string[], options: GhRunOptions) => Promise<GhRunResult>;
  cwd: string;
  log: (line: string) => void;
}

/**
 * CLI: `node scripts/migration-claims.ts --pr <N>` checks one PR and exits 1 on a conflict or an incomplete listing;
 * `node scripts/migration-claims.ts --next` prints the next free migration number across main and every open PR.
 * Returns the process exit code.
 */
export async function main(_argv: readonly string[], _deps: MigrationClaimsDeps): Promise<number> {
  throw new Error("Not implemented");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { execGh } = await import("../src/daemon/git/gh.ts");
  process.exitCode = await main(process.argv.slice(2), { execGh, cwd: process.cwd(), log: (line) => console.log(line) });
}
