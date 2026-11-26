import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { REVIEW_STATUS_CONTEXT } from "./review-stamp-gate.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_STARTUP_GRACE_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TRANSIENT_QUERY_ERRORS,
  REQUIRED_MAIN_CHECKS,
  classifyGhQueryError,
  classifyRollupItem,
  deduplicateRollup,
  evaluatePullRequest,
  parseWaitChecksArgs,
  waitForChecks,
  type CheckRunRollup,
  type PullRequestSnapshot,
  type RollupItem,
  type StatusContextRollup,
  type WaitChecksDeps,
  type WaitChecksOptions,
} from "./wait-checks.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function checkRun(name: string, status: string, conclusion: string | null, extra: Partial<CheckRunRollup> = {}): CheckRunRollup {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    workflowName: name.startsWith("check ") ? "check" : name === "review-stamp gate" ? "review-stamp" : "other",
    detailsUrl: `https://github.com/acme/repo/runs/${encodeURIComponent(name)}`,
    startedAt: "2026-11-23T02:00:00Z",
    ...extra,
  };
}

function statusCtx(context: string, state: string, extra: Partial<StatusContextRollup> = {}): StatusContextRollup {
  return {
    __typename: "StatusContext",
    context,
    state,
    targetUrl: `https://github.com/acme/repo/statuses/${encodeURIComponent(context)}`,
    startedAt: "2026-11-23T02:00:05Z",
    ...extra,
  };
}

function mainRequiredGreen(): RollupItem[] {
  return [
    checkRun("check (ubuntu 1/4)", "COMPLETED", "SUCCESS"),
    checkRun("check (ubuntu 2/4)", "COMPLETED", "SUCCESS"),
    checkRun("check (ubuntu 3/4)", "COMPLETED", "SUCCESS"),
    checkRun("check (ubuntu 4/4)", "COMPLETED", "SUCCESS"),
    checkRun("review-stamp gate", "COMPLETED", "SUCCESS"),
    checkRun("migration-claims", "COMPLETED", "SUCCESS"),
  ];
}

function makePr(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 418,
    url: "https://github.com/acme/repo/pull/418",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature/test",
    headRefOid: SHA_A,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [...mainRequiredGreen(), statusCtx(REVIEW_STATUS_CONTEXT, "SUCCESS")],
    ...overrides,
  };
}

function defaultOpts(overrides: Partial<WaitChecksOptions> = {}): WaitChecksOptions {
  return {
    prRef: "418",
    intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    startupGraceSeconds: DEFAULT_STARTUP_GRACE_SECONDS,
    once: false,
    ...overrides,
  };
}

function fakeHarness(
  responses: Array<{ kind: "ok"; pr: PullRequestSnapshot } | { kind: "failed"; code: number | string | null; stderr: string; timedOut?: boolean; missing?: boolean }>,
  localHead: string | null = SHA_A,
) {
  let nowMs = 0;
  let idx = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  const sleeps: number[] = [];

  const deps: WaitChecksDeps = {
    cwd: "/repo",
    readLocalHead: () => localHead,
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    queryPr: async () => {
      const item = responses[Math.min(idx, responses.length - 1)]!;
      idx += 1;
      if (item.kind === "ok") return { kind: "ok", stdout: JSON.stringify(item.pr) };
      return { kind: "failed", code: item.code, stderr: item.stderr, timedOut: Boolean(item.timedOut), missing: Boolean(item.missing) };
    },
  };

  return { deps, logs, errors, sleeps, calls: () => idx };
}

describe("parseWaitChecksArgs", () => {
  it("parses optional PR ref, polling flags, --once, and --help", () => {
    expect(parseWaitChecksArgs(["--help"])).toEqual({ help: true });
    expect(parseWaitChecksArgs(["--", "418", "--interval=5", "--timeout", "120", "--startup-grace", "30", "--once"])).toEqual({
      help: false,
      options: { prRef: "418", intervalSeconds: 5, timeoutSeconds: 120, startupGraceSeconds: 30, once: true },
    });
    expect(parseWaitChecksArgs([])).toEqual({
      help: false,
      options: {
        prRef: null,
        intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        startupGraceSeconds: DEFAULT_STARTUP_GRACE_SECONDS,
        once: false,
      },
    });
  });

  it("rejects invalid flags or non-positive numbers", () => {
    expect(() => parseWaitChecksArgs(["--interval", "0"])).toThrow(/positive integer/);
    expect(() => parseWaitChecksArgs(["--bogus"])).toThrow(/Unknown flag/);
    expect(() => parseWaitChecksArgs(["1", "2"])).toThrow(/Unexpected extra argument/);
  });
});

describe("workflow consistency", () => {
  it("keeps REQUIRED_MAIN_CHECKS aligned with the shards, review stamp, and migration claim jobs", () => {
    const checkWf = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/check.yml"), "utf8")) as {
      jobs: { check: { name: string; strategy: { matrix: { shard: string[] } } }; "migration-claims": { name: string } };
    };
    const stampWf = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/review-stamp.yml"), "utf8")) as {
      jobs: { gate: { name: string } };
    };
    const expected = [
      ...checkWf.jobs.check.strategy.matrix.shard.map((s) => checkWf.jobs.check.name.replace("${{ matrix.shard }}", s)),
      stampWf.jobs.gate.name,
      checkWf.jobs["migration-claims"].name,
    ];
    expect([...REQUIRED_MAIN_CHECKS]).toEqual(expected);
  });
});

describe("classifyRollupItem & deduplicateRollup", () => {
  it("exempts pending/expected bellwood/review while failing on error/failure and waiting on other pending contexts", () => {
    expect(classifyRollupItem(statusCtx(REVIEW_STATUS_CONTEXT, "PENDING")).bucket).toBe("exempt");
    expect(classifyRollupItem(statusCtx(REVIEW_STATUS_CONTEXT, "EXPECTED")).bucket).toBe("exempt");
    expect(classifyRollupItem(statusCtx(REVIEW_STATUS_CONTEXT, "SUCCESS")).bucket).toBe("pass");
    expect(classifyRollupItem(statusCtx(REVIEW_STATUS_CONTEXT, "FAILURE")).bucket).toBe("fail");
    expect(classifyRollupItem(statusCtx(REVIEW_STATUS_CONTEXT, "ERROR")).bucket).toBe("fail");
    expect(classifyRollupItem(statusCtx("ci/other", "PENDING")).bucket).toBe("wait");
  });

  it("keeps the latest rollup entry when the same check or context appears twice", () => {
    const items = deduplicateRollup([
      checkRun("check (ubuntu 1/4)", "COMPLETED", "CANCELLED", { startedAt: "2026-11-23T01:00:00Z" }),
      checkRun("check (ubuntu 1/4)", "COMPLETED", "SUCCESS", { startedAt: "2026-11-23T02:00:00Z" }),
      statusCtx(REVIEW_STATUS_CONTEXT, "PENDING", { startedAt: "2026-11-23T01:00:00Z" }),
      statusCtx(REVIEW_STATUS_CONTEXT, "SUCCESS", { startedAt: "2026-11-23T02:00:00Z" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.every((item) => classifyRollupItem(item).bucket === "pass")).toBe(true);
  });
});

describe("evaluatePullRequest", () => {
  const baseCtx = { elapsedMs: 0, startupGraceMs: 90_000, explicitPrArg: true, localHead: null };

  it("passes immediately when CI checks are green and only bellwood/review is pending", () => {
    const pr = makePr({
      isDraft: true,
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [...mainRequiredGreen(), statusCtx(REVIEW_STATUS_CONTEXT, "PENDING")],
    });
    const verdict = evaluatePullRequest(pr, baseCtx);
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.passed).toHaveLength(6);
      expect(verdict.exempt.map((e) => e.name)).toEqual([REVIEW_STATUS_CONTEXT]);
      expect(verdict.message).toContain("bellwood/review");
    }
  });

  it("treats SKIPPED check runs as non-blocking and passes on merged green PRs", () => {
    const pr = makePr({
      state: "MERGED",
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      statusCheckRollup: [
        ...mainRequiredGreen(),
        checkRun("deploy staging & smoke", "COMPLETED", "SKIPPED"),
        statusCtx(REVIEW_STATUS_CONTEXT, "SUCCESS"),
      ],
    });
    const verdict = evaluatePullRequest(pr, baseCtx);
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.skipped).toHaveLength(1);
    }
  });

  it("fails immediately on merge conflicts even when review-stamp gate passed and bellwood/review is pending", () => {
    const pr = makePr({
      number: 407,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [checkRun("review-stamp gate", "COMPLETED", "SUCCESS"), statusCtx(REVIEW_STATUS_CONTEXT, "PENDING")],
    });
    const verdict = evaluatePullRequest(pr, baseCtx);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") {
      expect(verdict.reason).toBe("conflict");
      expect(verdict.nextStep).toContain("origin/main");
    }
  });

  it("fails immediately on any failed check even while other checks are still running", () => {
    const pr = makePr({
      statusCheckRollup: [
        checkRun("check (ubuntu 1/4)", "COMPLETED", "FAILURE"),
        checkRun("check (ubuntu 2/4)", "IN_PROGRESS", null),
        checkRun("check (ubuntu 3/4)", "COMPLETED", "SUCCESS"),
        checkRun("check (ubuntu 4/4)", "COMPLETED", "SUCCESS"),
        checkRun("review-stamp gate", "COMPLETED", "SUCCESS"),
        checkRun("migration-claims", "COMPLETED", "SUCCESS"),
      ],
    });
    const verdict = evaluatePullRequest(pr, baseCtx);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") {
      expect(verdict.reason).toBe("checks-failed");
      expect(verdict.failed.map((f) => f.name)).toEqual(["check (ubuntu 1/4)"]);
      expect(verdict.waiting.map((w) => w.name)).toEqual(["check (ubuntu 2/4)"]);
      expect(verdict.nextStep).toContain("gh run view");
    }
  });

  it("waits during startup grace when main required checks have not appeared yet, then fails once grace expires", () => {
    const pr = makePr({ statusCheckRollup: [checkRun("review-stamp gate", "COMPLETED", "SUCCESS")] });
    const early = evaluatePullRequest(pr, { ...baseCtx, elapsedMs: 10_000, startupGraceMs: 90_000 });
    expect(early.kind).toBe("wait");
    if (early.kind === "wait") {
      expect(early.reason).toBe("startup-grace");
      expect(early.missingRequired).toHaveLength(5);
    }

    const late = evaluatePullRequest(pr, { ...baseCtx, elapsedMs: 90_000, startupGraceMs: 90_000 });
    expect(late.kind).toBe("fail");
    if (late.kind === "fail") {
      expect(late.reason).toBe("missing-required-checks");
      expect(late.missingRequired).toHaveLength(5);
    }
  });

  it("does not require main checks when targeting a non-main base branch", () => {
    const pr = makePr({ baseRefName: "feature/stack-base", statusCheckRollup: [] });
    expect(evaluatePullRequest(pr, baseCtx).kind).toBe("pass");
  });

  it("detects unpushed local commits when no explicit PR argument was provided", () => {
    const openPr = makePr({ headRefOid: SHA_B });
    const syncing = evaluatePullRequest(openPr, { elapsedMs: 0, startupGraceMs: 90_000, explicitPrArg: false, localHead: SHA_A });
    expect(syncing.kind).toBe("wait");
    const mismatch = evaluatePullRequest(openPr, { elapsedMs: 30_000, startupGraceMs: 90_000, explicitPrArg: false, localHead: SHA_A });
    expect(mismatch.kind).toBe("fail");
    if (mismatch.kind === "fail") expect(mismatch.reason).toBe("head-mismatch");

    const mergedPr = makePr({ state: "MERGED", headRefOid: SHA_B });
    const staleMerged = evaluatePullRequest(mergedPr, { elapsedMs: 0, startupGraceMs: 90_000, explicitPrArg: false, localHead: SHA_A });
    expect(staleMerged.kind).toBe("fail");
    if (staleMerged.kind === "fail") expect(staleMerged.reason).toBe("merged-stale-head");
  });
});

describe("waitForChecks", () => {
  it("polls while checks are in progress and exits 0 when only bellwood/review remains pending", async () => {
    const pendingPr = makePr({
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [
        checkRun("check (ubuntu 1/4)", "IN_PROGRESS", null),
        checkRun("check (ubuntu 2/4)", "COMPLETED", "SUCCESS"),
        checkRun("check (ubuntu 3/4)", "COMPLETED", "SUCCESS"),
        checkRun("check (ubuntu 4/4)", "COMPLETED", "SUCCESS"),
        checkRun("review-stamp gate", "COMPLETED", "SUCCESS"),
        checkRun("migration-claims", "COMPLETED", "SUCCESS"),
        statusCtx(REVIEW_STATUS_CONTEXT, "PENDING"),
      ],
    });
    const donePr = makePr({
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [...mainRequiredGreen(), statusCtx(REVIEW_STATUS_CONTEXT, "PENDING")],
    });
    const h = fakeHarness([
      { kind: "ok", pr: pendingPr },
      { kind: "ok", pr: pendingPr },
      { kind: "ok", pr: donePr },
    ]);

    const code = await waitForChecks(defaultOpts({ intervalSeconds: 10 }), h.deps);
    expect(code).toBe(0);
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([10_000, 10_000]);
    expect(h.logs.filter((l) => l.startsWith("[wait-checks]"))).toHaveLength(1);
    expect(h.logs.some((l) => l.startsWith("PASS:"))).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("exits 1 immediately without sleeping when PR has merge conflicts", async () => {
    const dirtyPr = makePr({
      number: 407,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [checkRun("review-stamp gate", "COMPLETED", "SUCCESS"), statusCtx(REVIEW_STATUS_CONTEXT, "PENDING")],
    });
    const h = fakeHarness([{ kind: "ok", pr: dirtyPr }]);

    const code = await waitForChecks(defaultOpts({ prRef: "407" }), h.deps);
    expect(code).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.errors.join("\n")).toContain("merge conflicts");
    expect(h.errors.join("\n")).toContain("Next step:");
  });

  it("exits 2 on --once when checks are still pending", async () => {
    const pendingPr = makePr({
      statusCheckRollup: [
        checkRun("check (ubuntu 1/4)", "IN_PROGRESS", null),
        checkRun("check (ubuntu 2/4)", "COMPLETED", "SUCCESS"),
        checkRun("check (ubuntu 3/4)", "COMPLETED", "SUCCESS"),
        checkRun("check (ubuntu 4/4)", "COMPLETED", "SUCCESS"),
        checkRun("review-stamp gate", "COMPLETED", "SUCCESS"),
        checkRun("migration-claims", "COMPLETED", "SUCCESS"),
      ],
    });
    const h = fakeHarness([{ kind: "ok", pr: pendingPr }]);
    const code = await waitForChecks(defaultOpts({ once: true }), h.deps);
    expect(code).toBe(2);
    expect(h.sleeps).toEqual([]);
  });

  it("retries transient gh errors up to the limit and fails immediately on permanent errors", async () => {
    const transient = { kind: "failed" as const, code: 1, stderr: "HTTP 502 Bad Gateway", timedOut: false, missing: false };
    const recovering = fakeHarness([transient, transient, { kind: "ok", pr: makePr() }]);
    expect(await waitForChecks(defaultOpts({ intervalSeconds: 5 }), recovering.deps)).toBe(0);
    expect(recovering.sleeps).toEqual([5_000, 5_000]);

    const exhausted = fakeHarness(Array.from({ length: MAX_TRANSIENT_QUERY_ERRORS }, () => transient));
    expect(await waitForChecks(defaultOpts({ intervalSeconds: 5 }), exhausted.deps)).toBe(1);

    const noPr = fakeHarness([{ kind: "failed", code: 1, stderr: "no pull requests found for branch \"foo\"" }]);
    expect(await waitForChecks(defaultOpts(), noPr.deps)).toBe(1);
    expect(noPr.sleeps).toEqual([]);

    expect(classifyGhQueryError({ kind: "failed", code: "ENOENT", stderr: "", timedOut: false, missing: true }).retryable).toBe(false);
  });

  it("exits 1 on timeout when waited checks stay pending", async () => {
    const pendingPr = makePr({
      statusCheckRollup: [
        checkRun("check (ubuntu 1/4)", "IN_PROGRESS", null),
        checkRun("check (ubuntu 2/4)", "COMPLETED", "SUCCESS"),
        checkRun("check (ubuntu 3/4)", "COMPLETED", "SUCCESS"),
        checkRun("check (ubuntu 4/4)", "COMPLETED", "SUCCESS"),
        checkRun("review-stamp gate", "COMPLETED", "SUCCESS"),
        checkRun("migration-claims", "COMPLETED", "SUCCESS"),
      ],
    });
    const h = fakeHarness([{ kind: "ok", pr: pendingPr }]);
    const code = await waitForChecks(defaultOpts({ intervalSeconds: 10, timeoutSeconds: 20 }), h.deps);
    expect(code).toBe(1);
    expect(h.sleeps).toEqual([10_000, 10_000]);
    expect(h.errors.join("\n")).toContain("FAIL (timeout)");
  });
});
