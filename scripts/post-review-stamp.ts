import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execGh, type GhRunOptions, type GhRunResult } from "../src/daemon/git/gh.ts";
import { isTransientGhError } from "./gh-transient.ts";
import { REVIEW_STATUS_CONTEXT } from "./review-stamp-gate.ts";

const GITHUB_DESCRIPTION_MAX = 140;
const GH_TIMEOUT_MS = 15_000;
export const DEFAULT_CLEAN_WAIT_SECONDS = 30;
export const DEFAULT_CLEAN_POLL_INTERVAL_MS = 2_000;
export const MAX_TRANSIENT_CLEAN_POLL_ERRORS = 5;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const PR_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+(?:[/?#]\S*)?$/iu;
const TOKEN_PREFIX = /^(?:gh[pousr]_|github_pat_)/u;
const TOKEN_ANYWHERE = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/gu;

export type StampState = "success" | "failure";

export interface PostStampArgs {
  pr: number;
  sha: string;
  state: StampState;
  account: string | null;
  description: string;
  dryRun: boolean;
  noWait?: boolean;
  waitTimeoutSeconds?: number;
}

export interface PostStampDeps {
  execGh: (cwd: string, args: readonly string[], options: GhRunOptions) => Promise<GhRunResult>;
  cwd: string;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export type CleanWaitResult =
  | { ok: true; mergeStateStatus: string; state: string; waitedMs: number }
  | {
      ok: false;
      reason: "moved_head" | "closed" | "dirty" | "behind" | "unstable" | "timeout" | "query_error";
      mergeStateStatus?: string;
      message: string;
      waitedMs: number;
    };

/**
 * Polls `gh pr view` after posting a `bellwood/review` success stamp until GitHub reports mergeStateStatus CLEAN.
 * Postcondition: returns ok:true on CLEAN, HAS_HOOKS, DRAFT, or MERGED; fails fast on moved head, CLOSED, DIRTY,
 * BEHIND, or UNSTABLE; retries transient gh errors up to MAX_TRANSIENT_CLEAN_POLL_ERRORS; returns timeout once timeoutMs elapses.
 */
export async function waitForPrCleanState(
  input: {
    pr: number;
    sha: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
    pollIntervalMs: number;
  },
  deps: PostStampDeps,
): Promise<CleanWaitResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const startedAt = now();
  const waited = () => Math.max(0, now() - startedAt);
  const expectedSha = input.sha.toLowerCase();
  let transientErrors = 0;

  while (true) {
    const res = await deps.execGh(
      deps.cwd,
      ["pr", "view", String(input.pr), "--json", "headRefOid,state,isDraft,mergeStateStatus"],
      { timeoutMs: GH_TIMEOUT_MS, env: input.env },
    );

    if (res.kind === "failed") {
      const transient = !res.missing && isTransientGhError(res.stderr, res.timedOut);
      transientErrors += 1;
      if (!transient || transientErrors >= MAX_TRANSIENT_CLEAN_POLL_ERRORS) {
        return {
          ok: false,
          reason: "query_error",
          message: `failed to poll PR #${input.pr} mergeStateStatus: ${failText(res)}`,
          waitedMs: waited(),
        };
      }
      const remaining = input.timeoutMs - waited();
      if (remaining <= 0) {
        return {
          ok: false,
          reason: "timeout",
          message: `timed out after ${Math.round(input.timeoutMs / 1000)}s waiting for PR #${input.pr} mergeStateStatus CLEAN`,
          waitedMs: waited(),
        };
      }
      await sleep(Math.min(input.pollIntervalMs, remaining));
      continue;
    }

    transientErrors = 0;
    let data: { headRefOid?: string; state?: string; isDraft?: boolean; mergeStateStatus?: string };
    try {
      data = JSON.parse(res.stdout) as { headRefOid?: string; state?: string; isDraft?: boolean; mergeStateStatus?: string };
    } catch {
      return {
        ok: false,
        reason: "query_error",
        message: "invalid JSON from gh pr view while waiting for CLEAN",
        waitedMs: waited(),
      };
    }

    const headSha = data.headRefOid?.toLowerCase() ?? "";
    if (headSha !== "" && headSha !== expectedSha) {
      return {
        ok: false,
        reason: "moved_head",
        ...(data.mergeStateStatus !== undefined ? { mergeStateStatus: data.mergeStateStatus } : {}),
        message: `PR #${input.pr} head moved to ${headSha} (expected ${expectedSha})`,
        waitedMs: waited(),
      };
    }

    const state = (data.state ?? "").toUpperCase();
    const mergeState = (data.mergeStateStatus ?? "UNKNOWN").toUpperCase();
    if (state === "MERGED") return { ok: true, mergeStateStatus: mergeState, state, waitedMs: waited() };
    if (state === "CLOSED") {
      return { ok: false, reason: "closed", mergeStateStatus: mergeState, message: `PR #${input.pr} is CLOSED`, waitedMs: waited() };
    }
    if (data.isDraft === true || mergeState === "DRAFT") {
      return { ok: true, mergeStateStatus: mergeState, state: state || "OPEN", waitedMs: waited() };
    }
    if (mergeState === "CLEAN" || mergeState === "HAS_HOOKS") {
      return { ok: true, mergeStateStatus: mergeState, state: state || "OPEN", waitedMs: waited() };
    }
    if (mergeState === "DIRTY") {
      return { ok: false, reason: "dirty", mergeStateStatus: mergeState, message: `PR #${input.pr} has merge conflicts (mergeStateStatus=DIRTY)`, waitedMs: waited() };
    }
    if (mergeState === "BEHIND") {
      return { ok: false, reason: "behind", mergeStateStatus: mergeState, message: `PR #${input.pr} is behind base branch (mergeStateStatus=BEHIND)`, waitedMs: waited() };
    }
    if (mergeState === "UNSTABLE") {
      return { ok: false, reason: "unstable", mergeStateStatus: mergeState, message: `PR #${input.pr} is unstable (mergeStateStatus=UNSTABLE)`, waitedMs: waited() };
    }

    const remaining = input.timeoutMs - waited();
    if (remaining <= 0) {
      return {
        ok: false,
        reason: "timeout",
        mergeStateStatus: mergeState,
        message: `timed out after ${Math.round(input.timeoutMs / 1000)}s waiting for PR #${input.pr} mergeStateStatus CLEAN (last: ${mergeState})`,
        waitedMs: waited(),
      };
    }
    await sleep(Math.min(input.pollIntervalMs, remaining));
  }
}

const clip = (text: string): string =>
  text.length <= GITHUB_DESCRIPTION_MAX ? text : `${text.slice(0, GITHUB_DESCRIPTION_MAX - 1)}…`;

const redactTokens = (text: string): string => text.replace(TOKEN_ANYWHERE, "[redacted]");

const defaultDescription = (state: StampState): string =>
  `Independent Bellwood review: ${state === "success" ? "PASS" : "FAIL"} on this commit`;

export function parsePostStampArgs(argv: readonly string[]): PostStampArgs | string {
  let prRaw: string | null = null;
  let sha: string | null = null;
  let state: StampState = "success";
  let account: string | null = null;
  let description: string | null = null;
  let dryRun = false;
  let noWait = false;
  let waitTimeoutSeconds: number | undefined;

  const parseTimeout = (raw: string | undefined): number | string => {
    if (!raw) return "--wait-timeout requires a positive integer number of seconds";
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) return `--wait-timeout must be a positive integer, got ${raw}`;
    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--no-wait") {
      noWait = true;
    } else if (arg === "--wait-timeout") {
      const t = parseTimeout(argv[++i]?.trim());
      if (typeof t === "string") return t;
      waitTimeoutSeconds = t;
    } else if (arg.startsWith("--wait-timeout=")) {
      const t = parseTimeout(arg.slice("--wait-timeout=".length).trim());
      if (typeof t === "string") return t;
      waitTimeoutSeconds = t;
    } else if (arg === "--sha" || arg === "--state" || arg === "--account" || arg === "--description") {
      const value = argv[++i]?.trim();
      if (!value) return `${arg} requires a value`;
      if (arg === "--sha") sha = value.toLowerCase();
      else if (arg === "--state") {
        if (value !== "success" && value !== "failure") return `--state must be success or failure, got ${value}`;
        state = value;
      } else if (arg === "--account") {
        if (TOKEN_PREFIX.test(value)) return "--account expects a GitHub login, not a token";
        account = value;
      } else {
        description = value;
      }
    } else if (arg.startsWith("-")) {
      return `unknown flag: ${arg}`;
    } else if (prRaw === null) {
      prRaw = arg.replace(/^#/u, "");
    } else {
      return `unexpected argument: ${arg}`;
    }
  }

  if (prRaw === null || !/^[1-9][0-9]*$/u.test(prRaw)) {
    return "usage: node scripts/post-review-stamp.ts <PR> --sha <40-char-sha> [--state success|failure] [--account <login>] [--description <text>] [--dry-run] [--no-wait] [--wait-timeout <seconds>]";
  }
  if (sha === null || !FULL_SHA.test(sha)) return "--sha must be a full 40-character commit SHA";
  return {
    pr: Number(prRaw),
    sha,
    state,
    account,
    description: clip(description ?? defaultDescription(state)),
    dryRun,
    ...(noWait ? { noWait: true } : {}),
    ...(waitTimeoutSeconds !== undefined ? { waitTimeoutSeconds } : {}),
  };
}

function parseRepoFromPrUrl(url: string): { host: string; owner: string; repo: string } | null {
  const m = PR_URL.exec(url.trim());
  if (m === null) return null;
  return { host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]! };
}

function failText(result: Extract<GhRunResult, { kind: "failed" }>): string {
  if (result.missing) return "gh is not installed";
  if (result.timedOut) return "gh timed out";
  const line = result.stderr.trim().split(/\r?\n/u)[0] ?? "";
  return redactTokens(line === "" ? `gh exited with ${String(result.code)}` : line);
}

async function tokenEnvFor(
  deps: PostStampDeps,
  account: string | null,
  host = "github.com",
): Promise<{ ok: true; env: Record<string, string> } | { ok: false; error: string }> {
  if (account === null) return { ok: true, env: {} };
  const args = ["auth", "token", "--user", account, ...(host === "github.com" ? [] : ["--hostname", host])];
  const res = await deps.execGh(deps.cwd, args, { timeoutMs: GH_TIMEOUT_MS });
  if (res.kind === "failed" || res.stdout.trim() === "") {
    return { ok: false, error: `failed to read gh token for account ${account}: ${res.kind === "failed" ? failText(res) : "empty token"}` };
  }
  // Pass the token only through gh's token env var so it never appears in argv or logs.
  return { ok: true, env: { [host === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"]: res.stdout.trim() } };
}

const defaultDeps: PostStampDeps = {
  execGh,
  cwd: process.cwd(),
  log: (line) => console.log(line),
};

export async function main(argv: readonly string[], deps: PostStampDeps = defaultDeps): Promise<number> {
  const parsed = parsePostStampArgs(argv);
  if (typeof parsed === "string") {
    deps.log(`post-review-stamp: ${parsed}`);
    return 1;
  }

  let auth = await tokenEnvFor(deps, parsed.account);
  if (!auth.ok) {
    deps.log(`post-review-stamp: ${auth.error}`);
    return 1;
  }

  const prRes = await deps.execGh(deps.cwd, ["pr", "view", String(parsed.pr), "--json", "number,url,headRefOid,state,isDraft,mergeStateStatus"], {
    timeoutMs: GH_TIMEOUT_MS,
    env: auth.env,
  });
  if (prRes.kind === "failed") {
    deps.log(`post-review-stamp: failed to inspect PR #${parsed.pr}: ${failText(prRes)}`);
    return 1;
  }

  let prData: { number?: number; url?: string; headRefOid?: string; state?: string; isDraft?: boolean; mergeStateStatus?: string };
  try {
    prData = JSON.parse(prRes.stdout) as { number?: number; url?: string; headRefOid?: string; state?: string; isDraft?: boolean; mergeStateStatus?: string };
  } catch {
    deps.log(`post-review-stamp: invalid JSON from gh pr view`);
    return 1;
  }

  const headSha = prData.headRefOid?.toLowerCase() ?? "";
  if (headSha !== parsed.sha) {
    deps.log(`post-review-stamp: PR #${parsed.pr} head is ${headSha || "(unknown)"}, not ${parsed.sha}; refusing to stamp a moved head`);
    return 1;
  }

  const repo = typeof prData.url === "string" ? parseRepoFromPrUrl(prData.url) : null;
  if (repo === null) {
    deps.log(`post-review-stamp: could not parse repository from PR URL ${String(prData.url ?? "")}`);
    return 1;
  }

  if (parsed.account !== null && repo.host !== "github.com") {
    auth = await tokenEnvFor(deps, parsed.account, repo.host);
    if (!auth.ok) {
      deps.log(`post-review-stamp: ${auth.error}`);
      return 1;
    }
  }

  const summary = {
    pr: parsed.pr,
    sha: parsed.sha,
    context: REVIEW_STATUS_CONTEXT,
    state: parsed.state,
    description: parsed.description,
    targetUrl: prData.url,
    account: parsed.account,
    dryRun: parsed.dryRun,
  };
  if (parsed.dryRun) {
    deps.log(JSON.stringify(summary));
    return 0;
  }

  const postRes = await deps.execGh(
    deps.cwd,
    [
      "api",
      "--method",
      "POST",
      ...(repo.host === "github.com" ? [] : ["--hostname", repo.host]),
      `repos/${repo.owner}/${repo.repo}/statuses/${parsed.sha}`,
      "--silent",
      "-f",
      `state=${parsed.state}`,
      "-f",
      `context=${REVIEW_STATUS_CONTEXT}`,
      "-f",
      `description=${parsed.description}`,
      "-f",
      `target_url=${prData.url!}`,
    ],
    { timeoutMs: GH_TIMEOUT_MS, env: auth.env },
  );
  if (postRes.kind === "failed") {
    deps.log(`post-review-stamp: failed to post ${REVIEW_STATUS_CONTEXT}: ${failText(postRes)}`);
    return 1;
  }

  if (parsed.state === "success" && !parsed.noWait && typeof prData.mergeStateStatus === "string") {
    const clean = await waitForPrCleanState(
      {
        pr: parsed.pr,
        sha: parsed.sha,
        env: auth.env,
        timeoutMs: (parsed.waitTimeoutSeconds ?? DEFAULT_CLEAN_WAIT_SECONDS) * 1000,
        pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_CLEAN_POLL_INTERVAL_MS,
      },
      deps,
    );
    if (!clean.ok) {
      deps.log(
        JSON.stringify({
          ...summary,
          posted: true,
          ...(clean.mergeStateStatus !== undefined ? { mergeStateStatus: clean.mergeStateStatus } : {}),
          waitedMs: clean.waitedMs,
          waitReason: clean.reason,
          waitError: clean.message,
        }),
      );
      return 1;
    }
    deps.log(JSON.stringify({ ...summary, posted: true, mergeStateStatus: clean.mergeStateStatus, waitedMs: clean.waitedMs }));
    return 0;
  }

  deps.log(JSON.stringify({ ...summary, posted: true }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
