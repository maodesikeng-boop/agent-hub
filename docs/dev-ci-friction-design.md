# Repository CI and collaboration friction

> Snapshot: 2026-11-26 (commit `3542ab5e`)

This plan covers four problems in how this repository is built and merged. It changes only this repository's workflows, scripts, `AGENTS.md`, and `REVIEW.md`. It changes no text that ships to other users' projects (`src/daemon/prompt.ts`, `src/shared/task-graph-skill.ts`, `src/shared/review.ts`).

## For the user

### Files to review

- [This design document](dev-ci-friction-design.md): root cause, history, options with outside references, recommendation, and cost for each of the four problems, plus the cloud acceptance drills.
- [`scripts/migration-claims.ts`](../scripts/migration-claims.ts) and [`scripts/migration-claims.test.ts`](../scripts/migration-claims.test.ts): skeleton and failing tests for the guard that catches two open PRs taking the same migration number.
- [`scripts/pr-body-sync.ts`](../scripts/pr-body-sync.ts) and [`scripts/pr-body-sync.test.ts`](../scripts/pr-body-sync.test.ts): skeleton and failing tests for syncing a PR description from a pushed tag, so a Worker never needs an owner token.
- [`scripts/review-stamp-gate.ts`](../scripts/review-stamp-gate.ts) and [`scripts/review-stamp-carry.test.ts`](../scripts/review-stamp-carry.test.ts): skeleton and failing tests for carrying a review stamp across an update that only merges `main`.
- [`scripts/wait-checks.ts`](../scripts/wait-checks.ts) and [`scripts/wait-checks-fresh.test.ts`](../scripts/wait-checks-fresh.test.ts): failing tests for reporting a PR whose checks ran on an older `main`.
- [`scripts/ci-friction.test.ts`](../scripts/ci-friction.test.ts): failing workflow guards for the shared apt installer, the PR-description workflow, and the migration-claims job.

### Decisions needed

Nothing here changes what a Bellwood user sees, so per the new process the Project Manager decides. Three items need the repository owner's account, because they are GitHub settings or need `admin` rights that Workers and the default `gh` account (`zn01okok`) do not have.

1. **Require branches to be up to date before merging (problem 2).** Options: (a) turn it on after the stamp carry-forward lands; (b) keep it off and keep merging `main` locally and running `pnpm typecheck` before each merge, as the Project Manager does today (GitHub reports `BEHIND` only in strict mode, so `wait-checks.ts` cannot catch it); (c) move the repository into an organization to unlock GitHub's merge queue. **Recommendation: (a).** Order matters: turning it on before carry-forward makes every update need a new review. Operation, run by the owner once the implementation PR is merged:
   - Web: Settings → Branches → rule for `main` → check "Require branches to be up to date before merging" → Save.
   - CLI: `gh api -X PATCH repos/maodesikeng-boop/agent-hub/branches/main/protection/required_status_checks -F strict=true` with the owner account active.
2. **Make `migration-claims` a required check (problem 4).** Options: (a) required; (b) advisory only, with `wait-checks.ts` as the gate. **Recommendation: (a)**, added after the job has reported green at least once (GitHub only offers checks that ran in the last 7 days). Operation: Settings → Branches → rule for `main` → "Require status checks to pass" → add `migration-claims`.
3. **How Workers update a PR description (problem 3).** Options: (a) the tag-triggered workflow in this plan, no token; (b) a fine-grained personal access token limited to this repository with only "Pull requests: write", handed to Workers through the project environment; (c) give `zn01okok` the Write role; (d) process only: Workers put the description in their hand-off and the Project Manager applies it at merge. **Recommendation: (a), with (d) as the rule until (a) merges.** (b) and (c) need the owner to create a credential or grant a role, and (c) also lets the default account push and merge.

### Checkpoint card

1. Playwright system packages come from a cached, timed install with a mirror fallback; a stalled apt mirror costs at most a few minutes and falls back instead of timing the job out.
2. A PR whose checks ran on an older `main` cannot merge until it is updated, and the update keeps the review stamp when it only merged `main`.
3. A Worker updates a PR description by pushing a tag; the PR head commit, its checks, and its review stamp stay as they were.
4. When two open PRs take the same migration number, the PR with the higher number fails a check that names the other PR and the next free number, usually before either PR is reviewed.

## For Workers and reviewers

### 1. User goal

> 把这些产品问题和流程问题，按照我们的新流程去分别优化
>
> 要注意各家厂商缓存的问题，不能破坏缓存了

This plan takes the four process problems the Project Manager reported on 2026-11-26 (section B of the friction notes) and removes the round trips they cause: re-running a stalled smoke job, hand-merging to check a PR against a newer `main`, stopping a Worker to wait for a description sync, and renumbering a migration after a merge.

None of these changes touch vendor sessions, system prompts, tool lists, or messages, so no vendor prompt cache is affected. The one agent-visible change is new text in `AGENTS.md`. Vendors read that file when a session starts; running sessions keep their cached prefix, and new sessions start with the new text once, the same as any `AGENTS.md` edit.

### 2. Current state

#### Problem 1: the smoke job installs Playwright's system packages from a live mirror on every run

- [Measured] `.github/workflows/check.yml:200` runs `pnpm exec playwright install --with-deps chromium webkit` with no condition. The browser cache at `check.yml:192-197` only covers `~/.cache/ms-playwright`. `--with-deps` runs `apt-get update` and `apt-get install` for the system libraries every time, cache hit or not. `.github/workflows/release.yml:106` does the same for Chromium.
- [Measured] Over the last 25 `check` runs (`gh run view <id> --json jobs`), the "Install Playwright browsers" step took 18 to 289 seconds, usually about 25 seconds. On PR #452 the first attempt of run 45748851401 spent 03:26:09 to 03:36:00 in that step: the log shows `Ign:2 http://azure.archive.ubuntu.com/ubuntu resolute InRelease` after 32 seconds and then no progress until the 10-minute job timeout (`check.yml:168`) cancelled it. Attempt 2 passed in 47 seconds.
- [Measured] The `check` job already solved the same failure for `bubblewrap` and `socat` on 2026-11-12 (`3e947076`, `6219de1f`): cached `.deb` files keyed by runner image (`check.yml:76-84`), a hard `timeout` on every apt call (`check.yml:118-123`), and a rewrite to `archive.ubuntu.com` when the Azure mirror fails (`check.yml:125-138`). Commit `da5d828c` proved the fallback by simulating a broken mirror on a temporary commit, then `e6855404` reverted it.
- [Measured] The smoke job came later, in `42ad066e` (#421, 2026-11-23), with Chromium only. `8776f581` (#436) added WebKit for the layout-switch check, which pulls the largest share of the system packages. Neither commit reused the hardened install, so the repository has two ways to install apt packages and only one of them survives a stalled mirror.
- [Measured] `pnpm exec playwright install-deps --dry-run` (Playwright 1.65.1) exits non-zero when a required package is missing and changes nothing, so a job can tell whether cached packages are enough before it touches the network.

#### Problem 2: PR checks run against the `main` of the moment they started

- [Measured] `check.yml:7-8` runs on `pull_request`. GitHub tests the merge of the PR head into `main` as it was when the event fired. Nothing re-runs the checks when `main` moves later. Branch protection currently does not require branches to be up to date: PR #452's checks stayed green after #453 merged, and the Project Manager merged #452 by hand-merging locally and running `pnpm typecheck` first.
- [Measured] `scripts/wait-checks.ts:286-288` fails fast only on a textual conflict (`mergeable=CONFLICTING` or `mergeStateStatus=DIRTY`). A PR that merges cleanly but breaks against the new `main` passes `wait-checks.ts`.
- [Measured] The review stamp is bound to the PR head commit. `scripts/review-stamp-gate.ts:73-84` keeps a stamp posted by a reviewer and otherwise posts pending on any listed path. `scripts/post-review-stamp.ts:151-155` refuses to stamp a moved head. `REVIEW.md` says "A new push changes the head commit, so it needs a new review." So updating a stamped branch with `main` costs a new review today.
- [Inferred] That cost is why strict up-to-date mode cannot simply be turned on. #408 (`9f2269fa`) added the stamp and #420 (`57f91c30`) added `wait-checks.ts` a day apart, and neither commit or its design text mentions updating a branch with `main`.
- [Measured] GitHub's merge queue is "available in any public repository owned by an organization" ([Managing a merge queue](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)). This repository is public and owned by the user account `maodesikeng-boop`, so the merge queue is not available without a transfer.
- [Inferred] With strict mode on, GitHub reports `mergeStateStatus=BEHIND` for a PR whose base moved, which `wait-checks.ts` can read from the same `gh pr view` call it already makes.

#### Problem 3: a Worker cannot edit its PR description

- [Measured] `gh auth status` on this machine: the active account is `zn01okok`, and `maodesikeng-boop` is logged in but inactive. `zn01okok` can read this public repository but has no write role, so `gh pr edit` fails for it. The remote is SSH (`git@github.com:maodesikeng-boop/agent-hub.git`), so Workers can push branches and tags.
- [Measured] The Project Manager borrows the owner token with `gh auth token --user maodesikeng-boop` (`scripts/post-review-stamp.ts:99-112`, `AGENTS.md` "When to merge"). Claude Code's safety check blocks a Worker from doing the same, which is the right call: that token can merge, change settings, and delete the repository.
- [Measured] On 2026-11-26 five Workers each spent one extra round trip reporting "please sync the PR description" and waiting.
- [Inferred] A workflow started by a `push` event uses the workflow file from the pushed commit, so anyone who can push can already run a workflow with any permission the repository allows. Letting a pushed tag edit a PR description adds no capability a pusher lacks today.

#### Problem 4: parallel PRs take the same migration number

- [Measured] `src/daemon/store/migrate.ts:61-63` requires manifest line N to be version N, so migration numbers form one contiguous sequence. A PR takes "latest on `main` plus one" when it starts. Two PRs started from the same `main` take the same number.
- [Measured] Collisions on record: #441, #443, and #445 all used `0051`; #451 still carries `migrations/0054_worker_app_approvals.sql` while `main` has `0054_system_wakeups.sql` from #453 (`gh pr view 451 --json files`).
- [Measured] `docs/ledger-database.md:31` relies on Git: both PRs append to the end of `migrations/manifest.sha256`, so the second to merge conflicts. That conflict appears only after the first PR merges. By then the second PR is usually reviewed and stamped, and `migrations/**` is a stamp path, so renumbering costs a fix, a new CI run, and a new review.
- [Inferred] Problem 2 widens this gap. A guard that runs only inside the PR's own checks evaluates once per push. If the other PR adds its migration later, this PR's green result is never re-evaluated. A guard must also run at merge time.

### 3. Approach comparison

Each problem lists one design that keeps the current structure and one designed as if the repository had started this way. The architect red-flag list (`.agents/skills/architect/references/design-red-flags.md`) is checked in the last column.

#### Problem 1

| Option | What changes | Outside reference | Cost | Red flags |
| --- | --- | --- | --- | --- |
| A. One shared apt installer | Move the `check` job's cache, timeout, and mirror-fallback script into a composite action `.github/actions/apt-install`. Each caller passes a "packages present" probe and an install command. The smoke job probes with `playwright install-deps --dry-run` and installs with `playwright install-deps chromium webkit`; `check` probes with `command -v bwrap socat`. Browsers install separately with `playwright install chromium webkit`, skipped on a browser cache hit. Release smoke uses the same action. | [Playwright CI](https://playwright.dev/docs/ci) installs with `--with-deps`; [actions/cache](https://github.com/actions/cache) for the `.deb` files | Small: one composite action, three call sites | Removes "two ways to do one task" |
| B. Playwright container image (from scratch) | Run the smoke job in `mcr.microsoft.com/playwright:v1.65.1-noble`, which already has browsers and system packages. A guard ties the image tag to the locked Playwright version. | [Playwright Docker](https://playwright.dev/docs/docker), the container example in [Playwright CI](https://playwright.dev/docs/ci) | Medium: about a 1.5 GB pull from a different registry each run, root user inside the container, a second version to bump | Hand-synced list (image tag and lockfile) unless guarded |
| C. Retry only | Wrap the existing `--with-deps` in a timeout and retry once | none | Smallest | Keeps two installers; a retry hits the same mirror |

**Recommendation: A.** It fixes the root cause, which is that the hardened installer exists once and the smoke job does not use it. B is the cleanest design for a fresh repository, but it trades the apt mirror for a registry pull of similar size and adds a second version number to keep in sync. Cached packages make the common path skip the network: on a cache hit the probe passes and apt never runs.

#### Problem 2

| Option | What changes | Outside reference | Cost | Red flags |
| --- | --- | --- | --- | --- |
| A. Strict up-to-date plus stamp carry-forward | Owner turns on "Require branches to be up to date". `review-stamp.yml` passes `github.event.before`; when the new head only merged `main` into an already stamped head and the PR's own added and removed lines are unchanged, the gate posts `success` with a "carried from" description. `wait-checks.ts` reports `BEHIND` as a failure with the update command. | [About protected branches: strict checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [Update a PR branch API](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch), the "not rocket science rule" behind [bors](https://graydon2.dreamwidth.org/1597.html) | Medium: one gate function and one workflow env var; each later PR re-runs CI (about 3 minutes) after every merge ahead of it | none: the stamp stays owned by the gate and the reviewer |
| B. Merge queue (from scratch) | Transfer the repository to an organization, require the merge queue, add `merge_group` triggers to every required workflow, and teach the gate to post `bellwood/review` on the queue's temporary commit when every PR in the group is stamped | [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [Mergify merge queue](https://docs.mergify.com/merge-queue/) | Large: repository transfer (changes URLs, release links, relay and update checker configuration), every workflow, and the gate | none, but the transfer is hard to reverse |
| C. Local freshness gate only | `wait-checks.ts` or a `merge-ready` script merges `main` into a temporary worktree and runs `pnpm typecheck` and `pnpm test:related` before the Project Manager merges | none | Small to build, but not enforced by GitHub and runs on the Project Manager's machine | Two places decide "mergeable" |

**Recommendation: A.** It gets the merge-queue guarantee (every merge was tested on the `main` it lands on) with settings this repository has today. Without carry-forward, strict mode would turn every merge into a new review for every other open PR, which is worse than the current problem. B stays open for when the repository moves to an organization; A's carry-forward rule is the same rule B's gate would need.

Carry-forward rule: compare, file by file, the ordered list of added and removed lines in the PR diff before and after the update, ignoring hunk headers and context lines. Carry the stamp only if the file list, each file's change type, and those lines are identical, the GitHub API returned a patch for every file, and the previous head's latest `bellwood/review` status is a `success` posted by someone other than the gate. A merge that needed conflict resolution changes the PR's own lines, so it gets a new review.

#### Problem 3

| Option | What changes | Security boundary | Cost |
| --- | --- | --- | --- |
| A. Tag-triggered description sync | A Worker writes the description to a file and runs `git tag -f -a --cleanup=verbatim pr-body/<PR> -F <file> origin/main` and `git push -f origin refs/tags/pr-body/<PR>`. `--cleanup=verbatim` matters: Git's default cleanup strips lines that start with `#`, which would delete every Markdown heading. Tagging `origin/main` makes the workflow file come from `main`. `.github/workflows/pr-body.yml` runs on `push` of `pr-body/*` tags with `pull-requests: write` and `contents: write`, reads the tag message, sets the description of that open PR, and deletes the tag. | Anyone who can push can already run a workflow with these permissions. The workflow only edits the description of an open PR whose head is in this repository, and caps the body at GitHub's 65,536 characters. It never posts statuses, so it cannot forge a review stamp. No credential is stored. | Small: one workflow and one script. The PR head commit does not change, so checks and the stamp stay. |
| B. Fine-grained personal access token | Owner creates a token for this repository only with "Pull requests: write", and the project setup exposes it to Workers as `GH_TOKEN` | The token can edit, comment on, label, and close PRs, but cannot push or merge (merging needs "Contents: write"). It lives in the environment, so a leak reaches every PR until it expires. See [fine-grained tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens). | Owner creates and rotates it |
| C. Write role for `zn01okok` | Add the default account as a collaborator with Write | The default account can then push to any branch and merge any PR that passes protection | One setting, too broad |
| D. Process only | Workers put the description in the hand-off and keep going; the Project Manager applies it once before merge | No new access | No code. The Project Manager still runs one command per PR, and reviewers see a stale description until merge. |

Prior art: [release-please](https://github.com/googleapis/release-please) and [release-drafter](https://github.com/release-drafter/release-drafter) edit PR and release text from a workflow token instead of a personal token. [Changesets](https://github.com/changesets/changesets) keeps per-PR text in per-PR files so parallel PRs do not edit one shared file.

**Recommendation: A, with D as the written rule until A merges.** A is the only option with no credential to create or leak and no new role. Keeping the tag off the PR branch matters: committing the description, as a file or an empty commit, would move the head and drop the review stamp, and a file would also land on `main` with the squash merge.

#### Problem 4 (designed together with problem 2)

| Option | What changes | Outside reference | Cost |
| --- | --- | --- | --- |
| A. Early claim check | `scripts/migration-claims.ts` lists migrations each open PR adds and compares them with `main`'s latest version read from the API, not from the PR's merge base. A PR fails when a version is already on `main` or is also added by an open PR with a lower number. It runs in three places: a `migration-claims` job in `check.yml` on every PR, `wait-checks.ts` before it reports a pass, and locally as `node scripts/migration-claims.ts --next` to pick a number. | [Alembic branches](https://alembic.sqlalchemy.org/en/latest/branches.html) (`alembic heads` detects two migrations with one parent); [Django migrations](https://docs.djangoproject.com/en/stable/topics/migrations/) (`makemigrations --check` reports conflicting leaf nodes) | Small: one script, one job, one call in `wait-checks.ts` |
| B. Graph or timestamp versions (from scratch) | Name migrations by timestamp or slug, record applied migrations in a table instead of `PRAGMA user_version`, and order by a parent pointer | [Rails migrations](https://guides.rubyonrails.org/active_record_migrations.html) (timestamp versions, `schema_migrations` table); [Flyway out-of-order](https://documentation.red-gate.com/fd/flyway-out-of-order-setting-277578985) | Large: a ledger format change that every installed release must upgrade through, and new tests in `test/e2e/release-upgrade.test.ts` |
| C. Number at merge time | PRs add `migrations/pending/<name>.sql`; a merge script assigns the number and pushes just before merge | none | Medium, and it moves the head right before merge, so the stamp needs carry-forward plus a new rule for renamed files |

**Recommendation: A.** The collision is cheap to fix before review and expensive after it, and A moves detection to the first push. B is the right shape for a new project, since numbering would stop being a shared counter, but sequential `user_version` is fine at this repository's pace, and changing it puts every user's ledger upgrade at risk for a developer-only problem.

How A interacts with problem 2: the PR's own check runs once per push, so it can go stale in one case. PR #10 adds `0055` after PR #11 already passed with `0055`. #10 wins because it has the lower number, but #11's green check never re-runs. Two independent layers close that gap. `wait-checks.ts` re-runs the claim check with fresh data before it reports a pass, so #11 fails at merge time. And once strict mode is on, #11 must update after #10 merges, and its re-run fails both the claim check and `loadMigrations()` on the new manifest. Tie-break by PR number, not by who pushed first, because GitHub does not expose push times and commit dates can be set by the pusher.

A gap left by a closed PR (for example #11 took `0056` because #10 held `0055`, then #10 closed) is caught by `loadMigrations()` in CI once #11 runs against current `main` ("lists 0056 where version 55 belongs"), and `--next` tells the Worker to take `0055`.

### 4. Performance and bounds

No new cache, snapshot, or growing in-memory collection. Bounds for the new API reads, sized for one month (about 300 PRs):

| Constant (in the script) | Value | Why |
| --- | --- | --- |
| `MIGRATION_CLAIMS_MAX_OPEN_PRS` | 100 | One page of `GET /pulls`. This repository has 4 open PRs today; past 100 the check fails closed and names the cap instead of skipping PRs. |
| `PR_FILES_API_MAX` (existing) | 3,000 | GitHub's list-files limit; a truncated list fails the claim check closed, like the stamp gate. |
| `PR_BODY_MAX_CHARS` | 65,536 | GitHub's PR body limit; a longer tag message is rejected, not cut. |

Tags: one `pr-body/<PR>` tag at a time per PR, deleted after each sync, so at most one per open PR. The apt `.deb` cache is keyed by runner image version, so GitHub's cache eviction (least recently used, 10 GB per repository) handles its size.

### 5. Cross-vendor and cross-platform unification

- Vendors: Every vendor's Worker runs the same `git tag` and `git push` commands and the same `node scripts/*.ts` commands through its shell tool. No vendor file changes. Acceptance drill 3 runs once from a Claude Worker and once from a Codex Worker, because their sandboxes differ.
- Platforms: The workflows run on GitHub's Ubuntu runners only. The local scripts (`wait-checks.ts`, `migration-claims.ts --next`) use `execGh` from `src/daemon/git/gh.ts` and no shell syntax, so they run the same on macOS, Windows (PowerShell or cmd), and Linux. The tag commands contain no quoting or here-documents, because the description goes in a file passed with `-F`.
- Entry points: none. No web, Feishu, or `hub` surface changes.

### 6. Deletions

- The inline apt script in `check.yml` (lines 73-145) moves into `.github/actions/apt-install/action.yml`; `check.yml` keeps only the call.
- Every `playwright install --with-deps` in `.github/workflows/` (`check.yml:200`, `release.yml:106`).
- `AGENTS.md` gains the tag sync rule in "Plans, commits, and pull requests"; nothing it replaces is written down today, because the Project Manager's habit of syncing descriptions lives only in its own notes. `docs/ledger-database.md:31` ("the second one to merge has a Git conflict. Resolve it by renumbering") is replaced by the claim check and `--next`.
- `REVIEW.md` "Paths that require a review stamp": the sentence "A new push changes the head commit, so it needs a new review" gains the carry-forward exception.

### 7. Skeleton files

- `scripts/migration-claims.ts`: claim parsing, conflict detection, next free number, and the CLI used by CI, `wait-checks.ts`, and Workers.
- `scripts/migration-claims.test.ts`: failing tests for parsing, conflicts with `main` and open PRs, tie-break, next number, and fail-closed caps.
- `scripts/pr-body-sync.ts`: tag name parsing and the sync decision for the tag-triggered workflow.
- `scripts/pr-body-sync.test.ts`: failing tests for tag parsing, open versus closed PRs, cross-repository heads, empty and oversize bodies.
- `scripts/review-stamp-gate.ts`: adds `CARRIED_STAMP_PREFIX`, `PrDiffFile`, and `decideStampCarry`, and documents that `decideGateStatus` keeps a carried stamp.
- `scripts/review-stamp-carry.test.ts`: failing tests for carry-forward and for keeping a carried stamp on a re-run.
- `scripts/wait-checks-fresh.test.ts`: failing tests for the `behind` and `migration-claim` verdicts.
- `scripts/ci-friction.test.ts`: failing workflow guards (no `--with-deps`, shared apt action, step timeout, `pr-body.yml` triggers and permissions, no other workflow fires on `pr-body/*` tags, `migration-claims` job, `review-stamp.yml` passes the previous head).

Implementation also adds `.github/actions/apt-install/action.yml` and `.github/workflows/pr-body.yml`, edits `check.yml`, `release.yml`, `review-stamp.yml`, `wait-checks.ts` (`REQUIRED_MAIN_CHECKS` and the two verdicts), `AGENTS.md`, `REVIEW.md`, and `docs/ledger-database.md`.

### 8. Verification plan

#### Acceptance scenarios

Each scenario: what happens first, what happens next, what the Project Manager sees. Each maps to a test, and to a cloud drill where a local test cannot prove it.

1. **Stalled mirror.** First: a run starts with no `.deb` cache. Next: the Azure apt mirror hangs. Seen: the install step times out its apt call within 2 minutes, logs the switch to `archive.ubuntu.com`, installs, and the smoke job passes inside its 10-minute limit. Test: `ci-friction.test.ts` (every apt call in the action is under `timeout`, and the fallback rewrite exists). Cloud drill 1.
2. **Cached packages.** First: a run saves the `.deb` cache. Next: a second run on the same runner image. Seen: the probe passes after `dpkg -i`, no `apt-get update` line in the log, and the step takes under 30 seconds. Cloud drill 1.
3. **Stale `main` blocks the merge.** First: PRs A and B are green; A renames an exported function and B adds a call to the old name, with no textual conflict. Next: A merges. Seen: B shows "This branch is out-of-date", `wait-checks.ts B` fails with reason `behind` and the update command, and after the update B's `check (ubuntu 1/4)` fails on `pnpm typecheck`. Tests: `wait-checks-fresh.test.ts`. Cloud drill 2.
4. **Stamp survives a clean update.** First: B is stamped. Next: B merges `main` with no conflict and pushes. Seen: `bellwood/review` on the new head is `success` with "carried from <old sha>", and no new review is requested. Tests: `review-stamp-carry.test.ts`. Cloud drill 2.
5. **Stamp does not survive an edited update.** First: B is stamped. Next: B merges `main` and changes one of its own lines in the same push, or resolves a conflict. Seen: `bellwood/review` is pending with the usual "Needs an independent review PASS" description. Tests: `review-stamp-carry.test.ts`.
6. **Worker updates a description.** First: a Worker on PR N writes a description file. Next: it pushes the `pr-body/N` tag. Seen: within a minute the PR description equals the file, the PR head SHA, checks, and `bellwood/review` are unchanged, and the tag is gone. Tests: `pr-body-sync.test.ts`, `ci-friction.test.ts`. Cloud drill 3.
7. **Two PRs take one number.** First: PR #X adds `0055_a.sql`. Next: PR #Y (higher number) adds `0055_b.sql`. Seen: #Y's `migration-claims` job fails with "0055 is also added by open PR #X; take 0056", and #X stays green. Tests: `migration-claims.test.ts`. Cloud drill 4.
8. **Late claim by the lower-numbered PR.** First: #Y (higher) passed with `0055`. Next: #X (lower) pushes `0055` later. Seen: #Y's checks stay green, but `wait-checks.ts #Y` fails with reason `migration-claim`. Tests: `migration-claims.test.ts`, `wait-checks-fresh.test.ts`. Cloud drill 4.

Required categories:

- **Two consecutive turns:** two pushes in a row to one PR. Scenario 4 chains (a carried stamp carries again), and scenario 6 force-updates the same tag twice; the second sync wins.
- **Restart mid-operation:** a cancelled or re-run job. A re-run of the smoke job uses the `.deb` cache when the first attempt saved it and repeats the fallback otherwise. `pr-body.yml` is idempotent: re-running it sets the same body, and a missing tag is a no-op.
- **State change while queued:** `main` moves while checks run (scenario 3), the other PR closes while a claim conflict is open (gap case, section 3), and the PR closes before the tag sync runs (sync skips; test in `pr-body-sync.test.ts`).
- **Existing rules:** `REVIEW.md` rules on `main` that match the changed paths: "Paths that require a review stamp" (`.github/**`, `scripts/review-stamp-gate.ts`), so the implementation PR needs a stamp; "Tests wait for events, not for time" (`**/*.test.ts`): the new tests are pure functions with no timers; "Detached child processes and temp dirs stay inside the session boundary" (`scripts/**`): the new scripts start only `gh` through `execGh` and write no temp files; and, once #454 merges, "Planned acceptance scenarios cover every requirement", which this section answers. `src/code-hygiene.test.ts` limits and `scripts/ci-workflows.test.ts` invariants (no cancelled `main` runs, `setup-node` cache rule, review-stamp permissions) still hold.
- **Large data:** 100 open PRs and 3,000-file PRs fail closed (section 4); a 65,536-character body is accepted and one more character is rejected.
- **Malformed data:** a tag named `pr-body/abc` or `pr-body/0`, a lightweight tag, an empty tag message, a body whose headings start with `#`, a manifest line that is not `<sha>  <version>_<name>.sql`, a migration name without a number, and a GitHub file entry without a `patch`. Each has a test.
- **Cross-vendor:** drill 3 from a Claude Worker and from a Codex Worker. Other vendors run the same shell commands; they are not separately drilled.
- **Cross-platform:** workflows run on Ubuntu only. The local scripts run in the existing `scripts/*.test.ts` suite, which CI runs on Ubuntu and `nightly.yml` runs on Windows and macOS.
- **Cross-entry and layout:** does not apply. No web, Feishu, `hub`, or multi-computer surface changes.

#### Cloud drills

Each drill runs on GitHub, not only in unit tests, and its PR links go into the implementation PR body.

1. **Mirror fallback.** On a throwaway branch, add one temporary commit that points the apt sources at an unreachable host, the way `da5d828c` did. Open a draft PR, record the smoke job log showing the timeout and the switch to `archive.ubuntu.com`, then push a second commit that reverts it and record a run showing the `.deb` cache hit. Close the draft PR without merging.
2. **Stale `main` and carry-forward.** After the owner turns on strict mode, open two draft PRs from current `main`: A renames an unused test helper and B calls it. Mark A ready, merge it after review, then run `node scripts/wait-checks.ts <B>` and save the output. Update B with `git merge origin/main` and push, save the `bellwood/review` status, and confirm the typecheck failure. Close B.
3. **Description sync.** On the implementation PR itself, have a Claude Worker and then a Codex Worker each push a `pr-body/<PR>` tag. Save `gh pr view <PR> --json body,headRefOid,statusCheckRollup` before and after, and `git ls-remote origin 'refs/tags/pr-body/*'` after.
4. **Migration claims.** Open draft PRs X and Y that each add `migrations/0055_drill_<x|y>.sql` with `SELECT 1;` and the manifest line. Save Y's failing `migration-claims` log. Then push a commit to X that changes its migration content (still `0055`), and run `node scripts/wait-checks.ts <Y>` with Y's checks green against an earlier claim set. Close both without merging.

#### Commands

- Pre-implementation record (taken on this branch at the plan commit: 39 new-behavior tests fail, the 3 unchanged-rule tests in the same files pass, and the 98 tests in the existing files pass): `pnpm exec vitest run scripts/migration-claims.test.ts scripts/pr-body-sync.test.ts scripts/review-stamp-carry.test.ts scripts/wait-checks-fresh.test.ts scripts/ci-friction.test.ts` fails on every new-behavior test; `pnpm exec vitest run scripts/ci-workflows.test.ts scripts/wait-checks.test.ts scripts/review-stamp-gate.test.ts scripts/post-review-stamp.test.ts` (plus `src/daemon/store/migrate.test.ts`, `src/docs-guard.test.ts`, `src/code-hygiene.test.ts`, and `src/prompt-portability.test.ts`) passes, proving the existing rules hold.
- After implementation: the same five files pass, `pnpm typecheck`, `pnpm lint`, `pnpm test:related`, and the four drill outputs.
