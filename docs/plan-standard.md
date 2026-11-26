# Plan and code-skeleton standard

Follow this standard whenever a task asks for a design plan. A planning step commits a design document in `docs/<topic>-design.md`, a compiling TypeScript code skeleton in the target files, and runnable acceptance tests. Before implementation, confirm and record that every test for new or changed behavior fails and that every regression test confirming an unchanged existing rule passes. Later implementation steps fill in the function bodies until every acceptance test passes.

## Design document

Write `docs/<topic>-design.md` in plain English following `.agents/skills/technical-writing/SKILL.md` and `.agents/skills/unslop/SKILL.md`. Directly under `# <Title>`, record the snapshot date and git commit (`> Snapshot: YYYY-MM-DD (commit \`<sha>\`)`) so readers can see which codebase state the document describes (`src/docs-guard.test.ts` enforces this line and `docs/README.md` indexing). Keep every section below in order. Write `None` when a section does not apply.

### For the user

Keep the opening section focused on what the user reviews and approves before implementation starts:

- **Files to review.** Link each deliverable file with one sentence on what it covers.
- **Decisions needed.** List each open product or scope trade-off with concrete options and your recommendation. For every rule that asks for user approval, attach a concrete example or a screenshot that shows what the user will see under that rule. Write `None` when no decision is open.
- **Checkpoint card.** Copy the plain-language acceptance scenario list from Section 8 into the plan's checkpoint card. Implementation starts only after the user approves that card and any open decisions.

### For Workers and reviewers

Include all eight sections below in order for downstream Workers and reviewers:

1. **User goal.** Quote the user's original request first, then state the intended outcome in one or two sentences.
2. **Current state.** Label each finding `[Measured]` or `[Inferred]` with `path:line` references. For measured claims, state how you ran the check.
3. **Approach comparison.** Compare at least two candidate designs in a table, starting from libraries already listed in `AGENTS.md` and standard industry approaches, then state your recommendation and why.
4. **Performance and bounds.** When touching caches, snapshots, or collections that grow over time, address all four rules in `AGENTS.md` ("Caches and state bounds"). List new `src/shared/limits.ts` constants in a table with values and one-month sizing math, or write `None` and explain why.
5. **Cross-vendor and cross-platform unification.** Show how one shared definition covers every registered vendor in `src/shared/vendors.ts` and all three platforms (`macOS`, `Windows`, and `Linux` via `src/daemon/platform/index.ts`), and name the single file a future vendor must implement.
6. **Deletions.** List superseded code paths, docs, and prompt text to delete in the same PR so old and new logic never coexist.
7. **Skeleton files.** List each created or modified file with one sentence on its responsibility, including the acceptance test files. Do not paste function signatures that already live in the code skeleton.
8. **Verification plan.** Prove the change works on real artifacts. "Tests pass" alone is not enough. Include all three items below:
   - **Acceptance scenarios.** Write plain-language scenarios from the user's quoted sentences in Section 1 and from every settled rule. Write each scenario in three concrete parts: what happens first, what happens next, and what the user should see. Map every quoted sentence and every settled rule to at least one scenario. Include at least one scenario for each of the four categories below whenever the change can reach it. If a category cannot apply, write one sentence that explains why:
     - Two consecutive turns in the same conversation.
     - A restart in the middle of the operation.
     - A state or configuration change while work or a notice waits in a queue.
     - Existing rules or boundaries that the change touches or uncovers.
   - **Real CLI verification.** For any scenario that depends on vendor CLI behavior, run it locally against the real vendor CLI before merge and save the output as evidence. A scenario that passes only against a fake CLI counts as not verified against the real CLI, not as passing. Keep fake CLIs for fast cloud checks. If the real CLI disagrees with a fake CLI, update the fake CLI and add a test in the same PR. If a vendor CLI is not installed or not logged in locally, mark the scenario as not verified against the real CLI and state why.
   - **Commands and visual checks.** Name the exact acceptance test files, `pnpm verify`, real-browser screenshots for UI changes, and command outputs to capture during implementation.

## Code skeleton and acceptance tests

Write the skeleton and acceptance tests directly in the target production and test files rather than a scratch directory:

- **Data shapes and migrations.** Define TypeScript interfaces and discriminated unions. For schema changes, add the next numbered SQL file in `migrations/` and its line in `migrations/manifest.sha256` ([Ledger database](ledger-database.md)).
- **Module boundaries.** Create target modules and export their public functions and types. Skip unexported private helpers.
- **Function signatures.** Write full parameter and return types without `any`. Use a single-line body: `throw new Error("Not implemented");`.
- **Contracts.** Document caller-observable preconditions and postconditions on exported functions with concise `/** */` doc comments. State module-wide invariants once at the top of the file. Do not prescribe internal data structures or step-by-step control flow. Public API contract comments remain after implementation per `.agents/skills/no-comments/references/comment-sicko.md`.
- **Acceptance tests.** Write real runnable tests with assertions in the matching `*.test.ts` and `*.test.tsx` files so every acceptance scenario in Section 8 and every contract clause maps to at least one executable test. Do not use `it.todo` placeholders for acceptance scenarios. Automated tests may run against fake CLIs for fast cloud checks, while vendor CLI scenarios still require a local run against the real CLI before merge.
- **Existing callers.** When changing an existing signature, update call sites so `pnpm typecheck` passes without altering runtime behavior yet.

Before you commit the plan, run `pnpm typecheck` and confirm it exits 0. Then run every acceptance test file (`pnpm exec vitest run <test-files>`) with no syntax or type errors. Confirm that every test for new or changed behavior fails against the skeleton or current code, and that every regression test confirming an unchanged existing rule runs and passes. Record the command and test output in your Worker report or PR body so downstream Workers and reviewers can verify both the pre-implementation failure record for every test of new or changed behavior and the pre-implementation passing record for every regression test confirming an unchanged existing rule.

Example skeleton and acceptance tests:

```ts
// src/shared/coupon.ts
// Invariant: all monetary amounts are integer cents.

/**
 * Precondition: price is a non-negative integer.
 * Postcondition: returns the discounted price floored to integer cents, or price unchanged when percent is 0.
 * Throws RangeError when percent is outside 0..100 inclusive.
 */
export function applyCoupon(price: number, percent: number): number {
	throw new Error("Not implemented");
}

// src/shared/coupon.test.ts
import { describe, expect, it } from "vitest";
import { applyCoupon } from "./coupon.ts";

describe("applyCoupon", () => {
	it("returns the original price when percent is 0", () => {
		expect(applyCoupon(1000, 0)).toBe(1000);
	});

	it("floors fractional cent discounts", () => {
		expect(applyCoupon(999, 10)).toBe(899);
	});

	it("throws RangeError when percent is outside 0..100", () => {
		expect(() => applyCoupon(1000, 101)).toThrow(RangeError);
	});
});
```

## Implementation

Implementation starts only after the user approves the plan's checkpoint card and any open decisions. Build directly on the committed skeleton and acceptance tests:

1. Read the design document, the code skeleton, and the committed acceptance tests. Treat them as the specification.
2. Run the committed acceptance tests before editing production code, and record the command and test output in your Worker report or PR body. Confirm that every test for new or changed behavior still fails on the current branch and that every regression test confirming an unchanged existing rule runs and passes before implementation. If any test for new or changed behavior already passes or any regression test fails before implementation, stop and report the mismatch before editing production code.
3. Fill in the function bodies until every acceptance test passes, including both the tests for new or changed behavior and the regression tests for unchanged existing rules. Do not modify, delete, skip, or weaken the acceptance tests written in the planning step. You may add extra unit tests for internal edge cases in separate test blocks or files.
4. If implementation shows that a signature, type, contract, or acceptance test must change, stop instead of rewriting the test. Report the conflict and your recommendation in the `偏离` and `问题` fields of your Worker report so the Project Manager can decide whether to revise the plan.
5. Do not create parallel modules or duplicate function names alongside the skeleton.

## Verification

Before you report done, confirm all four checks:

- The finished code matches the skeleton's public types and contracts.
- Every acceptance scenario in Section 8 has a passing test on HEAD. Your Worker report or PR body includes a recorded pre-implementation run showing that every test for new or changed behavior failed before implementation and that every regression test confirming an unchanged existing rule ran and passed before implementation.
- Implementation commits did not delete, skip, or weaken any acceptance test from the planning step.
- You saved every command output, local real-CLI run output, and real-browser screenshot listed in Section 8, and updated any fake CLI that disagreed with the real CLI.
