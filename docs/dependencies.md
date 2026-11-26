# Direct dependencies and repository skills

Catalog of direct npm and Cargo dependencies, installed web UI primitives, and vendored repository skills. `src/direct-dependencies.test.ts` verifies that `## Direct dependencies` matches `package.json` and `apps/windows/Cargo.toml` exactly.

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
- `p-limit`: Concurrency cap for Feishu media pre-uploads and reconnect catch-up (`daemon/feishu/context.ts`, `daemon/feishu/inbound-catchup.ts`).
- `unified`, `remark-parse`, and `remark-gfm`: Markdown AST parsing for sent file extraction (`sent-files.ts`).
- Built-in Node modules: `node:sqlite` for the SQLite database (`store/`) and `node:fs` for skill symlink sync (`src/vendors/_common/sync/skills.ts`).

### Web workbench (`src/web`)

- `react` and `react-dom`: UI runtime. `vite` and `@vitejs/plugin-react`: bundler (`vite.config.ts`).
- `zustand`: Client state (`components/Composer.tsx`, `device-hub.ts`).
- `@tanstack/react-query`: On-demand fetching and caching (`App.tsx`, `query-client.ts`, `components/PmMemoryFilesGroup.tsx`, `settings-model.ts`).
- `@tanstack/react-virtual`: Dynamic row-height virtual scrolling for the chat message list (`useVirtualRows.ts`, `components/MessageList.tsx`).
- `tailwindcss` and `@tailwindcss/vite`: Styling (`styles.css`).
- `lucide-react`: Smooth-line UI icons re-exported from `src/web/ui/icons.ts` alongside custom device-type and pinned SVGs.
- `react-resizable-panels`: Resizable multi-column shell panes with min and max bounds (`src/web/ui/resizable.tsx`).
- `lato-font`: Bundled Lato 2.015 web fonts in the `400`, `500`, and `600` weights, used unmodified (`src/web/styles.css`, preloaded by `vite.config.ts`).
- `clsx` and `tailwind-merge`: Class merging in `cn()` (`lib/utils.ts`). `class-variance-authority`: button variants (`ui/button.tsx`).
- `qrcode-generator`: QR code rendering in `components/QrCode.tsx` and terminal QR output in `src/feishu/main.ts`.
- Markdown rendering: `react-markdown`, `remark-gfm`, `remark-breaks`, `remark-cjk-friendly`, and `remark-cjk-friendly-gfm-strikethrough` (`components/Markdown.tsx`).
- Syntax highlighting: `shiki` (`highlight.ts`).
- Charts and diagrams: `mermaid`, `vega`, `vega-lite`, `vega-embed`, `vega-interpreter`, and `dompurify` (`charts/`).

### UI primitives (`src/web/ui/`)

- Built on Radix primitives with `shadcn/ui` styling conventions. The repository has **no `components.json` and no `@/` path alias**, so `shadcn add` cannot run directly.
- Installed primitives: `button` (`@radix-ui/react-slot` and `class-variance-authority`), `input`, `select` (`@radix-ui/react-select`), `resizable` (`react-resizable-panels`), `dialog` (`@radix-ui/react-dialog`), `drawer` (`vaul`, wrapped only in `src/web/ui/drawer.tsx`), `popover` (`@radix-ui/react-popover`), `tabs` (`@radix-ui/react-tabs`), `collapsible` (`@radix-ui/react-collapsible`), `avatar` (`@radix-ui/react-avatar`), and `switch`. `ChoiceRows.tsx`, `RouterModelPicker.tsx`, and `CapabilityScopeSwitch.tsx` use `@radix-ui/react-radio-group` directly.
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
- `.agents/skills/verify/` and `.agents/skills/tester/` are Bellwood-specific skills and must be preserved when updating `pstack`.
- `<repo>/.agents/skills/` is the single canonical directory (`.claude/skills` is a symlink to `../.agents/skills`), loaded directly from the repository without writing to the user's home directory.
- To update `pstack`: copy the new upstream `skills/` into `.agents/skills/` while keeping `PSTACK-LICENSE`, `verify/`, and `tester/`, update the commit SHA above, and open a PR.
