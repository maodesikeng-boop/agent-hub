// This repository's merge gate for review stamps, run by .github/workflows/review-stamp.yml under pull_request_target.
// Invariant: it reads the path list from the base commit and the PR only through the GitHub API; it never checks out or runs PR code.
// Branch protection requires REVIEW_STATUS_CONTEXT. This gate posts success for PRs that touch no listed path, and pending otherwise,
// until the Bellwood daemon posts success after an independent review PASS on the PR's head commit.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REVIEW_STATUS_CONTEXT } from "../src/shared/review.ts";

export { REVIEW_STATUS_CONTEXT };

/** The REVIEW.md heading whose bullet list names the paths that need a review stamp. */
export const STAMP_PATHS_HEADING = "## Paths that require a review stamp";

/** GitHub's list-files endpoint returns at most this many files; a PR at the cap counts as touching a listed path. */
export const PR_FILES_API_MAX = 3000;

export type CommitStatusState = "error" | "failure" | "pending" | "success";

export interface CommitStatus {
  state: CommitStatusState;
  description: string | null;
  /** Login of the status creator; `github-actions[bot]` for statuses this gate posted. */
  creator: string | null;
}

export type GateDecision =
  | { kind: "post"; state: "success" | "pending"; description: string }
  | { kind: "keep"; reason: string };

/**
 * Precondition: reviewMd is the REVIEW.md text from the PR's base commit.
 * Postcondition: returns every backticked glob on `- ` lines under STAMP_PATHS_HEADING, up to the next `## ` heading, in order.
 * Throws when the heading is missing or lists no glob, so a broken list fails the gate instead of waving every PR through.
 */
export function parseStampPaths(reviewMd: string): string[] {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns the changed files that match at least one glob, with REVIEW.md semantics
 * (`*` inside one segment, `**` across directories), in input order.
 */
export function matchStampPaths(files: readonly string[], globs: readonly string[]): string[] {
  throw new Error("Not implemented");
}

/**
 * Decides what the gate posts on the PR head commit, given the latest REVIEW_STATUS_CONTEXT status there.
 * - A status posted by anyone other than this gate is a review verdict: keep it, whatever the paths.
 * - No listed path and the file list is complete: post success ("no high-risk paths").
 * - A listed path, or a truncated file list: post pending naming the first matched path.
 * Postcondition: descriptions are at most 140 characters.
 */
export function decideGateStatus(input: { matched: readonly string[]; filesTruncated: boolean; current: CommitStatus | null }): GateDecision {
  throw new Error("Not implemented");
}

/**
 * Reads GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, and GH_TOKEN from env and REVIEW.md from the working tree (the base checkout).
 * With `--dry-run`, prints the decision and posts nothing, so a read-only token can rehearse it against real PRs.
 * Returns the process exit code: 0 after posting or keeping, 1 on a configuration or API error.
 */
export function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  throw new Error("Not implemented");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
