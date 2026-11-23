# Bellwood documentation

Active standards and architecture references for Bellwood. Start with [`../AGENTS.md`](../AGENTS.md) for engineering rules and [`../REVIEW.md`](../REVIEW.md) for path-triggered review checks.

## Standards

- [UI standard](ui-standard.md): Spacing, border radius, type scale, slime accent palette, controls, focus states, responsive shells, Markdown, Task Graph tracks, Router workbench, and deliverables.
- [UI polish baseline style brief](ui-polish/baseline/style-brief.md): Visual DNA and `S1`–`S6` baseline rules for `pnpm ui:polish` screenshot reviews.
- [Plan and code-skeleton standard](plan-standard.md): Structure for design documents, typed code skeletons, `it.todo` specs, and implementation handoffs.

## Architecture and security

- [Worker write and read scope](write-scope.md): Write boundaries across protected roots and least-privilege data-directory read and socket isolation across macOS, Linux, and Windows.
- [External capabilities](pm-capabilities-design.md): Router, PM, and Worker policies for skills, MCP servers, and connectors, Worker `inherit`, `none`, and `custom` modes, vendor isolation levels, and the project setup command API.
- [Read-only Worker design](readonly-worker-design.md): Vendor-neutral `ReadonlyPolicy`, OS-level read-only sandboxes, MCP `readOnlyHint` filtering, and credential deny lists.
- [Linux sandbox design](linux-sandbox-design.md): Outer `bubblewrap` (`bwrap`) isolation, PID and mount namespaces, secret-glob scanning, signal routing, and Ubuntu 24.04+ AppArmor setup.
- [Task Graph orchestration](task-graph-design.md): Directed acyclic Task Graphs, four-state step progression, `fusa-task-graph` skill delivery, user blockers, deliverables, and verify-only independent reviews.
- [Review stamp](review-stamp-design.md): The `bellwood/review` commit status posted after an independent review verdict, quiet skips off GitHub, and this repository's path-based merge gate.
- [Router architecture](router-design.md): Stateless single-turn cross-device dispatch, zero-copy `--verbatim` forwarding, two-tier background project catalog, decision tray, and timeline.
- [Account mesh and E2EE relay](account-mesh-design.md): GitHub Device Flow login, six-digit SAS device verification, mutual TLS 1.3 over LAN and Cloudflare or Node relays, and hub lease failover.
- [Event stream recovery](change-stream-recovery-design.md): Replay cursors tied to daemon boots, snapshot recovery, and reconnect through the Mesh proxy.
- [Feishu integration](feishu-design.md): QR bot creation, outbound persistent WebSocket, account-wide bot lease, slime-avatar project groups, guest permission tiers, and streaming JSON 2.0 cards.
- [Vendor plugin architecture](vendor-plugin-design.md): Per-vendor folder contracts (`VendorSpec` and `VendorDaemon`), eight supported CLIs, ACP and RPC protocols, system-prompt channels, background session renewal, and instant vendor switching.
- [Resource lifecycle](resource-lifecycle-design.md): Canonical resource registry, database slimming and dual-bounded retention, detached grandchild and temp-directory reaping, squash-merge branch cleanup, and the Resources self-check panel.
- [Ledger database](ledger-database.md): Exclusive SQLite file lock, the `migrations/manifest.sha256` completeness check, and upgrade tests on ledgers written by released versions.
- [Reliable turn completion](turn-completion-design.md): SQLite turn-outcome receipts, ordered per-session settlement, bounded retries after write failures, send holds, and receipt-aware restart recovery.

## Desktop and distribution

- [macOS app and DMG distribution](mac-distribution-design.md): Native Swift and `WKWebView` shell (`apps/macos/`), source mode versus `--dist` bundled Node 24 LTS runtime, signing, DMG packaging, and GitHub Releases.
- [Windows native architecture](windows-native-design.md): Native Tauri 2 desktop shell (`apps/windows/`), `fusa-supervisor`, `fusa-win-helper` Job Objects, restricted tokens, NTFS ACLs, Win11 24H2+ MXC read-only containers, and NSIS packaging.
- [Release flow](release-flow-design.md): Installer builds pinned to `pnpm-lock.yaml`, release gates on the tagged commit, release candidates promoted byte for byte, build commits in `runtime-manifest.json`, and rollback by yanking.
- [Official relay release and operations](relay-release-design.md): Cloudflare staging and production relay environments, `/health` build SHA contract, live smoke checks, manual production approval, and rollback runbook.
- [Running Bellwood on Linux](linux.md): Ubuntu user-mode setup, Node 24.12+ and `bubblewrap` configuration, CLI lookup paths, `systemd --user` service management, and remote access.

## Naming lineage

Three historical naming layers appear intentionally across the repository:

- **Bellwood**: User-facing product brand, web workbench, macOS application bundle (`Bellwood.app`), and release installers (`Bellwood-macos-arm64.dmg` and `Bellwood-windows-x64-setup.exe`).
- **`agent-hub` and `hub`**: Internal `package.json` name, default data directory (`~/.agent-hub`), `AGENT_HUB_*` environment variables, and the `hub` CLI called by Project Managers, Workers, and Router. Kept stable so existing installations upgrade without migrating paths or scripts.
- **`fusa-*`**: Native Windows Rust crates and helper binaries (`fusa-desktop`, `fusa-supervisor`, and `fusa-win-helper` producing `fusa-run.exe`), account-mesh TLS ALPN (`fusa-mesh/1`) and `FUSA_*` relay environment variables, the built-in `fusa-task-graph` skill, and Feishu group markers (`fusa:<deviceId>:pm:<pmId>`).
