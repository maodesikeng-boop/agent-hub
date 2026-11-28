# Bellwood documentation

User guides, active engineering standards, and architecture snapshots for Bellwood. Start with [User guides and references](#user-guides-and-references) if you are setting up or operating Bellwood, or [`../AGENTS.md`](../AGENTS.md) and [`../REVIEW.md`](../REVIEW.md) if you are contributing code.

## User guides and references

- [Running Bellwood on Linux](linux.md): Ubuntu user-mode setup, Node 24.12+ and `bubblewrap` configuration, CLI lookup paths, `systemd --user` service management, and remote access.
- [Worker write and read scope](write-scope.md): Write boundaries across protected roots and least-privilege data-directory read and socket isolation across macOS, Linux, and Windows.
- [Security policy](../SECURITY.md): Supported versions, private vulnerability reporting, local loopback and socket boundaries, OS sandboxes, Computer Use approvals, account mesh, and Feishu guest tiers.
- [Contributing guide](../CONTRIBUTING.md): Bug reports, local setup, mandatory gate commands, and pull request workflow.
- [Naming lineage](#naming-lineage): How `Bellwood`, `agent-hub` / `hub`, and `fusa-*` map across packages, directories, binaries, and environment variables.

## Standards

- [Testing, review, and merge policy](review-and-merge.md): Local verification, `pnpm test:related` selection, layered cloud CI, parallel logic and real-environment review, prompt-cache gates, `REVIEW.md` updates, merging, and PR body tag sync.
- [Direct dependencies and repository skills](dependencies.md): Direct npm and Cargo dependencies enforced by `src/direct-dependencies.test.ts`, installed `src/web/ui/` primitives, and `pstack` skill update rules.
- [UI standard](ui-standard.md): Spacing, border radius, type scale, slime accent palette, controls, focus states, responsive shells, Markdown, Task Graph tracks, Router workbench, and deliverables.
- [UI polish baseline style brief](ui-polish/baseline/style-brief.md): Visual DNA and `S1`–`S6` baseline rules for `pnpm ui:polish` screenshot reviews.
- [Plan and code-skeleton standard](plan-standard.md): Structure for design documents, architecture reviews, plain-language acceptance scenarios, typed code skeletons, runnable acceptance tests, implementation handoffs, and acceptance evidence.
- [Work panel design](work-panel-design.md): The wide right panel with `Active`, `Completed`, and `Info` tabs and Worker detail, the paged Completed feed, per-graph switch to a vertical list, and what replaces the old side panel and PM settings panel.
- [Info-style settings, dialogs, and small surfaces](info-style-rollout-design.md): The inventory of Settings pages, the New PM dialog, Info drill-down pages, phone settings, dialogs, popovers, and full-page states moved to the project manager `Info` row recipe, with before screenshots in Chromium and WebKit and the color choices.
- [Top-bar Router input and reply popover](router-topbar-design.md): Centered translucent-to-solid quick Router input in the `40px` desktop wood top bar, non-modal reply popover with follow-up chat and `Expand` handoff, shared Router command dispatch and turn rendering, and cross-platform window-drag boundaries.
- [Workbench shell design](workbench-shell-design.md): Rail, Project Manager column with pins, resizable columns, work panel integration, narrow-window tiers, phone tab bar, and a visual language that keeps pixel art for characters while controls use smooth lines.
- [Layout switch without a rebuild](layout-switch-design.md): Surfaces rendered once above the layout and moved between outlets, one navigation state for the page, settings, and the page behind settings, and the acceptance scenarios for crossing the one-column width.
- [Concentric inner corners for clipped card and strip rows](card-inner-corners-design.md): Root-cause audit of clipped focus and error rings inside rounded `overflow-hidden` cards, popovers, event strips, and code block headers, concentric CSS recipes (`--card-inner-radius`, `.card-reply-row`, `.event-strip-shell`, `.event-strip-trigger`), and visual verification plan.

## Architecture and security

- [Worker write and read scope](write-scope.md): Write boundaries across protected roots and least-privilege data-directory read and socket isolation across macOS, Linux, and Windows.
- [Security boundary hardening for Feishu guests and Windows read-only isolation](security-boundary-hardening-design.md): Fail-closed `observer` default and host-privilege disclosure for Feishu project groups, expanded guest command blocks, and fail-closed Windows MXC read-only enforcement removing `--readonly-fallback`.
- [User-confirmed Worker mode without outer sandbox](worker-no-outer-sandbox-design.md): Computer Use eligibility checks, human-only single-run confirmation cards, vendor built-in sandbox declarations, and launch-time fail-closed enforcement.
- [Computer Use app approval cards](computer-use-app-approval-design.md): Per-app workbench confirmation for Computer Use Workers, the vendor-neutral approval gate, Worker-run grants, and how cards end.
- [External capabilities](pm-capabilities-design.md): Router, PM, and Worker policies for skills, MCP servers, and connectors, Worker `inherit`, `none`, and `custom` modes, vendor isolation levels, and the project setup command API.
- [Read-only Worker design](readonly-worker-design.md): Vendor-neutral `ReadonlyPolicy`, OS-level read-only sandboxes, MCP `readOnlyHint` filtering, and credential deny lists.
- [Linux sandbox design](linux-sandbox-design.md): Outer `bubblewrap` (`bwrap`) isolation, PID and mount namespaces, secret-glob scanning, signal routing, and Ubuntu 24.04+ AppArmor setup.
- [Task Graph orchestration](task-graph-design.md): Directed acyclic Task Graphs, four-state step progression, `fusa-task-graph` skill delivery, user blockers, deliverables, and verify-only independent reviews.
- [Router architecture](router-design.md): Stateless single-turn cross-device dispatch, zero-copy `--verbatim` forwarding, two-tier background project catalog, decision tray, and timeline.
- [Account mesh and E2EE relay](account-mesh-design.md): GitHub Device Flow login, six-digit SAS device verification, mutual TLS 1.3 over LAN and Cloudflare or Node relays, and hub lease failover.
- [Event stream recovery](change-stream-recovery-design.md): Replay cursors tied to daemon boots, snapshot recovery, and reconnect through the Mesh proxy.
- [Feishu integration](feishu-design.md): QR bot creation, outbound persistent WebSocket, account-wide bot lease, slime-avatar project groups, guest permission tiers, and streaming JSON 2.0 cards.
- [Cross-hub Feishu inbound deduplication](feishu-cross-hub-dedupe-design.md): Account-wide Feishu inbound state lattice (`held_offline < claimed < handled`), Relay-fenced E2EE checkpoints, Peer mTLS mirroring, pre-execution claim persistence, and rolling-upgrade fallback.
- [Vendor plugin architecture](vendor-plugin-design.md): Per-vendor folder contracts (`VendorSpec` and `VendorDaemon`), eight supported CLIs, ACP and RPC protocols, system-prompt channels, background session renewal, and instant vendor switching.
- [Default vendor follows what this computer can run](vendor-default-design.md): One shared rule that picks the first usable vendor for new project managers, the first-start PM, and Router `Auto`, the sweep of every place Bellwood picks a vendor for the user, and the first-launch Providers guide.
- [Antigravity default terminal working directory fix](agy-cwd-design.md): Real `agy` workspace-sorting experiments, cross-vendor audit of all eight drivers, migration of Antigravity from `stream-json` to `agy acp` on `src/vendors/_common/acp/`, read-only and hook boundaries, and acceptance verification plan.
- [Resource lifecycle](resource-lifecycle-design.md): Canonical resource registry, database slimming and dual-bounded retention, detached grandchild and temp-directory reaping, squash-merge branch cleanup, and the Resources self-check panel.
- [Probe and tracked child process teardown cleanup](probe-teardown-cleanup-design.md): Shared `closeAndWaitChild` and `killChildAndWait` settlement across all eight vendors, async `ProviderQuota` and `SelfReloadController` shutdown, and the authoritative `ProcessLedger.shutdown()` drain barrier.
- [Ledger database](ledger-database.md): Exclusive SQLite file lock, the `migrations/manifest.sha256` completeness check, and upgrade tests on ledgers written by released versions.
- [Reliable turn completion](turn-completion-design.md): SQLite turn-outcome receipts, ordered per-session settlement, bounded retries after write failures, send holds, and receipt-aware restart recovery.
- [In-chat progress checklist](progress-checklist-design.md): Normalized vendor checklists, launch switches for hidden todo tools, append-only checklist messages, per-step process grouping, and live action timing in the `Worked for` slot.
- [Worker state accuracy and operations](worker-ops-fix-design.md): Worktree branch reconciliation, shared Worker list/show states, cross-vendor context-token preservation, stale Worker PM notice suppression, Task Graph step agent display, live `hub models` quota tracking, and background command inspection.
- [System wakeups and per-turn checklists](system-wakeup-turns-design.md): PM wakeups stored as system notices, placing system inputs where the agent read them, per-turn checklist slices, and the vendor checklist prompt rule.
- [Turn state foundation](turn-state-foundation-design.md): One ledger record per model turn with its inputs, tools, and background wait, daemon-clock durations, stop provenance, restart recovery turns, independent background-wait reminders, and turn summaries for the web.
- [Progress checklist in every multi-step turn](turn-checklist-rule-design.md): One trigger rule for when a turn must list its steps, the shared prompt section for every vendor, `hub checklist` for vendors without a checklist tool, and a one-time reminder that never starts a turn.
- [Lost Worker briefs and stale notices](lost-brief-stale-notice-design.md): Daemon shutdown never cancels unread messages in any vendor driver, restart resends interrupted turns or tells the PM, failed first launches show their error, one pre-write currency check for delivery notes and timeout reminders, `graph done` ending the parked Worker, and per-model effort validation.
- [Project Manager friction with `hub`](pm-friction-design.md): Plan reviews paused for the PM with `"confirm": "pm"`, `doneSteps` in `graph patch`, one text-limit table, `hub ask list/show`, `hub schedule show`, `hub worker wait`, the first typed PM notice entry, and help-only commands that keep the system prompt and every vendor cache unchanged.
- [Hub limits visible before they bite](hub-limits-visibility-design.md): One table of every length, size, and count limit an agent can hit through `hub`, rendered into `hub help`, per-command usage, and one rejection message, and `hub ask` rejecting over-limit text instead of cutting it.
- [Hub CLI audit and redesign](hub-cli-audit-design.md): Unified `hub` command metadata registry for progressive help and typo diagnostics, strict `graph` JSON validation with field paths, read-only `hub caps`, step capability/sandbox visibility in `graph show`, PM-own memory file sharing, and `self-reload` cancel plus named busy-session reporting.
- [In-place schedule editing with `hub schedule edit`](schedule-edit-design.md): Shared schedule patch planner (`planScheduleEdit`), synchronous in-place ledger mutation (`scheduleEditIn`) preserving schedule IDs and run history, enabled/paused `nextRunAt` recalculation, Feishu guest gating, live web sync, and zero prompt-cache impact.
- [Project Manager awareness of finished work](pm-awareness-design.md): A per-graph status list computed from the ledger and delivered to the PM as a snapshot plus changes on every wake, one decision chain from Worker to PM to user for `"confirm": true`, `hub watch` for outside conditions, step slots shared on one computer, and a delivery row for finished graphs.
- [Handover byte budget and lightweight skill carryover](handover-budget-and-skills-design.md): Lightweight verified skill-index carryover, declarative per-vendor single-message byte caps, delivery-time priority-tiered preamble budgeting protecting the latest user message, and prompt-cache preservation across all eight vendors.
- [Shipped prompt de-overfitting](prompt-deoverfitting-design.md): Separating platform mechanics from project workflow policy across shipped PM and Worker prompts, the Task Graph skill, CLI help, JSON hints, and runtime daemon notices, enforced by a workflow-neutrality audit contract.
- [Session stop lifecycle and settlement fix](stop-lifecycle-design.md): Root-cause traces on real `agy acp`, `stopId`-matched ledger stop settlement, unified `BaseSessionDriver` interrupt coordination with bounded `SIGINT` to `SIGKILL` escalation, post-turn ACP notification gating, and frontend `useStop` reset closure.
- [README and user documentation rewrite](readme-docs-rewrite-design.md): Full audit of current `main` versus user-facing docs and screenshots, architecture comparison, user sign-off decisions, visual refresh manifest, and automated doc-to-code consistency contract.

## Testing

- [AI tester](ai-tester-design.md): The resident test bench (a Mac and a server on a test account, a test Feishu bot, all eight vendor CLIs), nightly script flows, the AI tester handbook in `.agents/skills/tester/`, vendor coverage reporting, and the `pnpm verify` round-trip and restart checks.
- [Blind new-user walkthrough](blind-new-user-walkthrough-design.md): Zero-context new-user exploration on an isolated real Bellwood instance, Track 1 unattended Playwright vision and accessibility runs with H.264 MP4 recording, Track 2 prepared native macOS Computer Use handoffs, noise filtering, and severity-ranked pain-point reports.
- [Product capability evaluation](product-eval-design.md): The unified three-tier product capability evaluation framework (`harness`, `replay`, and `canary`), five non-collapsed capability dimensions, loopback mock model server with prompt-cache prefix verification, multi-trial `pass@k` and `pass^k` gating, holdout anti-overfitting guards, and CI and release-gate integration.
- [Real CLI with mock model test environment](real-cli-mock-model-design.md): Empirical 8-vendor endpoint audit, loopback multi-dialect mock LLM HTTP/SSE server, isolated temporary HOME provisioning, deterministic prompt-cache prefix stability assertions, normalized protocol snapshots, and cross-platform real-CLI CI strategy.

## Desktop and distribution

- [macOS app and DMG distribution](mac-distribution-design.md): Native Swift and `WKWebView` shell (`apps/macos/`), source mode versus `--dist` bundled Node 24 LTS runtime, signing, DMG packaging, and GitHub Releases.
- [Windows native architecture](windows-native-design.md): Native Tauri 2 desktop shell (`apps/windows/`), `fusa-supervisor`, `fusa-win-helper` Job Objects, restricted tokens, NTFS ACLs, Win11 24H2+ MXC read-only containers, and NSIS packaging.
- [Release flow](release-flow-design.md): Installer builds pinned to `pnpm-lock.yaml`, release gates on the tagged commit, release candidates promoted byte for byte, build commits in `runtime-manifest.json`, and rollback by yanking.
- [Repository CI and collaboration friction](dev-ci-friction-design.md): A shared apt installer with cached packages and a mirror fallback, strict up-to-date merges with review stamps carried across base-only updates, PR descriptions synced from pushed tags, and a guard against parallel PRs taking one migration number.
- [CI apt cache recovery and atomic executable script writes](ci-apt-and-hook-etxtbsy-design.md): Base-image `dpkg-query` cache fingerprinting, non-poisoning offline `.deb` restore with `dpkg --audit` repair, and a shared cross-platform atomic executable file writer (`writeExecutableFileAtomicSync`) eliminating Linux `ETXTBSY` races across review hooks and shims.
- [Friction diagnostics, isolated-HOME agy keychain safety, CI script resilience, and event-driven tests](friction-and-stability-fixes-design.md): Actionable `agy` rule budget warnings with filenames, unified macOS nested `sandbox-exec` exit-71 diagnostics, safe `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` isolated-`HOME` handling, GraphQL `EOF` retries, post-stamp `CLEAN` polling, and event-driven test stabilization.
- [Official relay release and operations](relay-release-design.md): Cloudflare staging and production relay environments, `/health` build SHA contract, live smoke checks, manual production approval, and rollback runbook.
- [Running Bellwood on Linux](linux.md): Ubuntu user-mode setup, Node 24.12+ and `bubblewrap` configuration, CLI lookup paths, `systemd --user` service management, and remote access.

## Naming lineage

Three historical naming layers appear intentionally across the repository:

- **Bellwood**: User-facing product brand, web workbench, macOS application bundle (`Bellwood.app`), and release installers (`Bellwood-macos-arm64.dmg` and `Bellwood-windows-x64-setup.exe`).
- **`agent-hub` and `hub`**: Internal `package.json` name, default data directory (`~/.agent-hub`), `AGENT_HUB_*` environment variables, and the `hub` CLI called by Project Managers, Workers, and Router. Kept stable so existing installations upgrade without migrating paths or scripts.
- **`fusa-*`**: Native Windows Rust crates and helper binaries (`fusa-desktop`, `fusa-supervisor`, and `fusa-win-helper` producing `fusa-run.exe`), account-mesh TLS ALPN (`fusa-mesh/1`) and `FUSA_*` relay environment variables, the built-in `fusa-task-graph` skill, and Feishu group markers (`fusa:<deviceId>:pm:<pmId>`).
