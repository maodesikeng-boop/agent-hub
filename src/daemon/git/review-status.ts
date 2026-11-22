// Invariant: a GitHub token lives only in memory for one post and reaches gh only as GH_TOKEN; no outcome, log line, or error carries it.
import type { WorkerPr } from "../../shared/hub.ts";
import type { ReviewStampOutcome, ReviewStampRequest } from "../../shared/review.ts";
import type { GhRunOptions, GhRunResult } from "./gh.ts";

export interface GithubRepoRef {
  host: string;
  owner: string;
  repo: string;
}

export interface PostReviewStatusInput {
  /** Working directory for gh; it resolves the repository from git remotes when `pr` is null. */
  cwd: string;
  request: ReviewStampRequest;
  pr: WorkerPr | null;
  account: string | null;
}

export interface PostReviewStatusDeps {
  execGh: (cwd: string, args: readonly string[], options: GhRunOptions) => Promise<GhRunResult>;
  now: () => number;
}

/** Thrown for failures worth retrying (timeout, network, GitHub 5xx); the message is already redacted. */
export class ReviewStatusRetryableError extends Error {}

/** Returns the repository of a GitHub or GitHub Enterprise pull request URL, or null for any other URL. */
export function parseGithubPrUrl(url: string): GithubRepoRef | null {
  throw new Error("Not implemented");
}

/** Replaces anything shaped like a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) with a placeholder. */
export function redactGithubTokens(text: string): string {
  throw new Error("Not implemented");
}

/**
 * Maps a failed gh run to a skip reason in Chinese for the ledger, or to `"retry"` for timeouts, network errors, and 5xx.
 * Covers: gh missing, not logged in, account not logged in, no GitHub remote, no git repository, 403/404 permission, 422 unknown commit.
 */
export function describeStatusFailure(failure: Extract<GhRunResult, { kind: "failed" }>, context: { account: string | null }): string | "retry" {
  throw new Error("Not implemented");
}

/**
 * Posts `request.state` under `REVIEW_STATUS_CONTEXT` on `request.sha`.
 * The repository comes from `pr.url` when it is a GitHub PR; a non-GitHub PR URL skips; without a PR, gh resolves `{owner}/{repo}` in `cwd`.
 * With `account`, the token comes from `gh auth token --user <account>` (on the PR's host) and reaches the post only as GH_TOKEN.
 * Postcondition: resolves `posted` or `skipped` with a redacted reason of at most `MAX_REVIEW_STAMP_REASON_CHARS`;
 * throws `ReviewStatusRetryableError` only for retryable failures. Never writes to git or to the working tree.
 */
export function postReviewStatus(input: PostReviewStatusInput, deps: PostReviewStatusDeps): Promise<ReviewStampOutcome> {
  throw new Error("Not implemented");
}
