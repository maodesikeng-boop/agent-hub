// Invariant: relay merge verification is read-only, never invokes repository diff or merge drivers, and fails closed on any reverted hunk, restored deletion, deleted addition, or diverged binary change.

export interface RawTreeChange {
  readonly path: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
  readonly status: string;
}

export interface UnifiedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly addedLines: readonly string[];
}

export interface ParsedFileDiff {
  readonly path: string;
  readonly binary: boolean;
  readonly hunks: readonly UnifiedHunk[];
}

export interface RelayCarryInput {
  readonly repoFolder: string;
  readonly timeoutMs: number;
  readonly ownMergeBase: string;
  readonly branchCommit: string;
  readonly containingMergeBase: string;
  readonly containingCommit: string;
}

/**
 * Precondition: stdout comes from `git diff-tree -r -z --no-renames --raw`.
 * Postcondition: returns a map from file path to its raw old/new mode, oid, and status.
 */
export function parseRawTreeDiff(_stdout: string): Map<string, RawTreeChange> {
  throw new Error("Not implemented");
}

/**
 * Precondition: stdout comes from `git diff-tree -p -U0 --no-renames --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/`.
 * Postcondition: returns a map from file path to its parsed zero-context hunks and binary flag.
 */
export function parseUnifiedZeroHunks(_stdout: string): Map<string, ParsedFileDiff> {
  throw new Error("Not implemented");
}

/**
 * Precondition: own, containing, and optional mainSinceOwn are parsed from diffs sharing the same left-hand base tree (ownMergeBase).
 * Postcondition: returns true only when neither own nor containing is binary, own has at least one hunk, and every own hunk overlaps at least one containing hunk that is not byte-identical to a mainSinceOwn hunk.
 */
export function hunksCoverOwnDiff(
  _own: ParsedFileDiff,
  _containing: ParsedFileDiff,
  _mainSinceOwn?: ParsedFileDiff,
): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: input.containingCommit contains input.branchCommit along its first-parent line and already reached the target branch.
 * Postcondition: returns true only when containingCommit retains or refines every file change that branchCommit introduced relative to ownMergeBase, with no reverted hunk, restored deletion, deleted addition, intermediate revert to base, main-merge dropped conflict, or diverged binary blob; never writes git objects or runs repository drivers.
 */
export async function verifyRelayCarriesChanges(_input: RelayCarryInput): Promise<boolean> {
  throw new Error("Not implemented");
}
