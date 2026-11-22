# Release flow

## For the user

### Files to review

- [Design](release-flow-design.md) checks the audit's release findings against current `main` and describes the locked installer build, the release gates, and the release candidate flow.
- [Releasing](#releasing) is the runbook for candidates, promotion, rehearsals, yanking, and restoring a pre-upgrade backup.
- [Changelog](../CHANGELOG.md) holds the release notes of every version, backfilled with v0.1.0 to v0.3.0.
- [Staged lockfile contract](../scripts/staged-lockfile.ts) defines how the installer build reuses `pnpm-lock.yaml` instead of resolving versions again.
- [Release plan contract](../scripts/release-plan.ts) defines which tags may publish, when a formal tag reuses a release candidate, and where release notes come from.
- [GitHub release contract](../scripts/release-github.ts) defines how the workflow reads releases, publishes without overwriting, runs dry, and yanks a bad release.
- [Build commit contract](../scripts/stage-runtime-common.ts) defines the commit recorded in each installer's `runtime-manifest.json`.
- Test cases: [staged lockfile](../scripts/staged-lockfile.test.ts), [release plan](../scripts/release-plan.test.ts), [GitHub release](../scripts/release-github.test.ts), [build commit](../scripts/stage-runtime-common.test.ts), and [workflow guards](../scripts/ci-workflows.test.ts).

### Decisions

The user approved option A for all four decisions on 2026-11-22.

1. **Release candidates before every formal release.** A: a formal `vX.Y.Z` publishes only after a published `vX.Y.Z-rc.N` on the same commit and reuses that candidate's installers byte for byte.
2. **GitHub immutable releases.** A: turn the repository setting on. It is a repository setting, so the maintainer runs `gh api -X PUT repos/maodesikeng-boop/agent-hub/immutable-releases` once. v0.1.0 to v0.3.0 stay mutable.
3. **Rollback after a bad formal release.** A: roll forward. `release-assets.ts yank` takes the bad release off `releases/latest`, and users who already upgraded follow [Restore after a bad upgrade](#restore-after-a-bad-upgrade).
4. **Changelog.** A: `CHANGELOG.md` replaces `.github/release-notes.md`. The downloads and checksum table that every release repeats moved to `.github/release-downloads.md`, which `publish` appends to the version's section.

Code signing, toolchain pins, and Action SHA pins are out of scope (see "Current state").

## For Workers and reviewers

### 1. User goal

> 都按照你的推荐来，顺便帮我审审开发流程

> 按三批推进，第一批本周开工

Before v0.4.0, every installer that reaches users must contain the dependency tree CI tested, come from a commit that passed the full suite on all three platforms, be installed by a person as a release candidate first, and map to exactly one commit. A bad release must have a documented way back.

### 2. Current state

This section checks audit findings P0-2, P0-3, and the build-commit part of P2-10 (written 2026-11-21 on `662abf22`) against base `838329f1`. GitHub facts come from read-only `gh api` and `gh run` calls on 2026-11-22.

**P0-2: the installer build bypasses the lockfile.** Still true.

- [Measured] `buildStagedDaemonPackageJson` copies the root caret ranges into the staged `package.json` (`scripts/stage-runtime-common.ts:155-183`). `stageDaemonTree` then runs `pnpm install --prod --no-lockfile --prefer-offline` (`scripts/stage-runtime-common.ts:373-381`) and deletes the lockfile pnpm writes (`:403`). To measure the drift, `/tmp/release-flow-exp/prune-lock.ts` built today's staged `package.json`, and both installs ran in fresh directories against the shared pnpm store. The `--no-lockfile` install downloaded 2 packages and installed 6 of 249 packages at versions the lockfile does not have: `ws` 8.22.1 to 8.23.0, `cookie` 2.0.1 to 2.0.2, `semver` 7.8.5 to 7.8.6, `mdast-util-to-markdown` 2.2.1 to 2.2.2, `@types/node` 24.19.2 to 26.6.6, and `undici-types` 7.24.6 to 8.9.0. Full output: `/tmp/release-flow-exp/lockfile-drift.txt`.
- [Measured] The fix works with pnpm 10.34.5. The same probe pruned `pnpm-lock.yaml` to the 22 daemon dependencies and their closure (294 of 881 snapshots, 89 KB). `pnpm install --prod --frozen-lockfile --offline --ignore-scripts --config.node-linker=hoisted --config.package-import-method=copy` accepted it in 8.3 s: 0 resolved, 0 downloaded, 249 added.
- [Measured] `.github/workflows/windows-desktop.yml:130` runs `pnpm dlx @tauri-apps/cli@^2`. `@tauri-apps/cli` is in neither `package.json` nor `pnpm-lock.yaml`. In the v0.3.0 build log (job `136346394063`), that CLI then downloads NSIS 3.13 and `nsis_tauri_utils` v0.5.3 from GitHub.
- [Inferred] The NSIS download URLs and hashes are compiled into the CLI, so pinning the CLI version pins them too.
- [Measured] `collectDaemonRuntimeDependencyNames` still finds dependency names with a regex (`scripts/stage-runtime-common.ts:113-153`). The hardcoded `@microsoft/mxc-sdk` at `:118` is redundant, because `src/daemon/platform/win32/mxc-readonly.ts:16` already matches the regex. The scan picks names, not versions. After this change a missed package fails the bundled `--self-test` instead of shipping a floating version, so this plan leaves the scan alone.
- [Measured] Other build inputs still float and stay out of scope (audit P2-9): `dtolnay/rust-toolchain@stable` (`.github/workflows/windows-desktop.yml:74`), the Xcode `swiftc` of the `macos-15` image (`scripts/build-mac-app.sh:87`), and Actions pinned by major tag.

**P0-3: releases skip the full suite, race the tag, and have no candidate or rollback.** Partly fixed by branch protection, otherwise still true.

- [Measured] `.github/workflows/release.yml:33-137` runs `verify` (one test file and a version check), the two installer builds, `assemble`, and `publish`. It never calls `check.yml`, `windows.yml`, the macOS suite, or `pnpm verify`. The v0.3.0 run `44753234247` ran exactly those five jobs.
- [Measured] `GET branches/main/protection` now requires `check (ubuntu 1/4)` through `check (ubuntu 4/4)` with `enforce_admins: true`, so the v0.3.0 sequence cannot recur through a pull request. In that sequence, PR #390 merged at 14:23:51Z before its checks finished, and the tag followed at 14:24:59Z. Gaps remain. `strict` is `false`, so a pull request's checks may have run against an older base than the squashed commit on `main`. `windows.yml` and the macOS suite are not required, and on `main` they run only for matching paths or nightly. Nothing ties a tag to a green commit, or even to a commit on `main`.
- [Measured] When a release already exists, `.github/workflows/release.yml:127-129` runs `gh release upload "$TAG" release-assets/* --clobber`. `workflow_dispatch` on a tag ref also reaches `publish` (`:10`, `:109`), so a manual run silently replaces published installers. `GET immutable-releases` returns `{"enabled":false}`.
- [Measured] `gh release list` shows v0.1.0, v0.2.0, and v0.3.0, none a prerelease. The prerelease path exists (`.github/workflows/release.yml:132-133`). `formalReleaseVersion` ignores prereleases (`src/shared/update.ts:67-71`), and `releases/latest` excludes them. A candidate therefore never reaches the in-app update reminder or the README download links. The safety exists but has never been used.
- [Measured] There is no `CHANGELOG.md`. `.github/release-notes.md` holds only the v0.3.0 notes.
- [Measured] `migrate` refuses a ledger newer than its latest migration (`src/daemon/store/migrate.ts:178-180`). Before it migrates, it writes `hub.sqlite.bak-<from>-<stamp>` with `VACUUM INTO` and keeps `MAX_DB_BACKUPS` (2) (`:116-131`). v0.4.0 adds migrations past v0.3.0 (asserted at `test/e2e/release-upgrade.test.ts:57-60`). No document explains how to go back.
- [Measured] New since the audit: `test/e2e/release-upgrade.test.ts` upgrades real v0.1.0 to v0.3.0 ledgers from `test/fixtures/release-db/` inside `check`, and `.github/workflows/nightly.yml` runs the Ubuntu, Windows, and macOS suites at 15:00 UTC. Both test `main`, not the tagged commit. Nightly run `44928107039` took 2.0 to 3.2 minutes per `check` shard, 3.2 minutes for `windows.yml`, and 6.6 to 6.8 minutes per macOS shard. In the v0.3.0 release run, the Windows build took 6.8 minutes, the Mac build 4.5 minutes, and the whole run 8 minutes.
- [Measured] Installers are unsigned previews, and the Developer ID path in `scripts/build-mac-app.sh:184-231` has never run in CI. Signing needs a paid Apple Developer ID and a Windows certificate, so it is a separate item.

**P2-10, build commit part.** Still true.

- [Measured] `runtime-manifest.json` has no commit: `scripts/stage-mac-runtime.ts:152-157` and `scripts/stage-win-runtime.ts:226-232`. Its readers accept a new field: `apps/windows/crates/fusa-supervisor/src/manifest.rs:10-18` uses serde without `deny_unknown_fields`, `apps/macos/SelfTest.swift:64-68` reads only `nodeVersion`, and `scripts/build-mac-app.sh:179` reads only `version`.
- [Inferred] Today a version does not identify a commit. `--clobber` can replace v0.3.0 installers with a rebuild of a different commit, and pull request builds produce `Bellwood_0.3.0_*` installers from any branch.

### 3. Approach comparison

**Daemon dependencies in the installer**

| Approach | Trade-off |
| --- | --- |
| Prune the root lockfile to the daemon closure and install it with `--frozen-lockfile --offline` | About 100 lines plus tests. Ships exactly the CI tree with pnpm's integrity checks, keeps today's daemon-only size, and measured 8.3 s with no network. |
| pnpm workspace with `pnpm deploy --prod` | The pnpm-native answer, but it splits the root `package.json` into a daemon package and touches tsconfig, Vitest projects, `knip`, and `scripts/test-related.ts`. Too large for this batch. |
| Exact versions in the staged `package.json` | Pins direct dependencies only. `cookie`, `semver`, and the other transitive packages in the measured drift would still float. |
| Copy the root manifest and lockfile and install every production dependency | Frozen and simple, but ships web-only packages such as `mermaid`, `shiki`, and `vega` that `dist/web` already bundles, which threatens the 60 MiB installer budgets. |

Prune the lockfile. `pruneLockfile` keeps the root specifiers and resolved versions, so pnpm's frozen check passes, and `assertInstalledMatchesLockfile` fails the build if pnpm ever installs a version outside the lockfile. The pruned `pnpm-lock.yaml` stays in the staged daemon directory as the record of shipped versions (89 KB before compression).

**Tauri CLI**

| Approach | Trade-off |
| --- | --- |
| Exact `@tauri-apps/cli` in `devDependencies`, run with `pnpm exec tauri` | Locked with an integrity hash like every other tool. Each developer install fetches one prebuilt CLI binary for that platform. |
| `cargo install tauri-cli --locked --version <x>` | Rust-native, but compiles for several minutes on every uncached CI run. |
| `pnpm dlx @tauri-apps/cli@<exact>` | Pins the version without a lockfile integrity check. |

Use the `devDependency`, pinned to the newest 2.x that matches `tauri` 2.12 in `apps/windows/Cargo.lock`, and add it to the dependency list in `AGENTS.md`.

**Release gates and candidates**

| Approach | Trade-off |
| --- | --- |
| Gates inside `release.yml` on the tagged commit, and the formal tag promotes the candidate's installers | Tests exactly what ships and needs no external state. A candidate run grows from about 8 to about 9 minutes, because the gates run in parallel with the builds. A promote run takes about 2 minutes. |
| Look up existing check runs for the tagged commit | Cheap, but `windows.yml` and the macOS suite do not run on every `main` commit, and docs-only commits skip `check` (`paths-ignore`), so many commits could never be released. |
| Gates on every tag, with a rebuild on the formal tag | Simpler, but the formal installers are new bytes that nobody installed. |

Use gates inside `release.yml` plus promotion. The target flow:

1. A pull request bumps the versions and adds `## vX.Y.Z` to `CHANGELOG.md`. After it merges, the maintainer pushes `vX.Y.Z-rc.1` on that `main` commit.
2. `plan` runs `scripts/release-assets.ts check` and `planRelease`. The result is a build plan.
3. These jobs run in parallel: `check.yml` (4 shards), `windows.yml`, a new reusable `macos.yml` (the nightly macOS job moved out of `nightly.yml`), a `pnpm verify` smoke job on Ubuntu, and both installer builds. The builds install from the pruned lockfile, run the locked Tauri CLI, and fail if `runtime-manifest.json` `gitCommit` differs from `$GITHUB_SHA`.
4. `assemble` renames the installers to their fixed names, checks the `.sha256` files, and attests build provenance for both installers with `actions/attest-build-provenance`. Only this job gets `id-token: write` and `attestations: write`.
5. `publish` needs every job above and runs `scripts/release-assets.ts publish`, which creates a draft, uploads all four files, and publishes a prerelease. It refuses any tag that already has a release, draft or published.
6. The maintainer installs the candidate over the previous formal release on a real Mac and a real Windows machine, using a data directory with real projects. The candidate passes if each app starts, a new `hub.sqlite.bak-*` exists, and existing projects and conversations open.
7. The maintainer pushes `vX.Y.Z` on the same commit. `plan` returns a promote plan, and the gates and builds are skipped. `promote` downloads the candidate's assets, checks each `.sha256` and the provenance attestation from `release.yml`, and publishes them as the latest release.
8. After the formal release, the maintainer runs `node scripts/release-db-fixture.ts vX.Y.Z` and commits the sample through a pull request, as today.

When a gate fails, nothing publishes. Fix the cause on `main` and push `vX.Y.Z-rc.N+1`. Do not rerun a job to get past a flaky test (`AGENTS.md`). Publishing happens only on tag pushes. `workflow_dispatch` on any ref with input `tag` runs the whole pipeline, and `publish` only prints the commands it would run. Implementation proves the gates this way without publishing.

**Rollback**

| Approach | Trade-off |
| --- | --- |
| Roll forward, with a scripted yank | `node scripts/release-assets.ts yank --tag vX.Y.Z` marks the release as a prerelease that is not latest, marks the previous formal release as latest, and confirms `releases/latest` returns it. The in-app check and download links fall back at once. Users who already upgraded follow written restore steps. |
| In-app downgrade | Restores the backup and offers the older installer. This is product work and needs UI. |

Roll forward. Implementation adds a "Releasing" runbook to this document covering steps 1 to 8, the yank command, and the user restore steps.

**Build commit**

| Approach | Trade-off |
| --- | --- |
| `gitCommit` in `runtime-manifest.json`, build provenance, and the immutable release attestation | No app change. With promotion and immutable releases, every published installer of a version comes from one commit. `gh attestation verify <installer> -R maodesikeng-boop/agent-hub` names the commit and the run. |
| Also show the commit in **Settings** and `/api/health` | Needs UI and contract changes. It only helps with unpublished pull request builds. |

Record the commit in the manifest and attest the installers. `readBuildCommit` adds `-dirty` for local builds with changes, and CI requires an exact match with `$GITHUB_SHA`.

### 4. Performance and bounds

None. Nothing adds a cache, snapshot, or growing collection. The CI cost is listed above: a candidate run takes about 9 minutes instead of 8, and a formal run about 2 minutes. Standard GitHub-hosted runners are free for this public repository.

### 5. Cross-vendor and cross-platform unification

`stageDaemonTree` is the one place both installers get their daemon. `scripts/stage-mac-runtime.ts` and `scripts/stage-win-runtime.ts` both call it, so the pruned lockfile and `assertInstalledMatchesLockfile` cover macOS and Windows together. Both manifests extend `RuntimeManifestBase`. Linux ships no installer. Source checkouts on all three platforms install from the root lockfile directly. A future installer platform implements only `scripts/stage-<platform>-runtime.ts`, which calls `stageDaemonTree` and writes a `RuntimeManifestBase`. Vendors are unaffected.

### 6. Deletions

- `--no-lockfile`, `--prefer-offline`, and the lockfile deletion in `stageDaemonTree` (`scripts/stage-runtime-common.ts:373-381`, `:403`).
- `pnpm dlx @tauri-apps/cli@^2` in `.github/workflows/windows-desktop.yml:130`.
- The inline publish script in `.github/workflows/release.yml:121-137`, including `--clobber`, and publishing from `workflow_dispatch`.
- The inline macOS job in `.github/workflows/nightly.yml:20-48`, which moves to `.github/workflows/macos.yml`.
- `.github/release-notes.md`, if decision 4 is A.
- The "CI and GitHub Releases" section of `docs/mac-distribution-design.md`, replaced by a link to this document. The "In-app update check" subsection stays.

### 7. Skeleton files

- `scripts/staged-lockfile.ts`: Prunes the root lockfile for the staged daemon, holds the frozen install arguments, and checks the installed tree against the lockfile.
- `scripts/release-plan.ts`: Pure decisions about a tag (build, promote, or refuse) and the release notes for a version.
- `scripts/release-github.ts`: Reads releases and git state, publishes from a draft without overwriting, runs dry, and yanks.
- `scripts/stage-runtime-common.ts`: Adds `RuntimeManifestBase` and `readBuildCommit`. Implementation also switches `stageDaemonTree` to the pruned lockfile and `STAGED_INSTALL_ARGS`.
- `scripts/staged-lockfile.test.ts`, `scripts/release-plan.test.ts`, `scripts/release-github.test.ts`, and `scripts/stage-runtime-common.test.ts`: `it.todo` cases for every contract clause.
- `scripts/ci-workflows.test.ts`, `scripts/stage-mac-runtime.test.ts`, and `scripts/stage-win-runtime.test.ts`: `it.todo` guards for the workflow graph, the Tauri CLI, the macOS workflow, and the manifest commit.
- Implementation only: `scripts/release-assets.ts` gains the `plan`, `publish`, and `yank` commands. Implementation also changes `.github/workflows/release.yml`, `.github/workflows/windows-desktop.yml`, `.github/workflows/mac-desktop.yml`, and `.github/workflows/nightly.yml`, and adds `.github/workflows/macos.yml`, `CHANGELOG.md`, `package.json`, `pnpm-lock.yaml`, the `AGENTS.md` dependency list, and `docs/README.md`. `release.yml` `pull_request.paths` must list every new release script.

### 8. Verification plan

- **Locked install.** `scripts/staged-lockfile.test.ts` runs `pruneLockfile` on the real root lockfile and `pnpm install` with `STAGED_INSTALL_ARGS` in a temporary directory, then checks that `assertInstalledMatchesLockfile` passes. The PR quotes the before and after: 6 differing packages with `--no-lockfile` (`/tmp/release-flow-exp/lockfile-drift.txt`), 0 after. The `mac-desktop` and `windows-desktop` logs show `downloaded 0` for the staged install.
- **Tauri CLI.** The `windows-desktop` log prints `pnpm exec tauri --version` with the pinned version, and a guard in `scripts/ci-workflows.test.ts` rejects `pnpm dlx` in every workflow.
- **Build commit.** `scripts/stage-runtime-common.test.ts` covers clean, dirty, and non-git checkouts. Both desktop workflows print `runtime-manifest.json` and compare `gitCommit` with `$GITHUB_SHA`. The PR links both runs.
- **Gates and dry run.** Guards in `scripts/ci-workflows.test.ts` check that `publish` needs every gate, that no `--clobber` remains, and that only `assemble` can attest. Run `gh workflow run release.yml --ref <branch> -f tag=v0.3.0-rc.99` and link the run: all gates run, and `publish` prints draft, upload, and publish commands without writing. Run it again with `-f tag=v0.3.0`: `plan` refuses because v0.3.0 already has a release. The PR contrasts that job list with the five jobs of the v0.3.0 run `44753234247`.
- **Plan, publish, and yank logic.** `scripts/release-plan.test.ts` covers every refusal. `scripts/release-github.test.ts` records the commands sent to a fake `CommandRunner`, never a real repository.
- **Immutable releases**, if decision 2 is A: after approval, the maintainer runs `gh api -X PUT repos/maodesikeng-boop/agent-hub/immutable-releases`. The PR shows `GET immutable-releases` returning `{"enabled":true}`.
- Run `pnpm typecheck`, `pnpm test:related`, and `pnpm verify`. Wait until every PR check is green, including the path-triggered `windows`, `mac-desktop`, and `windows-desktop` jobs.

### 9. Implementation notes

These details changed while implementing the skeleton:

- `planRelease` takes `{ dryRun }`. A rehearsal on a branch would otherwise always stop at "not on main", so in a dry run that check only prints a warning. Every other refusal still applies.
- `publish` decides on its own whether to write. It writes only when `GITHUB_EVENT_NAME` is `push`, `GITHUB_REF_TYPE` is `tag`, and `GITHUB_REF_NAME` equals `--tag` (`isTagPushOf`), and it re-plans with the write token right before publishing, so a draft or release created while the gates ran still stops it. Run anywhere else, including locally, `publish` is a dry run.
- Rehearsals skip `actions/attest-build-provenance`, because each attestation is a permanent entry in the public Sigstore log.
- `pnpm exec` does not find the root `node_modules/.bin` from `apps/windows/crates/fusa-desktop`, and the Tauri CLI must run there. The workflow calls the locked `node_modules\.bin\tauri.cmd` directly.
- `checkTagVersion` and `release-assets.ts check --tag` are deleted. `planRelease` covers tags, and `check` now confirms that the version sources agree and `CHANGELOG.md` has a section for the version.

## Releasing

### Ship a release candidate

1. Open a pull request that sets the new version in `package.json`, `apps/windows/Cargo.toml`, and `apps/windows/crates/fusa-desktop/tauri.conf.json`, updates the supported series in `SECURITY.md` when the minor version changes, and adds a `## vX.Y.Z` section at the top of `CHANGELOG.md` with Chinese bullets and an `### English` subsection. The `plan release` check fails until all of that agrees.
2. After the pull request merges, tag the merged commit: `git fetch origin main && git tag vX.Y.Z-rc.1 origin/main && git push origin vX.Y.Z-rc.1`.
3. `release.yml` runs `check`, `windows`, `macos`, `smoke (pnpm verify)`, and both installer builds on the tagged commit. When all of them pass, `assemble` attests the installers and `publish candidate` publishes a prerelease. The prerelease never reaches `releases/latest`, the README download links, or the in-app update reminder.
4. When a job fails, nothing publishes. Fix the cause on `main` and push `vX.Y.Z-rc.N+1`. Do not rerun a failed job to get past a flaky test.

### Accept the candidate

On a real Apple silicon Mac and a real Windows x64 machine that run the previous formal release with real projects:

1. Download the installer and its `.sha256` from the prerelease page, check the checksum, and run `gh attestation verify <installer> -R maodesikeng-boop/agent-hub`. It must name `release.yml` and the candidate tag.
2. Install over the previous version and open Bellwood.
3. The candidate passes when the app starts, existing projects and conversations open, and, for a release that adds migrations, a new `hub.sqlite.bak-<schema version>-<time>` appears in `~/.agent-hub/state/`.

### Promote the candidate

1. Tag the candidate's commit: `git tag vX.Y.Z vX.Y.Z-rc.N && git push origin vX.Y.Z`.
2. `plan release` returns a promote plan, and `promote candidate` downloads the newest candidate's assets, checks every `.sha256` and the provenance attestation from `release.yml` for `refs/tags/vX.Y.Z-rc.N`, and publishes them as the latest release. Nothing is rebuilt.
3. Add the released ledger sample: `node scripts/release-db-fixture.ts vX.Y.Z`, then commit it through a pull request.

### Rehearse without publishing

- `gh workflow run release.yml --ref <branch> -f tag=vX.Y.Z-rc.99` runs every gate and build of a candidate. `plan release` warns when the commit is not on `main`, `assemble` skips the attestation, and `publish candidate` prints each `gh` write prefixed with `[dry-run]`.
- `node scripts/release-assets.ts plan --tag <tag>` prints the plan for any tag from a local checkout, using read-only `gh api` and `git ls-remote` calls.

### Yank a bad formal release

1. Run `node scripts/release-assets.ts yank --tag vX.Y.Z --dry-run` and read the two edits it prints.
2. Run it again without `--dry-run`, with `gh` logged in as a maintainer. It marks `vX.Y.Z` as a prerelease that is not latest, marks the highest remaining formal release as latest, and checks that `releases/latest` returns it. The README links and the in-app update reminder fall back at once. Assets and tags stay in place.
3. Ship the fix as a new patch version through a candidate.

### Restore after a bad upgrade

A user who already installed the bad version and must go back loses every change made since the upgrade:

1. Quit Bellwood.
2. Install the previous version from its release page, such as `https://github.com/maodesikeng-boop/agent-hub/releases/tag/vX.Y.Z`.
3. In `~/.agent-hub/state/` (`%USERPROFILE%\.agent-hub\state\` on Windows, or `$AGENT_HUB_HOME/state/` when set), move `hub.sqlite`, `hub.sqlite-wal`, and `hub.sqlite-shm` into another folder.
4. Copy the newest `hub.sqlite.bak-<schema version>-<time>` to `hub.sqlite`. The schema version in the name is the one the previous version used, and the upgrade wrote this backup right before it migrated.
5. Open Bellwood. Without step 4, the previous version refuses to start because the ledger is newer than its migrations.
