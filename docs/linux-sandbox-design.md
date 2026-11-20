# Linux sandbox design

On Linux, Bellwood wraps Worker processes in `bubblewrap` (`bwrap`) so normal write boundaries, data-directory read boundaries, and outer read-only Workers match macOS `sandbox-exec` semantics at the kernel mount and PID namespace level (`src/daemon/driver/write-scope.ts`).

## Why `bubblewrap` over Landlock or vendor-only sandboxes

- **Mount ordering matches `WriteScope` and `DataDirReadScope`**: `bwrap` mounts `/` first, replaces `<dataDir>` with an empty `0700` `--tmpfs`, read-only binds allowed subdirectories (`worktrees`, `uploads`, `tools`, `run/bin`, `state/launch/<sessionId>`), binds `run/hub.sock` and `writableDirs`, and remounts `<dataDir>` read-only. Landlock is allow-list only and cannot deny `.agent-hub` inside `~` without breaking atomic writes to sibling files in `~` such as `~/.claude.json`.
- **Covers built-in edit tools and child processes**: Vendor-native sandboxes often wrap only shell commands rather than the vendor CLI's own file-editing tools. Wrapping the outer CLI process covers every tool call, child process, and stdio MCP server.
- **Closes `/proc` and `systemd --user` escapes**:
  - Without `--unshare-pid --proc /proc`, a Worker can read `/proc/<daemonPid>/environ` from the host `/proc` mount.
  - Without `--perms 0700 --tmpfs /run/user/<uid>`, a Worker can call `systemd-run --user` over the host D-Bus socket and ask the unsandboxed user manager to write into `state/`.
  - `--dev-bind /dev /dev` preserves device nodes such as `/dev/null` (`--bind / /` sets `MS_NODEV`).
  - `--disable-userns` prevents processes inside the sandbox from creating nested user namespaces to remount filesystems.

## Availability probe and fail-closed startup

`probeLinuxBwrap` (`osSandboxAvailable("linux")`) runs the same namespace and mount flags used by real Workers:

```sh
bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
	--bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> -- /bin/true
```

- **Caches `true` only**: A passing probe (~4.6 ms) is cached for the lifetime of the daemon. A failing probe is never cached and does not poll; the daemon retries on the next Worker launch so running `sudo scripts/linux-sandbox-setup.sh` takes effect immediately without restarting the daemon.
- **Fail closed**: When `osSandboxAvailable()` returns `false`, both normal and read-only Workers fail to start and return an error pointing to `sudo scripts/linux-sandbox-setup.sh`. Project Managers (`scope === null`) do not use a sandbox.

## Mount layout and secret-glob scanning

### Normal Workers (`bwrapArgs`)

```sh
bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
	--bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> \
	--perms 0700 --tmpfs <dataDir> \
	--ro-bind <dataDir>/worktrees <dataDir>/worktrees \
	--ro-bind <dataDir>/uploads <dataDir>/uploads \
	--ro-bind <dataDir>/tools <dataDir>/tools \
	--ro-bind <dataDir>/run/bin <dataDir>/run/bin \
	--ro-bind <dataDir>/state/launch/<sessionId> <dataDir>/state/launch/<sessionId> \
	--bind <dataDir>/run/hub.sock <dataDir>/run/hub.sock \
	--ro-bind <extraProtectedRoot> <extraProtectedRoot> \
	--bind <writableDir> <writableDir> \
	--remount-ro <dataDir> \
	-- <cli> <ownSandboxOffArgs...> <args...>
```

All paths pass through `realpath` first, and `bwrapArgs` emits bind flags only for paths that currently exist on disk (`bwrap` exits with an error if given a missing source path). Because `<dataDir>` itself is an empty read-only `tmpfs`, files created inside `state/` or `backups/` after the Worker starts remain invisible to the Worker.

### Read-only Workers (`readonlyBwrapArgs`)

`claude` and `codex` use their own native Linux read-only sandboxes (`claude` uses `bubblewrap` + `socat`; `codex` uses `bwrap` + Landlock + seccomp). Vendors with `writeGuard: "outer"` (`agy`, `pi`, `deepseek`, and `cursor`) run inside `readonlyBwrapArgs`:

```sh
bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
	--ro-bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> \
	--perms 0700 --tmpfs <dataDir> \
	--ro-bind <readableEntry> <readableEntry> \
	--bind <dataDir>/run/hub.sock <dataDir>/run/hub.sock \
	--bind <tmpDir> <tmpDir> --setenv TMPDIR <tmpDir> \
	--bind <writableRuntimeDirOrFile> <writableRuntimeDirOrFile> \
	--tmpfs <secretDir> --ro-bind /dev/null <secretFile> \
	--remount-ro <dataDir> \
	-- <cli> <args...>
```

Because `bwrap` cannot match path globs at open time, `scanSecretGlobs` scans `[cwd, ...addDirs]` once asynchronously via `fs.promises.opendir` before launch (skipping dependency and build trees in `SECRET_SCAN_SKIP_DIRS` such as `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`, and `.codegraph`, as well as symlinked directories) and merges matched `.env`, `.pem`, `.key`, `id_rsa*`, and `id_ed25519*` files into `secretPaths`:

- **Hard bounds**: At most 20,000 directory entries, 200 ms wall time, and 500 matched secret files (~2.5 ms measured on this repository).
- **Fail closed on cap or error**: Exceeding any cap or hitting a directory read error throws `DriverError("spawn_failed", ...)`. Unreadable directories (`EACCES` or `EPERM`) are masked as secret directories; transient `ENOENT` or `ENOTDIR` entries are skipped.

## Process tree, signals, and cleanup (`src/daemon/driver/process.ts`)

With `--unshare-pid` (without `--as-pid-1` or `--die-with-parent`), `bwrap` creates a three-process chain in one host process group (`PGID = B`):

1. `B`: Host outer `/usr/bin/bwrap` (`child.pid`, recorded in the ledger's `row.pid`).
2. `I`: Inner `/usr/bin/bwrap` running as PID 1 inside the PID namespace (reaps zombie children and forwards `C`'s exit code to `B` over `eventfd`).
3. `C`: The vendor CLI process (`NSpid` ending in `2`).

Bellwood handles signals and teardown across all drivers through `src/daemon/driver/process.ts`:

- **`signalTarget(pid)` and `signalChild(child, sig)`**: When `/proc/<pid>/exe` resolves to `bwrap`, `signalTarget` walks `/proc/<p>/task/<p>/children` to find the descendant whose `/proc/<c>/status` `NSpid:` ends in `2`, delivering `SIGINT` straight to `C` instead of killing `B` prematurely.
- **Namespace teardown (`termGroupAfterExit`)**: PID 1 inside a namespace (`I`) ignores `SIGTERM` and blocks in `wait()` if a tool spawned background processes in a new process group. Once `B` exits, `termGroupAfterExit` sends `SIGKILL` to `-child.pid`, killing `I` so the Linux kernel immediately destroys the PID namespace and `SIGKILL`s every remaining descendant.
- **Daemon restart recovery (`cleanupStale`)**: Because `--die-with-parent` is intentionally omitted, in-flight Workers survive a daemon reload; `cleanupStale` locates `C` via `signalTarget(row.pid)` for graceful `SIGINT` shutdown before falling back to `forceKillTree`.

## One-time Ubuntu 24.04+ setup (`scripts/linux-sandbox-setup.sh`)

Ubuntu 24.04 enables `kernel.apparmor_restrict_unprivileged_userns=1` by default, blocking unprivileged `bwrap` user namespaces unless `/usr/bin/bwrap` has an AppArmor profile (do **not** use Ubuntu's `bwrap-userns-restrict` profile, which blocks `apply-seccomp` inside Claude Code's native read-only sandbox). Run the idempotent setup script once:

```sh
sudo scripts/linux-sandbox-setup.sh
```

The script installs `bubblewrap` and `socat`, writes and loads `/etc/apparmor.d/bwrap` (`flags=(unconfined)` with `userns`, while Bellwood's outer `bwrap` passes `--disable-userns` to block nested namespaces inside the sandbox), and runs the verification probe as the invoking non-root user.

## Known boundaries

- **Files created after launch outside `<dataDir>`**: Secret masking via `--tmpfs` and `--ro-bind /dev/null` covers paths that exist when the Worker starts (`<dataDir>` itself is covered dynamically because its root is a read-only `tmpfs`).
- **Same-user sockets in `/tmp` or localhost TCP**: `/run/user/<uid>` is masked, so `systemd --user` and D-Bus escapes are blocked. Avoid running unauthenticated same-user command servers such as a default `tmux` socket in `/tmp/tmux-<uid>/` on the same Linux account as the daemon.
