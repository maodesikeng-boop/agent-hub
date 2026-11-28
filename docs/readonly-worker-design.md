# Read-only Worker design

> Snapshot: 2026-11-20 (commit `e8ed3389`)

Read-only Workers power independent code reviews (`review: true` Task Graph steps) and `hub worker start --readonly`. A read-only Worker can read project files and run shell commands (`pnpm typecheck`, targeted `vitest` runs, `pnpm verify`, and `git diff`), cannot write anywhere except a private per-session temp directory and minimal vendor runtime state, cannot read user credentials or Bellwood's `state/` and `backups/` directories, and can call only read-only MCP connector tools.

## Vendor-neutral policy (`src/shared/readonly-policy.ts`)

`buildReadonlyPolicy` constructs `ReadonlyPolicy` once during launch preparation (`src/daemon/launch.ts`) and attaches it to `LaunchFiles.readonly`:

```ts
export interface ReadonlyPolicy {
	secretPaths: string[];
	secretGlobs: string[];
	connectors: { extraAllow: string[]; deny: string[] };
	stateDir?: string;
	protectedRoots?: string[];
	dataDirScope?: DataDirReadScope;
	dataDirDenied?: string[];
}
```

- **Home credential paths (`READONLY_SECRET_HOME_PATHS`)**: Combines shared OS credential paths from `src/shared/secret-paths.ts` (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/Library/Keychains`, `~/.local/share/keyrings`) with each vendor's `spec.home.readonlySecrets` (`~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.gemini/oauth*`, `~/.dsh/.env`, and equivalents) while leaving vendor transcript directories readable when needed. When a vendor home override such as `CODEX_HOME` or `KIMI_CODE_HOME` is set, the same secrets under the overridden directory are added too.
- **Secret globs (`READONLY_SECRET_GLOBS`)**: `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, and `**/id_ed25519*`.
- **Bellwood data-directory boundary (`dataDirScope` and `dataDirDenied`)**: Enforces the exact same least-privilege boundary as normal Workers ([Worker write and read scope](write-scope.md)). The entire `dataDir` is unreadable (`state/hub.sqlite*`, `state/ui-token`, `state/*-secrets.json`, `state/mesh/`, `state/pm-memory/`, `state/personas/`, `state/logs/`, `backups/`, `pm-home/`, and `sent-files/`), allowing reads only on `worktrees/`, `uploads/`, `tools/`, `run/bin/`, and the session's own `state/launch/<sessionId>/` directory, and allowing socket connections only to `run/hub.sock` while blocking `run/admin.sock`.
- **MCP connector rule (`connectorToolAllowed`)**:
  1. Any `<server>/<tool>` or `<server>/*` matching `connectors.deny` is rejected.
  2. Otherwise, any match in `connectors.extraAllow` is allowed (for internal tools whose server omits annotations).
  3. Otherwise, the tool is allowed only when its MCP annotations declare `readOnlyHint: true` and `destructiveHint !== true`. Unannotated tools are denied.

## Enforcement across vendors and platforms

Each vendor declares its read-only strategy in `src/vendors/<vendor>/` (`capabilities.readonly` in `spec.ts`):

| Vendor | Write guard | Tool and MCP enforcement | OS and filesystem isolation |
| --- | --- | --- | --- |
| `claude` | Native (`macOS` and `Linux`), outer MXC (`Windows`) | `default` mode + `--permission-prompt-tool stdio`; allows `Read`, `Glob`, `Grep`, `Bash`, `WebSearch`, `WebFetch`; denies `Edit`, `Write`, `NotebookEdit`, and `Read(...)` on `secretPaths`, `secretGlobs`, and `dataDirDenied`. Checks MCP `readOnlyHint` lazily via `mcp_status` on the first `can_use_tool` call (`0 ms` startup cost). | Uses Claude Code's built-in sandbox (`denyWrite`, `denyRead`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, and `enableWeakerNetworkIsolation: true` on macOS so Go CLIs reach `com.apple.trustd.agent`) on macOS and Linux; uses MXC ProcessContainer or restricted-token fallback on Windows. |
| `codex` | Native (`macOS`, `Linux`, and `Windows`) | Declines all file-change and command approvals (`decideCommandApproval` and `decideFileChangeApproval`); configures `approval_mode = "approve"` for `extraAllow`, `disabled_tools` for `deny`, and declines non-read-only `mcpServer/elicitation/request` calls. | Selects a custom permission profile via `default_permissions`: sets `<dataDir>` to `none`, sets `readable` entries and `run/hub.sock` to `read`, denies `secretPaths`, and sets `network.enabled = true`. Omits `sandbox` on `thread/start` and `thread/resume` and omits `sandboxPolicy` on `turn/start` so `codex-cli` keeps the custom profile active. |
| `agy` | Outer OS sandbox | Runs `--mode plan` with `--settings` allowing `read_file(*)`, `command(*)`, and `read_url(*)`, denying `write_file(*)` and `read_file(<secret>)`, and pre-probing configured stdio MCP `tools/list` to emit explicit `allow` and `deny` `mcp(<server>/<tool>)` rules. Automatically sends a continuation nudge if `agy` terminates a turn early on an unapproved action. | Wrapped in `readonlySeatbeltProfile` (macOS), `readonlyBwrapArgs` (Linux), or MXC ProcessContainer and restricted-token fallback (Windows). |
| `pi` | Outer OS sandbox | Passes `--exclude-tools edit,write` and `--no-mcp` in read-only mode. | Wrapped in Bellwood's outer read-only OS sandbox on macOS, Linux, and Windows. |
| `deepseek` (`dsh`) | Outer OS sandbox | Rejects mutating and non-read-only MCP `session/request_permission` requests in the ACP driver (`src/vendors/_common/acp/`). | Wrapped in Bellwood's outer read-only OS sandbox on macOS, Linux, and Windows. |
| `cursor` (`cursor-agent`) | Outer OS sandbox | Rejects mutating and non-read-only MCP `session/request_permission` requests in the ACP driver rather than using Cursor's `ask` mode, which disables shell execution needed for tests. | Wrapped in Bellwood's outer read-only OS sandbox on macOS, Linux, and Windows. |
| `opencode` | Outer OS sandbox | Switches the session to OpenCode's `plan` agent (the `mode` config option on OpenCode 2.3) and passes a `mcp.use` `deny` policy plus permission rules through `OPENCODE_CONFIG_CONTENT`: `*` `ask`, `allow` for `read`, `glob`, `grep`, `list`, `shell`, `external_directory`, `webfetch`, `websearch`, `todowrite`, `skill`, and `subagent`, then `edit` and `question` `deny`. Rules from this document win because OpenCode takes the last matching rule, so MCP calls that still connect (Code Mode's `execute` tool) reach the ACP permission gate and are rejected. | Wrapped in Bellwood's outer read-only OS sandbox; `~/.local/share/opencode` and `~/.local/state/opencode` stay writable because OpenCode keeps sessions in `opencode.db`, which is a secret for every other vendor. `mcp-auth.json` stays hidden. |
| `kimi` (Kimi Code) | Outer OS sandbox | Runs in Kimi's `yolo` mode because its permission requests carry no ACP tool kind, so the ACP gate would also reject `Bash`; `AskUserQuestion` prompts are cancelled. | Wrapped in Bellwood's outer read-only OS sandbox; only `sessions/`, `logs/`, `locks/`, `credentials/`, and `session_index.jsonl` under `KIMI_CODE_HOME` stay writable. Because `yolo` approves MCP calls inside Kimi, every MCP source stays hidden: `mcp.json`, `plugins/installed.json`, and `credentials/mcp` under the active `KIMI_CODE_HOME`, and `<cwd>/.kimi-code/mcp.json` plus the project `.mcp.json` (`readonlySandbox.hiddenPaths`). |

## Outer read-only OS sandboxes

Vendors with `writeGuard: "outer"` run inside a process-wide read-only OS wrapper built in `src/daemon/driver/write-scope.ts`:

### macOS (`readonlySeatbeltProfile`)

- Starts from `(allow default)` and `(deny file-write*)`, then allows writes only to `/dev/null`, `/dev/zero`, `/dev/dtracehelper`, `/dev/tty*`, `/dev/fd/*`, the session's private `TMPDIR` (deleted when the session closes), shared caches (`~/.cache` and `~/Library/Caches`) required by local MCP servers, and each vendor's non-config runtime state paths (never `settings.json`, `CLAUDE.md`, or `mcp_config.json`).
- Enforces `DataDirReadScope` over `dataDir`, denies `file-read*` on `secretPaths`, and matches `secretGlobs` dynamically with seatbelt regular expressions.

### Linux (`readonlyBwrapArgs`)

- Mounts `/` read-only (`--ro-bind / /`), isolates PID and user namespaces (`--unshare-user --disable-userns --unshare-pid --proc /proc`), masks `/run/user/<uid>` with an empty `0700` `--tmpfs`, and applies the `<dataDir>` tmpfs, read-only bind allowlist, and `run/hub.sock` bind ([Linux sandbox design](linux-sandbox-design.md)).
- Binds only the private session `tmpDir`, shared cache directories, and existing vendor runtime paths writable.
- Masks existing secret directories with `--tmpfs` and secret files (including matches from a bounded startup `scanSecretGlobs` pass over `cwd` and `addDirs`) with `--ro-bind /dev/null`. If `bwrap` is unavailable or `scanSecretGlobs` exceeds its hard caps, launch fails closed.

### Windows (`@microsoft/mxc-sdk`, fail-closed without MXC)

- **Windows 11 24H2+ (`src/daemon/platform/win32/mxc-readonly.ts` and `mxc-runner.ts`)**: When the `@microsoft/mxc-sdk` capability probe finds `base-container` or `appcontainer-bfs` (no host DACL mutation) with `filesystemDeniedPaths`, the Worker runs inside a read-only MXC ProcessContainer. Local drives, worktrees, and `protectedRoots` are read-only; only the session `tmpDir`, `%TEMP%`, and vendor runtime paths are writable; `secretPaths`, `dataDir` denied paths (excluding `state\launch\<sessionId>`), and scanned `.env` files are passed to `deniedPaths`; and `HUB_SOCK` bridges over a per-session `127.0.0.1` loopback listener.
- **Older Windows builds or missing MXC (fail-closed)**: When MXC is unavailable (cached briefly for `WIN_MXC_NEGATIVE_CACHE_TTL_MS`), `wrapInReadonlyOsSandbox` returns `osSandboxed: false` and `checkReadonlyWorkerSandbox` rejects non-Codex read-only launches immediately with `WIN32_READONLY_NEEDS_MXC_MESSAGE` rather than degrading to tool-layer checks. `codex` read-only Workers continue running through Codex's native read-only sandbox.
