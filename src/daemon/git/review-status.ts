// Invariant: a GitHub token lives only in memory for one post and reaches gh only through its token environment variable; no outcome, log line, or error carries it.
import { truncateChars } from "../../shared/domain.ts";
import type { WorkerPr } from "../../shared/hub.ts";
import { MAX_REVIEW_STAMP_REASON_CHARS, REVIEW_STAMP_TIMEOUT_MS } from "../../shared/limits.ts";
import { REVIEW_STATUS_CONTEXT, reviewStatusDescription, type ReviewStampOutcome, type ReviewStampRequest } from "../../shared/review.ts";
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

type GhFailure = Extract<GhRunResult, { kind: "failed" }>;

/** Thrown for failures worth retrying (timeout, network, GitHub 5xx); the message is already redacted. */
export class ReviewStatusRetryableError extends Error {}

const PR_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+(?:[/?#]\S*)?$/iu;

/** Returns the repository of a GitHub or GitHub Enterprise pull request URL, or null for any other URL. */
export function parseGithubPrUrl(url: string): GithubRepoRef | null {
  const m = PR_URL.exec(url.trim());
  if (m === null) return null;
  const [, host, owner, repo] = m;
  if (owner === "-" || repo === "-") return null;
  return { host: host!.toLowerCase(), owner: owner!, repo: repo! };
}

const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/gu;

/** Replaces anything shaped like a GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) with a placeholder. */
export function redactGithubTokens(text: string): string {
  return text.replace(TOKEN_SHAPE, "[redacted]");
}

/**
 * Maps a failed gh run to a skip reason in Chinese for the ledger, or to `"retry"` for timeouts, network errors, 5xx, and anything unrecognized.
 * Covers: gh missing, not logged in, account not logged in, no GitHub remote, no git repository, 403/404 permission, 422 unknown commit.
 */
export function describeStatusFailure(failure: GhFailure, context: { account: string | null }): string | "retry" {
  if (failure.missing) return "本机没装 gh";
  if (failure.timedOut) return "retry";
  const err = failure.stderr;
  if (/not a git repository/iu.test(err)) return "项目主文件夹不是 git 仓库";
  if (/no git remotes found|none of the git remotes configured/iu.test(err)) return "项目的 git 远端都不在 GitHub 上";
  if (/no oauth token found/iu.test(err)) return context.account === null ? "gh 没登录 GitHub" : `gh 里没有登录账号 ${context.account}`;
  if (/HTTP 401|gh auth login|not logged in/iu.test(err)) return context.account === null ? "gh 没登录 GitHub" : `账号 ${context.account} 的 gh 登录已失效`;
  if (/HTTP 40[34]/u.test(err)) return context.account === null ? "gh 当前登录的账号没有在这个仓库写提交状态的权限" : `账号 ${context.account} 没有在这个仓库写提交状态的权限`;
  if (/HTTP 422/u.test(err)) return "被审的提交还没推到 GitHub";
  return "retry";
}

function retryMessage(failure: GhFailure): string {
  if (failure.timedOut) return "gh 超时";
  const firstLine = failure.stderr.trim().split(/\r?\n/u)[0] ?? "";
  return truncateChars(redactGithubTokens(firstLine === "" ? `gh 退出码 ${String(failure.code)}` : firstLine), MAX_REVIEW_STAMP_REASON_CHARS);
}

function skipped(request: ReviewStampRequest, reason: string, now: number): ReviewStampOutcome {
  return { kind: "skipped", sha: request.sha, reason: truncateChars(redactGithubTokens(reason), MAX_REVIEW_STAMP_REASON_CHARS), at: now };
}

type TokenEnv = { kind: "env"; env: Record<string, string> } | { kind: "skip"; reason: string };

async function tokenEnvFor(input: PostReviewStatusInput, repo: GithubRepoRef | null, deps: PostReviewStatusDeps): Promise<TokenEnv> {
  if (input.account === null) return { kind: "env", env: {} };
  const host = repo?.host ?? "github.com";
  const args = ["auth", "token", "--user", input.account, ...(repo === null ? [] : ["--hostname", host])];
  const result = await deps.execGh(input.cwd, args, { timeoutMs: REVIEW_STAMP_TIMEOUT_MS });
  if (result.kind === "failed") {
    if (result.missing) return { kind: "skip", reason: "本机没装 gh" };
    if (result.timedOut) throw new ReviewStatusRetryableError("gh auth token 超时");
    return { kind: "skip", reason: `gh 里没有登录账号 ${input.account}` };
  }
  const token = result.stdout.trim();
  if (token === "") return { kind: "skip", reason: `gh 里没有登录账号 ${input.account}` };
  // gh reads GH_ENTERPRISE_TOKEN, not GH_TOKEN, for hosts other than github.com.
  return { kind: "env", env: { [host === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"]: token } };
}

/**
 * Posts `request.state` under `REVIEW_STATUS_CONTEXT` on `request.sha`.
 * The repository comes from `pr.url` when it is a GitHub PR; a non-GitHub PR URL skips; without a PR, gh resolves `{owner}/{repo}` in `cwd`.
 * With `account`, the token comes from `gh auth token --user <account>` (on the PR's host) and reaches the post only as GH_TOKEN
 * (GH_ENTERPRISE_TOKEN on other hosts).
 * Postcondition: resolves `posted` or `skipped` with a redacted reason of at most `MAX_REVIEW_STAMP_REASON_CHARS`;
 * throws `ReviewStatusRetryableError` only for retryable failures. Never writes to git or to the working tree.
 */
export async function postReviewStatus(input: PostReviewStatusInput, deps: PostReviewStatusDeps): Promise<ReviewStampOutcome> {
  const { request, pr } = input;
  const repo = pr === null ? null : parseGithubPrUrl(pr.url);
  if (pr !== null && repo === null) return skipped(request, `PR ${pr.url} 不在 GitHub 上`, deps.now());
  const auth = await tokenEnvFor(input, repo, deps);
  if (auth.kind === "skip") return skipped(request, auth.reason, deps.now());
  const path = repo === null ? "repos/{owner}/{repo}" : `repos/${repo.owner}/${repo.repo}`;
  const args = [
    "api",
    "--method",
    "POST",
    ...(repo === null ? [] : ["--hostname", repo.host]),
    `${path}/statuses/${request.sha}`,
    "--silent",
    "-f",
    `state=${request.state}`,
    "-f",
    `context=${REVIEW_STATUS_CONTEXT}`,
    "-f",
    `description=${reviewStatusDescription(request.verdict)}`,
    ...(pr === null ? [] : ["-f", `target_url=${pr.url}`]),
  ];
  const result = await deps.execGh(input.cwd, args, { timeoutMs: REVIEW_STAMP_TIMEOUT_MS, env: auth.env });
  if (result.kind === "ok") return { kind: "posted", sha: request.sha, state: request.state, account: input.account, at: deps.now() };
  const reason = describeStatusFailure(result, { account: input.account });
  if (reason === "retry") throw new ReviewStatusRetryableError(retryMessage(result));
  return skipped(request, reason, deps.now());
}
