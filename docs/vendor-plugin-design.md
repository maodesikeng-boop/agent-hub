# Vendor plugin architecture

Bellwood drives eight official coding-agent CLIs through one plugin contract so shared layers (the SQLite ledger, Task Graph scheduler, Router, Feishu, and React UI) contain zero hardcoded vendor branches (`src/vendors/`, guarded by `src/shared/vendor-guard.test.ts` and `src/vendors/contract.test.ts`).

## Directory structure and single registry

`src/vendors/registry.ts` (`VENDOR_LIST`) is the single list of registered vendors. Every vendor lives in `src/vendors/<id>/`:

- **`spec.ts` (`VendorSpec` in `src/vendors/types.ts`)**: Browser-safe declarative metadata imported by both `src/shared/vendors.ts` and `src/web/`: CLI binary name and `AGENT_HUB_<VENDOR>` override env var, display name, bundled fallback models, effort tiers, `routerDefault` fast model preset, composer slash-command rules, `home.readonlySecrets`, `subagentTools` to forbid in Worker prompts, tool-name to `ToolAction` mappings, skill-load signals, and capability flags (`systemPrompt`, `skills`, `readonly`, `quota`).
- **`daemon.ts` (`VendorDaemon` in `src/vendors/daemon-types.ts`)**: Loaded on the daemon side by `src/vendors/daemon-registry.ts`, wiring the vendor's `Driver`, `VendorCatalogSource` (`catalog.ts`), `composer.ts`, `paths.ts`, `setup.ts` (install, update, and sign-in in **Providers** settings), `transcript.ts`, `handover.ts`, `capabilities.ts` (per-PM skill and MCP toggles), and `sync/` adapters.
- **Shared protocol helpers (`src/vendors/_common/`)**: Standard Agent Client Protocol (`@agentclientprotocol/sdk`) client transport in `_common/acp/`, comment-preserving JSONC/TOML config patchers and skill symlink sync in `_common/sync/`, and SSRF-hardened remote OAuth loopback callback parsing in `_common/setup/loopback-callback.ts`.

## Supported vendor CLIs

| Vendor ID | CLI binary | Wire protocol | System-prompt channel | Read-only write guard |
| --- | --- | --- | --- | --- |
| `claude` | `claude` | `stream-json` stdio (`--input-format stream-json --output-format stream-json`) | Resident (`--append-system-prompt-file`) | Native (`claude` sandbox; MXC on Windows) |
| `codex` | `codex` | `codex app-server` JSON-RPC stdio | Resident (`baseInstructions` / `developerInstructions`) | Native (`default_permissions` profile) |
| `agy` | `agy` | Headless JSON stream (`--print`) | Resident (`--add-dir` isolated rule folder in `state/launch/<id>`) | Outer OS sandbox |
| `pi` | `pi` (`@earendil-works/pi-coding-agent`) | `--mode rpc` JSON stdio | Resident (`--append-system-prompt`) | Outer OS sandbox + `--exclude-tools edit,write --no-mcp` |
| `deepseek` | `dsh` (`@deepseek-ai/dsh`) | ACP (`@agentclientprotocol/sdk`) | Resident (`--patch` `system-prompt.config.personaSuffix`) | Outer OS sandbox + ACP permission gate |
| `cursor` | `cursor-agent` | ACP (`cursor-agent acp`) | First user message + automatic re-injection after context compaction | Outer OS sandbox + ACP permission gate |
| `opencode` | `opencode` (`@opencode/cli`) | ACP (`opencode acp`, private server per process) | First user message + automatic re-injection after `compaction_update` | Outer OS sandbox + `plan` agent + `mcp.use` deny policy + ACP permission gate via `OPENCODE_CONFIG_CONTENT` |
| `kimi` | `kimi` (`@moonshot-ai/kimi-code`) | ACP (`kimi acp`) | First user message | Outer OS sandbox hides every MCP server list (`yolo` mode; `AskUserQuestion` cancelled) |

### Vendor-specific protocol notes

- **Mid-turn steering and interruption**: Drivers stream user follow-ups into running turns when supported (`claude` `msg_lifecycle_v1` + `interrupt_cancel_queued_v1`, `codex` `turn/steer` and `turn/interrupt`, ACP cancellation) so queued vs delivered message states stay accurate.
- **Persona and mode edits without restart**: Editing a PM's persona or mode (`Orchestrate` vs `Hands-on`) increments `personaRevision` and prepends a `[系统]` update block on the next user turn (`src/daemon/driver/persona-note.ts`) rather than killing the live CLI session.
- **Antigravity rule budget**: `src/vendors/agy/rules.ts` budgets combined rule files under `agy`'s ~60 KB ceiling so `--add-dir` system instructions are never truncated by large workspace `AGENTS.md` files.
- **Cursor model selection**: `cursor-agent acp` ignores `--model` and mutates global `~/.cursor/cli-config.json` if passed on the command line, so the driver selects models over ACP session config (`Auto` when unset) without touching user config files.
- **OpenCode per-session config**: The driver passes `OPENCODE_CONFIG_CONTENT` (merged after user and project config) to deny the interactive `question` tool, deny per-PM disabled skills and MCP tools (`<server>_*` permission actions), and add the PM's product skill directory. Read-only Workers also get a `mcp.use` deny policy, a trailing `*` `ask` rule that only allowlisted built-in tools override, and `edit` deny, so any MCP call that still connects (a user `mcp.use` allow policy wins over ours because OpenCode resolves policies earliest-first) reaches the ACP permission gate as Code Mode's `execute` tool. OpenCode 2.3 has no `modes` field on `session/new`, so the ACP base switches to `plan` through the `mode` config option, and model IDs missing from the live `model` option are skipped because OpenCode rejects them with `-32602`; the default model is the free `opencode/big-pickle`. Install uses `https://opencode.ai/v2/install` on macOS and Linux and `npm install -g @opencode/cli` on Windows; the UI stores an OpenCode Zen key as `OPENCODE_API_KEY`. MCP sync follows the layout already in `~/.config/opencode/opencode.json(c)` (V1 `mcp.<name>` or V2 `mcp.servers.<name>`).
- **Kimi Code turn outcomes**: `kimi acp` (2.5 to 2.7.1) answers a failed non-auth turn with `stopReason: end_turn`. The ACP base calls the optional `watchPromptOutcome` hook before each prompt; the Kimi driver reads the tail of `$KIMI_CODE_HOME/sessions/<workDir>/<sessionId>/agents/main/wire.jsonl` and reports `turn.ended` `reason: failed` as `quota_exceeded` (`provider.rate_limit`, quota codes), `auth_required`, or `error_during_execution`. Kimi Platform API keys are passed as `KIMI_MODEL_API_KEY`, `KIMI_MODEL_NAME`, and `KIMI_MODEL_BASE_URL` because Kimi reads provider keys only from `config.toml` or `KIMI_MODEL_*`. In `yolo` mode Kimi approves MCP calls itself, so read-only Workers hide `mcp.json`, `plugins/installed.json` (plugin MCP servers), and `credentials/mcp` under the active `KIMI_CODE_HOME`, plus `<cwd>/.kimi-code/mcp.json` and the project `.mcp.json` through the ACP `readonlySandbox.hiddenPaths` hook; Kimi 2.7.1 starts no MCP server when those reads fail.

## Session renewal, skill carryover, and zero-wait vendor switching

1. **Background session renewal (`src/daemon/handover/` and `src/daemon/ledger/handover.ts`)**: When a PM thread crosses its token threshold, the daemon forks or reads the session between turns in the background to draft a structured handover summary while the user keeps chatting, then steps into a fresh session carrying the handover, up to recent verbatim dialogue limits (`src/shared/limits.ts`), and the bodies of skills loaded in the prior generation (`src/daemon/ledger/loaded-skills.ts` and `src/shared/skill-loads.ts`).
2. **Instant cross-vendor switching**: Changing a PM's provider on its profile page switches immediately in a single SQLite transaction without waiting for a summary pass. The new vendor receives the current generation's active handover baseline, recent verbatim user/PM messages, attachments, Worker reports, and live Task Graph state (`HANDOVER_*` / switch char budgets in `src/shared/limits.ts`), so switching back and forth across `claude`, `codex`, `agy`, `pi`, `dsh`, `cursor-agent`, `opencode`, and `kimi` preserves full context.

## Providers settings and cross-vendor sync

- **One-click install, update, and sign-in (`src/daemon/provider-manager/`)**: Runs vendor install/update commands, manages API keys in `state/provider-secrets.json` (`0600`), and drives browser OAuth, device-code login, and headless loopback callback paste (`loopback-callback.ts` enforces six SSRF checks: `http:`/`https:` scheme, `localhost`/`127.0.0.1`/`[::1]` host, unprivileged port matching the active login listener, no credentials in URL, bounded length, and single-use session state).
- **MCP and skill union sync (`src/daemon/vendor-sync/`)**: Scans installed CLIs' MCP configs (`jsonc-parser` and `@decimalturn/toml-patch`) and skill directories, previews additions/removals in `Sync preview` (keeping app-bundled `hostBound` MCP servers opt-in and never deleting source files), backs up user configs into `backups/`, and writes updates atomically via `write-file-atomic`.

## Adding a new vendor

1. Create `src/vendors/<id>/` implementing `VendorSpec` (`spec.ts`) and `VendorDaemon` (`daemon.ts`).
2. Add `<id>` to `VENDOR_LIST` in `src/vendors/registry.ts` and add `AGENT_HUB_<UPPER_ID>` to environment docs.
3. Run `pnpm typecheck`, `pnpm vitest run src/vendors/contract.test.ts src/shared/vendor-guard.test.ts src/shared/write-scope.test.ts`, and `pnpm verify`.
