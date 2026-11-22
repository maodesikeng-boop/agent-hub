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

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)(?:-rc\.([1-9]\d*))?$/;

function rcNumberOf(tag: string, version: string): number | null {
  const match = RELEASE_TAG.exec(tag);
  return match?.[1] === version && match[2] !== undefined ? Number(match[2]) : null;
}

/**
 * Postcondition: returns a build plan for a vX.Y.Z-rc.N tag and a promote plan for a vX.Y.Z tag, whose fromTag is the
 * highest-numbered published vX.Y.Z-rc.N prerelease.
 * Throws when the tag is not vX.Y.Z or vX.Y.Z-rc.N, its version differs from appVersion, main does not contain the commit,
 * or any release, draft or published, already uses the tag. A formal tag also throws when no published rc exists for its
 * version, when that rc points at another commit, or when that rc lacks one of REQUIRED_RELEASE_ASSETS.
 * With opts.dryRun, a commit that main does not contain is allowed, so a branch can rehearse the whole pipeline.
 */
export function planRelease(facts: ReleaseFacts, opts: { dryRun?: boolean } = {}): ReleasePlan {
  const { tag } = facts;
  const match = RELEASE_TAG.exec(tag);
  if (!match) throw new Error(`Tag ${tag} is not vX.Y.Z or vX.Y.Z-rc.N`);
  const version = match[1]!;
  if (version !== facts.appVersion) {
    throw new Error(`Tag ${tag} does not match app version ${facts.appVersion}; bump the version in a pull request before tagging`);
  }
  const existing = facts.releases.find((release) => release.tag === tag);
  if (existing) {
    throw new Error(`Tag ${tag} already has a ${existing.draft ? "draft" : "published"} release; push the next vX.Y.Z-rc.N instead`);
  }
  if (!facts.onMain && !opts.dryRun) throw new Error(`Commit ${facts.commit} of ${tag} is not on main`);
  if (match[2] !== undefined) return { mode: "build", tag, version, rc: Number(match[2]) };

  const candidates = facts.releases
    .filter((release) => !release.draft && release.prerelease && rcNumberOf(release.tag, version) !== null)
    .sort((a, b) => rcNumberOf(b.tag, version)! - rcNumberOf(a.tag, version)!);
  const rc = candidates[0];
  if (!rc) throw new Error(`${tag} has no published v${version}-rc.N to promote; push v${version}-rc.1 first`);
  if (rc.commit !== facts.commit) {
    throw new Error(`${tag} points at ${facts.commit}, but the newest candidate ${rc.tag} points at ${rc.commit}; tag the candidate's commit`);
  }
  const missing = REQUIRED_RELEASE_ASSETS.filter((name) => !rc.assets.includes(name));
  if (missing.length > 0) throw new Error(`${rc.tag} lacks ${missing.join(", ")}; push the next rc`);
  return { mode: "promote", tag, version, fromTag: rc.tag };
}

/**
 * Precondition: changelog is CHANGELOG.md text with one "## vX.Y.Z" heading per formal version, newest first.
 * Postcondition: returns the trimmed text under "## v<version>" up to the next "## " heading. Prereleases of a version use
 * its section, so the notes are reviewed with the rc.
 * Throws when the section is missing or empty, so no release ships without notes.
 */
export function releaseNotesFor(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const heading = `## v${version}`;
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no "${heading}" section`);
  const next = lines.findIndex((line, idx) => idx > start && line.startsWith("## "));
  const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
  if (body === "") throw new Error(`CHANGELOG.md section "${heading}" is empty`);
  return body;
}
