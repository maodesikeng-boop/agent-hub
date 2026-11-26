import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PR_BODY_TAG_PREFIX = "pr-body/";

/** GitHub rejects a pull request body longer than this. */
export const PR_BODY_MAX_CHARS = 65_536;

export interface PrBodyTarget {
  number: number;
  state: "open" | "closed";
  /** `owner/repo` of the head branch, or null when the head repository was deleted. */
  headRepo: string | null;
  body: string | null;
}

export type PrBodySyncDecision =
  | { kind: "update"; pr: number; body: string }
  | { kind: "skip"; reason: string }
  | { kind: "reject"; reason: string };

/**
 * Accepts `refs/tags/pr-body/<N>` or `pr-body/<N>`.
 * Postcondition: returns N when it is a positive integer without leading zeros, otherwise null.
 */
export function parsePrBodyTag(ref: string): number | null {
  const tag = ref.replace(/^refs\/tags\//u, "");
  if (!tag.startsWith(PR_BODY_TAG_PREFIX)) return null;
  const number = tag.slice(PR_BODY_TAG_PREFIX.length);
  return /^[1-9][0-9]*$/u.test(number) && Number.isSafeInteger(Number(number)) ? Number(number) : null;
}

/**
 * Decides what the workflow does for one tag push. `repo` is `owner/repo` of the repository running the workflow, and
 * `tagMessage` is null for a lightweight tag.
 * - Invalid tag name, lightweight tag, blank message, message over PR_BODY_MAX_CHARS, PR not found, or a head in another repository: `reject`.
 * - Closed or merged PR, or a body identical to the current one: `skip`.
 * - Otherwise `update` with the message exactly as written, minus one trailing newline.
 */
export function decidePrBodySync(input: { tagRef: string; tagMessage: string | null; repo: string; pr: PrBodyTarget | null }): PrBodySyncDecision {
  const { tagRef, tagMessage, repo, pr } = input;
  const number = parsePrBodyTag(tagRef);
  if (number === null) return { kind: "reject", reason: "Invalid PR body tag name" };
  if (tagMessage === null) return { kind: "reject", reason: "Use an annotated tag with the PR description as its message" };
  const body = tagMessage.replace(/\r?\n$/u, "");
  if (body.trim() === "") return { kind: "reject", reason: "PR description is blank" };
  if (body.length > PR_BODY_MAX_CHARS) return { kind: "reject", reason: `PR description exceeds ${PR_BODY_MAX_CHARS} characters` };
  if (pr === null || pr.number !== number) return { kind: "reject", reason: `PR #${number} was not found` };
  if (pr.state === "closed") return { kind: "skip", reason: `PR #${number} is closed` };
  if (pr.headRepo?.toLowerCase() !== repo.toLowerCase()) return { kind: "reject", reason: `PR #${number} has a head outside this repository` };
  if (pr.body === body) return { kind: "skip", reason: `PR #${number} already has this description` };
  return { kind: "update", pr: number, body };
}

export interface PrBodySyncDeps {
  fetch: typeof fetch;
  deleteTag: (ref: string, sha: string) => void;
  log: (line: string) => void;
}

interface GitHubRepo {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

interface TagObject {
  sha: string;
  type: "tag" | "commit";
}

async function request(repo: GitHubRepo, path: string, body?: { body: string }): Promise<Response> {
  const method = body === undefined ? "GET" : "PATCH";
  const response = await repo.fetch(`${repo.baseUrl}/${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${repo.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && !(method === "GET" && response.status === 404)) throw new Error(`GitHub API ${method} ${path} answered ${response.status}`);
  return response;
}

async function readTagRef(repo: GitHubRepo, pr: number): Promise<TagObject | null> {
  const response = await request(repo, `git/ref/tags/${PR_BODY_TAG_PREFIX}${pr}`);
  if (response.status === 404) return null;
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("object" in data) || !data.object || typeof data.object !== "object") {
    throw new Error("Invalid GitHub tag ref");
  }
  const { object } = data;
  if (!("sha" in object) || typeof object.sha !== "string" || !/^[0-9a-f]{40}$/u.test(object.sha) ||
    !("type" in object) || (object.type !== "tag" && object.type !== "commit")) throw new Error("Invalid GitHub tag object");
  return { sha: object.sha, type: object.type };
}

async function readTagMessage(repo: GitHubRepo, tag: TagObject): Promise<string | null> {
  if (tag.type !== "tag") return null;
  const response = await request(repo, `git/tags/${tag.sha}`);
  if (response.status === 404) throw new Error("Annotated tag object was not found");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("message" in data) || typeof data.message !== "string") throw new Error("Invalid annotated tag message");
  return data.message;
}

async function readPr(repo: GitHubRepo, number: number): Promise<PrBodyTarget | null> {
  const response = await request(repo, `pulls/${number}`);
  if (response.status === 404) return null;
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("number" in data) || data.number !== number ||
    !("state" in data) || (data.state !== "open" && data.state !== "closed") ||
    !("body" in data) || (data.body !== null && typeof data.body !== "string") ||
    !("head" in data) || !data.head || typeof data.head !== "object" || !("repo" in data.head)) throw new Error("Invalid GitHub pull request");
  const head = data.head.repo;
  const headRepo = head && typeof head === "object" && "full_name" in head && typeof head.full_name === "string" ? head.full_name : null;
  return { number, state: data.state, body: data.body, headRepo };
}

function deleteTag(ref: string, sha: string): void {
  execFileSync("git", ["push", `--force-with-lease=${ref}:${sha}`, "origin", `:${ref}`], {
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Updates the description from the current tag and deletes that tag only if its object still matches. */
export async function main(env: Readonly<Record<string, string | undefined>>, deps: PrBodySyncDeps): Promise<number> {
  const { GITHUB_REPOSITORY: repo, GITHUB_REF: tagRef, GH_TOKEN: token } = env;
  const number = tagRef === undefined ? null : parsePrBodyTag(tagRef);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/u.test(repo) || !tagRef || number === null || !token) {
    deps.log("PR body sync: expected GITHUB_REPOSITORY, an annotated pr-body/<PR> tag, and GH_TOKEN");
    return 1;
  }
  const github = { baseUrl: `${env.GITHUB_API_URL || "https://api.github.com"}/repos/${repo}`, token, fetch: deps.fetch };
  try {
    const tag = await readTagRef(github, number);
    if (tag === null) {
      deps.log(`PR #${number}: tag is already gone`);
      return 0;
    }
    const [tagMessage, pr] = await Promise.all([readTagMessage(github, tag), readPr(github, number)]);
    const decision = decidePrBodySync({ tagRef, tagMessage, repo, pr });
    if ((await readTagRef(github, number))?.sha !== tag.sha) {
      deps.log(`PR #${number}: tag moved while reading the description`);
      return 0;
    }

    if (decision.kind === "update") {
      const response = await request(github, `pulls/${decision.pr}`, { body: decision.body });
      await response.body?.cancel();
      deps.log(`PR #${number}: updated the description`);
    } else {
      deps.log(decision.reason);
    }

    try {
      deps.deleteTag(`refs/tags/${PR_BODY_TAG_PREFIX}${number}`, tag.sha);
    } catch {
      if ((await readTagRef(github, number))?.sha === tag.sha) throw new Error(`Could not delete tag ${PR_BODY_TAG_PREFIX}${number}`);
    }
    return decision.kind === "reject" ? 1 : 0;
  } catch (error) {
    deps.log(`PR body sync: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.env, { fetch: (...args) => fetch(...args), deleteTag, log: (line) => console.log(line) });
}
