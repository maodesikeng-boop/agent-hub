# Bellwood

Cross-platform multi-agent workbench for macOS, Windows, and Linux. **Router** aggregates pending decisions and deliveries across projects and computers, while each project has one **Project Manager (PM)** that dispatches short-lived **Worker** agents (`Pieces`) across multiple model CLIs and an outbound Feishu channel. Internal package names and the default data directory keep `agent-hub` and `hub` for upgrade compatibility; see `docs/README.md` for the full naming map and documentation index.

## Directory layout

- `src/daemon/`: Local daemon, SQLite ledger, Task Graph scheduler, HTTP and WebSocket servers, Feishu persistent WebSocket channel, OS sandboxes, and vendor config sync.
- `src/vendors/`: Vendor CLI drivers, protocol adapters, model catalogs, and config sync modules.
- `src/web/`: React workbench and UI component primitives in `src/web/ui/`.
- `src/hub/` and `src/feishu/`: Entry points for the `hub` CLI called by agents and the terminal Feishu setup tool.
- `src/mesh/` and `src/relay/`: Account login and device management CLI in `src/mesh/`, device trust, mutual TLS transport, and Feishu hub leases in `src/daemon/mesh/`, and the Node and Cloudflare relays in `src/relay/`.
- `src/shared/`: Shared types, numeric limits in `limits.ts`, pixel art assets, and pure functions.
- `apps/`: Desktop supervisor contract in `desktop/`, native macOS Swift shell in `macos/`, and Windows Rust and Tauri shell plus sandbox helpers in `windows/`.
- `migrations/`: Ordered SQLite schema migrations and the `manifest.sha256` that startup checks them against (`docs/ledger-database.md`).

## Engineering standards

- **Fix root causes.** Fix each defect at the boundary where the wrong state originates. Delete superseded code, docs, and prompt text in the same PR so old and new paths never coexist.
- **Centralize shared rules.** Keep backend and cross-layer thresholds and caps in `src/shared/limits.ts`, web-only UI constants in `src/web/limits.ts`, agent prompts in `src/daemon/prompt.ts`, and vendor launch arguments in `src/vendors/<vendor>/`. Never import `src/shared/limits.ts` from `vitest.config.ts` or `vite.config.ts`.
- **Prefer established libraries.** Use `zustand` for client state, `@tanstack/react-query` for fetching and query caches, Radix and `shadcn/ui` patterns for UI primitives, and `lru-cache` for bounded caches instead of custom state machines, eviction loops, or pagination glue.
- **Keep shipped text project-agnostic.** Agent prompts, the Task Graph skill, the review checklist, `hub` help and errors, system notes, and vendor-injected text ship to every user's project. They must hold for any language and build tool, trunk and remote name, code host or none, missing git or CI, and Windows PowerShell or cmd as well as POSIX shells. Rules that only this repo or team needs go in `AGENTS.md`, `REVIEW.md`, or `.agents/skills/`. `src/prompt-portability.test.ts` fails when a name such as `origin/main`, `pnpm`, `gh pr`, or a heredoc is written as an instruction for every project, and passes it as an example or under a condition that names the trait. A `REVIEW.md` rule covers the judgment calls.
- **Follow the UI standard.** Match `docs/ui-standard.md` for spacing, border radius, type scale, palette, control height, focus states, and alignment. Update `docs/ui-standard.md` first when a screen needs a pattern the standard does not yet cover.
- **Language policy.** Source code comments, Web UI copy, `AGENTS.md`, `REVIEW.md`, `docs/`, commit messages, and PR descriptions use English. `README.zh-CN.md`, Feishu user cards, and agent-user chat or internal agent prompts remain Chinese.
- **Minimal comments.** Do not write comments that restate code, echo type signatures, add section banners (`// ----`), or cite doc section numbers. Write a concise one-line English comment only for a non-obvious *why*, such as a security invariant, a concurrency subtlety, or an OS or vendor quirk that types and names cannot express.
- **Small modules and functions.** Do not build multi-thousand-line factory closures or giant functions. Keep modules focused and functions short with explicit typed parameters instead of large shared mutable closures. `src/code-hygiene.test.ts` enforces these rules and the comment rules: new files stay at or under 1,000 lines (including `.swift` and `.rs` under `apps/`), `.ts` functions at or under 250 lines, and `.tsx` components and functions at or under 300 lines, and comments are English with no banners or doc references. Legacy oversized entries in `src/code-hygiene.baseline.json` cannot grow.

## Caches and state bounds

Every cache, state snapshot, and growing collection must satisfy all four rules below. Guard tests live in `src/web/selectors-cache.test.ts`, `src/daemon/store/db-cache.test.ts`, and `src/web/sw-rules-cache.test.ts`:

1. **Invalidation.** Invalidate entries promptly when underlying files, configs, or ledger rows change, and clean up session state when a session exits or is deleted. Keep failed or empty lookups only for a short retry backoff such as `FETCHED_QUOTA_RETRY_MS`, never as normal cached values.
2. **Upper bounds.** Size every in-memory collection, single API response, and command output for one month of continuous use: 300 finished Workers, 30,000 messages, and 50,000 step logs. Put backend and shared cap constants in `src/shared/limits.ts`, web-only UI constants in `src/web/limits.ts`, and enable compression on large responses.
3. **Stable front-end references.** Selectors and hooks must return the same object reference when their inputs have not changed, such as by caching per input object in a `WeakMap`, so child `memo` boundaries hold.
4. **Measured verification.** For performance or wide-impact changes, measure before and after numbers using `.agents/skills/benchmark-checklist/SKILL.md` and `blast-radius`, and record the numbers in the PR.

## Testing and merge policy

- **Local verification (development).** While iterating or fixing individual failures, run only the targeted test files or screenshot target affected by the edit (for example `pnpm exec vitest run <file>` or `pnpm ui:polish shots --only <target>`). Do not chain `pnpm test:related`, full `pnpm ui:polish` runs, or performance benchmarks into repeated `&&` loops after each small edit. Run the full local gate (`pnpm lint`, `pnpm typecheck`, `pnpm test:related`, and `pnpm verify` per `.agents/skills/verify/SKILL.md`) once after all edits are final and right before the final push; do not replace that final `pnpm test:related` pass with hand-picked test files. `pnpm test:related` (`scripts/test-related.ts`) runs every test that imports a file changed since the merge base with `origin/main`, directly or transitively, plus tests and modules that name a changed non-code file such as a migration, workflow, or fixture, plus the tree-scanning guards in `ALWAYS_RUN_TESTS`. Changes to `package.json` or `pnpm-lock.yaml` stay scoped to tests and `scripts/` modules that reference them (plus `ALWAYS_RUN_TESTS` such as `src/direct-dependencies.test.ts`), leaving the full suite to CI; changes to `vitest*.config.*` (or `vite.config.*`) still run the full suite. A new guard that scans the tree instead of importing its target must join `ALWAYS_RUN_TESTS`. `src/shared/write-scope.test.ts` is mandatory whenever sandboxes or write scopes change. Never use `gh run rerun` to hide a flaky test. Inside a macOS Worker sandbox, tests that need `ps` or a nested `sandbox-exec` skip through `test/sandbox-probes.ts` and still run on CI. The project setup command installs dependencies outside the sandbox; a `pnpm install` inside it cannot write the shared pnpm store and builds a separate store of about 1 GB in the worktree's ignored `.pnpm-store/`, so rerun it only when `package.json` or the lockfile changed.
- **Cloud checks and handoff division.** Cloud CI runs `migration-claims` on every PR to `main`, alongside the 4 parallel Ubuntu full-suite shards (`check (ubuntu 1/4)` through `check (ubuntu 4/4)`) plus smoke and path-filtered platform jobs as the hard merge gate. If a PR is immediately followed by an independent review step and does not change platform code that this machine cannot test (Linux `bwrap`, Windows native, or desktop packaging), the implementation Worker may hand off after pushing so independent review and cloud CI run in parallel. Otherwise, wait for the PR's CI checks (`node scripts/wait-checks.ts <PR>` or `node scripts/wait-checks.ts` on the PR branch; `check` takes about 3 minutes) before reporting done. Do not use `gh pr checks --watch`: it hangs on `bellwood/review` (which stays pending until independent review passes on high-risk paths) and on merge conflicts where `pull_request` workflows never start; `scripts/wait-checks.ts` ignores pending `bellwood/review` and fails immediately on conflicts, a GitHub `BEHIND` verdict, or red checks. Before reporting green, it rechecks migration claims against current `main` and open PRs. A red check is yours to fix, including Linux `bwrap` and Windows jobs this machine cannot run. If the same failure is red on `main` or the test is flaky, report it as a problem instead of reporting done.
- **Independent review (this repository).** Reviewers inspect the PR diff and surrounding code against the general checklist in `src/shared/review.ts` and every rule in `REVIEW.md` on `main` (`git show origin/main:REVIEW.md`) whose `Trigger:` matches a changed path. Tag each finding in the report's `问题` field as `[Important]`, `[Nit]`, or `[Pre-existing]`; only `[Important]` results in `FAIL`, while `[Nit]` and `[Pre-existing]` are noted with `PASS`. Round 2+ follow-up reviews verify open `[Important]` findings and the incremental diff since the last reviewed commit, stopping for human escalation after 3 rounds. During review, run only the directly related test files (or `pnpm test:related --base <prev-sha>` on a follow-up round) and `pnpm verify` (plus real-browser render checks when UI files changed). When the PR already has cloud CI running or green, do not rerun the full `pnpm test:related` locally; check cloud CI with `node scripts/wait-checks.ts <PR>` before issuing a verdict. Run full `pnpm test:related` locally during review only for branches without a PR or CI run. When fixing an `[Important]` finding, add a regression test or structural guard in the same PR; if the mistake is only recognizable by reading a diff and has recurred in two or more PRs, also append a `Trigger:`/`Check:`/`Seen in:` entry to `REVIEW.md` in that PR, keeping existing entries. Review steps run on a different vendor from the implementation step.
- **Layered cloud checks.** `check` (4 Ubuntu shards) runs on every pull request with no path filter, so branch protection can require `check (ubuntu 1/4)` through `check (ubuntu 4/4)`. Touching platform code, drivers, process, pipe, git, or sync layers, `apps/windows/**`, or `test/windows/**` also triggers `.github/workflows/windows.yml`. Touching `apps/**`, packaging scripts, or the lockfile triggers the desktop installer workflows. Runs on `main` are never cancelled by a later merge. `.github/workflows/nightly.yml` runs the full suite on Ubuntu, Windows, and macOS against `main` at 14:17 UTC (22:17 Beijing time, off the top of the hour) every night to surface flaky tests. Release candidate tags run the same three suites (`check.yml`, `windows.yml`, `macos.yml`) plus `pnpm verify` on the tagged commit before `.github/workflows/release.yml` publishes anything ([Release flow](docs/release-flow-design.md#releasing)). `scripts/ci-workflows.test.ts` guards these rules and the desktop path filters.
- **When to merge.** `main` is protected: merge only through a pull request whose checks have all finished green, including path-filtered Windows and desktop jobs that ran, and after required reviews pass. Use squash merge only; GitHub deletes the head branch after merge. Never push directly to `main`, and never merge a draft. For a PR that changes a path listed under "Paths that require a review stamp" in `REVIEW.md`, once an independent review judges `PASS` on its head commit and cloud checks are green, the Project Manager posts the required `bellwood/review` `success` commit status with `node scripts/post-review-stamp.ts <PR> --sha <HEAD_SHA> [--account <login>]` (for example `--account maodesikeng-boop` when `gh`'s active account lacks write access) and then squash-merges. A Task Graph line shares one PR, and the Project Manager runs `hub graph finish` only after that PR merges. When a merged PR changes the daemon or the web UI, the Project Manager runs `hub self-reload` (with `--build` when `src/web/` changed) so the running daemon serves the new code.

## Plans, commits, and pull requests

- **Plan first.** Tasks that call for a design plan deliver both a design doc and a code skeleton (types, function signatures, contracts, and `it.todo` cases) on the same branch per `docs/plan-standard.md`. Implementation steps fill in the bodies on that skeleton.
- **Commit and PR discipline.** Project Managers coordinate tasks with `.agents/skills/poteto-mode/SKILL.md`. Workers do not load `poteto-mode` and follow their task brief and these rules directly:
  - Split commits and structure PR descriptions per `.agents/skills/poteto-mode/playbooks/opening-a-pr.md`. State the user goal in the first sentence of `## Why` and write both headings and body prose in English.
  - Read your full diff before committing. Remove AI filler per `.agents/skills/unslop/SKILL.md` and delete redundant comments per `.agents/skills/no-comments/references/comment-sicko.md` without spawning subagents.
  - Follow `.agents/skills/technical-writing/SKILL.md`. Fill in `.github/pull_request_template.md`.
  - To update a PR description, write it to a file and run `git fetch origin main`. Run `git tag -f -a --cleanup=verbatim pr-body/<PR> -F <file> origin/main`, then `git push -f origin refs/tags/pr-body/<PR>`. Replace the placeholders with the PR number and the description file. The workflow applies the description and removes the remote tag. If the workflow is not on `main` yet, include the description file in your handoff for the Project Manager.
  - Open a design or plan PR that still awaits the user's decision as a draft (`gh pr create --draft`), and run `gh pr ready` only after the user approves it. Open every other PR ready for review. This overrides the readiness rule in the `pstack` PR playbook.

## Direct dependencies

Only direct dependencies in `package.json` and `apps/windows/Cargo.toml` are listed here (macOS uses system frameworks). Check this list before adding a package, and update this section in the same PR whenever dependencies change.

### Daemon (`src/daemon`)

- `fastify`: HTTP server (`agent-api/server.ts`, `ui-server/server.ts`, `peers/proxy.ts`).
- `@fastify/websocket` and `ws`: WebSocket server and client (`ui-server/server.ts`, `peers/routes.ts`, `peers/proxy.ts`).
- `@fastify/static`: Serves the built web assets (`ui-server/server.ts`).
- `@fastify/compress`: Compresses large HTTP responses (`ui-server/server.ts`, `peers/proxy.ts`).
- `zod`: Input validation (`ledger/hub-commands.ts`, `peers/service.ts`, `update-checker.ts`).
- `lru-cache`: Bounded caches (`commands-catalog.ts`, `driver/model-catalog.ts`, `shared/paths.ts`, `platform/win32/`, `skill-files.ts`, `ledger/loaded-skills.ts`, `daemon/feishu/service.ts`, `update-checker.ts`, `src/relay/node/server.ts`).
- `web-push`: Web Push delivery (`push/sender.ts`, `push/vapid.ts`).
- `@peculiar/x509` and `reflect-metadata`: Generates self-signed Ed25519 device certificates (`src/daemon/mesh/identity.ts`).
- `@agentclientprotocol/sdk`: Agent Client Protocol (ACP) client and server transport (`src/vendors/_common/acp/`).
- `jsonc-parser`: Comment-preserving JSON and JSONC parsing and patching (`src/vendors/_common/sync/jsonc.ts`).
- `@decimalturn/toml-patch`: Comment-preserving TOML parsing and patching (`src/vendors/_common/sync/toml.ts`).
- `write-file-atomic`: Same-directory temp file, `fsync`, and `rename` for atomic user config writes while preserving symlink targets and permissions (`daemon/vendor-sync/backup.ts`).
- `@microsoft/mxc-sdk`: Windows 11 24H2+ MXC ProcessContainer probing and read-only container execution, with restricted-token fallback on older Windows builds (`daemon/platform/win32/mxc-readonly.ts`, `daemon/platform/win32/mxc-runner.ts`).
- `@larksuiteoapi/node-sdk`: Feishu Open API, persistent WebSocket events, card callbacks, QR `registerApp`, and message `normalize`. Only `daemon/feishu/sdk.ts` imports this package; all other modules depend on `daemon/feishu/transport.ts` (`docs/feishu-design.md`).
- `sharp`: On-demand temporary image resizing before Feishu uploads (`daemon/feishu/files.ts`) and PNG rendering of slime group avatars (`daemon/feishu/avatars.ts`).
- `p-limit`: Concurrency cap for Feishu media pre-uploads and reconnect catch-up (`daemon/feishu/service.ts`).
- `unified`, `remark-parse`, and `remark-gfm`: Markdown AST parsing for sent file extraction (`sent-files.ts`).
- Built-in Node modules: `node:sqlite` for the SQLite database (`store/`) and `node:fs` for skill symlink sync (`src/vendors/_common/sync/skills.ts`).

### Web workbench (`src/web`)

- `react` and `react-dom`: UI runtime. `vite` and `@vitejs/plugin-react`: bundler (`vite.config.ts`).
- `zustand`: Client state (`components/Composer.tsx`, `device-hub.ts`).
- `@tanstack/react-query`: On-demand fetching and caching (`App.tsx`, `components/BrowserSessions.tsx`, `components/PmMemoryFilesGroup.tsx`).
- `@tanstack/react-virtual`: Dynamic row-height virtual scrolling for the chat message list (`useVirtualRows.ts`, `components/MessageList.tsx`).
- `tailwindcss` and `@tailwindcss/vite`: Styling (`styles.css`).
- `lucide-react`: Smooth-line UI icons re-exported from `src/web/ui/icons.ts` alongside custom device-type and pinned SVGs.
- `react-resizable-panels`: Resizable multi-column shell panes with min/max bounds (`src/web/ui/resizable.tsx`).
- `lato-font`: Bundled Lato 2.015 web fonts in the `400`, `500`, and `600` weights, used unmodified (`src/web/styles.css`, preloaded by `vite.config.ts`).
- `clsx` and `tailwind-merge`: Class merging in `cn()` (`lib/utils.ts`). `class-variance-authority`: button variants (`ui/button.tsx`).
- `qrcode-generator`: QR code rendering in `components/QrCode.tsx` and terminal QR output in `src/feishu/main.ts`.
- Markdown rendering: `react-markdown`, `remark-gfm`, `remark-breaks`, `remark-cjk-friendly`, and `remark-cjk-friendly-gfm-strikethrough` (`components/Markdown.tsx`).
- Syntax highlighting: `shiki` (`highlight.ts`).
- Charts and diagrams: `mermaid`, `vega`, `vega-lite`, `vega-embed`, `vega-interpreter`, and `dompurify` (`charts/`).

### UI primitives (`src/web/ui/`)

- Built on Radix primitives with `shadcn/ui` styling conventions. The repository has **no `components.json` and no `@/` path alias**, so `shadcn add` cannot run directly.
- Installed primitives: `button` (`@radix-ui/react-slot` and `class-variance-authority`), `input`, `select` (`@radix-ui/react-select`), `resizable` (`react-resizable-panels`), `dialog` (`@radix-ui/react-dialog`), `drawer` (`vaul`, wrapped only in `src/web/ui/drawer.tsx`), `popover` (`@radix-ui/react-popover`), `tabs` (`@radix-ui/react-tabs`), `collapsible` (`@radix-ui/react-collapsible`), `avatar` (`@radix-ui/react-avatar`), `switch`, and `segmented` (`@radix-ui/react-radio-group`). `ModeRows.tsx` and the `CapabilityScopeSwitch.tsx` project picker also use `@radix-ui/react-radio-group` directly.
- Not installed: `Sheet`, `Textarea`, `Tooltip`, `DropdownMenu`, `ScrollArea`, and `Sonner`.
- To add a primitive: inspect upstream source with `pnpm dlx shadcn@latest view <name>`, copy it into `src/web/ui/<name>.tsx` with relative imports (`../lib/utils.ts`), install any runtime package with `pnpm add`, and align styles with `docs/ui-standard.md`.

### Desktop shells (`apps/desktop`, `apps/macos`, `apps/windows`)

- Shared supervisor contract: `apps/desktop/contract.json` (`apps/macos/DaemonSupervisor.swift`, `apps/windows/crates/fusa-supervisor/src/contract.rs`, `apps/windows/crates/fusa-desktop/src/lib.rs`).
- macOS (`apps/macos/`): Native Swift (`AppKit`, `WebKit`, `UserNotifications`) built by `scripts/build-mac-app.sh`. `--dist` stages an official Node binary and daemon runtime (`scripts/stage-mac-runtime.ts` and `scripts/stage-runtime-common.ts`) and packs a signed DMG with `codesign` and `hdiutil` (`docs/mac-distribution-design.md`).
- Windows (`apps/windows/`, Rust workspace with `fusa-win-helper`, `fusa-supervisor`, and `fusa-desktop`): `windows-sys` (Win32 Job Objects, restricted tokens, NTFS ACLs, Restart Manager, sleep inhibition, and named pipes), `tauri`, `tauri-build`, `tauri-plugin-single-instance`, `tauri-plugin-dialog`, and `tauri-plugin-opener`, `ureq` (loopback health and auth probes), `winreg` (system and user `Path` lookup), `sha2` (runtime manifest SHA-256 verification and pipe naming), `serde`, `serde_json`, `thiserror`, `url`, and `tempfile` for Rust tests (`docs/windows-native-design.md`).

### Testing and tooling

- `vitest` (`vitest.config.ts`), `jsdom` (`src/shared/test-helpers.ts`), `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom` (`src/web/test-setup.ts`).
- `playwright`: Library-only headless Chromium driver for real-browser screenshots and smoke checks (`test/ui-polish/capture.ts`, `test/ui-polish/patches.ts`, `scripts/verify-smoke.ts`, `scripts/bench-message-list.ts`; install once via `pnpm exec playwright install chromium`).
- `@axe-core/playwright`: Automated contrast and accessibility checks (`test/ui-polish/checks.ts`).
- `yaml`: Parses GitHub workflow files in `scripts/ci-workflows.test.ts` and prunes `pnpm-lock.yaml` for the staged desktop daemon (`scripts/staged-lockfile.ts`).
- `@tauri-apps/cli`: Exact-pinned Tauri CLI that builds the Windows NSIS installer from `node_modules/.bin` (`.github/workflows/windows-desktop.yml`); its version also pins the NSIS download it fetches.
- `typescript` (`pnpm typecheck`), `oxlint` and `oxlint-tsgolint` (`pnpm lint`, `.oxlintrc.json`, `.oxlint-baseline.json`), `knip` (`pnpm exec knip --treat-config-hints-as-errors`), `@types/node`, `@types/react`, `@types/react-dom`, `@types/ws`, `@types/web-push`, `@types/write-file-atomic`, and `oxc-parser` (AST timer guard in `src/web/web-guard.test.ts`).
- `wrangler` and `@cloudflare/workers-types`: Deployment and local Durable Object integration tests for the Cloudflare relay (`wrangler.toml`, `src/relay/cloudflare/`).

## Repository skills (`pstack`)

- Upstream `backnotprop/pstack` (`MIT`, `@ f104aa8`) skills live in `.agents/skills/` under `.agents/skills/PSTACK-LICENSE`.
- `.agents/skills/verify/` is a Bellwood-specific skill and must be preserved when updating `pstack`.
- `<repo>/.agents/skills/` is the single canonical directory (`.claude/skills` is a symlink to `../.agents/skills`), loaded directly from the repository without writing to the user's home directory.
- To update `pstack`: copy the new upstream `skills/` into `.agents/skills/` while keeping `PSTACK-LICENSE` and `verify/`, update the commit SHA above, and open a PR.
