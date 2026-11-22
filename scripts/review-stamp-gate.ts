// This repository's merge gate for review stamps, run by .github/workflows/review-stamp.yml under pull_request_target.
// Invariant: it reads the path list from the base commit and the PR only through the GitHub API; it never checks out or runs PR code.
// Branch protection requires REVIEW_STATUS_CONTEXT. This gate posts success for PRs that touch no listed path, and pending otherwise,
// until the Bellwood daemon posts success after an independent review PASS on the PR's head commit.
import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
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

/** The login GitHub reports for statuses posted with the Actions token, i.e. by this gate. */
export const GATE_STATUS_CREATOR = "github-actions[bot]";

const GITHUB_DESCRIPTION_MAX = 140;
const PER_PAGE = 100;

const clip = (text: string): string => (text.length <= GITHUB_DESCRIPTION_MAX ? text : `${text.slice(0, GITHUB_DESCRIPTION_MAX - 1)}…`);

/**
 * Precondition: reviewMd is the REVIEW.md text from the PR's base commit.
 * Postcondition: returns every backticked glob on `- ` lines under STAMP_PATHS_HEADING, up to the next `## ` heading, in order.
 * Throws when the heading is missing or lists no glob, so a broken list fails the gate instead of waving every PR through.
 */
export function parseStampPaths(reviewMd: string): string[] {
  const lines = reviewMd.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === STAMP_PATHS_HEADING);
  if (start === -1) throw new Error(`REVIEW.md has no "${STAMP_PATHS_HEADING}" section`);
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.trimStart().startsWith("- ")) continue;
    for (const m of line.matchAll(/`([^`]+)`/gu)) globs.push(m[1]!);
  }
  if (globs.length === 0) throw new Error(`REVIEW.md "${STAMP_PATHS_HEADING}" lists no path`);
  return globs;
}

/**
 * Postcondition: returns the changed files that match at least one glob, with REVIEW.md semantics
 * (`*` inside one segment, `**` across directories), in input order.
 */
export function matchStampPaths(files: readonly string[], globs: readonly string[]): string[] {
  return files.filter((file) => globs.some((glob) => matchesGlob(file, glob)));
}

/**
 * Decides what the gate posts on the PR head commit, given the latest REVIEW_STATUS_CONTEXT status there.
 * - A status posted by anyone other than this gate is a review verdict: keep it, whatever the paths.
 * - No listed path and the file list is complete: post success ("no high-risk paths").
 * - A listed path, or a truncated file list: post pending naming the first matched path.
 * Postcondition: descriptions are at most 140 characters.
 */
export function decideGateStatus(input: { matched: readonly string[]; filesTruncated: boolean; current: CommitStatus | null }): GateDecision {
  const { matched, filesTruncated, current } = input;
  if (current !== null && current.creator !== GATE_STATUS_CREATOR) {
    return { kind: "keep", reason: `${current.state} from ${current.creator ?? "an unknown account"}: ${current.description ?? ""}`.trim() };
  }
  if (matched.length === 0 && !filesTruncated) {
    return { kind: "post", state: "success", description: "No high-risk paths changed; review stamp not required" };
  }
  const why = matched[0] ?? `more than ${PR_FILES_API_MAX} files changed`;
  return { kind: "post", state: "pending", description: clip(`Needs an independent review PASS on this commit: ${why}`) };
}

export interface GateDeps {
  fetch: typeof fetch;
  readReviewMd: () => string;
  log: (line: string) => void;
}

interface GateEnv {
  repo: string;
  pr: number;
  sha: string;
  token: string;
  api: string;
  runUrl: string | null;
}

function gateEnvOf(env: Readonly<Record<string, string | undefined>>): GateEnv | string {
  const missing = ["GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_SHA", "GH_TOKEN"].filter((k) => !env[k]);
  if (missing.length > 0) return `missing ${missing.join(", ")}`;
  const pr = Number(env.PR_NUMBER);
  if (!Number.isInteger(pr) || pr <= 0) return `PR_NUMBER is not a PR number: ${env.PR_NUMBER}`;
  if (!/^[0-9a-f]{40}$/u.test(env.HEAD_SHA!)) return `HEAD_SHA is not a full commit SHA: ${env.HEAD_SHA}`;
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  return { repo: env.GITHUB_REPOSITORY!, pr, sha: env.HEAD_SHA!, token: env.GH_TOKEN!, api: env.GITHUB_API_URL || "https://api.github.com", runUrl };
}

async function github<T>(g: GateEnv, deps: GateDeps, path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const response = await deps.fetch(`${g.api}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${g.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`GitHub API ${init?.method ?? "GET"} ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

async function listChangedFiles(g: GateEnv, deps: GateDeps): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let seen = 0;
  for (let page = 1; seen < PR_FILES_API_MAX; page++) {
    const batch = await github<Array<{ filename: string; previous_filename?: string }>>(g, deps, `/repos/${g.repo}/pulls/${g.pr}/files?per_page=${PER_PAGE}&page=${page}`);
    seen += batch.length;
    for (const f of batch) files.push(f.filename, ...(f.previous_filename === undefined ? [] : [f.previous_filename]));
    if (batch.length < PER_PAGE) return { files, truncated: false };
  }
  return { files, truncated: true };
}

async function currentStatus(g: GateEnv, deps: GateDeps): Promise<CommitStatus | null> {
  const statuses = await github<Array<{ context: string; state: CommitStatusState; description: string | null; creator: { login: string } | null }>>(
    g,
    deps,
    `/repos/${g.repo}/commits/${g.sha}/statuses?per_page=${PER_PAGE}`,
  );
  const latest = statuses.find((s) => s.context === REVIEW_STATUS_CONTEXT);
  return latest === undefined ? null : { state: latest.state, description: latest.description, creator: latest.creator?.login ?? null };
}

const defaultDeps: GateDeps = {
  fetch: (...args) => fetch(...args),
  readReviewMd: () => readFileSync("REVIEW.md", "utf8"),
  log: (line) => console.log(line),
};

/**
 * Reads GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, and GH_TOKEN from env and REVIEW.md from the working tree (the base checkout).
 * With `--dry-run`, prints the decision and posts nothing, so a read-only token can rehearse it against real PRs.
 * Returns the process exit code: 0 after posting or keeping, 1 on a configuration or API error.
 */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: GateDeps = defaultDeps): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const g = gateEnvOf(env);
  if (typeof g === "string") {
    deps.log(`review-stamp gate: ${g}`);
    return 1;
  }
  try {
    const globs = parseStampPaths(deps.readReviewMd());
    const { files, truncated } = await listChangedFiles(g, deps);
    const matched = matchStampPaths(files, globs);
    const decision = decideGateStatus({ matched, filesTruncated: truncated, current: await currentStatus(g, deps) });
    deps.log(JSON.stringify({ pr: g.pr, sha: g.sha, matched: matched.slice(0, 10), filesTruncated: truncated, decision, dryRun }));
    if (decision.kind === "keep" || dryRun) return 0;
    await github(g, deps, `/repos/${g.repo}/statuses/${g.sha}`, {
      method: "POST",
      body: { state: decision.state, context: REVIEW_STATUS_CONTEXT, description: decision.description, ...(g.runUrl === null ? {} : { target_url: g.runUrl }) },
    });
    return 0;
  } catch (error) {
    deps.log(`review-stamp gate: ${(error as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
