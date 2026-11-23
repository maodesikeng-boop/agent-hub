# Review stamp design

> Snapshot: 2026-11-22 (commit `9f2269fa`)

## For the user

### Files to review

- [docs/review-stamp-design.md](review-stamp-design.md): this plan. It covers how the daemon posts a commit status after an independent review, and how this repository requires that status before high-risk PRs merge.
- [REVIEW.md](../REVIEW.md): the new "Paths that require a review stamp" section, which is the proposed high-risk path list.
- [.github/workflows/review-stamp.yml](../.github/workflows/review-stamp.yml) and [scripts/review-stamp-gate.ts](../scripts/review-stamp-gate.ts): this repository's merge gate, with the workflow complete and the script as a skeleton.
- [src/daemon/git/review-status.ts](../src/daemon/git/review-status.ts), [src/daemon/ledger/workers/review-stamp.ts](../src/daemon/ledger/workers/review-stamp.ts), and [src/shared/review.ts](../src/shared/review.ts): the product skeleton that posts the status and records the outcome in the ledger.

### Decisions needed

1. **Which identity the daemon uses to post the status.**
   - A. **Recommended.** Add a per-project GitHub login, set with `hub project review-status --account <login>` (Project Manager only). For each post, the daemon runs `gh auth token --user <login>` and passes the token to one `gh api` call as `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` on a GitHub Enterprise host). The ledger stores only the login, in a new `project_review_status` table. The token is never written to the repository, the ledger, a log, or a command line. On this machine `maodesikeng-boop` is already logged in to gh as a second account, so the setup is one command after this PR merges. With no login set, the daemon uses gh's active account.
   - B. Pick automatically: try each account gh has logged in for the host and use the first one with push permission. This needs no setup, but the daemon would choose which account acts without anyone deciding.
   - C. Give the daemon a personal access token in an environment variable. That puts a long-lived secret in a launchd plist, a shell profile, or the Windows desktop shell's environment, and each desktop shell needs its own setup path.
   - D. Use gh's active account only. Here the active account is `zn01okok`, which cannot write to this repository, so every post would be skipped unless the active account changes. You already decided to keep `zn01okok` as the active account.
2. **Which paths count as high-risk.** I measured the last 100 merged PRs (method under "Current state").
   - A. **Recommended.** Use a curated list in `REVIEW.md`: sandboxes and write scopes, vendor launch arguments, ledger storage and migrations, device trust, relay, Feishu, the review mechanism and `.github/**`, and release and packaging scripts. **56 of 100** PRs would have needed a stamp.
   - B. Use every `Trigger:` glob in `REVIEW.md`. **89 of 100** PRs would have needed a stamp, because `**/*.test.ts`, `src/web/**`, and `scripts/**` are triggers.
   - C. Require a stamp on every PR (100 of 100). This contradicts the decision that only high-risk paths need one.
3. **How to require the status only for those paths.** Branch protection can only require a status on every PR.
   - A. **Recommended.** Branch protection requires the one status `bellwood/review`. A `pull_request_target` workflow reads the list from `main` and posts `bellwood/review` itself. It posts success when the PR touches no listed path, and pending, naming the first matching file, when it does. The daemon's success after a PASS then replaces the pending status. The workflow never replaces a status that someone other than itself posted.
   - B. Add a separate gate status that a workflow recomputes when `bellwood/review` arrives, using the `status` event. GitHub runs `status` workflows only from the default branch and attaches them to the default branch's head commit. The gate would need its own plumbing to find the PR, and it cannot be rehearsed before it merges.
4. **What a FAIL posts.**
   - A. **Recommended.** Post `failure` on the reviewed commit. GitHub then shows that a review happened and failed, merging stays blocked, and a later re-review of the same commit can replace it with success.
   - B. Post nothing on FAIL. Merging stays blocked by the gate's pending status, but GitHub shows no record of the failed review.
5. **Repository settings the Project Manager changes after you approve and this PR merges.** Add `bellwood/review` to the required status checks on `main` with source "any". The daemon posts it with a user token and the workflow posts it with the Actions token, so pinning the check to the GitHub Actions app (as `check (ubuntu 1/4..4/4)` are pinned now) would reject the daemon's status. Keep the four `check` contexts and enforcement for admins. Change no other setting. Two side effects:
   - Open PRs that never ran the new workflow stay blocked until they get a new push or are closed and reopened.
   - Any push after a review moves the head commit, so a high-risk PR needs a new review before merge. That includes merging `main` into the branch. I recommend accepting this for the first version. Carrying a stamp across commits that touch no listed path is possible later.

## For Workers and reviewers

### 1. User goal

> 独立审查判 PASS（或 PASS+NOTES）后，由 Bellwood 守护进程在被审的那个提交上挂一个 GitHub 提交状态；FAIL 不挂成功。本仓库要求：改到高风险路径的 PR，没有这个状态就合不进 main。高风险路径怎么界定、怎么做到只对这些路径要求，由方案定。第一版用现有 GitHub 账号，不配 GitHub App。顺手在 `hub worker start` 的用法说明里加一句：独立审查请用单步审查图（审查步骤），不要用普通 Worker 审。

The review verdict leaves a machine-checkable mark on GitHub. In this repository, a high-risk PR without a PASS stamp on its head commit cannot merge. Any other project gets the stamp when it is on GitHub and has permission, and nothing breaks when it is not.

### 2. Current state

- [Measured] Of the last 100 merged PRs, 57 have no review comment and none has a native GitHub review (`/tmp/review-stamp/dev-process-audit.md`, P1-7).
- [Measured] Branch protection on `main` requires `check (ubuntu 1/4)` through `check (ubuntu 4/4)`, pinned to app 15368 (GitHub Actions), with `enforcement_level: everyone`. Checked with `gh api repos/maodesikeng-boop/agent-hub/branches/main --jq .protection`.
- [Measured] gh 2.100.0 on this machine has two github.com accounts in the keyring: `zn01okok` (active) and `maodesikeng-boop`. Both have `repo` scope. Checked with `gh auth status --json hosts`, tokens redacted. `gh auth token --user <login>` prints a chosen account's token.
- [Measured] A review report that says done with PASS returns `outcome: "verify"` (`src/daemon/ledger/task-graphs/turn-report.ts:227`). `insertReport` then enqueues `review.verify` (`src/daemon/ledger/workers/reports.ts:125`). The handler compares the branch, remote, and PR with the snapshot (`src/daemon/handlers.ts:290`) and calls `insertReport` again with `reviewVerified` (`src/daemon/ledger/workers/worktree.ts:121`). Only after that does `cleanDoneIn` complete the step (`turn-report.ts:228`). FAIL stops at `reviewStopOf` (`turn-report.ts:72`) and never runs the branch check.
- [Measured] The review snapshot already holds the full reviewed SHA and the PR (`number`, `state`, `url`) from `gh pr list --head` (`src/shared/review.ts` `ReviewSnapshot`, `src/daemon/handlers.ts:200`).
- [Measured] All gh calls go through the private `runGh` in `src/daemon/git/pr.ts:51`, which sets `GH_PROMPT_DISABLED` and resolves `gh.cmd` on Windows. It returns only PR shapes.
- [Measured] Durable actions have per-type retry policies and an `actionFailedIn` hook after the last attempt (`src/shared/actions.ts`, `src/daemon/ledger/workers/worktree.ts:163`). Finished action rows are pruned after `ACTIONS_TERMINAL_RETENTION_DAYS` (14).
- [Measured] Paths covered: I saved `gh pr list --state merged --limit 100 --json number,files` and matched every file with Node 24's `path.matchesGlob`. The union of all 90 `Trigger:` globs in `REVIEW.md` hits 89 PRs. The 22-glob list in the new `REVIEW.md` section hits 56 PRs (55 if test files are ignored). The most common hits are `migrations/**` (22), `src/daemon/feishu/**` (17), `scripts/stage-*.ts` (12), and `.github/**` (10).
- [Inferred] GitHub rulesets cannot make a required status conditional on changed paths. Their file-path rules block pushes instead. So path selection has to happen in a workflow.

### 3. Approach comparison

Where the daemon hooks in:

| Option | Retries and restarts | FAIL covered | Coupling |
| --- | --- | --- | --- |
| **New `review.stamp` action, enqueued in `insertReport` when a review report becomes final** | Uses the action executor's backoff, and survives a daemon restart | Yes | GitHub errors never touch the verdict or the step |
| Post inside the `review.verify` handler | Shares verify's retries, so a GitHub outage would delay the PASS | No, because FAIL never runs verify | A failed post would look like a failed verify |

Identity: see decision 1. Option A reuses gh's keyring, where the token already lives, and adds only a one-row-per-project login table.

This repository's gate:

| Option | Path-selective | Testable before merge | Moving parts |
| --- | --- | --- | --- |
| **One required status, posted by a `pull_request_target` gate workflow and replaced by the daemon** | Yes | Yes: unit tests, plus `--dry-run` against real PRs | One workflow and one script |
| Separate gate status recomputed on the `status` event | Yes | No: `status` workflows run only from `main` | Two contexts plus PR lookup |
| Require `bellwood/review` on every PR | No | Yes | None |
| CODEOWNERS with required approving reviews | Yes | Yes | Needs a second account to approve. A GitHub App was already rejected. |

Recommendation: a `review.stamp` action, a per-project gh account, and one required status with a gate workflow. Each reuses machinery that already exists: the action executor, gh's keyring, and branch protection's required contexts.

Flow after the change:

1. The review Worker reports. `reviewStampRequestOf(report, target, reviewVerified)` returns `success` for a verified PASS or PASS+NOTES, `failure` for a well-formed FAIL, and null otherwise.
2. `insertReport` calls `enqueueReviewStampIn` once a review report is final: after the branch check for a PASS, or right away for a FAIL. It skips reports with a pending follow-up or a forced note. The dedupe key is `workerId:reportMessageId`, and an existing row under that key in any status blocks a second enqueue, because the executor re-runs a finished action enqueued again. Keying on the report instead of the SHA lets a FAIL followed by a PASS on the same commit post both.
3. `createReviewStampHandler` reads `getReviewStampTask`: the main folder, the snapshot PR, and the project account. It then calls `postReviewStatus`. The task is null once the stamp is stale: its Worker is no longer the step's latest Worker, or that Worker has replied after the stamped report. A late retry therefore never posts over a newer verdict or a takeover's verdict. The executor runs `review.stamp` actions one at a time, so two posts cannot land on GitHub out of order.
4. `postReviewStatus` resolves the repository from the PR URL, or from gh's `{owner}/{repo}` placeholder in the main folder when there is no PR. It gets a token for the account and posts `bellwood/review`.
5. `onReviewStamped` writes `reviewStamp` (`posted` or `skipped` with a reason) on the step artifact, unless the stamp went stale while it ran. The delivery note and `hub graph show` print it. Nothing wakes the Project Manager, and nothing changes the step's status.

Skips, with no error and one ledger line each: gh is missing or not logged in, the account is not logged in, the folder is not a git repository, no remote is on GitHub, the PR is on another host, the account lacks permission (403 or 404), or the commit was never pushed (422). Timeouts, network errors, and 5xx responses retry up to 3 times, then `actionFailedIn` records a skip.

The gate posts nothing when the PR head moved past `HEAD_SHA` while it read the file list; the run for the newer push decides. Otherwise it decides by these rules, in order (`decideGateStatus`):

1. A `bellwood/review` status from anyone other than `github-actions[bot]` is a review verdict. Keep it.
2. If the PR touches no listed path and the file list is complete, post success: "No high-risk paths changed; review stamp not required".
3. Otherwise post pending: "Needs an independent review PASS on this commit: `<first matched file>`".

The workflow, the gate script, and `REVIEW.md` are themselves on the stamp list, so loosening the gate needs a review PASS. The gate script imports no other repository module, and `scripts/ci-workflows.test.ts` fails when a module it runs falls outside the list.

Trust boundary: anyone with write access can post a commit status through the API. Without a GitHub App this cannot be prevented. The gate stops accidental merges of unreviewed or failed work. It does not stop a collaborator who deliberately bypasses it.

### 4. Performance and bounds

Each review verdict creates one action row and runs at most two gh processes (`gh auth token`, then `gh api`). A month of 300 finished Workers means at most 300 stamp actions, and rows are pruned after 14 days like every other action. The `reviewStamp` artifact field is bounded by `MAX_REVIEW_STAMP_REASON_CHARS`. Nothing is cached, so no invalidation rules apply. The token is held in memory for one call.

| Constant | Value | Sizing |
| --- | --- | --- |
| `REVIEW_STAMP_TIMEOUT_MS` | 15,000 | One `gh api` POST. That is 3x the PR probe's 5 s, because it writes. |
| `MAX_REVIEW_STAMP_REASON_CHARS` | 300 | One redacted skip reason per review step. 300 steps a month × 300 chars ≈ 90 KB, inside `MAX_NODE_ARTIFACT_BYTES` per step. |
| `MAX_REVIEW_STATUS_ACCOUNT_CHARS` | 100 | One login per project. GitHub logins are at most 39 characters. |

### 5. Cross-vendor and cross-platform unification

The stamp depends on the review step, not on the vendor that ran it, so every vendor in `src/shared/vendors.ts` gets it without vendor code. `execGh` in `src/daemon/git/gh.ts` is the one gh runner. It keeps the Windows `PATHEXT` and cmd-shim resolution that `runGh` has today, and macOS and Linux spawn `gh` directly. A future code host, such as GitLab commit statuses, would implement one sibling of `src/daemon/git/review-status.ts` with the same `postReviewStatus` contract. The handler would pick that implementation from the PR URL's host.

### 6. Deletions

- `runGh` in `src/daemon/git/pr.ts` is replaced by `execGh`. `probePr` and `probePrByUrl` keep their signatures and parse on top of `execGh`.
- The task-graph skill sentence "判 PASS 后后台核对被审分支、远端和 PR 在审查期间没被动过，没动过才往下走。" (`src/shared/task-graph-skill.ts:41`) gains a clause saying the daemon also posts the verdict as a commit status when the project is on GitHub. The clause must be worded for any project. The sentence is extended in place, with no second copy.
- `AGENTS.md` "When to merge" gains one sentence pointing to the `REVIEW.md` stamp section. No other text is superseded.

### 7. Skeleton files

- `src/shared/review.ts`: `REVIEW_STATUS_CONTEXT`, the stamp request and outcome types, `reviewStampRequestOf`, and `reviewStatusDescription`.
- `src/shared/actions.ts`: the `review.stamp` action type with its params, dedupe key, and retry policy.
- `src/shared/domain.ts`: `TaskArtifact.reviewStamp`.
- `src/shared/ledger.ts`: `ReviewStampTask`, `getReviewStampTask`, and `onReviewStamped` on `Ledger`.
- `src/shared/limits.ts`: the three constants above.
- `migrations/0048_project_review_status.sql` and `migrations/manifest.sha256`: the `project_review_status` side table, one row per project that sets a login. It uses a side table rather than `ADD COLUMN` so the migration can re-run. It is registered in `src/shared/resource-registry.ts` as bounded config, and implementation adds its `DELETE` next to `project_folders` in the PM purge (`src/daemon/ledger/persona.ts`).
- `src/daemon/ledger/workers/review-stamp.ts`: enqueues stamps, serves the task, records outcomes, and records the final failure.
- `src/daemon/ledger/task-graphs/review-stamp.ts`: writes the outcome to the step artifact through the new `recordReviewStampIn` graph hook.
- `src/daemon/ledger/projects.ts`: `validReviewStatusAccount` for the new hub command.
- `src/daemon/git/gh.ts`: the shared gh runner.
- `src/daemon/git/review-status.ts`: resolves the repository, gets the token, posts the status, and maps errors to skip reasons.
- `src/daemon/handlers.ts`: `createReviewStampHandler`. `src/daemon/daemon.ts` registers it during implementation.
- `scripts/review-stamp-gate.ts` and `.github/workflows/review-stamp.yml`: this repository's gate.
- `REVIEW.md`: the high-risk path list.
- Tests (`it.todo`): `src/shared/review.test.ts`, `src/daemon/git/review-status.test.ts`, `src/daemon/git/gh.test.ts`, `src/daemon/handlers.test.ts`, `src/daemon/ledger/task-graph-review.test.ts`, `src/daemon/ledger/ledger-projects-persona.test.ts`, `src/hub/cli.test.ts`, `scripts/review-stamp-gate.test.ts`, and `scripts/ci-workflows.test.ts`.

Implementation also wires these pieces, which the skeleton leaves out so runtime behavior stays unchanged until then:

- the `hub project review-status` command: `HUB_COMMANDS`, args and result types, the role map, the agent-api schema and byte cap, the CLI parse and usage, and the Feishu permission lists that already name `project.setup`;
- the `hub status` line that shows the account;
- the `hub worker start` usage sentence about single-step review graphs;
- the `insertReport` call site;
- clearing `reviewStamp` when a new review report merges into the artifact;
- the `actionFailedIn` branch;
- handler registration in `daemon.ts`.

### 8. Verification plan

- Unit and ledger tests: every `it.todo` above becomes a real test and fails before its code exists. `src/daemon/git/review-status.test.ts` runs a fake `gh` on `PATH` that records its arguments and environment. It asserts the token appears only in `GH_TOKEN` and never in arguments, results, or thrown messages. A real-git case in a temp folder covers no git, no remote, and a non-GitHub remote. It shows the quiet skip and its ledger reason, with no network access.
- `src/daemon/ledger/task-graph-review.test.ts`: a review graph judged PASS enqueues exactly one `review.stamp` with `success` on the snapshot SHA. FAIL enqueues `failure`. A report error or a moved branch enqueues none. A skipped outcome lands on the step artifact without changing the step's status.
- Gate rehearsal before merge (`pull_request_target` runs only from `main`): `GITHUB_REPOSITORY=maodesikeng-boop/agent-hub PR_NUMBER=<n> HEAD_SHA=<sha> GH_TOKEN=<read token> node scripts/review-stamp-gate.ts --dry-run` against three real PRs: one touching `migrations/**` (expects pending), one docs-only (expects success), and this PR after a stamp exists (expects keep). Paste the outputs into the PR.
- Live stamp, with the Project Manager's approval because it writes to GitHub: run `postReviewStatus` from the branch with account `maodesikeng-boop` on this PR's head commit, then attach the output of `gh api repos/maodesikeng-boop/agent-hub/commits/<sha>/statuses --jq '.[] | {context, state, description, creator: .creator.login}'`. Do the same with a FAIL request on a scratch commit, and show it is `failure`, never `success`.
- After merge, with the Project Manager: `hub self-reload` and `hub project review-status --account maodesikeng-boop`. Then enable the required context and show `gh pr view <n> --json mergeStateStatus` as `BLOCKED` for a high-risk PR before its review and `CLEAN` after the PASS stamp. A docs-only PR is unaffected.
- `pnpm typecheck`, `pnpm test:related`, `pnpm verify`, and green PR checks.
