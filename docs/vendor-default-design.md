# Default vendor follows what this computer can run

> Snapshot: 2026-11-27 (commit `194a9314`)

## Plan review and decisions

### Files to review

The plan, implementation, and review land on draft PR [#494](https://github.com/maodesikeng-boop/agent-hub/pull/494).

- [`docs/vendor-default-design.md`](vendor-default-design.md): the sweep of every place the system picks a vendor for the user, with evidence, the fix or the reason to leave it, and the verification plan.
- [`src/shared/vendors.ts`](../src/shared/vendors.ts): skeleton of the one shared rule, `firstUsableVendor`, `defaultPmVendor`, and `availabilityOfCatalogs`.
- [`src/daemon/first-run-pm.ts`](../src/daemon/first-run-pm.ts): skeleton of `ensureFirstRunPm`, which takes the first-start PM out of `daemon.ts`.
- [`src/web/components/new-pm-provider.ts`](../src/web/components/new-pm-provider.ts): skeleton of the New PM dialog's default provider and its "why Create is off" line.
- Acceptance tests: [`src/shared/vendor-default.test.ts`](../src/shared/vendor-default.test.ts), [`src/daemon/ledger/pm-default-vendor.test.ts`](../src/daemon/ledger/pm-default-vendor.test.ts), [`src/daemon/first-run-pm.test.ts`](../src/daemon/first-run-pm.test.ts), [`src/web/components/new-pm-provider.test.tsx`](../src/web/components/new-pm-provider.test.tsx), and [`src/web/first-run-providers.test.tsx`](../src/web/first-run-providers.test.tsx).

### Project Manager plan review

Check that each quoted user sentence in Section 1 maps to a scenario in Section 8, that every verification category in Section 8 has a scenario or a one-sentence reason, and that the designs in Section 3 differ in structure.

### Decisions needed

None open. Goal 1 (the New PM dialog defaults to the first usable vendor, and shows where to install or sign in when none is usable) was approved with the task. The user settled D1–D3 on decision card #448, choosing option A for all three:

> 定案：A 三条都按推荐 A（D1 首次启动自动建的默认 PM 选第一个能用的厂商、最多等 4 秒探测一次；D2 不指定厂商建 PM 的所有入口都按这条规则，指定厂商的照旧；D3 一家都不能用时首次打开自动弹 Settings → Providers）。

| Decision | Settled rule | Acceptance tests |
|---|---|---|
| D1 | The PM created on first start uses `defaultPmVendor`, after waiting at most `VENDOR_RECHECK_BUDGET_MS` (4 s) for one round of probes. | `first-run-pm.test.ts`: all 7 tests |
| D2 | Every entry point that creates a PM without naming a vendor uses `defaultPmVendor`. A named vendor is used as given. | `pm-default-vendor.test.ts`: createPm, `POST /api/pms` body, and Router `project-create` (the Feishu path) without a vendor, plus a named vendor kept as given |
| D3 | When no provider is usable, the first launch opens Settings → Providers once per browser, even with the daemon's PM present. | `first-run-providers.test.tsx`: both tests |

The options considered for each decision follow.

**D1. The PM a fresh install creates follows the same rule.** Today the daemon creates `项目经理` on Claude on its first start, whatever is installed. On a Codex-only computer the user's first message to it shows `找不到 Claude  Manage providers…` (`/tmp/default-vendor/before/codex/1440-06-default-pm-send.png`). Under D1 that PM is created on Codex and answers. The first start waits at most `VENDOR_RECHECK_BUDGET_MS` (4 s) for vendor probes so that a signed-out Claude does not win over a signed-in Codex. This wait happens once per data directory. Options: (A, chosen) follow the rule and wait for probes; (B) follow the rule using only the install check, with no wait, so an installed but signed-out vendor can still win; (C) keep Claude.

**D2. A PM created without a vendor follows the same rule.** This covers `POST /api/pms` without `vendor`, the Router's `hub dispatch project-create` without `--vendor`, and project creation that starts from Feishu through the Router. Today all of these create a Claude PM (measured: `/tmp/default-vendor/before/codex/api-create-pm-no-vendor.txt`). Under D2 they create a Codex PM on a Codex-only computer. A vendor the caller names is still used as given. Options: (A, chosen) follow the rule; (B) keep Claude.

**D3. Settings → Providers opens on first launch when nothing is usable.** This behavior is supposed to exist already, but it never fires, because its trigger requires zero PMs and the daemon always creates one on first start. Measured in both isolated environments: no dialog opened on first load (`/tmp/default-vendor/before/none/notes.txt`). Under D3 the first launch on a computer with no usable provider opens Providers once per browser, as `src/web/components/ProvidersSettings.test.tsx` already describes. Options: (A, chosen) drop the zero-PM condition; (B) leave it unchanged.

## 1. User goal

> 如果新用户打开了，它电脑上本来登录的cli可以直接在我们app里用吗

> 新用户打开后项目经理默认都是claude，不去调整的话 并且新用户如果电脑上没有安装登录任何cli怎么办？

> 嗯可以，出个方案去做吧，排查一下类似的问题

A new user's existing CLI logins work in Bellwood without extra steps. Wherever Bellwood picks a vendor on the user's behalf, it picks one that runs on that computer, using the order of `VENDOR_LIST`. When nothing runs, the user sees at once where to install or sign in.

## 2. Current state and history

### Design history

`src/vendors/registry.ts:10` says "the first entry is the default vendor". That premise held when every user had Claude. Commit `31302794` (#50) made the PM vendor selectable and kept `DEFAULT_AGENT_SETTING` as the New PM default and `input.vendor ?? DEFAULT_AGENT_VENDOR` in `createPmIn`. Commit `68117d46` later gave the Router an `Auto` mode that walks `VENDOR_LIST` and takes the first available vendor (`src/shared/router-model.ts:232`), so the Router stopped assuming Claude while PM creation did not. Commit `dc4d2360` added the first-launch Providers guide and a New PM fallback that expands `More settings` when no provider is ready. The guide's trigger, `local.state.pms.length === 0` (`src/web/shell-model.ts:270`), cannot fire on a real first launch, because the daemon has created a PM at first start since M1 (`bd3aa53b`, `src/daemon/daemon.ts:545`). The test for the guide passes only because it builds a snapshot with `pms: []` (`src/web/components/ProvidersSettings.test.tsx:485`). Today's code is a stack of patches: four places pick a vendor, and each has its own rule.

### Core concepts

- **Vendor availability** has four states: `available`, `unknown` (installed but not yet probed, or the probe failed), `signed_out`, and `not_installed` (`src/shared/vendors.ts:296`). The daemon's `ModelCatalogs` is the only writer (`src/daemon/driver/model-catalog.ts:218`). `not_installed` is known synchronously from the binary path, and the other states need a probe of about 1.4 s for Codex (measured with `GET /api/models?refresh=true`). The web reads availability per device through `GET /api/models` (`src/web/models.tsx:108`) and shows the bundled catalogs, all `unknown`, until the reply arrives.
- **Which vendor to use when nobody named one** is written four times today:
  - `resolveRouterModel` takes the first `available` vendor (`src/shared/router-model.ts:232`).
  - `resolveRouterModelPreview` takes `available` first, then `unknown` (`src/shared/router-model.ts:270`).
  - The Router prompt lists `available` and `unknown` vendors, or all of them when none qualify (`src/daemon/router/prompt.ts:119`).
  - New PMs always use `VENDOR_LIST[0]` (`src/web/components/NewPmDialog.tsx:66`, `src/daemon/ledger/persona.ts:551`, `src/daemon/daemon.ts:547`).
- **Missing concept:** one function that picks the vendor from availability. This plan adds it as `firstUsableVendor`, plus `defaultPmVendor` for the zero-usable fallback.

### Verified evidence

The isolated environments ran a real daemon from this commit with `AGENT_HUB_HOME` and `HOME` under `/tmp/default-vendor/env-<mode>/`. Every vendor's `AGENT_HUB_<VENDOR>` variable pointed at a missing path, except `AGENT_HUB_CODEX` in the Codex-only environment, which pointed at the real `codex` binary, with a copy of the Codex sign-in in the isolated `HOME` that was deleted after the run. Launch and capture scripts: `/tmp/default-vendor/scripts/launch.sh` and `/tmp/default-vendor/scripts/capture.mts`.

| # | Entry point | Where the vendor is picked | Evidence | Fix |
|---|---|---|---|---|
| 1 | Web New PM dialog | `src/web/components/NewPmDialog.tsx:66` uses `DEFAULT_AGENT_SETTING` | [Measured] Codex only: the Provider row reads `Claude Code (Not installed)`, Create stays disabled with a valid name, and the reason sits inside the collapsed `More settings` (`before/codex/1440-03-…`, `390-03-…`, `1440-04-…`). Nothing installed: same, with no pointer to Providers (`before/none/1440-04-…`). | Default from `newPmDefaultVendor`, following catalog refreshes until the user touches Provider. When the picked provider cannot run, show a line above Create with `Manage providers…` and expand `More settings`. |
| 2 | First start of the daemon | `src/daemon/daemon.ts:545-552` calls `createPm` without a vendor | [Measured] Both environments: `pm 1 项目经理 claude` while Codex was `available` (`before/codex-state-initial.json`). Sending to it shows `找不到 Claude  Manage providers…` (`before/codex/1440-06-default-pm-send.png`). | D1: `ensureFirstRunPm` waits for probes within the budget, picks with `defaultPmVendor`, and checks `AGENT_HUB_DEFAULT_MODEL` against that vendor instead of always Claude. |
| 3 | HTTP API, Router `project-create`, Feishu through the Router | `src/daemon/ledger/persona.ts:551`, reached from `src/daemon/ui-server/routes-pms.ts:39` and `src/daemon/router/target-port.ts:466` | [Measured] `POST /api/pms` without `vendor` on Codex only gave `api-no-vendor claude`. [Measured in a test] Router `project-create` without `--vendor`, which Feishu project creation also goes through, gave a Claude PM on a Codex-only ledger (`pm-default-vendor.test.ts`). | D2: `createPmIn` uses `input.vendor ?? defaultPmVendor(ctx.vendorAvailability)`. A named vendor is kept. |
| 4 | Web first-launch Providers guide | `src/web/shell-model.ts:270` requires `pms.length === 0` | [Measured] Neither environment opened a dialog on first load (`before/*/notes.txt`, `before/none/1440-01-first-open.png`). | D3: drop the zero-PM condition. The guide still opens only when no provider is usable, and only once per browser. |
| 5 | Router `Auto` | `src/shared/router-model.ts:232` | [Measured] Codex only: the top bar shows `Auto GPT-6-Luna` and the command ran on Codex (`before/codex/1440-01-first-open.png`). The Codex launch then failed with `sandbox-exec: sandbox_apply: Operation not permitted`, because this Worker runs inside a macOS sandbox. That failure is an artifact of the test machine. | Already correct. Its loop moves onto `firstUsableVendor(…, { probedOnly: true })` so that one rule serves both. |
| 6 | Router with nothing installed | `src/shared/router-model.ts:253` | [Measured] The reply reads `本机尚未安装任何已接入的 Agent CLI，无法执行自由指令分派` with only `Retry` (`before/none/1440-07-router-command.png`). | Not fixed. Once D3 lands, Providers opens on first launch, and the Router text already says the reason. Adding a Providers link to Router failures is a separate interface change. |
| 7 | Router command placeholder vendor | `src/daemon/router/dispatcher.ts:895` | [Measured] The failed command row stores `vendor: "claude"` (`before/none-state-after.json`). | Not fixed. The value is a placeholder that success overwrites, and no screen shows it for a failed command. |
| 8 | Remote computers | Per-device catalogs in `DevicePicker` (`NewPmDialog.tsx:286`); the Router prompt's vendor list (`src/daemon/router/prompt.ts:119`) | [Inferred] The dialog fix runs per device, because each device scope reads its own `/api/models`. D2 runs on the target daemon, so an omitted vendor follows the target computer. The Router prompt still lists the local computer's vendors, so a Router that names `--vendor` can pick one that the remote computer lacks. | Fixed through 1 and 3. The Router prompt list is not fixed: per-device availability in the fleet digest is a separate change, and the remote PM still reports the missing vendor on its first message. |
| 9 | Worker and Task Graph defaults | `src/daemon/ledger/workers/start.ts:119`, `workers/dispatch.ts:35` | [Inferred] Workers default to their PM's vendor, which already runs on the same daemon. A named vendor passes `checkTargetVendorUsable` (`workers/create.ts:59`), and a Task Graph step raises the existing user-blocker card (`task-graphs/progress.ts:164`). | Not fixed: no system-picked default is involved. |
| 10 | Task Graph skill example | `src/shared/hub.ts:321` shows `"vendor":"agy"` as the review example | [Inferred] A PM that copies the example on a Codex-only computer gets a step that asks the user to install Antigravity. The PM prompt already tells the PM to check `hub models` before naming a vendor (`src/daemon/prompt.ts:150`). | Not fixed. A per-computer example would make shipped skill text differ by machine, which breaks the prompt cache across sessions. |
| 11 | Feishu PM model card | `src/daemon/feishu/model-picker.ts:80` lists signed-out vendors | [Inferred] The user picks explicitly, and the option carries its state label. | Not fixed: the user makes the choice, not the system. |
| 12 | Display fallbacks | `selectors.ts:255`, `:353`, `InfoTab.tsx:526`, `WorkPanelShell.tsx:96`, `ledger/router.ts:1217`, `task-graphs/progress.ts:101`, `prompt.ts:42`, `vendors.ts:188` | [Inferred] Each one labels a stored row whose vendor is null or unknown. None decides what runs. | Not fixed. |
| 13 | Provider manager Git install | `src/daemon/provider-manager/manager.ts:500` uses `AGENT_VENDORS[0]` | [Inferred] It only borrows that vendor's managed environment variables to install Git, and no vendor CLI starts. | Not fixed. |

The same runs also showed Chinese text on the web (`找不到 Claude`, the Router failure line), which the language policy asks to be English. That text comes from daemon health notices that Feishu shares. It is out of scope here and belongs to a language sweep.

## 3. Reference designs and approach comparison

- aider picks its model from the API keys it finds, and with no keys it offers to connect a provider ([Models and API keys](https://aider.chat/docs/troubleshooting/models-and-keys.html)).
- Zed's agent panel asks first-time users to configure a provider or an external agent before chatting, and model choice is limited to configured providers ([Agent Panel](https://zed.dev/docs/ai/agent-panel), [AI Quick Start](https://zed.dev/docs/ai/configuration)).

Both pick from what is configured on this machine, and both send the user to setup when nothing is configured. Neither has a fixed default that ignores the environment.

| | A. One shared picker over availability (recommended) | B. PM vendor stored as "follow default" | C. Patch each call site |
|---|---|---|---|
| Structure | A pure function in `src/shared/vendors.ts`. Each creator calls it once and stores a concrete vendor. | `pms.vendor` may be null, meaning "use whatever is first usable when a turn starts", which changes the schema and every reader of `pm.vendor`. | Replace `DEFAULT_AGENT_VENDOR` at each site with local availability checks. |
| Size | About 6 files changed, no migration. | A migration plus every reader of `pm.vendor` (prompts, handover, quota, Feishu cards, web), several times the work. | Same size as A. |
| Day-one design | Yes. The rule lives in one place, and the PM's vendor stays an explicit fact. | Closer to "auto" semantics, but silent vendor switches between turns break the prompt cache and session continuity. | No. |
| Red flags | Avoids duplicated rules and keeps stored state explicit. | Hidden state change: the vendor changes without the user acting. | Duplicated rules, which is the problem this plan fixes. |

A is recommended. B is rejected because a PM that silently changes vendor between turns loses its session and cache. A fixes the root cause (no shared rule) without rebuilding storage.

## 4. Performance and bounds

None. The picker walks the eight registered vendors without caching. `ensureFirstRunPm` adds one bounded wait of at most `VENDOR_RECHECK_BUDGET_MS` (4 s, already in `src/shared/limits.ts`), only when the ledger has no PM. No collection grows.

## 5. Cross-vendor and cross-platform unification

`firstUsableVendor` reads only `VENDOR_LIST` order and `VendorAvailability`, so it covers every vendor registered in `src/vendors/registry.ts` and every platform. Availability already comes from each vendor's catalog source on macOS, Windows, and Linux. A future vendor implements nothing new. Its `src/vendors/<vendor>/spec.ts` entry and catalog source feed the rule as they are.

## 6. Deletions

- `DEFAULT_AGENT_SETTING` in `src/shared/vendors.ts:41`. Its only caller is the New PM dialog, which moves to `newPmDefaultVendor`.
- The first-start block in `src/daemon/daemon.ts:545-553`, which moves to `ensureFirstRunPm`.
- The inline `for (const spec of VENDOR_LIST)` pick in `resolveRouterModel`, replaced by `firstUsableVendor`.
- The `local.state.pms.length === 0` clause in `src/web/shell-model.ts:270`, plus the `pms: []` setup in `ProvidersSettings.test.tsx:485` that hid the bug.

## 7. Skeleton files

- `src/shared/vendors.ts`: adds `AvailabilityOf`, `firstUsableVendor`, `defaultPmVendor`, and `availabilityOfCatalogs`.
- `src/daemon/first-run-pm.ts`: `ensureFirstRunPm`, the first-start PM with a bounded probe wait.
- `src/web/components/new-pm-provider.ts`: `newPmDefaultVendor` and `newPmProviderNotice` for the dialog.
- Implementation-only changes, which need no new exports: `src/daemon/ledger/persona.ts` (D2), `src/daemon/daemon.ts` (calls `ensureFirstRunPm`), `src/shared/router-model.ts` (uses `firstUsableVendor`), `src/web/components/NewPmDialog.tsx` (default, notice row, `More settings` open while the provider cannot run), and `src/web/shell-model.ts` (D3).
- `src/shared/vendor-default.test.ts`: tests the rule and checks that Router `Auto` and the PM default agree.
- `src/daemon/ledger/pm-default-vendor.test.ts`: tests `createPm` with and without a named vendor, and the entry points that omit one (`POST /api/pms` and Router `project-create`).
- `src/daemon/first-run-pm.test.ts`: tests the first-start PM, the probe budget and its 4 s default, the default-model check, and that later starts do nothing.
- `src/web/components/new-pm-provider.test.tsx`: tests the dialog for Codex only, a user pick that survives a refresh, and nothing installed on desktop and mobile.
- `src/web/first-run-providers.test.tsx`: tests that the first-launch guide fires with the daemon-created PM present.

## 8. Verification plan

### Acceptance scenarios

1. **Codex only, New PM (quote 2, goal 1).** The user opens New project manager on a computer where only Codex is signed in, then types a name. Create is enabled, the Provider row reads Codex, and the new PM runs on Codex. Tests: `new-pm-provider.test.tsx` "picks Codex…", `vendor-default.test.ts`.
2. **Nothing installed, New PM (quote 2, goal 1).** The user opens New project manager with no CLI installed, then types a name. Create stays disabled, and the line "No provider is ready on this computer." with `Manage providers…` shows at 1440 and 390 without expanding anything. Test: `new-pm-provider.test.tsx` "nothing installed" for mobile=false and mobile=true.
3. **Existing logins just work (quote 1).** A Codex sign-in made outside Bellwood is used as it is. The first-start PM (D1) and Router `Auto` both run on it, and the user's first message gets a reply. Tests: `first-run-pm.test.ts` "Codex only", `vendor-default.test.ts` "share one rule". Real CLI: see the next section.
4. **First launch with nothing installed (quote 2, D3).** The daemon creates its PM, then the user opens the workbench. Settings → Providers opens once. Test: `first-run-providers.test.tsx`.
5. **Sweep (quote 3).** Every row in the Section 2 table is either fixed with a test (rows 1–5) or recorded with its reason (rows 6–13).
6. **Two consecutive turns.** The user picks Kimi in the dialog, and the catalog refreshes while the dialog stays open. The pick stays Kimi, and the default no longer overrides it. Test: `new-pm-provider.test.tsx` "keeps the provider the user picked".
7. **Restart mid-operation.** The daemon stops after the first start and starts again. No second PM is created and no probe wait happens. Test: `first-run-pm.test.ts` "does nothing on later starts".
8. **State change while queued.** Probes finish while the first start waits. The result that arrives within the budget wins (signed-out Claude loses to Codex), and a slow probe does not hold startup past the budget. Tests: `first-run-pm.test.ts` "within the budget", "past the budget", and "waits up to VENDOR_RECHECK_BUDGET_MS".
9. **Existing rules this touches.** A named vendor is kept (`pm-default-vendor.test.ts` "keeps the vendor the caller named"), and with nothing usable the default stays Claude (`pm-default-vendor.test.ts`, `vendor-default.test.ts`). `REVIEW.md` rules matching the changed files:
   - *Async work stops touching the ledger after shutdown starts* (`daemon.ts`, `ledger/**`): `ensureFirstRunPm` runs before the servers start and before shutdown handlers can close the ledger. Its only await is the bounded probe race, and it calls `createPm` once afterward.
   - *Restart recovery finishes what the last run left* (`daemon.ts`): the first-start PM is derived from the ledger (`hasAnyPm`), so nothing is minted per start.
   - *Database transactions stay synchronous* and *Growing data has a cap* (`ledger/**`): `createPmIn` stays synchronous and adds no rows beyond today's.
   - *Caches key on identity, have a limit, and retry failures soon* (`shell-model.ts`, `models.tsx`): `shell-model.ts` adds no cache, and `fetchCatalogs` in `src/web/models.tsx` lets React Query observe a rejected `/api/models` fetch instead of caching `[]` as a fresh success, so a subsequent retry recovers as soon as `/api/models` succeeds (`src/web/models.test.tsx`).
   - *Persisted fields have a reader and dual retention bounds*: no new field.
   - *Text shipped to agents holds in any project* (`ledger/**`): no agent-facing text changes.
   - *Front-end selectors return stable references* (`shell-model.ts`): D3 removes a condition and adds no selector.
   - *Stale in-flight queries never overwrite fresh mutations* (`src/web/**`): the dialog only reads the existing models query and writes no cache.
   - *A rewrite keeps what the old code guaranteed* (`src/web/**`): the unknown-vendor fallback, `Add provider…`, and the zero-provider expansion of `More settings` stay.
   - *Interface changes come with a real-browser render*: screenshots below.
   - *A result is matched to its request by an id both carry*: no new request-result matching.
   - *Tests wait for events, not for time*: the probe-budget tests use fake timers.
   - *Planned acceptance scenarios cover every requirement*: this section.
10. **Reopening a stale view.** The user opens the dialog before `/api/models` returns, while the bundled catalogs are all `unknown`. The dialog shows the first vendor, then switches to Codex when the reply lands, because the user has not touched Provider. Covered by scenario 1's test, which starts from the bundled catalogs, and by the real-browser capture.
11. **Large data volume.** Not applicable: the picker reads at most eight availability values and touches no growing collection.
12. **Malformed or dirty data.** An older ledger already holds Claude PMs, which stay as they are because only creation changes. A catalog list missing a vendor reads it as `unknown` (`vendor-default.test.ts` "availabilityOfCatalogs"). An invalid `AGENT_HUB_DEFAULT_MODEL` (including an unsupported model-effort suffix checked against `models.current(vendor)`) is dropped with a log line (`first-run-pm.test.ts`, `first-run-pm-regression.test.ts`).
13. **Cross-vendor.** The rule walks every registered vendor (`vendor-default.test.ts` uses all `AGENT_VENDORS`). Prompt cache: no system prompt, tool list, or sent message changes, so the `TokenUsage.cacheRead` gate does not apply.
14. **Cross-platform.** The rule is pure TypeScript with no platform branch. Availability already comes from each platform's catalog sources. CI runs the tests on macOS, Linux, and Windows.
15. **Cross-entry and layout.** Web at 1440 and 390 (scenarios 1, 2, 4). The HTTP API, and Feishu and the Router through `project-create` (D2, `pm-default-vendor.test.ts` "entry points"). The `hub` CLI is unchanged for named vendors. Remote computers use per-device catalogs (row 8).

### Real-environment and real-CLI verification

- **Web flows** run in the isolated environments above (Codex only, nothing installed) with Playwright screenshot sequences at 1440 and 390: first open, default PM, New PM static, named with Create hovered, `More settings` expanded, after Create, the default-PM send, and the Router. Before-captures are in `/tmp/default-vendor/before/`. After-captures go to `/tmp/default-vendor/after/` with the same names.
- **Real Codex CLI.** This Worker cannot start Codex inside its own macOS sandbox (`sandbox-exec: sandbox_apply: Operation not permitted`), so the scenario "first-start PM replies on Codex" is `not verified` here and runs in real-environment review outside the Worker sandbox or on the testbed.
- **Feishu and multiple computers.** No testbed run in this step. D2 on Feishu and on a remote computer is `not verified` until the real-environment review runs on the testbed.
- **Prompt cache.** Not applicable, as explained in scenario 13.

### Commands and visual checks

- `pnpm exec vitest run src/shared/vendor-default.test.ts src/daemon/ledger/pm-default-vendor.test.ts src/daemon/first-run-pm.test.ts src/web/components/new-pm-provider.test.tsx src/web/first-run-providers.test.tsx`
- `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify`.
- `/tmp/default-vendor/scripts/launch.sh <codex|none>` followed by `node /tmp/default-vendor/scripts/capture.mts <mode> after`, which produces the screenshot sequences above.

### Pre-implementation baseline

Recorded on the final planning commit, after decision card #448:

- New behavior, failing (29): every test in `vendor-default.test.ts` (11), `first-run-pm.test.ts` (7), `new-pm-provider.test.tsx` (6), and `first-run-providers.test.tsx` (2), plus 3 in `pm-default-vendor.test.ts` ("uses the first usable vendor", "POST /api/pms without vendor…", and "Router project-create without --vendor…"). Each `pm-default-vendor.test.ts` failure reads `expected 'claude' to be 'codex'`, matching the measured behavior.
- Unchanged rules, passing (2): `pm-default-vendor.test.ts` "keeps the registry default when nothing is usable" and "keeps the vendor the caller named".
- `first-run-pm.test.ts` also covers unchanged rules ("does nothing on later starts", "keeps the registry default"). Those tests fail only because the new module is a stub. The same rules pass today through `src/daemon/daemon.ts`.
