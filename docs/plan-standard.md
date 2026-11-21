# Plan and code-skeleton standard

Follow this standard whenever a task asks for a design plan. A planning step delivers two artifacts on the same branch: a design document in `docs/<topic>-design.md` and a compiling TypeScript code skeleton in the real target files. Subsequent implementation steps fill in function bodies on that exact skeleton.

## Design document

Write `docs/<topic>-design.md` in plain English following `.agents/skills/technical-writing/SKILL.md` and `.agents/skills/unslop/SKILL.md`. Keep every section below in order; write `None` when a section does not apply.

### For the user

Keep the opening section focused on two items only:

- **Files to review.** Link each deliverable file with a one-sentence description of what it covers.
- **Decisions needed.** List each open product or scope trade-off with concrete options and your recommendation, or write `None`.

### For Workers and reviewers

Include all eight sections below in order for downstream Workers and reviewers:

1. **User goal.** Quote the user's original request first, then state the intended outcome in one or two sentences.
2. **Current state.** Label each finding `[Measured]` or `[Inferred]` with `path:line` references. For measured claims, state how you ran the check.
3. **Approach comparison.** Compare at least two candidate designs in a table, starting from libraries already listed in `AGENTS.md` and standard industry approaches, then state your recommendation and why.
4. **Performance and bounds.** When touching caches, snapshots, or collections that grow over time, address all four rules in `AGENTS.md` ("Caches and state bounds"). List new `src/shared/limits.ts` constants in a table with values and one-month sizing math, or write `None` and explain why.
5. **Cross-vendor and cross-platform unification.** Show how one shared definition covers every registered vendor in `src/shared/vendors.ts` and all three platforms (`macOS`, `Windows`, and `Linux` via `src/daemon/platform/index.ts`), and name the single file a future vendor must implement.
6. **Deletions.** List superseded code paths, docs, and prompt text to delete in the same PR so old and new logic never coexist.
7. **Skeleton files.** List each created or modified file with one sentence on its responsibility. Do not paste function signatures that already live in the code skeleton.
8. **Verification plan.** Specify how implementation will prove the change works on real artifacts: exact test files, `pnpm verify`, screenshots, or command outputs. "Tests pass" alone is not enough.

## Code skeleton

Write the skeleton directly in the target production and test files rather than a scratch directory:

- **Data shapes and migrations.** Define TypeScript interfaces and discriminated unions. For schema changes, add the next numbered SQL file in `migrations/` and its line in `migrations/manifest.sha256` ([Ledger database](ledger-database.md)).
- **Module boundaries.** Create target modules and export their public surface. Skip unexported private helpers.
- **Function signatures.** Write full parameter and return types without `any`. Use a single-line body: `throw new Error("Not implemented");`.
- **Contracts.** Document caller-observable preconditions and postconditions on exported functions with concise `/** */` doc comments. State module-wide invariants once at the top of the file. Do not prescribe internal data structures or step-by-step control flow. Public API contract comments remain after implementation per `.agents/skills/no-comments/references/comment-sicko.md`.
- **Test skeleton.** Add `it.todo("<observable behavior>")` cases in the matching `*.test.ts` file so every contract clause maps to at least one test.
- **Existing callers.** When changing an existing signature, update call sites so `pnpm typecheck` passes without altering runtime behavior yet.

Run `pnpm typecheck` before committing the skeleton; it must exit 0.

Example skeleton:

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
import { describe, it } from "vitest";

describe("applyCoupon", () => {
	it.todo("returns the original price when percent is 0");
	it.todo("floors fractional cent discounts");
	it.todo("throws RangeError when percent is outside 0..100");
});
```

## Implementation

Implementation steps build directly on the committed skeleton:

1. Read the design document and skeleton files; treat the skeleton as the specification.
2. Convert `it.todo` entries into real assertions and confirm they fail before writing production logic.
3. Fill in function bodies until the tests pass without weakening assertions or bypassing contracts.
4. If implementation reveals that a signature, type, or contract must change, update it and explain what changed and why in the `偏离` field of your Worker report.
5. Do not create parallel modules or duplicate function names alongside the skeleton.

## Verification

Confirm that the finished code matches the skeleton's public types and contracts, every contract clause has a passing test, and all evidence listed under "Verification plan" is captured.
