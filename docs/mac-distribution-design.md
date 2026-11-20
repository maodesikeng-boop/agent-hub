# macOS app and DMG distribution

Bellwood's macOS desktop shell (`apps/macos/`) is a native Swift application (`AppKit`, `WKWebView`, and `UserNotifications`) supervised through `apps/desktop/contract.json`. `scripts/build-mac-app.sh` builds `Bellwood.app` in two modes without changing source-checkout ergonomics.

## Build modes

1. **Source mode (`pnpm app:mac` or `bash scripts/build-mac-app.sh [--install]`)**:
   - Produces a lightweight `< 5 MB` `build/Bellwood.app` (and optionally installs `/Applications/Bellwood.app`) whose `Info.plist` embeds `AgentHubRepoDir` and `AgentHubNodePath` pointing at the local checkout and Node binary (`AGENT_HUB_REPO_DIR` and `AGENT_HUB_NODE` override them at runtime).
   - Preserves hot `hub self-reload [--build]` (`exit 75` per `apps/desktop/contract.json`).
2. **Standalone distribution mode (`bash scripts/build-mac-app.sh --dist`)**:
   - Stages a self-contained Apple silicon (`arm64`) runtime into `Bellwood.app/Contents/Resources/runtime` via `scripts/stage-mac-runtime.ts` and `scripts/stage-runtime-common.ts` (shared with Windows): official stripped Node 24 LTS, bundled `npm` and `npx` (for one-click CLI installs under **Providers** in **Settings**), `dist/web`, `src/`, `migrations/`, `apps/desktop/contract.json`, and production `node_modules`, verified by a SHA-256 runtime manifest.
   - Emits `build/dist/Bellwood_<version>_arm64-unsigned-preview.dmg` (or signed filename when `MAC_SIGN_IDENTITY` is set) plus a `.sha256` checksum file, without touching `/Applications`.

## Supervision and `--self-test`

`DaemonSupervisor.swift` reads `apps/desktop/contract.json`, launches or attaches to the loopback daemon, authenticates `WKWebView` automatically using `state/ui-token` (`POST /auth`), bridges native `NSOpenPanel` uploads, `~/Downloads` saves, default-browser external links, Dock badges, `NSStatusItem` menu-bar presence, and `caffeinate` sleep inhibition while work is active.

Running `Bellwood.app/Contents/MacOS/AgentHub --self-test` mirrors Windows `fusa-desktop.exe --self-test`: it starts the bundled daemon in a temporary data directory on a free loopback port under a clean environment (`env -i` in CI with no system `node` on `PATH`), verifies Node version, `npm`, `401` unauthenticated / `200` authenticated health checks, bundled `hub` CLI execution, and clean `SIGTERM` shutdown (`~0.8s` cold start, `~0.16s` shutdown), then prints `[fusa-self-test] PASS`.

## Code signing, notarization hooks, and DMG format

`scripts/build-mac-app.sh --dist` signs inner Mach-O binaries first (bundled `node` with `apps/macos/node.entitlements` for V8 JIT and native `.node` addons, without `get-task-allow`) and signs the outer `.app` bundle last without `--deep`, verifying with `codesign --verify --deep --strict`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAC_SIGN_IDENTITY` | `-` (ad-hoc) | Set to `Developer ID Application: ...` to enable `--options runtime --timestamp`, sign the DMG, and drop `-unsigned-preview` from the output name. |
| `MAC_NODE_ENTITLEMENTS` | `apps/macos/node.entitlements` | Hardened-runtime entitlements for the bundled Node binary. |
| `MAC_APP_ENTITLEMENTS` | unset | Optional entitlements plist for the outer Swift binary. |
| `MAC_NOTARY_PROFILE` | unset | `xcrun notarytool` keychain profile; notarizes and staples when paired with a Developer ID identity. |

`hdiutil create -srcfolder <staging> -fs HFS+ -format ULMO` packs an LZMA-compressed DMG (~41 MiB, enforced under the `60 MiB` `DMG_BUDGET_MIB` cap in `.github/workflows/mac-desktop.yml`) without `hdiutil makehybrid` (which mutates `FinderInfo` xattrs and breaks `codesign --strict`).

## CI and GitHub Releases (`.github/workflows/release.yml`)

Pushing a `v*` tag triggers `.github/workflows/release.yml` (`scripts/release-assets.ts`):

1. **`verify`**: Confirms the git tag version matches `package.json`, `apps/windows/Cargo.toml`, and `apps/windows/crates/fusa-desktop/tauri.conf.json`.
2. **`mac` and `windows`**: Reuses `mac-desktop.yml` and `windows-desktop.yml` via `workflow_call`, including isolated `--self-test` runs.
3. **`assemble` and `publish`**: Renames artifacts to stable latest-release URLs (`Bellwood-macos-arm64.dmg` and `Bellwood-windows-x64-setup.exe` with `.sha256` files) so `releases/latest/download/<asset>` links in `README.md` never break across versions. Tags with suffixes such as `v0.2.0-rc.1` publish as GitHub prereleases without moving `releases/latest`.

### In-app update check

- **Daemon**: `src/daemon/update-checker.ts` reads the running version from `package.json`, asks `https://api.github.com/repos/maodesikeng-boop/agent-hub/releases/latest` at most once per `UPDATE_CHECK_TTL_MS` (failures and rate limits retry after `UPDATE_CHECK_RETRY_MS`), and serves the result at `GET /api/update`; `POST /api/update/check` forces a check. Only non-draft, non-prerelease `vX.Y.Z` releases count, and the installer links use the fixed asset names above (`RELEASE_INSTALLER_FILES` in `src/shared/update.ts`, which `scripts/release-assets.ts` also uses).
- **Install kind**: A packaged runtime has no `.git` next to its `package.json`, so it is `bundled` and gets the sidebar `Update` reminder plus the download button in **Settings → General**. Source checkouts only see the status there.
- **Offline tests**: `AGENT_HUB_UPDATE_RELEASE_URL` points the check at a plain-HTTP loopback mock (other URLs are ignored) and `AGENT_HUB_UPDATE_INSTALL_KIND` forces `bundled` or `source`.
- **Open tabs after an upgrade**: `src/web/preload-recovery.ts` turns a `vite:preloadError` for an old hashed chunk into one page reload. It records each build and failing chunk pair in `sessionStorage`, so a chunk that still fails after the reload surfaces its error instead of reloading again.
