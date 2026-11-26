import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execGh, type GhRunResult } from "../src/daemon/git/gh.ts";
import { REVIEW_STATUS_CONTEXT } from "./review-stamp-gate.ts";

export const DEFAULT_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_TIMEOUT_SECONDS = 40 * 60;
export const DEFAULT_STARTUP_GRACE_SECONDS = 90;
export const MAX_TRANSIENT_QUERY_ERRORS = 5;
const GH_QUERY_TIMEOUT_MS = 30_000;

export const REQUIRED_MAIN_CHECKS = [
  "check (ubuntu 1/4)",
  "check (ubuntu 2/4)",
  "check (ubuntu 3/4)",
  "check (ubuntu 4/4)",
  "review-stamp gate",
] as const;

const PR_VIEW_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
].join(",");

const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL"]);
const EXEMPT_STATUS_STATES = new Set(["PENDING", "EXPECTED"]);
const PENDING_STATUS_STATES = new Set(["PENDING", "EXPECTED"]);

export interface CheckRunRollup {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string | null;
  workflowName?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface StatusContextRollup {
  __typename: "StatusContext";
  context: string;
  state: string;
  targetUrl?: string | null;
  startedAt?: string | null;
}

export type RollupItem = CheckRunRollup | StatusContextRollup;

export interface PullRequestSnapshot {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
  statusCheckRollup: RollupItem[];
}

export interface PullRequestSummary {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
}

export type CheckBucket = "pass" | "skip" | "wait" | "fail" | "exempt";

export interface ClassifiedCheck {
  bucket: CheckBucket;
  kind: "check" | "status";
  name: string;
  workflow: string | null;
  detail: string;
  url: string | null;
}

export type WaitVerdict =
  | {
      kind: "pass";
      pr: PullRequestSummary;
      passed: ClassifiedCheck[];
      skipped: ClassifiedCheck[];
      exempt: ClassifiedCheck[];
      message: string;
    }
  | {
      kind: "wait";
      pr: PullRequestSummary;
      reason: "checks-pending" | "startup-grace" | "head-sync";
      waiting: ClassifiedCheck[];
      passed: ClassifiedCheck[];
      skipped: ClassifiedCheck[];
      exempt: ClassifiedCheck[];
      missingRequired: string[];
      message: string;
    }
  | {
      kind: "fail";
      pr: PullRequestSummary;
      reason: "closed" | "conflict" | "checks-failed" | "missing-required-checks" | "head-mismatch" | "merged-stale-head";
      failed: ClassifiedCheck[];
      waiting: ClassifiedCheck[];
      passed: ClassifiedCheck[];
      exempt: ClassifiedCheck[];
      missingRequired: string[];
      message: string;
      nextStep: string;
    };

export interface WaitChecksOptions {
  prRef: string | null;
  intervalSeconds: number;
  timeoutSeconds: number;
  startupGraceSeconds: number;
  once: boolean;
}

export interface WaitChecksDeps {
  cwd: string;
  queryPr: (prRef: string | null) => Promise<GhRunResult>;
  readLocalHead: () => string | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
}

export function parseWaitChecksArgs(argv: readonly string[]): { help: true } | { help: false; options: WaitChecksOptions } {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let prRef: string | null = null;
  let intervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let startupGraceSeconds = DEFAULT_STARTUP_GRACE_SECONDS;
  let once = false;

  const parsePositiveInt = (flag: string, value: string | undefined): number => {
    if (value === undefined) throw new Error(`${flag} requires a number of seconds`);
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer (got ${value})`);
    return parsed;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--once") {
      once = true;
    } else if (arg === "--interval") {
      intervalSeconds = parsePositiveInt("--interval", args[++i]);
    } else if (arg.startsWith("--interval=")) {
      intervalSeconds = parsePositiveInt("--interval", arg.slice("--interval=".length));
    } else if (arg === "--timeout") {
      timeoutSeconds = parsePositiveInt("--timeout", args[++i]);
    } else if (arg.startsWith("--timeout=")) {
      timeoutSeconds = parsePositiveInt("--timeout", arg.slice("--timeout=".length));
    } else if (arg === "--startup-grace") {
      startupGraceSeconds = parsePositiveInt("--startup-grace", args[++i]);
    } else if (arg.startsWith("--startup-grace=")) {
      startupGraceSeconds = parsePositiveInt("--startup-grace", arg.slice("--startup-grace=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (prRef === null) {
      prRef = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  return { help: false, options: { prRef, intervalSeconds, timeoutSeconds, startupGraceSeconds, once } };
}

export function parsePullRequestSnapshot(stdout: string): PullRequestSnapshot {
  const raw = JSON.parse(stdout) as Partial<PullRequestSnapshot> | null;
  if (!raw || typeof raw.number !== "number" || typeof raw.state !== "string" || typeof raw.headRefOid !== "string") {
    throw new Error("gh pr view returned an unexpected pull request payload");
  }
  return {
    number: raw.number,
    url: typeof raw.url === "string" ? raw.url : "",
    state: raw.state,
    isDraft: Boolean(raw.isDraft),
    baseRefName: typeof raw.baseRefName === "string" ? raw.baseRefName : "",
    headRefName: typeof raw.headRefName === "string" ? raw.headRefName : "",
    headRefOid: raw.headRefOid,
    mergeable: typeof raw.mergeable === "string" ? raw.mergeable : "UNKNOWN",
    mergeStateStatus: typeof raw.mergeStateStatus === "string" ? raw.mergeStateStatus : "UNKNOWN",
    statusCheckRollup: Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [],
  };
}

function itemKey(item: RollupItem): string {
  if (item.__typename === "StatusContext") return `status:${item.context}`;
  return `check:${item.workflowName ?? ""}:${item.name}`;
}

function isNewerRollupItem(candidate: RollupItem, current: RollupItem): boolean {
  const a = candidate.startedAt ?? "";
  const b = current.startedAt ?? "";
  if (a !== b) return a > b;
  return true;
}

export function deduplicateRollup(items: readonly RollupItem[]): RollupItem[] {
  const latest = new Map<string, RollupItem>();
  for (const item of items) {
    const key = itemKey(item);
    const prev = latest.get(key);
    if (prev === undefined || isNewerRollupItem(item, prev)) latest.set(key, item);
  }
  return [...latest.values()];
}

export function classifyRollupItem(item: RollupItem): ClassifiedCheck {
  if (item.__typename === "StatusContext") {
    const state = item.state.toUpperCase();
    const url = item.targetUrl ?? null;
    if (item.context === REVIEW_STATUS_CONTEXT) {
      if (state === "SUCCESS") return { bucket: "pass", kind: "status", name: item.context, workflow: null, detail: state, url };
      if (EXEMPT_STATUS_STATES.has(state)) {
        return { bucket: "exempt", kind: "status", name: item.context, workflow: null, detail: `${state} (awaiting independent review)`, url };
      }
      return { bucket: "fail", kind: "status", name: item.context, workflow: null, detail: state, url };
    }
    if (state === "SUCCESS") return { bucket: "pass", kind: "status", name: item.context, workflow: null, detail: state, url };
    if (PENDING_STATUS_STATES.has(state)) return { bucket: "wait", kind: "status", name: item.context, workflow: null, detail: state, url };
    return { bucket: "fail", kind: "status", name: item.context, workflow: null, detail: state, url };
  }

  const status = item.status.toUpperCase();
  const conclusion = (item.conclusion ?? "").toUpperCase();
  const workflow = item.workflowName ?? null;
  const url = item.detailsUrl ?? null;
  if (status !== "COMPLETED") {
    return { bucket: "wait", kind: "check", name: item.name, workflow, detail: status, url };
  }
  if (PASS_CONCLUSIONS.has(conclusion)) {
    return { bucket: "pass", kind: "check", name: item.name, workflow, detail: conclusion, url };
  }
  if (conclusion === "SKIPPED") {
    return { bucket: "skip", kind: "check", name: item.name, workflow, detail: conclusion, url };
  }
  return { bucket: "fail", kind: "check", name: item.name, workflow, detail: conclusion || "UNKNOWN", url };
}

function summarizePr(pr: PullRequestSnapshot): PullRequestSummary {
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function formatCheckLine(check: ClassifiedCheck): string {
  const link = check.url ? ` (${check.url})` : "";
  return `- ${check.name}: ${check.detail}${link}`;
}

function hasMergeConflict(pr: PullRequestSnapshot): boolean {
  return pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY" || pr.mergeStateStatus === "CONFLICTING";
}

export function evaluatePullRequest(
  snapshot: PullRequestSnapshot,
  ctx: { elapsedMs: number; startupGraceMs: number; explicitPrArg: boolean; localHead: string | null },
): WaitVerdict {
  const pr = summarizePr(snapshot);
  const state = snapshot.state.toUpperCase();
  const classified = deduplicateRollup(snapshot.statusCheckRollup).map(classifyRollupItem);
  const passed = classified.filter((c) => c.bucket === "pass");
  const skipped = classified.filter((c) => c.bucket === "skip");
  const exempt = classified.filter((c) => c.bucket === "exempt");
  const waiting = classified.filter((c) => c.bucket === "wait");
  const failed = classified.filter((c) => c.bucket === "fail");
  const presentNames = new Set(classified.map((c) => c.name));
  const missingRequired =
    state === "OPEN" && snapshot.baseRefName === "main"
      ? REQUIRED_MAIN_CHECKS.filter((name) => !presentNames.has(name))
      : [];

  if (state === "CLOSED") {
    return {
      kind: "fail",
      pr,
      reason: "closed",
      failed,
      waiting,
      passed,
      exempt,
      missingRequired,
      message: `PR #${pr.number} is CLOSED without merging.`,
      nextStep: "Reopen the PR or open a new PR from your branch, then run node scripts/wait-checks.ts again.",
    };
  }

  if (!ctx.explicitPrArg && ctx.localHead !== null && ctx.localHead !== snapshot.headRefOid) {
    if (state === "MERGED") {
      return {
        kind: "fail",
        pr,
        reason: "merged-stale-head",
        failed,
        waiting,
        passed,
        exempt,
        missingRequired,
        message: `PR #${pr.number} is already MERGED at ${shortSha(snapshot.headRefOid)}, while local HEAD is ${shortSha(ctx.localHead)}.`,
        nextStep: "Create a new branch from origin/main and open a new PR for your new commits.",
      };
    }
    const syncGraceMs = Math.min(ctx.startupGraceMs, 30_000);
    if (ctx.elapsedMs < syncGraceMs) {
      return {
        kind: "wait",
        pr,
        reason: "head-sync",
        waiting,
        passed,
        skipped,
        exempt,
        missingRequired,
        message: `Waiting for PR #${pr.number} head (${shortSha(snapshot.headRefOid)}) to update to local HEAD (${shortSha(ctx.localHead)}).`,
      };
    }
    return {
      kind: "fail",
      pr,
      reason: "head-mismatch",
      failed,
      waiting,
      passed,
      exempt,
      missingRequired,
      message: `Local HEAD (${shortSha(ctx.localHead)}) does not match PR #${pr.number} head (${shortSha(snapshot.headRefOid)}).`,
      nextStep: "Push your latest commits (git push) and re-run node scripts/wait-checks.ts.",
    };
  }

  if (state === "OPEN" && hasMergeConflict(snapshot)) {
    return {
      kind: "fail",
      pr,
      reason: "conflict",
      failed,
      waiting,
      passed,
      exempt,
      missingRequired,
      message: `PR #${pr.number} has merge conflicts (mergeable=${snapshot.mergeable}, mergeStateStatus=${snapshot.mergeStateStatus}); GitHub will not run pull_request workflows.`,
      nextStep: "Fetch origin/main, merge or rebase onto origin/main to resolve conflicts, run pnpm typecheck, pnpm test:related, and pnpm verify, push, and re-run node scripts/wait-checks.ts.",
    };
  }

  if (failed.length > 0) {
    return {
      kind: "fail",
      pr,
      reason: "checks-failed",
      failed,
      waiting,
      passed,
      exempt,
      missingRequired,
      message: `PR #${pr.number} has ${failed.length} failed check(s): ${failed.map((f) => `${f.name} (${f.detail})`).join(", ")}.`,
      nextStep:
        "Inspect the failing job log URL(s) (or run `gh run view <run-id> --log-failed`), fix the failure (or report to the PM if it is flaky or already red on main), push, and re-run node scripts/wait-checks.ts.",
    };
  }

  if (state === "MERGED") {
    return {
      kind: "pass",
      pr,
      passed,
      skipped,
      exempt,
      message: `PR #${pr.number} is MERGED; all ${passed.length} recorded check(s) passed${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""}.`,
    };
  }

  if (missingRequired.length > 0) {
    if (ctx.elapsedMs < ctx.startupGraceMs) {
      return {
        kind: "wait",
        pr,
        reason: "startup-grace",
        waiting,
        passed,
        skipped,
        exempt,
        missingRequired,
        message: `PR #${pr.number}: waiting for required checks to start (${missingRequired.join(", ")}).`,
      };
    }
    return {
      kind: "fail",
      pr,
      reason: "missing-required-checks",
      failed,
      waiting,
      passed,
      exempt,
      missingRequired,
      message: `PR #${pr.number} required checks did not start within ${Math.round(ctx.startupGraceMs / 1000)}s: ${missingRequired.join(", ")} (mergeable=${snapshot.mergeable}, mergeStateStatus=${snapshot.mergeStateStatus}).`,
      nextStep: "Inspect the PR on GitHub for workflow trigger issues or mergeability errors, push an updated commit if needed, and re-run node scripts/wait-checks.ts.",
    };
  }

  if (waiting.length > 0) {
    const exemptNote = exempt.length > 0 ? `; ignoring ${exempt.map((e) => `${e.name} (${e.detail})`).join(", ")}` : "";
    return {
      kind: "wait",
      pr,
      reason: "checks-pending",
      waiting,
      passed,
      skipped,
      exempt,
      missingRequired,
      message: `PR #${pr.number}: waiting for ${waiting.length} check(s): ${waiting.map((w) => `${w.name} (${w.detail})`).join(", ")}${exemptNote}.`,
    };
  }

  const exemptNote =
    exempt.length > 0
      ? ` Not waited (awaiting independent review): ${exempt.map((e) => e.name).join(", ")}.`
      : "";
  return {
    kind: "pass",
    pr,
    passed,
    skipped,
    exempt,
    message: `PR #${pr.number} CI checks finished green (${passed.length} passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}).${exemptNote}`,
  };
}

export function classifyGhQueryError(failure: Extract<GhRunResult, { kind: "failed" }>): { retryable: boolean; message: string; nextStep: string } {
  if (failure.missing) {
    return {
      retryable: false,
      message: "GitHub CLI (`gh`) is not installed or not in PATH.",
      nextStep: "Install `gh` and authenticate with `gh auth login`, then re-run node scripts/wait-checks.ts.",
    };
  }
  const stderr = failure.stderr.trim();
  if (/no pull requests found|could not resolve to a pullrequest|HTTP 404/iu.test(stderr)) {
    return {
      retryable: false,
      message: stderr || "No pull request found for the target branch or number.",
      nextStep: "Open a PR first (or pass an explicit PR number: `node scripts/wait-checks.ts <PR>`), then re-run node scripts/wait-checks.ts.",
    };
  }
  if (/not logged into|gh auth login|bad credentials|HTTP 401|HTTP 403|authentication|no oauth token/iu.test(stderr)) {
    return {
      retryable: false,
      message: stderr || "GitHub CLI is not authenticated or lacks permission to read this repository.",
      nextStep: "Authenticate `gh` with read access to this repository (or report the permission gap to the PM if running in a restricted account).",
    };
  }
  if (failure.timedOut || /network|connect|timed? out|dns|resolve|enotfound|econnrefused|econnreset|tls|ssl|HTTP 5\d\d/iu.test(stderr)) {
    return {
      retryable: true,
      message: failure.timedOut ? "gh pr view timed out" : stderr || "transient gh error",
      nextStep: "Check network connectivity to GitHub and re-run node scripts/wait-checks.ts.",
    };
  }
  return {
    retryable: false,
    message: stderr || `gh pr view failed (code ${String(failure.code)})`,
    nextStep: "Check `gh pr view` output and repository permissions, then re-run node scripts/wait-checks.ts.",
  };
}

function formatPassReport(verdict: Extract<WaitVerdict, { kind: "pass" }>): string[] {
  const draftTag = verdict.pr.isDraft ? ", draft" : "";
  const lines = [
    `PASS: ${verdict.message}`,
    `PR: #${verdict.pr.number} (${verdict.pr.state}${draftTag}, base=${verdict.pr.baseRefName}, head=${shortSha(verdict.pr.headRefOid)})${verdict.pr.url ? ` ${verdict.pr.url}` : ""}`,
  ];
  if (verdict.passed.length > 0) {
    lines.push("Passed:", ...verdict.passed.map(formatCheckLine));
  }
  if (verdict.skipped.length > 0) {
    lines.push(`Skipped (${verdict.skipped.length}): ${verdict.skipped.map((s) => s.name).join(", ")}`);
  }
  if (verdict.exempt.length > 0) {
    lines.push("Not waited (awaiting independent review):", ...verdict.exempt.map(formatCheckLine));
  }
  return lines;
}

function formatFailReport(verdict: Extract<WaitVerdict, { kind: "fail" }>): string[] {
  const lines = [
    `FAIL (${verdict.reason}): ${verdict.message}`,
    `PR: #${verdict.pr.number} (${verdict.pr.state}, mergeable=${verdict.pr.mergeable}, mergeStateStatus=${verdict.pr.mergeStateStatus})${verdict.pr.url ? ` ${verdict.pr.url}` : ""}`,
  ];
  if (verdict.failed.length > 0) {
    lines.push("Failed:", ...verdict.failed.map(formatCheckLine));
  }
  if (verdict.waiting.length > 0) {
    lines.push("Still running:", ...verdict.waiting.map(formatCheckLine));
  }
  lines.push(`Next step: ${verdict.nextStep}`);
  return lines;
}

function waitKeyOf(verdict: Extract<WaitVerdict, { kind: "wait" }>): string {
  return [
    verdict.reason,
    verdict.missingRequired.join(","),
    verdict.waiting.map((w) => `${w.name}:${w.detail}`).join(","),
    verdict.exempt.map((e) => `${e.name}:${e.detail}`).join(","),
  ].join("|");
}

export async function waitForChecks(options: WaitChecksOptions, deps: WaitChecksDeps): Promise<number> {
  const startedAt = deps.now();
  const timeoutMs = options.timeoutSeconds * 1000;
  const intervalMs = options.intervalSeconds * 1000;
  const startupGraceMs = options.startupGraceSeconds * 1000;
  const explicitPrArg = options.prRef !== null;
  const localHead = explicitPrArg ? null : deps.readLocalHead();
  let transientErrors = 0;
  let lastWaitKey: string | null = null;

  while (true) {
    const query = await deps.queryPr(options.prRef);
    if (query.kind === "failed") {
      const classified = classifyGhQueryError(query);
      transientErrors += 1;
      if (!classified.retryable || options.once || transientErrors >= MAX_TRANSIENT_QUERY_ERRORS) {
        deps.error(`FAIL (query-error): ${classified.message}`);
        deps.error(`Next step: ${classified.nextStep}`);
        return 1;
      }
      deps.log(`[wait-checks] transient query error (${transientErrors}/${MAX_TRANSIENT_QUERY_ERRORS}): ${classified.message}; retrying in ${options.intervalSeconds}s`);
      await deps.sleep(intervalMs);
      continue;
    }

    transientErrors = 0;
    let snapshot: PullRequestSnapshot;
    try {
      snapshot = parsePullRequestSnapshot(query.stdout);
    } catch (error) {
      deps.error(`FAIL (query-parse): ${(error as Error).message}`);
      deps.error("Next step: Verify `gh pr view` output and re-run node scripts/wait-checks.ts.");
      return 1;
    }

    const elapsedMs = deps.now() - startedAt;
    const verdict = evaluatePullRequest(snapshot, { elapsedMs, startupGraceMs, explicitPrArg, localHead });
    if (verdict.kind === "pass") {
      for (const line of formatPassReport(verdict)) deps.log(line);
      return 0;
    }
    if (verdict.kind === "fail") {
      for (const line of formatFailReport(verdict)) deps.error(line);
      return 1;
    }
    if (options.once) {
      deps.log(`PENDING: ${verdict.message}`);
      return 2;
    }

    const key = waitKeyOf(verdict);
    if (key !== lastWaitKey) {
      lastWaitKey = key;
      deps.log(`[wait-checks] ${verdict.message}`);
    }

    const remainingMs = timeoutMs - (deps.now() - startedAt);
    if (remainingMs <= 0) {
      deps.error(`FAIL (timeout): Timed out after ${options.timeoutSeconds}s waiting for PR #${verdict.pr.number} checks.`);
      if (verdict.waiting.length > 0) deps.error(["Still pending:", ...verdict.waiting.map(formatCheckLine)].join("\n"));
      if (verdict.missingRequired.length > 0) deps.error(`Missing required checks: ${verdict.missingRequired.join(", ")}`);
      deps.error("Next step: Inspect the stalled workflow run(s) on GitHub, fix or report the stall to the PM, and re-run node scripts/wait-checks.ts.");
      return 1;
    }
    await deps.sleep(Math.min(intervalMs, remainingMs));
  }
}

const USAGE = [
  "Usage: node scripts/wait-checks.ts [<pr>] [options]",
  "  <pr>                   PR number, URL, or branch (defaults to current branch PR)",
  `  --interval <seconds>   Poll interval in seconds (default: ${DEFAULT_POLL_INTERVAL_SECONDS})`,
  `  --timeout <seconds>    Max wait time in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})`,
  `  --startup-grace <sec>  Max wait for required main checks to start (default: ${DEFAULT_STARTUP_GRACE_SECONDS})`,
  "  --once                 Evaluate once without polling (exits 0 pass, 1 fail, 2 pending)",
  "  -h, --help             Show this help message",
].join("\n");

function readGitHead(cwd: string): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  let parsed: ReturnType<typeof parseWaitChecksArgs>;
  try {
    parsed = parseWaitChecksArgs(argv);
  } catch (error) {
    console.error(`wait-checks: ${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  return waitForChecks(parsed.options, {
    cwd,
    queryPr: (prRef) => execGh(cwd, ["pr", "view", ...(prRef ? [prRef] : []), "--json", PR_VIEW_FIELDS], { timeoutMs: GH_QUERY_TIMEOUT_MS }),
    readLocalHead: () => readGitHead(cwd),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
