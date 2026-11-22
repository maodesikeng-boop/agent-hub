// Decides what a pushed v* tag may publish. Callers gather the facts from git and GitHub; this module does no I/O.
// Invariant: a formal vX.Y.Z release reuses, byte for byte, the installers of the newest vX.Y.Z-rc.N prerelease built from the same commit.
import { RELEASE_INSTALLER_FILES } from "../src/shared/update.ts";

/** Every release must carry each installer and its .sha256, because the in-app update check needs both. */
export const REQUIRED_RELEASE_ASSETS: readonly string[] = Object.values(RELEASE_INSTALLER_FILES).flatMap((name) => [name, `${name}.sha256`]);

export interface ExistingRelease {
  tag: string;
  /** Full SHA the release tag points at. */
  commit: string;
  draft: boolean;
  prerelease: boolean;
  assets: readonly string[];
}

export interface ReleaseFacts {
  tag: string;
  /** Full SHA the pushed tag points at. */
  commit: string;
  /** Shared version of package.json, apps/windows/Cargo.toml, and tauri.conf.json. */
  appVersion: string;
  /** Whether origin/main contains commit. */
  onMain: boolean;
  /** Every release in the repository, drafts included. */
  releases: readonly ExistingRelease[];
}

export type ReleasePlan =
  | { mode: "build"; tag: string; version: string; rc: number }
  | { mode: "promote"; tag: string; version: string; fromTag: string };

/**
 * Postcondition: returns a build plan for a vX.Y.Z-rc.N tag and a promote plan for a vX.Y.Z tag, whose fromTag is the
 * highest-numbered published vX.Y.Z-rc.N prerelease.
 * Throws when the tag is not vX.Y.Z or vX.Y.Z-rc.N, its version differs from appVersion, main does not contain the commit,
 * or any release, draft or published, already uses the tag. A formal tag also throws when no published rc exists for its
 * version, when that rc points at another commit, or when that rc lacks one of REQUIRED_RELEASE_ASSETS.
 */
export function planRelease(facts: ReleaseFacts): ReleasePlan {
  throw new Error("Not implemented");
}

/**
 * Precondition: changelog is CHANGELOG.md text with one "## vX.Y.Z" heading per formal version, newest first.
 * Postcondition: returns the trimmed text under "## v<version>" up to the next "## " heading. Prereleases of a version use
 * its section, so the notes are reviewed with the rc.
 * Throws when the section is missing or empty, so no release ships without notes.
 */
export function releaseNotesFor(changelog: string, version: string): string {
  throw new Error("Not implemented");
}
