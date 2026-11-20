# Windows native architecture

Bellwood runs natively on Windows x64 (`Windows 10 1809+` and `Windows 11`, with `Windows 11 24H2+` recommended for outer MXC read-only containers) with **no WSL 2 requirement and no administrator privileges**. User repositories stay on native NTFS drives so Visual Studio, MSBuild, Windows SDKs, and native agent CLIs work directly (`apps/windows/` and `src/daemon/platform/win32/`).

## Workspace crates (`apps/windows/`)

1. **`fusa-desktop` (`crates/fusa-desktop/`)**: Tauri 2 native desktop shell (`tauri-plugin-single-instance`, `tauri-plugin-dialog`, `tauri-plugin-opener`, and system tray). Closing the window hides to the tray; choosing **彻底退出 Bellwood** triggers a graceful daemon shutdown and tears down every child process tree.
2. **`fusa-supervisor` (`crates/fusa-supervisor/`)**: Shares `apps/desktop/contract.json` with macOS (`reloadExitCode = 75`), verifies the SHA-256 manifest of the bundled Node 24 LTS runtime staged by `scripts/stage-win-runtime.ts`, refreshes live `HKLM` and `HKCU` `Path` entries via `winreg` so newly installed CLIs (`winget` or **Providers** in **Settings**) appear without restarting Bellwood, probes loopback HTTP health via `ureq`, inhibits idle sleep via `SetThreadExecutionState` while turns are running, and rotates daemon logs.
3. **`fusa-win-helper` (`crates/fusa-win-helper/`)**: Compiles two native binaries with zero runtime dependencies:
   - `fusa-run.exe`: Process-tree Job Object wrapper, restricted-token launcher, and NTFS/pipe ACL tool (`acl`, `probe`, `--sandbox worker`, and `--readonly-fallback`).
   - `hub.exe`: Native binary shim in `run\bin\hub.exe` so shells (`pwsh`, `cmd.exe`, Git Bash) invoke `hub` cleanly without `.cmd` batch-quoting pitfalls.

## Local IPC, process cleanup, and cross-volume worktrees

- **Named pipes (`run/hub.sock` and `run/admin.sock` equivalents)**: On Windows, `src/daemon/platform/win32/` maps `hub` and `admin` sockets to per-data-dir local named pipes (`\\.\pipe\...` derived with SHA-256). Before accepting requests on the admin pipe, the daemon runs `fusa-run.exe acl deny-pipe` (`DENY FusaWorker`), returning `503` while hardening is in progress and closing the pipe if hardening fails.
- **Leak-free process trees and file-lock recovery**: Every spawned CLI and setup script runs inside a Win32 Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` plus UI handle isolation (`UILIMIT_HANDLES | UILIMIT_DESKTOP | UILIMIT_GLOBALATOMS`). Worktree cleanup uses Win32 Restart Manager (`RmStartSession` / `RmGetList`) to identify lingering processes holding open handles before removing directories.
- **Cross-volume worktree roots (`src/daemon/platform/win32/worktree-roots.ts`)**: When `%USERPROFILE%\.agent-hub` sits on `C:\` while a project repository lives on `D:\`, creating worktrees on `C:\` would break same-volume `pnpm` hardlinks and fast renames. Bellwood places those worktrees under `D:\.fusa-wt\<dataDirHash8>\` and adds that root to `WriteScope.protectedRoots` so identical ACL isolation applies on every drive.

## Kernel write and read isolation (`fusa-run.exe` and MXC)

1. **Capability SIDs (`state\win-sandbox-sids.json`)**: Guarded by an exclusive cross-process file lock (`state\win-sandbox-sids.lock`), persisting `FusaWorker` (shared across all Workers), `FusaWorker-<id>` (per-Worker worktree write grant), and `FusaRead-<sessionId>` (per-session launch-dir read grant, bounded in size and synced with `src/shared/limits.ts`).
2. **NTFS write and read ACLs (`src/daemon/platform/win32/acl.ts`)**:
   - Protected roots receive inheritable `DENY FusaWorker` specific write bits (write, append, delete, delete-child, `WRITE_DAC`, `WRITE_OWNER`; narrow enough to preserve directory traversal) plus `OWNER RIGHTS (S-1-3-4): READ_CONTROL` to strip the owner's implicit `WRITE_DAC` right.
   - Worktree folders get inheritable `ALLOW FusaWorker-<id>` modify rights before `git worktree add` runs.
   - Data-directory read isolation ([Worker write and read scope](write-scope.md)) sets `DENY FusaWorker` read on `dataDir`, `state\`, `run\`, and `backups\`, `ALLOW FusaWorker` read on `worktrees\`, `uploads\`, `tools\`, and `run\bin\`, and `ALLOW FusaRead-<sessionId>` read on `state\launch\<sessionId>\`. Runtime ACL calls execute asynchronously via `execFile`, deduplicate in-flight `(Worker, dir)` pairs, key caches on directory identity (`stat`) + SID, and re-run if the target directory was replaced during an in-flight call.
3. **Restricted token (`CreateRestrictedToken`)**: Uses `DISABLE_MAX_PRIVILEGE | LUA_TOKEN` (without `WRITE_RESTRICTED`, ensuring restricting SIDs enforce both read and write deny ACEs) while preserving enabled user and `Authenticated Users` group SIDs so external project drives, toolchains, and `%TEMP%` work normally.
4. **Read-only Workers (`@microsoft/mxc-sdk`)**: On Windows 11 24H2+ when `base-container` or `appcontainer-bfs` with `filesystemDeniedPaths` is available, non-Codex read-only Workers run inside a Microsoft MXC ProcessContainer (`HUB_SOCK` bridged over `127.0.0.1`). On older Windows builds, Bellwood falls back automatically to `fusa-run.exe --readonly-fallback` plus tool-level write blocks and logs `driver.warning` (`WIN_MXC_NEGATIVE_CACHE_TTL_MS = 30s`).

## Packaging and CI

- `scripts/stage-win-runtime.ts` stages Node 24 LTS, `npm.cmd`/`npx.cmd`, `fusa-run.exe`, `hub.exe`, and the daemon bundle into `apps/windows/crates/fusa-desktop/staged-runtime`, which `@tauri-apps/cli` packs into a per-user NSIS installer (`Bellwood_<version>_x64-setup-unsigned-preview.exe`).
- `.github/workflows/windows.yml` runs unit and real NTFS/Job/ACL integration tests (`test/windows/**`), and `.github/workflows/windows-desktop.yml` builds the NSIS installer and executes `fusa-desktop.exe --self-test`.
