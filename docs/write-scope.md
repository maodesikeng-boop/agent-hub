# Worker write and read scope

Every Worker runs inside a native OS sandbox that restricts writes inside protected roots and restricts reads across Bellwood's data directory (`~/.agent-hub` by default). Project Managers run unsandboxed (`workerWriteScope` returns `null` when `role !== "worker"`).

- **Vendor-neutral scope definition**: `src/shared/write-scope.ts` builds `WriteScope` (`dataDir`, `protectedRoots`, `writableDirs`, and `readScope`) and attaches it to `LaunchFiles.writeScope`.
- **OS enforcement**: `src/daemon/driver/write-scope.ts` (`WRITE_SCOPE_ENFORCERS` and `spawnInWriteScope`) wraps Worker processes on macOS, Linux, and Windows.

## Write boundary

Inside every protected root (`protectedRoots`: `dataDir` plus any cross-volume worktree roots such as `<drive>:\.fusa-wt\<hash8>` on Windows), a normal Worker may create or modify files **only** inside its assigned worktree (`writableDirs`). Sibling worktrees, `state/`, `backups/`, `run/`, and top-level entries inside protected roots are read-only or unreadable.

Outside `protectedRoots`, a normal Worker keeps the current OS user's permissions so it can read and write the project repository, update `.git` metadata, install dependencies, and access the network. A Worker started with `--no-worktree` has `writableDirs: []`, which blocks all writes inside `protectedRoots` while leaving the project folder writable.

## Data-directory read and socket boundary

Normal Workers, read-only Workers, and single-turn Router sessions all enforce least-privilege read access over `dataDir` via `DataDirReadScope` (`src/shared/write-scope.ts`), stored in `WriteScope.readScope` for normal Workers and `ReadonlyPolicy.dataDirScope` for read-only Workers:

- **Denied by default**: The entire `dataDir` is unreadable. Workers cannot read `state/` (`ui-token`, `*-secrets.json`, `mesh/`, `push-*.json`, `hub.sqlite*`, `peers*.json`, `pm-memory/`, `personas/`, `router-home/`, `logs/`, setup logs such as `state/logs/setup/worker-<id>.log`, or other sessions' launch directories), `backups/`, `pm-home/`, `sent-files/`, or any future top-level entry unless added to `DATA_DIR_READABLE_ENTRIES`.
- **Readable allowlist**:
  - `worktrees/`, `uploads/`, and `tools/` (`DATA_DIR_READABLE_ENTRIES`).
  - `run/bin/` (`RUN_DIR_READABLE_ENTRIES`, providing the `hub` command wrapper).
  - The session's own launch directory `state/launch/<sessionId>/` (prompt, vendor settings, skills, rules, and review `pre-push` hooks).
  - Session `cwd` or `addDirs` entries that sit strictly inside `dataDir`, such as `state/router-home` for Router.
- **Socket allowlist**: Only `run/hub.sock` (`RUN_DIR_CONNECTABLE_ENTRIES`, authenticated with the per-session `AGENT_HUB_TOKEN`) accepts connections. Workers cannot connect to `run/admin.sock` or its Windows admin named pipe.
- **Sent-file boundary**: `isShareable` in `src/daemon/sent-files.ts` enforces the same `DataDirReadScope` so a session cannot leak denied `dataDir` files by attaching them as deliverables or inline links.
- **Setup failure logs**: Because `state/logs/setup/worker-<id>.log` sits inside `state/`, the daemon includes the failing setup command and log tail directly in the Worker's opening message when setup fails.

### Layer-by-layer read enforcement

1. **Outer OS sandboxes** enforce `DataDirReadScope` across the entire process tree:
   - **macOS (`seatbeltProfile` and `readonlySeatbeltProfile`)**: Denies `file-read*` on `(subpath dataDir)`, permits `file-read-metadata` so tools walking parent directories with `stat` do not fail with `EPERM`, re-allows `readable` subpaths, and restricts `network-outbound` inside `dataDir` to `run/hub.sock`.
   - **Linux (`bwrapArgs` and `readonlyBwrapArgs`)**: Mounts an empty `0700` `--tmpfs` over `<dataDir>`, read-only binds each existing `readable` entry back in, binds `run/hub.sock` (and `writableDirs` for normal Workers), and finishes with `--remount-ro <dataDir>`.
   - **Windows (`fusa-run.exe`)**: Applies inheritable `DENY FusaWorker` read ACEs on `dataDir`, `state\`, `run\`, and `backups\`, explicit `ALLOW FusaWorker` read ACEs on `worktrees\`, `uploads\`, `tools\`, and `run\bin\`, a per-session `ALLOW FusaRead-<sessionId>` read ACE on `state\launch\<sessionId>\`, and `DENY FusaWorker` on the admin named pipe before serving requests.
2. **Codex read-only permission profile**: Read-only `codex` runs its own sandbox (which cannot nest inside an outer OS sandbox) configured via `default_permissions`. The profile sets `<dataDir>` to `none`, sets each `readable` entry and `run/hub.sock` to `read` (Codex resolves by most specific path), and sets `network.enabled = true`. `thread/start` and `thread/resume` omit `sandbox`, and `turn/start` omits `sandboxPolicy`, because passing either flag causes `codex-cli` to replace the custom permission profile with its built-in preset and drop the `dataDir` read boundary.
3. **Expanded deny list (`dataDirDenyList`) for tool-level layers**: Layers that cannot express allow-inside-deny (`claude` `Read` rules and native sandbox `denyRead`, `agy` `read_file` rules, and Windows MXC `deniedPaths`) receive an expanded deny list covering every non-allowed top-level entry (`state/` as a whole, except MXC which excludes `state/launch/<sessionId>`) and every non-allowed entry under `run/`, merged with known paths from `src/shared/paths.ts` (`provider-secrets.json`, `feishu-secrets.json`, `backups/`, `pm-home/`, `run/admin.sock`, `hub.sqlite-wal`). If directory enumeration fails for any reason other than `ENOENT` or `ENOTDIR`, launch fails closed instead of starting with a partial list.

## macOS: `sandbox-exec` (`seatbelt`)

Normal Workers across all eight vendors and outer-sandboxed read-only Workers run inside `/usr/bin/sandbox-exec`. Because macOS forbids nested `sandbox-exec` calls (`sandbox_apply: Operation not permitted`, exit code 71), wrapped processes disable each vendor CLI's built-in sandbox:

| Vendor | Built-in sandbox | How Bellwood disables nesting |
| --- | --- | --- |
| `claude` | `sandbox.enabled` in user or project settings | Passes `sandbox.enabled: false` via `--settings` (`buildSessionSettings`), overriding project and user settings. |
| `codex` | Per-command `sandbox-exec` (`workspace-write` or `read-only`) | Normal Workers pass `sandboxPolicy: { type: "externalSandbox" }` on `turn/start`. Read-only Workers omit the outer wrapper and enforce boundaries through Codex's own permission profile. |
| `agy` | Terminal sandbox (`--sandbox` or `enableTerminalSandbox: true`) | Passes `--settings {"enableTerminalSandbox":false}` (`AGY_SANDBOX_OFF_ARGS`). |
| `deepseek` (`dsh`) | Local sandbox in built-in presets | Runs under `danger-full-access` inside Bellwood's outer OS sandbox. |
| `pi`, `cursor`, `opencode`, and `kimi` | No nested `sandbox-exec` by default in headless RPC or ACP | Wrapped directly by Bellwood's outer OS sandbox. |

Driver-level approval callbacks (`decideCommandApproval`, `decideFileChangeApproval`, and `commandMayWriteOutsideScope`) remain active as defense in depth.

## Linux: `bubblewrap` (`bwrap`)

Linux enforces the same boundaries with `bubblewrap` (see [Linux sandbox design](linux-sandbox-design.md)):

- **Normal Workers (`bwrapArgs`)**: Unshares user and PID namespaces (`--unshare-user --disable-userns --unshare-pid --proc /proc`), binds `/` and `--dev-bind /dev /dev`, masks `/run/user/<uid>` with an empty `0700` `--tmpfs` to block host `systemd --user` and D-Bus socket escapes, mounts a `0700` `--tmpfs` over `<dataDir>` with read-only binds for allowed entries, binds `run/hub.sock` and `writableDirs`, and remounts `<dataDir>` read-only.
- **Read-only Workers**: `claude` (`bubblewrap` + `socat`) and `codex` (`bwrap` + Landlock + seccomp) use their native Linux sandboxes; `agy`, `pi`, `deepseek`, `cursor`, `opencode`, and `kimi` run inside `readonlyBwrapArgs` (`--ro-bind / /`, writable private `tmpDir` and vendor runtime paths, `--tmpfs` over secret directories, and `--ro-bind /dev/null` over secret files including `.env` matches found by `scanSecretGlobs`).
- **Ubuntu 24.04+ setup**: Run `sudo scripts/linux-sandbox-setup.sh` once to install `bubblewrap` and `socat` and load `/etc/apparmor.d/bwrap`.

## Windows: `fusa-win-helper` (`fusa-run.exe`)

Windows enforces Worker isolation without administrator privileges or WSL 2 through `apps/windows/crates/fusa-win-helper` (see [Windows native architecture](windows-native-design.md)):

- **Job Object and restricted token**: Every Worker runs inside a `KILL_ON_JOB_CLOSE` Job Object with `JOB_OBJECT_UILIMIT_HANDLES | UILIMIT_DESKTOP | UILIMIT_GLOBALATOMS` under a full `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN)` token (never `WRITE_RESTRICTED`, so restricting SIDs participate in both read and write checks).
- **Capability SIDs (`state\win-sandbox-sids.json`)**: Protected by an exclusive cross-process lock file (`state\win-sandbox-sids.lock`), storing the shared `FusaWorker` SID, per-Worker `FusaWorker-<id>` write SIDs, and per-session `FusaRead-<sessionId>` read-only SIDs.
- **Write and read NTFS ACLs**:
  - Each root in `protectedRoots` gets inheritable `DENY FusaWorker` write permissions (write, append, delete, delete-child, `WRITE_DAC`, `WRITE_OWNER`) plus `OWNER RIGHTS (S-1-3-4): READ_CONTROL` so file owners cannot rewrite DACLs via `icacls` or `Set-Acl`.
  - Each Worker worktree directory receives an inheritable `ALLOW FusaWorker-<id>` modify ACE before `git worktree add`, so checked-out files and `node_modules` inherit permissions with zero recursive walk.
  - Before launch, `prepareOsSandboxForLaunch` asynchronously sets `DENY FusaWorker` read on `dataDir`, `state\`, `run\`, and `backups\`, `ALLOW FusaWorker` read on `worktrees\`, `uploads\`, `tools\`, and `run\bin\`, and `ALLOW FusaRead-<sessionId>` read on `state\launch\<sessionId>\`. ACL caches key on directory identity and SID, and re-verify the target directory if it was replaced while an `fusa-run.exe` call was in flight.
  - The admin named pipe applies `acl deny-pipe` (`DENY FusaWorker`) before serving requests; requests arriving before hardening receive HTTP 503, and hardening failure closes the admin pipe rather than serving it unguarded.
- **Read-only Workers**: `codex` uses its native `readOnly` sandbox; the other five vendors use `@microsoft/mxc-sdk` ProcessContainer on Windows 11 24H2+ when available, and fall back to `fusa-run.exe --readonly-fallback` plus vendor tool-level write blocks with a `driver.warning` notice on older Windows builds.

## Fail-closed startup and known boundaries

- **Fail closed when the sandbox is unavailable**: Whenever `!osSandboxAvailable()` (for example missing `bwrap` or AppArmor profile on Linux, or missing `fusa-win-helper` or non-ACL FAT/exFAT storage on Windows), both task dispatch and process spawn fail immediately with platform remediation instructions. There is no flag to run Workers without an OS sandbox.
- **Known OS boundaries**: Normal Workers retain network access and run under the current OS user outside `protectedRoots`. Same-user IPC services reachable outside masked paths, such as `launchctl` on macOS, an unguarded `tmux` socket in `/tmp` on Unix, or out-of-process COM, Task Scheduler, or WMI on Windows, remain outside the threat model, which targets accidental cross-branch writes, credential reads, and privilege drift rather than hostile kernel escapes.
