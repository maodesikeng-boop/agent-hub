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
- `migrations/`: Ordered SQLite schema migrations.

## Engineering standards

- **Fix root causes.** Fix each defect at the boundary where the wrong state originates. Delete superseded code, docs, and prompt text in the same PR so old and new paths never coexist.
- **Centralize shared rules.** Keep tunable thresholds and caps in `src/shared/limits.ts`, agent prompts in `src/daemon/prompt.ts`, and vendor launch arguments in `src/vendors/<vendor>/`.
- **Prefer established libraries.** Use `zustand` for client state, `@tanstack/react-query` for fetching and query caches, Radix and `shadcn/ui` patterns for UI primitives, and `lru-cache` for bounded caches instead of custom state machines, eviction loops, or pagination glue.
- **Follow the UI standard.** Match `docs/ui-standard.md` for spacing, border radius, type scale, palette, control height, focus states, and alignment. Update `docs/ui-standard.md` first when a screen needs a pattern the standard does not yet cover.
- **Language policy.** Source code comments, Web UI copy, `AGENTS.md`, `REVIEW.md`, `docs/`, commit messages, and PR descriptions use English. `README.zh-CN.md`, Feishu user cards, and agent-user chat or internal agent prompts remain Chinese.
- **Minimal comments.** Do not write comments that restate code, echo type signatures, add section banners (`// ----`), or cite doc section numbers. Write a concise one-line English comment only for a non-obvious *why*, such as a security invariant, a concurrency subtlety, or an OS or vendor quirk that types and names cannot express.
- **Small modules and functions.** Do not build multi-thousand-line factory closures or giant functions. Keep modules focused and functions short with explicit typed parameters instead of large shared mutable closures. `src/code-hygiene.test.ts` enforces these rules and the comment rules: new files stay at or under 1,000 lines, `.ts` functions at or under 250 lines, and `.tsx` components and functions at or under 300 lines, and comments are English with no banners or doc references. Legacy oversized entries in `src/code-hygiene.baseline.json` cannot grow.

## Caches and state bounds

Every cache, state snapshot, and growing collection must satisfy all four rules below. Guard tests live in `src/web/selectors-cache.test.ts`, `src/daemon/store/db-cache.test.ts`, and `src/web/sw-rules-cache.test.ts`:

1. **Invalidation.** Invalidate entries promptly when underlying files, configs, or ledger rows change, and clean up session state when a session exits or is deleted. Keep failed or empty lookups only for a short retry backoff such as `FETCHED_QUOTA_RETRY_MS`, never as normal cached values.
2. **Upper bounds.** Size every in-memory collection, single API response, and command output for one month of continuous use: 300 finished Workers, 30,000 messages, and 50,000 step logs. Put all cap constants in `src/shared/limits.ts` and enable compression on large responses.
3. **Stable front-end references.** Selectors and hooks must return the same object reference when their inputs have not changed, such as by caching per input object in a `WeakMap`, so child `memo` boundaries hold.
4. **Measured verification.** For performance or wide-impact changes, measure before and after numbers using `.agents/skills/benchmark-checklist/SKILL.md` and `blast-radius`, and record the numbers in the PR.

## Testing and merge policy

- **Targeted local verification.** During development and independent review, run `pnpm typecheck`, the test files covering the changed modules (`src/shared/write-scope.test.ts` is mandatory whenever sandboxes or write scopes change), and `pnpm verify` (`.agents/skills/verify/SKILL.md`). Do not run the full `vitest` suite locally or block on desktop installer builds or cloud CI queues. Never use `gh run rerun` to hide a flaky test.
- **Two-layer review.** Independent reviews check the general checklist in `src/shared/review.ts` first, then check every rule in `REVIEW.md` on `main` whose `Trigger:` matches a changed path. Tag each finding as `[Important]`, `[Nit]`, or `[Pre-existing]`; only `[Important]` blocks a merge. When fixing an `[Important]` finding, add a regression test or structural guard in the same PR; if the mistake is only recognizable by reading a diff and has recurred in two or more PRs, also append a `Trigger:`/`Check:`/`Seen in:` entry to `REVIEW.md` in that PR, keeping existing entries.
- **Layered cloud checks.** Pull requests run 4 parallel Ubuntu shards by default. Touching platform code, drivers, process, pipe, git, or sync layers, `apps/windows/**`, or `test/windows/**` also triggers `.github/workflows/windows.yml`. Touching `apps/**`, packaging scripts, or the lockfile triggers the desktop installer workflows.
- **When to merge.** Merge routine changes that can be verified locally into `main` once targeted tests and required reviews pass; `main` runs full regression suites and desktop bundle self-tests asynchronously. Changes to the Linux `bwrap` sandbox, Windows native crates, or installer packaging that cannot be verified on the local OS must wait for the matching cloud check to pass before merging.

## Plans, commits, and pull requests

- **Plan first.** Tasks that call for a design plan deliver both a design doc and a code skeleton (types, function signatures, contracts, and `it.todo` cases) on the same branch per `docs/plan-standard.md`. Implementation steps fill in the bodies on that skeleton.
- **Commit and PR discipline.** Project Managers coordinate tasks with `.agents/skills/poteto-mode/SKILL.md`. Workers do not load `poteto-mode` and follow their task brief and these rules directly:
  - Split commits and structure PR descriptions per `.agents/skills/poteto-mode/playbooks/opening-a-pr.md`. State the user goal in the first sentence of `## Why` and write both headings and body prose in English.
  - Read your full diff before committing. Remove AI filler per `.agents/skills/unslop/SKILL.md` and delete redundant comments per `.agents/skills/no-comments/references/comment-sicko.md` without spawning subagents.
  - Follow `.agents/skills/technical-writing/SKILL.md`. Open PRs ready for review (never as drafts), and wait for CI only when the task brief or platform rule requires it.

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
- `@tanstack/react-query`: On-demand fetching and caching (`App.tsx`, `components/BrowserSessions.tsx`, `components/PmProfile.tsx`).
- `@tanstack/react-virtual`: Dynamic row-height virtual scrolling for the chat message list (`useVirtualRows.ts`, `components/MessageList.tsx`).
- `tailwindcss` and `@tailwindcss/vite`: Styling (`styles.css`).
- `pixelarticons`: 24-grid pixel icons re-exported from `src/web/ui/icons.ts` alongside inline composer stroke icons.
- `@fontsource-variable/geist`: Bundled Geist Variable font (`src/web/styles.css`).
- `clsx` and `tailwind-merge`: Class merging in `cn()` (`lib/utils.ts`). `class-variance-authority`: button variants (`ui/button.tsx`).
- `qrcode-generator`: QR code rendering in `components/QrCode.tsx` and terminal QR output in `src/feishu/main.ts`.
- Markdown rendering: `react-markdown`, `remark-gfm`, `remark-breaks`, `remark-cjk-friendly`, and `remark-cjk-friendly-gfm-strikethrough` (`components/Markdown.tsx`).
- Syntax highlighting: `shiki` (`highlight.ts`).
- Charts and diagrams: `mermaid`, `vega`, `vega-lite`, `vega-embed`, `vega-interpreter`, and `dompurify` (`charts/`).
- DAG layout: `@dagrejs/dagre` for layered Task Graph layout (`task-graph-layout.ts`).

### UI primitives (`src/web/ui/`)

- Built on Radix (`@radix-ui/react-*`) with `shadcn/ui` styling conventions. The repository has **no `components.json` and no `@/` path alias**, so `shadcn add` cannot run directly.
- Installed primitives: `button` (`slot` + `cva`), `input`, `dialog`, `drawer` (`vaul`, wrapped only in `src/web/ui/drawer.tsx`), `popover`, `tabs`, `collapsible`, `avatar`, `switch`, and `segmented` (Radix `RadioGroup`). `ModeRows.tsx` and the `CapabilityScopeSwitch.tsx` project picker use `@radix-ui/react-radio-group` directly.
- Not installed: `Sheet`, `Select`, `Textarea`, `Tooltip`, `DropdownMenu`, `ScrollArea`, and `Sonner`.
- To add a primitive: inspect upstream source with `pnpm dlx shadcn@latest view <name>`, copy it into `src/web/ui/<name>.tsx` with relative imports (`../lib/utils.ts`), install any runtime package with `pnpm add`, and align styles with `docs/ui-standard.md`.

### Desktop shells (`apps/desktop`, `apps/macos`, `apps/windows`)

- Shared supervisor contract: `apps/desktop/contract.json` (`apps/macos/DaemonSupervisor.swift`, `apps/windows/crates/fusa-supervisor/src/contract.rs`, `apps/windows/crates/fusa-desktop/src/lib.rs`).
- macOS (`apps/macos/`): Native Swift (`AppKit`, `WebKit`, `UserNotifications`) built by `scripts/build-mac-app.sh`. `--dist` stages an official Node binary and daemon runtime (`scripts/stage-mac-runtime.ts` and `scripts/stage-runtime-common.ts`) and packs a signed DMG with `codesign` and `hdiutil` (`docs/mac-distribution-design.md`).
- Windows (`apps/windows/`, Rust workspace with `fusa-win-helper`, `fusa-supervisor`, and `fusa-desktop`): `windows-sys` (Win32 Job Objects, restricted tokens, NTFS ACLs, Restart Manager, sleep inhibition, and named pipes), `tauri`, `tauri-build`, `tauri-plugin-single-instance`, `tauri-plugin-dialog`, and `tauri-plugin-opener`, `ureq` (loopback health and auth probes), `winreg` (system and user `Path` lookup), `sha2` (runtime manifest SHA-256 verification and pipe naming), `serde`, `serde_json`, `thiserror`, `url`, and `tempfile` for Rust tests (`docs/windows-native-design.md`).

### Testing and tooling

- `vitest` (`vitest.config.ts`), `jsdom` (`src/shared/test-helpers.ts`), `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom` (`src/web/test-setup.ts`).
- `playwright`: Library-only headless Chromium driver for real-browser screenshots and smoke checks (`test/ui-polish/capture.ts`, `test/ui-polish/patches.ts`, `scripts/verify-smoke.ts`, `scripts/bench-message-list.ts`; install once via `pnpm exec playwright install chromium`).
- `@axe-core/playwright`: Automated contrast and accessibility checks (`test/ui-polish/checks.ts`).
- `typescript` (`pnpm typecheck`), `knip` (`pnpm exec knip`), `@types/*` (`node`, `react`, `react-dom`, `ws`, `web-push`, `write-file-atomic`), and `oxc-parser` (AST timer guard in `src/web/web-guard.test.ts`).
- `wrangler` and `@cloudflare/workers-types`: Deployment and local Durable Object integration tests for the Cloudflare relay (`wrangler.toml`, `src/relay/cloudflare/`).

## Repository skills (`pstack`)

- Upstream `backnotprop/pstack` (`MIT`, `@ f104aa8`) skills live in `.agents/skills/` under `.agents/skills/PSTACK-LICENSE`.
- `.agents/skills/verify/` is a Bellwood-specific skill and must be preserved when updating `pstack`.
- `<repo>/.agents/skills/` is the single canonical directory (`.claude/skills` is a symlink to `../.agents/skills`), loaded directly from the repository without writing to the user's home directory.
- To update `pstack`: copy the new upstream `skills/` into `.agents/skills/` while keeping `PSTACK-LICENSE` and `verify/`, update the commit SHA above, and open a PR.
