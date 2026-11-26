# Plan and code-skeleton standard

Follow this standard whenever a task asks for a design plan. The workflow runs in one line: design plan (or two independent designs and a synthesis step for complex work), Project Manager plan review, implementation, parallel logic and real-environment review, fix and re-review (up to 3 rounds), Project Manager merge, and delivery of the acceptance evidence to the user.

A planning step commits a design document in `docs/<topic>-design.md`, a compiling TypeScript code skeleton in the target files, and runnable acceptance tests. Before implementation starts, confirm and record that every test for new or changed behavior fails and that every regression test confirming an unchanged existing rule passes. Later implementation steps fill in the function bodies until every acceptance test passes.

## Design document

Write `docs/<topic>-design.md` in plain English following `.agents/skills/technical-writing/SKILL.md` and `.agents/skills/unslop/SKILL.md`. Directly under `# <Title>`, record the snapshot date and git commit (`> Snapshot: YYYY-MM-DD (commit \`<sha>\`)`) so readers can see which codebase state the document describes (`src/docs-guard.test.ts` enforces this line and `docs/README.md` indexing). Keep every section below in order. Write `None` when a section does not apply.

### Two-agent planning for complex tasks

When the Project Manager judges a task complex (no fixed threshold applies), planning splits into two phases:

1. **Two independent designs.** Two Workers on different vendors each write a complete design document on their own. Do not write the code skeleton or acceptance tests during this phase.
2. **Synthesis.** A synthesis Worker chooses one design as the base and grafts the stronger parts of the second design onto it. Record explicitly in Section 3 which design is the base, what parts came from the second design, and why. The synthesis step then delivers the final design document, the compiling code skeleton, and the runnable acceptance tests.

### Plan review and decisions

Keep the opening section focused on what the Project Manager checks before implementation starts, and on any decision that must escalate to the user:

- **Files to review.** Link each deliverable file with one sentence on what it covers.
- **Project Manager plan review.** Before implementation starts, the Project Manager checks the plan against three criteria: every quoted user sentence in Section 1 maps to at least one acceptance scenario, no applicable verification category in Section 8 is missing (and every omitted category states in one sentence why it cannot apply), and the candidate designs in Section 3 are genuinely structurally distinct. If any check fails, the Project Manager sends the plan back for revision.
- **Decisions needed.** The Project Manager decides routine design questions and notes each choice in the report. Escalate to the user with a decision card only in three cases:
  - User-visible behavior or interface changes.
  - Fixing the root cause requires rebuilding the foundation and multiplies the work several times over.
  - Irreversible or external-facing operations.
  For every rule sent to the user for approval, attach a concrete example or a screenshot showing what the user will see under that rule. Write `None` when no user decision is needed.
- **Task Graph sequencing note.** Task Graph checkpoints currently pause only for the user, not for Project Manager review. Until Task Graph supports a Project Manager review pause, run planning as a standalone step and append the implementation and review steps only after the Project Manager approves the plan.

### For Workers and reviewers

Include all eight sections below in order for downstream Workers and reviewers:

1. **User goal.** Quote the user's original request first, then state the intended outcome in one or two sentences.
2. **Current state and history.** Read the code you will change by following the `/how` method (`.agents/skills/how/SKILL.md`: trace key concepts, runtime flow, ownership, and gotchas yourself without spawning subagents). Inspect earlier design documents (including deleted ones retrieved from git history) and past commits that touched this area. Record all of the following:
   - **Design history.** State what premise the original design rested on, which later changes altered that premise, and whether the current code is a stack of patches.
   - **Core concepts.** List what states exist, who has write authority over each state, which facts are stored in more than one place, and what concept is missing.
   - **Verified evidence.** Label each finding `[Measured]` or `[Inferred]` with `path:line` references. For measured claims, state how you ran the check.
3. **Reference designs and approach comparison.** Document how 2 to 3 mature products or open-source projects solve the same problem, with links. Design documents (`docs/*-design.md`) may name reference products. PR descriptions, commit messages, UI copy, and code comments must not. Then compare candidates in a table and state your recommendation:
   - **Challenge patched foundations.** If earlier patches buried the foundation, include introducing the missing concept (or rebuilding the foundation) as a candidate design, and flag it in the `偏离` field of your Worker report so the Project Manager can weigh it.
   - **Structurally distinct designs.** Present at least two designs with genuinely different structures, not small edits inside one structure. Start from libraries already listed in `docs/dependencies.md` and established patterns. One candidate must be the design you would build if you started from day one.
   - **Design red flags.** Screen every candidate against `.agents/skills/architect/references/design-red-flags.md` and note how the chosen design avoids each applicable red flag.
   - **Patch rationale.** If you recommend a patch instead of fixing the root cause, explain why you are not fixing the root cause and estimate how large the root-cause fix would be.
   - **Synthesis record.** When synthesizing two independent designs for a complex task, state which design is the base, which parts you grafted from the other design, and why.
4. **Performance and bounds.** When touching caches, snapshots, or collections that grow over time, address all four rules in `AGENTS.md` ("Caches and state bounds"). List new `src/shared/limits.ts` constants in a table with values and one-month sizing math, or write `None` and explain why.
5. **Cross-vendor and cross-platform unification.** Show how one shared definition covers every registered vendor in `src/shared/vendors.ts` and all three platforms (`macOS`, `Windows`, and `Linux` via `src/daemon/platform/index.ts`), and name the single file a future vendor must implement.
6. **Deletions.** List superseded code paths, docs, and prompt text to delete in the same PR so old and new logic never coexist.
7. **Skeleton files.** List each created or modified file with one sentence on its responsibility, including the acceptance test files. Do not paste function signatures that already live in the code skeleton.
8. **Verification plan.** Prove the change works on real artifacts. Passing unit tests alone is not enough. Include all three items below:
   - **Acceptance scenarios.** Write plain-language scenarios from the user's quoted sentences in Section 1 and from every settled rule. Write each scenario in three concrete parts: what happens first, what happens next, and what the user should see. Map every quoted sentence and every settled rule to at least one scenario. Include at least one scenario for each applicable category. If a category cannot apply, write one sentence explaining why:
     - Two consecutive turns in the same conversation.
     - A restart in the middle of the operation.
     - A state or configuration change while work or a notice waits in a queue.
     - Existing rules or boundaries that the change touches or uncovers. Read `REVIEW.md` from `main` (`git show origin/main:REVIEW.md`), list every rule whose `Trigger:` matches a file the plan will change, and state one by one how this design satisfies each rule.
     - Reopening a closed view after cached data becomes stale. Hold the refresh open long enough to check what the view shows before the new response arrives.
     - Large data volume sized for one month of continuous use (300 finished Workers, 30,000 messages, 50,000 step logs).
     - Malformed or dirty data: corrupt formats, half-written records, data left by older versions, and abnormal events from vendor CLIs.
     - Cross-vendor coverage across every registered vendor in `src/shared/vendors.ts`, including prompt-cache preservation. State how the change affects prompt caching across vendors: never modify the system prompt, the tool or MCP list, or previously sent messages mid-session, and never prepend content before existing messages (append to the end only). Whenever a change touches session prompts, messages, tools, or MCP definitions, compare before and after `TokenUsage.cacheRead` (parsed by `src/daemon/driver/protocol.ts`, `src/vendors/_common/acp/protocol.ts`, and vendor `src/vendors/*/protocol.ts` modules) from real sessions for every affected vendor under comparable conditions: the same vendor, the same model, and a comparable session and warm-up.
     - Cross-platform coverage across macOS, Windows, and Linux.
     - Cross-entry-point and layout coverage: wide and narrow web screens, Feishu, the `hub` CLI, and multiple computers.
   - **Real-environment and real-CLI verification.** Name where each scenario runs in a real environment and what evidence it produces. Every scenario that runs must produce complete evidence (a screen recording or a start-to-finish screenshot sequence, never a single static screenshot). Only the listed unavailable cases below may record the scenario, the reason, and `not verified` instead, and `not verified` never counts as verified or passing:
     - **Web flows.** Start an isolated local Bellwood instance with a separate temporary data directory and capture a Playwright screen recording or a start-to-finish screenshot sequence for each scenario. Web-only flows that do not depend on a missing real dependency run locally and cannot claim `not verified`. When a web scenario also depends on a missing real dependency (such as a real vendor CLI that cannot run safely isolated locally and cannot run on a testbed), the exception applies only to that missing dependency. Run the web portion that can execute in the isolated local instance with a Playwright screen recording or a start-to-finish screenshot sequence, and record only the missing real-dependency portion with the scenario, the reason, and `not verified` (which does not count as verified or passing).
     - **Real CLI scenarios.** Vendor CLI behavior must be proved by the real-environment review track running against the real vendor CLI (locally or on a dedicated testbed). Hand-written fake events and fake CLIs serve only as automated regression tests for fast cloud checks and cannot prove vendor CLI behavior on their own. A run that passes only against hand-written fake events or a fake CLI counts as `not verified` against the real CLI. Before running locally, confirm that the temporary Bellwood instance isolates vendor config so the real CLI cannot alter the user's own vendor configuration. If safe isolation is not verified or the vendor CLI is not installed or logged in locally, run the scenario on a dedicated testbed when available. Only when the vendor CLI cannot run safely isolated locally and cannot run on a testbed either, record the missing real-CLI portion with the scenario, the reason, and `not verified` until a dedicated testbed is available. If the real CLI disagrees with a fake CLI, update the fake CLI and add a test in the same PR.
     - **Prompt-cache preservation (hard gate).** Prompt-cache verification is separate from the general real-CLI `not verified` exception and cannot be waived with a local-unavailability note. Whenever a change touches session prompts, messages, tools, or MCP definitions, compare before and after `TokenUsage.cacheRead` from real sessions for every affected vendor using the same vendor, the same model, and a comparable session and warm-up. If an affected vendor cannot run locally, run the comparison on the testbed. Only when an affected vendor cannot run either locally or on a testbed, mark that vendor `not verified` and have the Project Manager escalate to the user with a decision card for that vendor. Without explicit user approval for that vendor, review judges `FAIL` and the PR cannot merge. If the user approves proceeding without that vendor's comparison, record the decision card ID and the user's exact quote in the PR body. Once review verifies that recorded approval, review does not judge `FAIL` for that unavailable vendor's missing comparison. If a measured real-session comparison shows `TokenUsage.cacheRead` regressed, review always judges `FAIL` and blocks merge regardless of any approval.
     - **Feishu, multi-computer mesh, and desktop app flows.** Run on the testbed or with Computer Use. When neither is available locally, record the scenario, the reason, and `not verified`.
     - **Local load.** Run at most one real-environment verification or review session on the local machine at a time.
   - **Commands and visual checks.** Name the exact acceptance test files, `pnpm verify`, the real-environment video or start-to-finish screenshot sequence planned for each runnable acceptance scenario (and any listed environment gap that will be recorded as `not verified`), and the command outputs to capture.

## Code skeleton and acceptance tests

Write the skeleton and acceptance tests directly in the target production and test files rather than a scratch directory:

- **Data shapes and migrations.** Define TypeScript interfaces and discriminated unions. For schema changes, add the next numbered SQL file in `migrations/` and its line in `migrations/manifest.sha256` ([Ledger database](ledger-database.md)).
- **Module boundaries.** Create target modules and export their public functions and types. Skip unexported private helpers.
- **Function signatures.** Write full parameter and return types without `any`. Use a single-line body: `throw new Error("Not implemented");`.
- **Contracts.** Document caller-observable preconditions and postconditions on exported functions with concise `/** */` doc comments. State module-wide invariants once at the top of the file. Do not prescribe internal data structures or step-by-step control flow. Public API contract comments remain after implementation per `.agents/skills/no-comments/references/comment-sicko.md`.
- **Acceptance tests.** Write real runnable tests with assertions in the matching `*.test.ts` and `*.test.tsx` files so every acceptance scenario in Section 8 and every contract clause maps to at least one executable test. Do not use `it.todo` placeholders for acceptance scenarios. Automated tests may use hand-written fake events and fake CLIs as fast regression tests in cloud CI, but they cannot prove vendor CLI behavior on their own. Vendor CLI scenarios still require real-environment verification against the real vendor CLI (locally or on a testbed), or a documented `not verified` record for a listed exception. Prompt-cache preservation remains a separate hard gate that requires comparable real-session verification, or per-vendor user approval recorded in the PR body only when an affected vendor cannot run locally or on a testbed, and any measured `TokenUsage.cacheRead` regression still fails.
- **Existing callers.** When changing an existing signature, update call sites so `pnpm typecheck` passes without altering runtime behavior yet.

Before you commit the plan, run `pnpm typecheck` and confirm it exits 0. Then run every acceptance test file (`pnpm exec vitest run <test-files>`) with no syntax or type errors. Confirm that every test for new or changed behavior fails against the skeleton or current code, and that every regression test confirming an unchanged existing rule runs and passes. Record the command and test output in your Worker report or PR body so downstream Workers and reviewers can verify this pre-implementation baseline.

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

Implementation starts once the Project Manager approves the plan (and after the user resolves any decision card when one of the three escalation cases applies). The Project Manager opens a draft PR after the plan is pushed, and every later implementation and fix step pushes to the same branch.

Build directly on the committed skeleton and acceptance tests:

1. Read the design document, the code skeleton, and the committed acceptance tests. Treat them as the specification.
2. Run the committed acceptance tests before editing production code, and record the command and test output in your Worker report or PR body.
   - **Single-step implementation or first step of a multi-step plan.** Confirm that every test for new or changed behavior still fails on the current branch and that every regression test confirming an unchanged existing rule runs and passes. Stop and report a mismatch if any test for new or changed behavior already passes or any regression test fails.
   - **Later step of a multi-step implementation plan.** Tests satisfied by earlier implementation steps on this branch are expected to pass already. Confirm that every test for the unimplemented behavior assigned to this step still fails, and that tests already completed by earlier implementation steps plus regression tests for unchanged existing rules run and pass. Stop and report a mismatch if a test for this step's unimplemented behavior already passes, or if an earlier step's completed test or an unchanged-rule regression test fails.
3. Fill in the function bodies until every acceptance test in your step passes (and every acceptance test in the plan passes once the final implementation step finishes). Do not modify, delete, skip, or weaken the acceptance tests written in the planning step. You may add extra unit tests for internal edge cases in separate test blocks or files.
4. If implementation shows that a signature, type, contract, or acceptance test must change, stop instead of rewriting the test. Report the conflict and your recommendation in the `偏离` and `问题` fields of your Worker report so the Project Manager can decide whether to revise the plan.
5. Do not create parallel modules or duplicate function names alongside the skeleton.
6. After your local verification gate passes, push to the branch and hand off right away (to the next implementation step, or to parallel logic and real-environment review alongside cloud CI). Exception: if the change touches platform code this machine cannot test (Linux `bwrap`, Windows native, or desktop packaging), wait for cloud CI checks before handing off as described in `docs/review-and-merge.md`.

## Verification and acceptance evidence

Every completed plan requires a full acceptance package before merge and delivery to the user:

- **Contract match.** The finished code matches the skeleton's public types and contracts, and implementation commits did not delete, skip, or weaken any acceptance test from the planning step.
- **Test results.** Record the pre-implementation baseline (confirming that before the first implementation commit, every test for new or changed behavior failed and every regression test for an unchanged existing rule ran and passed), the post-implementation commands and full passing output on HEAD, and the cloud CI check results.
- **Real-environment evidence.** Evaluate every acceptance scenario in Section 8 under one rule. Every scenario that ran in a real environment must include a screen recording (video) or a complete start-to-finish sequence of screenshots (never a single static screenshot). Web-only flows that do not depend on a missing real dependency run locally and cannot claim `not verified`. When a web scenario also depends on a missing real dependency (such as a real vendor CLI that cannot run safely isolated locally and cannot run on a testbed), run the web portion that can execute in the isolated local instance with a Playwright recording or start-to-finish screenshot sequence, and record only the missing real-dependency portion with the scenario, the reason, and `not verified`. Every scenario or dependency portion blocked by a listed unavailable case (a real vendor CLI that cannot run safely isolated locally and cannot run on a testbed for general real-CLI scenarios, or missing testbed and Computer Use for Feishu, multi-computer mesh, or desktop app scenarios) must record the scenario, the reason, and `not verified`, which does not count as verified or passing. A scenario fails review if it has neither complete evidence nor a listed `not verified` record, if a web-only flow claims `not verified`, or if a web scenario with a missing real dependency omits local Playwright evidence for its runnable web portion. Update any fake CLI that disagreed with the real CLI in the same PR.
- **Prompt-cache preservation evidence (hard gate).** Whenever a change touches session prompts, messages, tools, or MCP definitions, include comparable before and after `TokenUsage.cacheRead` results from real sessions for every affected vendor (same vendor, same model, comparable session and warm-up), running on the testbed when unavailable locally. Only when an affected vendor cannot run either locally or on a testbed, record that vendor as `not verified` and have the Project Manager escalate to the user with a decision card for that vendor. Without explicit user approval for that vendor, review judges `FAIL` and blocks merge. If the user approves proceeding without that vendor's comparison, record the decision card ID and the user's exact quote in the PR body. Once review verifies that recorded approval, review does not judge `FAIL` for that unavailable vendor's missing comparison. If a measured real-session comparison shows `TokenUsage.cacheRead` regressed, review always judges `FAIL` and blocks merge regardless of any approval.
- **Merge and delivery.** Once parallel reviews pass (or logic review passes for docs and rules changes), cloud CI is green, and no unresolved hard gate remains (such as an affected vendor whose prompt-cache check cannot run locally or on a testbed and is `not verified` without recorded per-vendor user approval on a Project Manager decision card, or any measured `TokenUsage.cacheRead` regression), the Project Manager merges without waiting for user approval to merge, then delivers the test results and real-environment evidence (recordings or screenshot sequences for scenarios that ran, plus any `not verified` records) to the conversation and Router.
