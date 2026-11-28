# CI apt cache recovery and atomic executable script writes

> Snapshot: 2026-11-28 (commit `4a3fdac6`)

## Plan review and decisions

### Files to review

- [This design document](ci-apt-and-hook-etxtbsy-design.md): measured root causes, history, candidate comparison, platform unification, and verification plan for both defects.
- [`docs/README.md`](README.md): adds this design document to the repository documentation index.
- [`src/daemon/platform/win32/fs-safe.ts`](../src/daemon/platform/win32/fs-safe.ts) and [`src/daemon/platform/index.ts`](../src/daemon/platform/index.ts): typed skeleton and contract for `writeExecutableFileAtomicSync`.
- [`scripts/apt-install-action.test.ts`](../scripts/apt-install-action.test.ts): executable acceptance tests for `.github/actions/apt-install/action.yml` cache keying, non-poisoning cache restore, `dpkg` repair before fallback, EC2 mirror rewrite, and clean cache saves.
- [`src/daemon/platform/executable-write.test.ts`](../src/daemon/platform/executable-write.test.ts): acceptance tests for `writeExecutableFileAtomicSync` semantics (atomic publish, idempotency, replacement inode isolation, symlink safety, Windows retry, cleanup) and `prepareLaunch` review-hook atomic replacement under concurrent execution.
- [`src/daemon/platform/executable-write-guard.test.ts`](../src/daemon/platform/executable-write-guard.test.ts): tree-scanning structural guard ensuring production executable scripts and shared harnesses use `writeExecutableFileAtomicSync`.
- [`scripts/test-related.ts`](../scripts/test-related.ts): registers `src/daemon/platform/executable-write-guard.test.ts` in `ALWAYS_RUN_TESTS`.

### Project Manager plan review

- Every quoted user requirement and every defect item from the incident record maps to at least one runnable acceptance scenario in Section 8.
- Every verification category in `docs/plan-standard.md` is covered in Section 8, and each non-applicable category states in one sentence why it cannot apply.
- Both defects evaluate genuinely structurally distinct candidate designs against `.agents/skills/architect/references/design-red-flags.md`.

### Decisions needed

None. Neither fix changes user-visible behavior or interfaces, neither rebuilds a multi-fold foundation, and neither performs an irreversible external operation.

## For Workers and reviewers

### 1. User goal

> 「有产品反馈直接去核实然后做就行」
>
> 「一律先走完整流程」
>
> 「现在所有的需求你来拍板，直到一切都完成，检查，不满意的话重新来」

Incident record (`/tmp/ci-apt-etxtbsy-fix/context.md`):

1. Cloud `verify-smoke (ubuntu)` hit a cached apt archive (`apt-debs-v2-...`) and failed with exit code 100 (`E: Unmet dependencies`), blocking subsequent PR merges.
2. Linux CI (`check (ubuntu 1/4)`) failed intermittently in `test/e2e/review-verify-only.test.ts:109` with `fatal: cannot exec '.../review-hooks/pre-push': Text file busy` (`ETXTBSY`).

This plan eliminates both CI failures at their root causes without weakening any CI check and migrates every executable script writer in the repository onto one atomic platform helper.

### 2. Current state and history

#### Defect 1: `.github/actions/apt-install/action.yml` cross-cloud cache mismatch and exit code 100

##### Design history

- Commit `3e947076` and `6219de1f` (2026-11-12) added cached `.deb` files keyed by `ImageVersion`, hard timeouts, and an `archive.ubuntu.com` mirror fallback inline in `.github/workflows/check.yml` for `bubblewrap` and `socat`.
- Commit `42ad066e` (#421) and `8776f581` (#436) added `verify-smoke (ubuntu)` with Chromium and WebKit using `playwright install --with-deps`.
- Commit `252707ef` (#455, `docs/dev-ci-friction-design.md`) extracted the inline installer into `.github/actions/apt-install/action.yml` and wired three callers: `check.yml` (`check` and `verify-smoke`) and `release.yml` (`smoke`).
- The original premise of `apt-debs-v2-${{ runner.os }}-${{ runner.arch }}-${{ steps.image.outputs.version }}-${{ inputs.cache-id }}` was that `ImageVersion` uniquely determines the runner's pre-installed `dpkg` package set and that a failed `dpkg -i` falls back cleanly to `$INSTALL`. Both premises are false on GitHub's hosted `ubuntu-latest` fleet.

##### Core concepts

- **Runner base package state**: the set of packages and versions already installed in `/var/lib/dpkg/status` when a job starts. GitHub serves `ubuntu-latest` (`ubuntu-26.04`, `ImageVersion=20261122.9.1`) from both Azure and AWS pools with different pre-installed package sets.
- **Delta `.deb` cache**: the files copied from `/var/cache/apt/archives/*.deb` after an online install. Because `apt-get` downloads only packages missing or outdated relative to the originating runner's base state, a delta cache is valid only for runners with the same base package state.
- **Live `dpkg` database (`/var/lib/dpkg/status`)**: mutated immediately by `dpkg -i` during unpack before dependency verification. When `dpkg -i` fails with missing dependencies, it leaves unpacked, unconfigured packages behind.
- **Missing concept**: base-package-state cache fingerprinting plus non-poisoning cache restore and `dpkg` repair before online fallback.

##### Verified evidence

- `[Measured]` `gh run view --repo maodesikeng-boop/agent-hub 46069220597 --job 140741856436 --log` (2026-11-27 21:16Z, passing) ran on `Cloud: Azure`, `Region: westus2`, `Image: ubuntu-26.04`, `Version: 20261122.9.1`, restored cache `apt-debs-v2-Linux-X64-20261122.9.1-playwright-chromium-webkit-1033c406fa5b06b1227b83b0244eb8c3704a6b2639e6a645992029b07fbe8226` (138,389,667 bytes, cache id `11137008103`), and printed `Installed packages from cached debs`.
- `[Measured]` `gh run view --repo maodesikeng-boop/agent-hub 46072006606 --job 140750928666 --log` (2026-11-27 21:42Z, failing 25 minutes later) ran on `Cloud: AWS`, `Region: us-west-2`, with the identical `Image: ubuntu-26.04`, `Version: 20261122.9.1`, and restored the exact same cache (`138,389,667` bytes, id `11137008103`).
- `[Measured]` On that AWS runner, `.github/actions/apt-install/action.yml:47` ran `sudo timeout --kill-after=5s 60 dpkg -i "${debs[@]}"`. `dpkg` unpacked `gstreamer1.0-plugins-bad` and `libasound2t64` from the Azure cache, then failed configuration because `libjson-glib-1.0-0` was absent and `libasound2-data` was at `1.2.15.3-1ubuntu1.1` instead of `>= 1.2.15.3-1ubuntu1.2`, leaving broken unconfigured packages in `/var/lib/dpkg/status`.
- `[Measured]` `.github/actions/apt-install/action.yml:51-64` logged a warning and ran `install_packages` (`pnpm exec playwright install-deps chromium webkit`) without repairing `dpkg`. `apt-get install` refused to proceed because `/var/lib/dpkg/status` already had broken dependencies and exited with code 100 (`E: Unmet dependencies. Try 'apt --fix-broken install'`).
- `[Measured]` `.github/actions/apt-install/action.yml:66-77` misclassified exit code 100 as a runner mirror outage, rewrote `/etc/apt/sources.list.d/*` to `http://archive.ubuntu.com/ubuntu/`, retried `install_packages`, and hit the exact same exit code 100.
- `[Measured]` `.github/actions/apt-install/action.yml:72-75` rewrites `mirror+file:/etc/apt/apt-mirrors.txt` and `azure.archive.ubuntu.com`, but does not match direct AWS `*.ec2.archive.ubuntu.com` URLs. Line 80-84 copies `/var/cache/apt/archives/*.deb` into `$DEBS` without clearing stale files in `$DEBS` first.
- `[Measured]` `.github/actions/apt-install/action.yml` has three callers (`git grep "apt-install"`): `.github/workflows/check.yml:70`, `.github/workflows/check.yml:169`, and `.github/workflows/release.yml:116`.

#### Defect 2: Linux `review-hooks/pre-push` `ETXTBSY` and repository-wide executable script writers

##### Design history

- Commit `919ec76e` (#15) introduced `src/daemon/agent-api/shim.ts` to write `<binDir>/hub` using a temp file (`${target}.${process.pid}.tmp`), `chmodSync`, and `renameSync`.
- Commit `25c5cafa` (and deleted `docs/review-verify-only-design.md`, recovered via `git show 3437df1f^:docs/review-verify-only-design.md`) added the review `pre-push` hook in `src/daemon/launch.ts:264-269` using direct in-place `writeFileSync(hook, REVIEW_PRE_PUSH_HOOK, { mode: 0o755 })` followed by `chmodSync(hook, 0o755)`.
- Commit `0d43d30f` (#434) and `src/daemon/driver/base-driver.ts:591` call `prepareLaunch(session)` in `deliverNext` before every turn while the Worker process is already alive, in addition to initial launch (`src/daemon/driver/base-driver.ts:836`) and handover (`src/daemon/handover/runner.ts:132`).
- Because each subsystem hand-rolled executable script writes instead of using a shared platform helper, in-place `writeFileSync` + `chmodSync` spread across daemon modules and test harnesses.

##### Core concepts

- **Linux `ETXTBSY` invariant**: on Linux (`execve(2)`), executing an inode while any process holds an open writable file descriptor (`O_WRONLY` or `O_RDWR`) on that inode fails with `ETXTBSY` (`Text file busy`). Conversely, opening an actively executing inode for writing also fails with `ETXTBSY`.
- **Two concurrent races on in-place `writeFileSync`**:
  1. **First-write visibility race**: `writeFileSync` creates the directory entry at `open(O_WRONLY | O_CREAT | O_TRUNC)` before `write`, `close`, and `chmodSync` finish. An external process polling `existsSync(hook)` (such as `test/e2e/review-verify-only.test.ts:100`) can invoke `git push` while the daemon still holds the writable fd open.
  2. **Rewrite-while-executing race**: every subsequent `prepareLaunch` (`deliverNext`, restart, or handover) reopens the existing `pre-push` inode with `O_WRONLY | O_TRUNC` while the review Worker or test executes `git push`, causing `ETXTBSY` in `execve` or `open`.
- **Write authority and duplicated implementations**: four production modules and five test or harness utilities write executable scripts today, each with its own `writeFileSync` + `chmodSync` or PID-only temp file pattern. The missing concept is one shared atomic executable file writer in `src/daemon/platform/`.

##### Verified evidence

- `[Measured]` `gh run view --repo maodesikeng-boop/agent-hub 46067177553 --log-failed` failed in `test/e2e/review-verify-only.test.ts:109` with `fatal: cannot exec '/tmp/ah-e2e-5NUG0l/home/state/launch/3/review-hooks/pre-push': Text file busy`.
- `[Measured]` `src/daemon/launch.ts:264-269` writes `join(hooksDir, "pre-push")` in place with `writeFileSync(hook, REVIEW_PRE_PUSH_HOOK, { mode: 0o755 })` and `chmodSync(hook, 0o755)`.
- `[Measured]` `src/daemon/driver/base-driver.ts:591`, `src/daemon/driver/base-driver.ts:836`, and `src/daemon/handover/runner.ts:132` all invoke `prepareLaunch` during session startup, before each turn in `deliverNext`, and during handover.
- `[Measured]` Repository-wide audit (`git grep` for `chmodSync`, `chmod(`, `#!/`, `0o755`, `0o700`, `writeFileSync` across `src/`, `scripts/`, and `test/`) found all executable script writers:
  - Production (`src/`):
    1. `src/daemon/launch.ts:267-268`: `review-hooks/pre-push` (in-place `writeFileSync` + `chmodSync`, rewritten on every `prepareLaunch`).
    2. `src/daemon/agent-api/shim.ts:62-65`: `run/bin/hub` POSIX shim (temp file + `chmodSync` + `renameSync`, but uses PID-only temp name `${target}.${process.pid}.tmp` which collides on concurrent same-process calls and duplicates atomic write logic).
    3. `src/vendors/_common/setup/browser-capture.ts:117-122`: `fusa-browser`, `open`, `xdg-open`, and `sensible-browser` shims (in-place `writeFileSync` + `chmodSync`).
    4. `src/daemon/provider-manager/recipes.ts:276`: `install.sh` (in-place `writeFileSync` without `chmodSync` to override `umask`).
  - Shared harnesses (`test/` and fixtures):
    5. `test/tester/local-instance.ts:82`: `ensureNodeBin` writes shared persistent `npm` and `npx` shims in place without `chmodSync`, creating a live Linux `ETXTBSY` risk across concurrent test-bench runs.
    6. `test/fake-cli-shim.ts:47-48`: `writeExecutableNodeScript` writes POSIX fake CLI shims in place with `writeFileSync` + `chmodSync`.
    7. `test/smoke/kit.ts:61-78` (`writeClaudeWrapper`), `test/eval/isolation.ts:133-134` (`writeShims`), and `src/daemon/driver/data-dir-fixture.ts:74-75,119-120` write executable shims in place.
- `[Measured]` `src/daemon/platform/win32/fs-safe.ts:190-273` already owns `renameSyncWithWindowsRetry` and `writeFileAtomicSyncWithRetry`, re-exported through `src/daemon/platform/index.ts`. Inspection of `node_modules/write-file-atomic/lib/index.js` confirmed that `write-file-atomic` calls `fs.realpathSync` (following symlinks instead of replacing them), uses `O_WRONLY | O_CREAT | O_TRUNC` without `O_EXCL`, runs `fsyncSync` by default, and registers a global `signal-exit` listener on every call.

### 3. Reference designs and approach comparison

#### Reference designs

- **Debian and Ubuntu `apt-get` offline installation and broken-state recovery**: [`apt-get(8)`](https://manpages.debian.org/bookworm/apt/apt-get.8.en.html) resolves dependencies for local `.deb` arguments under `--no-download --no-install-recommends` before unpacking, aborting cleanly without mutating `/var/lib/dpkg/status` when a dependency is missing. [`dpkg(1)`](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html) provides `dpkg --audit` to detect unconfigured or half-installed packages and `dpkg --configure -a` followed by `apt-get -f install` to repair broken state.
- **Playwright CI container and `actions/cache` key design**: [Playwright CI](https://playwright.dev/docs/ci) documents both host `install-deps` and pre-built `mcr.microsoft.com/playwright` container images; [actions/cache](https://github.com/actions/cache) recommends keying immutable caches on every input that affects compatibility.
- **POSIX atomic executable installation**: [GNU coreutils `install(1)`](https://www.gnu.org/software/coreutils/manual/html_node/install-invocation.html) and Linux [`execve(2)`](https://man7.org/linux/man-pages/man2/execve.2.html) avoid `ETXTBSY` by writing a new unlinked-target temp inode, closing the write descriptor, setting permissions, and atomically swapping the directory entry with `rename(2)`. [Go issue #22315](https://github.com/golang/go/issues/22315) documents why keeping writable descriptors open across `fork`/`exec` triggers `ETXTBSY`, which reinforces doing synchronous `openSync -> writeSync -> closeSync -> chmodSync -> renameSync` on Node's main thread so it cannot interleave with `spawn`. [npm/write-file-atomic](https://github.com/npm/write-file-atomic) implements atomic temp-file writes for user configs and is already in `docs/dependencies.md`, while Bellwood's `src/daemon/platform/win32/fs-safe.ts` wraps Windows transient rename retries.

#### Defect 1 candidate comparison

| Option | Structure | Cost | Red flags (`.agents/skills/architect/references/design-red-flags.md`) |
| --- | --- | --- | --- |
| **1A. Fingerprinted cache key + offline `apt-get` restore + fail-safe `dpkg` repair (Recommended)** | Hash sorted `dpkg-query -W` base packages into an `apt-debs-v3-` cache key alongside `ImageOS` and `ImageVersion`. Restore cached `.deb`s with `apt-get install -y --no-download --no-install-recommends` so missing dependencies abort before unpacking. If cached install fails and `dpkg --audit` is non-empty, repair with `dpkg --configure -a` and `apt-get update && apt-get -f install -y` inside the timed mirror-fallback runner before `$INSTALL`. Clear `$DEBS` before saving new archives and include `*.ec2.archive.ubuntu.com` in mirror fallback. | Small: one composite action file, zero new dependencies, preserves <30s cache hits on both Azure and AWS runners. | Avoids "two ways to do one task" (all three callers keep one action) and "hand-synced list" (base package identity comes directly from `dpkg-query`). |
| **1B. Pre-built Playwright container image (from-scratch alternative)** | Run `verify-smoke` and release `smoke` inside `mcr.microsoft.com/playwright:v<locked>-noble` and drop `.deb` caching for Playwright. Keep `apt-install` only for `check` (`bubblewrap`, `socat`). | Medium: ~1.5 GB container pull per run, root-user differences inside container, a second pinned Playwright image tag to keep in sync with `pnpm-lock.yaml`, and host `bwrap` jobs still need `apt-install`. | Introduces "hand-synced list" (container tag vs `pnpm-lock.yaml`) and splits Linux CI package setup into two mechanisms. |
| **1C. Patch only (bump `v2` to `v3` or run `apt-get -f install` after `dpkg -i`)** | Keep `ImageVersion`-only cache key and `dpkg -i`, adding `apt-get -f install -y` after `dpkg -i` fails. | Smallest edit, but Azure and AWS runners keep colliding on the same cache key, wasting 30–45s unpacking and repairing on roughly half of all runs. | Treats the symptom instead of fixing the shared cache-key collision root cause. |

**Recommendation for Defect 1: 1A.** Option 1A fixes both root causes (the cross-cloud cache key collision and the unrecovered `dpkg` poison state), keeps one shared composite action for all three jobs, and guarantees clean recovery even if a future cache is truncated or timed out mid-unpack.

#### Defect 2 candidate comparison

| Option | Structure | Cost | Red flags (`.agents/skills/architect/references/design-red-flags.md`) |
| --- | --- | --- | --- |
| **2A. Shared `writeExecutableFileAtomicSync` in `src/daemon/platform/` + tree guard (Recommended, from-scratch shape)** | Add one cross-platform helper `writeExecutableFileAtomicSync` in `src/daemon/platform/win32/fs-safe.ts` (re-exported via `src/daemon/platform/index.ts`): no-op when target is already a regular file with matching content and mode; otherwise `openSync(O_WRONLY\|O_CREAT\|O_EXCL)` on a unique same-directory temp file, write, `closeSync`, `chmodSync` on POSIX, and `renameSyncWithWindowsRetry`, unlinking the temp file on any error. Migrate all four production executable writers and shared test harnesses to it, and add an AST guard test in `ALWAYS_RUN_TESTS`. | Small: ~45 lines in `fs-safe.ts`, clean replacements at 9 call sites, one guard test. | Eliminates "split ownership" and "two ways to do one task" (all executable writers share one deep platform helper); avoids "importable internals" by exporting through `src/daemon/platform/index.ts`. |
| **2B. Immutable content-addressed hook directories per launch** | Write `pre-push` into `<launchDir>/review-hooks-<hash>/pre-push` once and never overwrite it. | Medium: changes the stable `state/launch/<id>/review-hooks` contract in `docs/write-scope.md` and tests, still needs atomic temp+rename for the first-write race, leaves stale directories on updates, and does not fix `shim.ts`, `browser-capture.ts`, `recipes.ts`, or `local-instance.ts`. | Leaves "two ways to do one task" across the remaining executable writers and leaks internal versioning into `core.hooksPath` paths. |
| **2C. Retry `git push` or sleep in `test/e2e/review-verify-only.test.ts`** | Catch `ETXTBSY` in the test or wait a fixed delay after `existsSync`. | Tiny edit, violates `AGENTS.md` ("Fix root causes") and `REVIEW.md` ("Tests wait for events, not for time"), and leaves Linux production `prepareLaunch` broken under real concurrent `git push`. | Rejected outright. |

**Recommendation for Defect 2: 2A.** Option 2A is the design we would build from day one: one deep platform helper owns POSIX `O_EXCL` atomic publication, `umask`-independent permissions, idempotent no-op checks, symlink replacement safety, and Windows rename retries, enforced across the repository by an automated AST guard.

#### Synthesis record

None.

### 4. Performance and bounds

- **Invalidation**:
  - `.github/actions/apt-install/action.yml`: cache key `apt-debs-v3-<os>-<arch>-<imageOs>-<imageVersion>-<dpkgHash>-<cacheId>` changes immediately whenever the base runner package set changes (separating Azure and AWS pools and new image rollouts) or `pnpm-lock.yaml` changes. On a cache miss, `$DEBS` is emptied before copying `/var/cache/apt/archives/*.deb`, so failed or partial cache entries are never mixed into saved archives.
  - `writeExecutableFileAtomicSync`: holds no in-memory cache; each call checks live `lstatSync` and file content directly, so deleted, tampered, or replaced targets are always repaired immediately.
- **Upper bounds (one-month sizing: 300 finished Workers, 30,000 messages, 50,000 step logs)**:
  - GitHub Actions caches are bounded by GitHub's 10 GB per-repository LRU eviction policy. Each Playwright `chromium webkit` cache is ~132 MB; separating Azure and AWS adds at most one extra ~132 MB entry per active runner image (~264 MB total, <3% of quota).
  - `writeExecutableFileAtomicSync` creates a unique temp file only when the target is missing or changed, renames it on success, and unlinks it in `finally` on error, so zero temp files accumulate over one month of daemon operation. The idempotent check reduces `prepareLaunch` disk writes for `pre-push` to once per review session instead of once per turn.
- **Stable front-end references**: None (no web store, selector, or component changes).
- **Measured verification**: Record `verify-smoke (ubuntu)` install step duration on cache miss and cache hit in cloud CI, and verify concurrent `prepareLaunch` plus `pre-push` execution completes with zero `ETXTBSY` errors in `src/daemon/platform/executable-write.test.ts`.
- **New `src/shared/limits.ts` constants**: None. Windows rename retries reuse the existing `WIN_RENAME_RETRY_DELAYS_MS` constant in `src/shared/limits.ts`.

### 5. Cross-vendor and cross-platform unification

- **Vendors**: All eight registered vendors in `src/shared/vendors.ts` (`claude`, `codex`, `agy`, `cursor`, `kimi`, `opencode`, `deepseek`, `pi`) share `createLaunchPreparer` (`src/daemon/launch.ts`), `installHubShim` (`src/daemon/agent-api/shim.ts`), `createBrowserCaptureSession` (`src/vendors/_common/setup/browser-capture.ts`), and `executeInstallRecipe` (`src/daemon/provider-manager/recipes.ts`). No vendor-specific driver or protocol code changes; any future vendor implementing `src/vendors/<vendor>/spec.ts` and `daemon.ts` automatically inherits atomic executable writes.
- **Platforms**: `writeExecutableFileAtomicSync` lives in `src/daemon/platform/win32/fs-safe.ts` and is exported through `src/daemon/platform/index.ts`, covering macOS, Linux, and Windows behind one interface (gating `chmodSync` and POSIX permission comparison on `platform !== "win32"`, and reusing `renameSyncWithWindowsRetry` on `win32`). `.github/actions/apt-install/action.yml` targets Ubuntu Linux GitHub Actions runners only.

### 6. Deletions

- Delete raw `dpkg -i "${debs[@]}"` restore and the `apt-debs-v2-` cache key in `.github/actions/apt-install/action.yml`.
- Delete direct in-place `writeFileSync` and `chmodSync` calls for executable scripts in `src/daemon/launch.ts`, `src/vendors/_common/setup/browser-capture.ts`, `src/daemon/provider-manager/recipes.ts`, `test/tester/local-instance.ts`, `test/fake-cli-shim.ts`, `test/smoke/kit.ts`, `test/eval/isolation.ts`, and `src/daemon/driver/data-dir-fixture.ts`.
- Delete the duplicate PID-only temp-file + `chmodSync` + `renameSync` block in `src/daemon/agent-api/shim.ts` in favor of `writeExecutableFileAtomicSync`.

### 7. Skeleton files

Delivered in this planning step:

- `docs/ci-apt-and-hook-etxtbsy-design.md`: design document covering root causes, history, candidate comparison, platform unification, and verification plan.
- `docs/README.md`: indexes `ci-apt-and-hook-etxtbsy-design.md`.
- `src/daemon/platform/win32/fs-safe.ts`: exports `WriteExecutableFileOptions` and the typed `writeExecutableFileAtomicSync` skeleton.
- `src/daemon/platform/index.ts`: re-exports `writeExecutableFileAtomicSync` and `WriteExecutableFileOptions`.
- `scripts/apt-install-action.test.ts`: runnable acceptance tests for `.github/actions/apt-install/action.yml` (key fingerprinting, non-poisoning cache restore, `dpkg` repair, EC2 mirror rewrite, clean cache save, and unchanged-rule timeout guard).
- `src/daemon/platform/executable-write.test.ts`: runnable acceptance tests for `writeExecutableFileAtomicSync` contract clauses and `prepareLaunch` review-hook atomic replacement under concurrent execution.
- `src/daemon/platform/executable-write-guard.test.ts`: runnable AST structural guard scanning production `src/` and shared test harnesses for direct in-place executable writes, plus self-tests for guard rules.
- `scripts/test-related.ts`: adds `src/daemon/platform/executable-write-guard.test.ts` to `ALWAYS_RUN_TESTS`.

Modified during implementation (Step 2):

- `.github/actions/apt-install/action.yml`: implements `dpkg-query` cache fingerprinting (`apt-debs-v3-`), offline `apt-get install --no-download`, fail-safe `dpkg --audit` repair, EC2 mirror fallback, and clean `$DEBS` saving.
- `src/daemon/platform/win32/fs-safe.ts`: implements `writeExecutableFileAtomicSync`.
- `src/daemon/launch.ts`, `src/daemon/agent-api/shim.ts`, `src/vendors/_common/setup/browser-capture.ts`, `src/daemon/provider-manager/recipes.ts`, `test/tester/local-instance.ts`, `test/fake-cli-shim.ts`, `test/smoke/kit.ts`, `test/eval/isolation.ts`, `src/daemon/driver/data-dir-fixture.ts`: replace direct executable script writes with `writeExecutableFileAtomicSync`.

### 8. Verification plan

#### Acceptance scenarios

1. **Cross-cloud apt cache isolation (maps to Defect 1 and user requirement for full root-cause fix).** First: an Azure `ubuntu-26.04` (`20261122.9.1`) runner computes the `apt-install` cache key with `libjson-glib-1.0-0` and `libasound2-data=1.2.15.3-1ubuntu1.2` installed. Next: an AWS `ubuntu-26.04` (`20261122.9.1`) runner computes the cache key without `libjson-glib-1.0-0` and with `libasound2-data=1.2.15.3-1ubuntu1.1`. Seen: both keys use prefix `apt-debs-v3-` and have different hashes, so the AWS runner never restores the incompatible Azure cache. Test: `scripts/apt-install-action.test.ts`.
2. **Incompatible cached `.deb` fallback recovery without exit code 100 (maps to Defect 1).** First: `CACHE_HIT=true` restores a cached `.deb` set that is missing a dependency required by one cached package. Next: the `Install from cache or apt` step runs offline restore and falls back to `$INSTALL` (`playwright install-deps`). Seen: offline restore fails without poisoning `/var/lib/dpkg/status` (or repairs any broken state before `$INSTALL`), `$INSTALL` succeeds with exit code 0, and the final probe passes. Test: `scripts/apt-install-action.test.ts`.
3. **Dirty `dpkg` recovery after interrupted or corrupt cache restore (maps to Defect 1 and malformed/restart categories).** First: `dpkg --audit` reports an unconfigured broken package after a failed cache restore. Next: the fallback path runs before `$INSTALL`. Seen: the action runs `dpkg --configure -a` and `apt-get -f install -y` (within the timed mirror-fallback path) so `$INSTALL` never fails with exit code 100. Test: `scripts/apt-install-action.test.ts`.
4. **EC2 mirror fallback and clean cache directory save (maps to Defect 1).** First: the default runner mirror (including `*.ec2.archive.ubuntu.com`) fails during online install while stale `.deb`s exist in `$DEBS`. Next: the action rewrites apt sources to `http://archive.ubuntu.com/ubuntu/`, completes `$INSTALL`, and saves `/var/cache/apt/archives/*.deb`. Seen: EC2 mirror URLs are rewritten to `archive.ubuntu.com`, stale `.deb`s are cleared from `$DEBS`, and only newly downloaded archives are saved. Test: `scripts/apt-install-action.test.ts`.
5. **Atomic publication and idempotent rewrite of `review-hooks/pre-push` (maps to Defect 2).** First: `createLaunchPreparer` prepares a review Worker session, creating `review-hooks/pre-push` with mode `0o755`. Next: `createLaunchPreparer` runs repeatedly (as `deliverNext` does before every turn) while a child process concurrently executes `pre-push` in a tight loop, and again after `pre-push` mode is tampered to `0o644`. Seen: unchanged re-runs preserve the existing inode without opening it for writing, tampered re-runs publish a new inode via atomic rename with mode `0o755`, and every concurrent execution succeeds with `审查步骤只查不修：不能推送` and zero `ETXTBSY` errors. Test: `src/daemon/platform/executable-write.test.ts`, `test/e2e/review-verify-only.test.ts`, `src/daemon/git/review-guard.test.ts`.
6. **Symlink safety, Windows retry, and error cleanup in `writeExecutableFileAtomicSync` (maps to Defect 2 and cross-platform/malformed categories).** First: `targetPath` is a symlink to another file, or a Windows rename hits transient `EPERM`/`EBUSY`, or rename fails on a non-empty directory. Next: `writeExecutableFileAtomicSync` runs. Seen: a symlink is replaced without mutating its target, Windows retries succeed within `delaysMs`, and a failed rename removes its temporary file. Test: `src/daemon/platform/executable-write.test.ts`.
7. **Repository-wide executable script writer unification (maps to user requirement to audit all similar concurrency points).** First: a structural AST scan checks all production `src/` modules (outside `fs-safe.ts`) and shared test harnesses (`test/tester/local-instance.ts`, `test/fake-cli-shim.ts`). Next: the guard inspects every `writeFileSync`/`writeFile` and `chmodSync`/`chmod` site. Seen: zero direct in-place executable script writes remain, and synthetic violations are rejected. Test: `src/daemon/platform/executable-write-guard.test.ts`.

Required coverage categories from `docs/plan-standard.md`:

- **Two consecutive turns in the same conversation**: Scenario 5 runs consecutive `prepareLaunch` calls (simulating turn 1 and turn 2 `deliverNext`) while the review `pre-push` hook is actively invoked; turn 2 is an idempotent no-op that never reopens the hook inode for writing.
- **A restart in the middle of the operation**: Scenario 3 covers a runner job or `dpkg` unpack interrupted mid-install leaving unconfigured packages; Scenario 6 covers a mid-write failure cleaning up its temp file so the next start leaves a clean directory and valid executable.
- **A state or configuration change while work or a notice waits in a queue**: Scenario 5 covers a hook file whose mode or content changes while queued turns wait for `deliverNext` (`prepareLaunch` atomically swaps in a new inode without disturbing in-flight `execve` callers).
- **Existing rules or boundaries (`git show origin/main:REVIEW.md`)**:
  - *Paths that require a review stamp* (`.github/**`, `src/daemon/launch.ts`, `src/daemon/platform/**`): the implementation PR will pass parallel logic and real-environment review and carry a `bellwood/review` `success` stamp before squash-merge.
  - *Worker sandboxes keep the data directory out of reach* (`src/daemon/launch.ts`, `src/daemon/platform/**`): `writeExecutableFileAtomicSync` writes only inside the caller's existing target directory (`review-hooks/`) with exact mode `0o755`, never changes read/write scopes or deny lists, and keeps `src/shared/write-scope.test.ts` plus Linux `bwrap` and Windows CI green.
  - *Caches key on identity, have a limit, and retry failures soon* (`src/daemon/platform/win32/**`): `writeExecutableFileAtomicSync` keeps no in-memory cache (reads live `lstatSync` and bytes each call), and Windows rename retries remain bounded by `WIN_RENAME_RETRY_DELAYS_MS`.
  - *Child processes are tracked and gone before cleanup* (`src/daemon/provider-manager/**`, `src/vendors/_common/setup/**`): child spawning and cleanup in `recipes.ts` and `browser-capture.ts` are untouched.
  - *Detached child processes and temp dirs stay inside the session boundary* (`src/daemon/launch.ts`, `scripts/**`): temp files created by `writeExecutableFileAtomicSync` live strictly in the target's parent directory (inside the session launch dir, never bare `/tmp`) and are unlinked in `finally` on failure.
  - *Tests wait for events, not for time* (`**/*.test.ts`, `test/**`): all new tests are synchronous or event-driven with zero fixed sleeps or wall-clock duration assertions.
  - *A result is matched to its request by an id both carry* (`src/daemon/**`): no request/reply/event correlation paths change.
  - *Planned acceptance scenarios cover every requirement and pass real tests* (`**`): satisfied by this section and the recorded pre-implementation baseline.
- **Reopening a closed view after cached data becomes stale**: Does not apply because this change modifies only GitHub Actions apt caching and daemon filesystem helpers, with no web UI view or client query cache.
- **Large data volume sized for one month of continuous use**: Section 4 verifies zero accumulating temp files across 300 finished Workers and 50,000 step logs, and Scenario 5 exercises repeated concurrent launches and hook executions without inode or temp-file leaks.
- **Malformed or dirty data**: Scenario 2 and Scenario 3 test incompatible cached `.deb` archives and dirty `/var/lib/dpkg/status` (`dpkg --audit` non-empty); Scenario 6 tests symlinks at the executable target path and non-empty directory collisions.
- **Cross-vendor coverage and prompt-cache preservation**: All eight vendors in `src/shared/vendors.ts` share `createLaunchPreparer`, `installHubShim`, `browser-capture.ts`, and `recipes.ts` (covered by `src/daemon/launch.test.ts` across `AGENT_VENDORS`). No session prompt, message, tool list, or MCP definition changes, so vendor prompt caching (`TokenUsage.cacheRead`) is unaffected.
- **Cross-platform coverage**: `writeExecutableFileAtomicSync` tests run on macOS locally, Linux Ubuntu in `check.yml` (`1/4..4/4`), and Windows in `windows.yml` (`src/daemon/platform/**` triggers `windows.yml`). `.github/actions/apt-install/action.yml` tests run on macOS and Linux bash locally and on real Ubuntu runners in `verify-smoke (ubuntu)` and `check (ubuntu 1/4..4/4)`.
- **Cross-entry-point and layout coverage**: Does not apply because no web layout, Feishu card, `hub` CLI command, or multi-computer mesh protocol changes.

#### Real-environment and real-CLI verification

- **Cloud Ubuntu CI (real environment for Defect 1 and Linux `ETXTBSY`)**: After implementation pushes, run `node scripts/wait-checks.ts <PR>` and inspect the real GitHub Actions logs of `verify-smoke (ubuntu)`, `check (ubuntu 1/4..4/4)`, and `windows (fusa-win-helper & integration)`. Verify `verify-smoke (ubuntu)` computes the `apt-debs-v3-` key with the `dpkg-query` hash, installs cleanly without exit code 100, and passes `pnpm verify --composer-layout` (producing its `check-verify-smoke` screenshot artifacts); verify `check (ubuntu 1/4..4/4)` passes `test/e2e/review-verify-only.test.ts` and `src/daemon/platform/executable-write.test.ts` on real Linux kernels; verify `windows` passes on real Windows runners.
- **Local isolated web and daemon verification (`pnpm verify`)**: Run `pnpm verify` in an isolated temporary data directory with headless Chromium to capture start-to-finish screenshot artifacts proving the daemon starts, installs `run/bin/hub` via `writeExecutableFileAtomicSync`, and renders the workbench cleanly.
- **Real vendor CLI and prompt-cache hard gate**: No vendor CLI protocol, prompt, message, tool, or MCP definition changes, so the prompt-cache `TokenUsage.cacheRead` hard gate is not triggered.

#### Commands and visual checks

- Pre-implementation baseline (recorded on this planning commit):
  - `pnpm typecheck` exits 0.
  - `pnpm exec vitest run scripts/apt-install-action.test.ts src/daemon/platform/executable-write.test.ts src/daemon/platform/executable-write-guard.test.ts` fails on every new-behavior test and passes on every unchanged-rule regression test.
  - `pnpm exec vitest run scripts/ci-friction.test.ts scripts/ci-workflows.test.ts scripts/test-related.test.ts src/daemon/platform/win32.test.ts src/daemon/launch.test.ts src/daemon/git/review-guard.test.ts src/docs-guard.test.ts src/code-hygiene.test.ts` passes.
- Post-implementation gate:
  - `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify` (capturing headless Chromium screenshots), plus `src/shared/write-scope.test.ts` and `test/e2e/review-verify-only.test.ts`.
  - Cloud CI via `node scripts/wait-checks.ts <PR>`: all `check (ubuntu 1/4..4/4)`, `verify-smoke (ubuntu)`, `migration-claims`, and `windows (fusa-win-helper & integration)` green.
