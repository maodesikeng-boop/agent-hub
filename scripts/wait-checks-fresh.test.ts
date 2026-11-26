import { describe, expect, it } from "vitest";
import { REVIEW_STATUS_CONTEXT } from "./review-stamp-gate.ts";
import { REQUIRED_MAIN_CHECKS, evaluatePullRequest, type CheckRunRollup, type PullRequestSnapshot, type RollupItem } from "./wait-checks.ts";

const SHA = "a".repeat(40);

function green(name: string): CheckRunRollup {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", workflowName: "check", startedAt: "2026-11-26T02:00:00Z" };
}

function rollup(): RollupItem[] {
  return [...REQUIRED_MAIN_CHECKS.map(green), { __typename: "StatusContext", context: REVIEW_STATUS_CONTEXT, state: "SUCCESS" }];
}

function pr(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 452,
    url: "https://github.com/acme/repo/pull/452",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature/x",
    headRefOid: SHA,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: rollup(),
    ...overrides,
  };
}

const ctx = { elapsedMs: 0, startupGraceMs: 90_000, explicitPrArg: true, localHead: null };

describe("evaluatePullRequest against a moved main", () => {
  it("fails a green PR whose base moved, and says how to update it", () => {
    const verdict = evaluatePullRequest(pr({ mergeStateStatus: "BEHIND" }), ctx);
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") {
      expect(verdict.reason).toBe("behind");
      expect(verdict.nextStep).toContain("main");
    }
  });

  it("fails a green PR whose migration number another open PR holds, even though its own checks passed earlier", () => {
    const verdict = evaluatePullRequest(pr(), {
      ...ctx,
      migrationConflicts: [{ kind: "claimed", version: 55, file: "migrations/0055_mine.sql", otherPr: 451, otherFile: "migrations/0055_theirs.sql" }],
    });
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail") {
      expect(verdict.reason).toBe("migration-claim");
      expect(verdict.message).toContain("#451");
    }
  });

  it("still passes an up-to-date green PR with no migration conflict", () => {
    expect(evaluatePullRequest(pr(), { ...ctx, migrationConflicts: [] }).kind).toBe("pass");
  });

  it("waits for the migration-claims job like the other required checks", () => {
    expect(REQUIRED_MAIN_CHECKS).toContain("migration-claims");
  });
});
