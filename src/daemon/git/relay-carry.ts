// Invariant: relay merge verification is read-only, never invokes repository diff or merge drivers, and fails closed on any reverted hunk, restored deletion, deleted addition, or diverged binary change.
import { SQUASH_MERGE_RELAY_DEPTH_MAX } from "../../shared/limits.ts";
import { GIT_READONLY_ARGS, GIT_READONLY_ENV, failedGit, runGit } from "./git.ts";

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

const DIFF_READONLY_ARGS: readonly string[] = [...GIT_READONLY_ARGS, "-c", "core.quotePath=false", "-c", "diff.external="];
const PROBE_ENV: Readonly<Record<string, string>> = { ...GIT_READONLY_ENV, LC_ALL: "C" };
const RAW_ENTRY_RE = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z][0-9]*)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const PATH_BATCH_SIZE = 100;

/**
 * Precondition: stdout comes from `git diff-tree -r -z --no-renames --raw`.
 * Postcondition: returns a map from file path to its raw old/new mode, oid, and status.
 */
export function parseRawTreeDiff(stdout: string): Map<string, RawTreeChange> {
  const result = new Map<string, RawTreeChange>();
  if (stdout === "") return result;
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const header = parts[i]!.replace(/^[\r\n]+/, "");
    const match = RAW_ENTRY_RE.exec(header);
    if (match === null) continue;
    const status = match[5]!;
    const path = parts[++i];
    if (path === undefined || path === "") continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const dstPath = parts[++i];
      if (dstPath === undefined || dstPath === "") continue;
      result.set(dstPath, {
        path: dstPath,
        oldMode: match[1]!,
        newMode: match[2]!,
        oldOid: match[3]!,
        newOid: match[4]!,
        status,
      });
      continue;
    }
    result.set(path, {
      path,
      oldMode: match[1]!,
      newMode: match[2]!,
      oldOid: match[3]!,
      newOid: match[4]!,
      status,
    });
  }
  return result;
}

function parseDiffGitPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (!rest.startsWith("a/")) return null;
  // With --no-renames and --src-prefix=a/ --dst-prefix=b/, the header is always "a/<path> b/<path>".
  const payloadLen = rest.length - 5;
  if (payloadLen <= 0 || payloadLen % 2 !== 0) return null;
  const pathLen = payloadLen / 2;
  const left = rest.slice(2, 2 + pathLen);
  const sep = rest.slice(2 + pathLen, 5 + pathLen);
  const right = rest.slice(5 + pathLen);
  return sep === " b/" && left === right ? left : null;
}

/**
 * Precondition: stdout comes from `git diff-tree -p -U0 --no-renames --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/`.
 * Postcondition: returns a map from file path to its parsed zero-context hunks and binary flag.
 */
export function parseUnifiedZeroHunks(stdout: string): Map<string, ParsedFileDiff> {
  const result = new Map<string, ParsedFileDiff>();
  if (stdout === "") return result;

  let current: { path: string; binary: boolean; hunks: UnifiedHunk[] } | null = null;
  let activeHunk: {
    addedLines: string[];
    oldRem: number;
    newRem: number;
  } | null = null;

  for (const line of stdout.split("\n")) {
    if (activeHunk !== null) {
      if (line.startsWith("+")) {
        activeHunk.addedLines.push(line.slice(1));
        activeHunk.newRem -= 1;
        if (activeHunk.oldRem <= 0 && activeHunk.newRem <= 0) activeHunk = null;
        continue;
      }
      if (line.startsWith("-")) {
        activeHunk.oldRem -= 1;
        if (activeHunk.oldRem <= 0 && activeHunk.newRem <= 0) activeHunk = null;
        continue;
      }
      if (line.startsWith("\\")) continue;
      activeHunk = null;
    }

    if (line.startsWith("diff --git ")) {
      const path = parseDiffGitPath(line);
      if (path !== null) {
        current = { path, binary: false, hunks: [] };
        result.set(path, current);
      } else {
        current = null;
      }
      continue;
    }

    if (current === null) continue;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = HUNK_HEADER_RE.exec(line);
      if (match === null) continue;
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      const addedLines: string[] = [];
      current.hunks.push({ oldStart, oldCount, newStart, newCount, addedLines });
      activeHunk = oldCount > 0 || newCount > 0 ? { addedLines, oldRem: oldCount, newRem: newCount } : null;
    }
  }
  return result;
}

function sameOwnSpaceHunk(a: UnifiedHunk, b: UnifiedHunk): boolean {
  return (
    a.oldStart === b.oldStart &&
    a.oldCount === b.oldCount &&
    a.addedLines.length === b.addedLines.length &&
    a.addedLines.every((line, idx) => line === b.addedLines[idx])
  );
}

function hunkCoversOwn(own: UnifiedHunk, candidate: UnifiedHunk): boolean {
  if (own.oldCount === 0) {
    if (candidate.oldCount === 0) return candidate.oldStart === own.oldStart;
    if (candidate.newCount === 0) return false;
    const candidateEnd = candidate.oldStart + candidate.oldCount - 1;
    return (
      (own.oldStart >= candidate.oldStart && own.oldStart <= candidateEnd) ||
      (own.oldStart === 0 && candidate.oldStart === 1)
    );
  }
  if (candidate.oldCount === 0) return false;
  const ownEnd = own.oldStart + own.oldCount - 1;
  const candidateEnd = candidate.oldStart + candidate.oldCount - 1;
  return own.oldStart <= candidateEnd && candidate.oldStart <= ownEnd;
}

/**
 * Precondition: own, containing, and optional mainSinceOwn are parsed from diffs sharing the same left-hand base tree (ownMergeBase).
 * Postcondition: returns true only when neither own nor containing is binary, own has at least one hunk, and every own hunk overlaps at least one containing hunk that is not byte-identical to a mainSinceOwn hunk.
 */
export function hunksCoverOwnDiff(
  own: ParsedFileDiff,
  containing: ParsedFileDiff,
  mainSinceOwn?: ParsedFileDiff,
): boolean {
  if (own.binary || containing.binary || own.hunks.length === 0 || containing.hunks.length === 0) return false;
  const effectiveContaining =
    mainSinceOwn === undefined
      ? containing.hunks
      : containing.hunks.filter((c) => !mainSinceOwn.hunks.some((m) => sameOwnSpaceHunk(c, m)));
  if (effectiveContaining.length === 0) return false;
  return own.hunks.every((ownHunk) => effectiveContaining.some((candidate) => hunkCoversOwn(ownHunk, candidate)));
}

async function rawDiffTree(repoFolder: string, timeoutMs: number, fromTree: string, toTree: string): Promise<Map<string, RawTreeChange>> {
  const run = await runGit(
    repoFolder,
    [...DIFF_READONLY_ARGS, "diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", "--raw", fromTree, toTree],
    timeoutMs,
    PROBE_ENV,
  );
  if (run.code !== 0) throw failedGit("git diff-tree --raw", run);
  return parseRawTreeDiff(run.stdout);
}

async function unifiedZeroDiff(
  repoFolder: string,
  timeoutMs: number,
  fromTree: string,
  toTree: string,
  paths: readonly string[],
): Promise<Map<string, ParsedFileDiff>> {
  const merged = new Map<string, ParsedFileDiff>();
  for (let i = 0; i < paths.length; i += PATH_BATCH_SIZE) {
    const batch = paths.slice(i, i + PATH_BATCH_SIZE);
    const run = await runGit(
      repoFolder,
      [
        ...DIFF_READONLY_ARGS,
        "diff-tree",
        "-p",
        "-U0",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        fromTree,
        toTree,
        "--",
        ...batch,
      ],
      timeoutMs,
      PROBE_ENV,
    );
    if (run.code !== 0) throw failedGit("git diff-tree -p -U0", run);
    for (const [path, diff] of parseUnifiedZeroHunks(run.stdout)) merged.set(path, diff);
  }
  return merged;
}

async function hasIntermediateRevertToBase(
  input: RelayCarryInput,
  ownRaw: ReadonlyMap<string, RawTreeChange>,
  paths: readonly string[],
): Promise<boolean> {
  for (let i = 0; i < paths.length; i += PATH_BATCH_SIZE) {
    const batch = paths.slice(i, i + PATH_BATCH_SIZE);
    const run = await runGit(
      input.repoFolder,
      [
        ...DIFF_READONLY_ARGS,
        "log",
        "--first-parent",
        "-m",
        "--raw",
        "--no-abbrev",
        "-z",
        "--no-renames",
        "--format=%x00",
        `--max-count=${SQUASH_MERGE_RELAY_DEPTH_MAX}`,
        `${input.branchCommit}..${input.containingCommit}`,
        "--",
        ...batch,
      ],
      input.timeoutMs,
      PROBE_ENV,
    );
    if (run.code !== 0) throw failedGit("git log --first-parent --raw", run);
    const parts = run.stdout.split("\0");
    for (let idx = 0; idx < parts.length; idx++) {
      const header = parts[idx]!.replace(/^[\r\n]+/, "");
      const match = RAW_ENTRY_RE.exec(header);
      if (match === null) continue;
      const status = match[5]!;
      const path = parts[++idx];
      if (path === undefined) continue;
      if (status.startsWith("R") || status.startsWith("C")) idx += 1;
      const ownChange = ownRaw.get(path);
      if (ownChange !== undefined && match[4] === ownChange.oldOid) return true;
    }
  }
  return false;
}

/**
 * Precondition: input.containingCommit contains input.branchCommit along its first-parent line and already reached the target branch.
 * Postcondition: returns true only when containingCommit retains or refines every file change that branchCommit introduced relative to ownMergeBase, with no reverted hunk, restored deletion, deleted addition, intermediate revert to base, main-merge dropped conflict, or diverged binary blob; never writes git objects or runs repository drivers.
 */
export async function verifyRelayCarriesChanges(input: RelayCarryInput): Promise<boolean> {
  const { repoFolder, timeoutMs, ownMergeBase, branchCommit, containingMergeBase, containingCommit } = input;
  const ownRaw = await rawDiffTree(repoFolder, timeoutMs, ownMergeBase, branchCommit);
  if (ownRaw.size === 0) return false;

  const containingFromOwnRaw = await rawDiffTree(repoFolder, timeoutMs, ownMergeBase, containingCommit);
  const containingNetRaw =
    containingMergeBase === ownMergeBase
      ? containingFromOwnRaw
      : await rawDiffTree(repoFolder, timeoutMs, containingMergeBase, containingCommit);

  const divergedPaths: string[] = [];
  for (const [path, ownChange] of ownRaw) {
    const contOwn = containingFromOwnRaw.get(path);
    const contNet = containingNetRaw.get(path);
    if (contOwn === undefined || contNet === undefined) return false;

    if (ownChange.status === "D") {
      if (contOwn.status !== "D" || contNet.status !== "D") return false;
      continue;
    }

    // Fast path: identical blob and mode require no unified diff or history scan.
    if (contOwn.newOid === ownChange.newOid && contOwn.newMode === ownChange.newMode) continue;

    if (ownChange.status === "A" && contOwn.status !== "A") return false;
    if (ownChange.status === "M" && contOwn.status !== "M") return false;
    if (ownChange.status === "T") return false;

    // Pure mode-only change requires the mode to survive intact.
    if (ownChange.oldOid === ownChange.newOid && ownChange.oldMode !== ownChange.newMode) {
      if (contOwn.newMode !== ownChange.newMode) return false;
      continue;
    }

    divergedPaths.push(path);
  }

  if (divergedPaths.length === 0) return true;
  if (await hasIntermediateRevertToBase(input, ownRaw, divergedPaths)) return false;

  const [ownDiff, contDiff, mainDiff] = await Promise.all([
    unifiedZeroDiff(repoFolder, timeoutMs, ownMergeBase, branchCommit, divergedPaths),
    unifiedZeroDiff(repoFolder, timeoutMs, ownMergeBase, containingCommit, divergedPaths),
    containingMergeBase === ownMergeBase
      ? Promise.resolve(undefined)
      : unifiedZeroDiff(repoFolder, timeoutMs, ownMergeBase, containingMergeBase, divergedPaths),
  ]);

  for (const path of divergedPaths) {
    const ownFile = ownDiff.get(path);
    const contFile = contDiff.get(path);
    if (ownFile === undefined || contFile === undefined) return false;
    if (!hunksCoverOwnDiff(ownFile, contFile, mainDiff?.get(path))) return false;
  }
  return true;
}
