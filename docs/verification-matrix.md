# Verification matrix

> Snapshot: 2026-11-28 (commit `6f6eed41`)

Commit-bound verification status for Bellwood **v0.4.0** across all 8 registered agent CLIs and 3 platforms. Generated from [`docs/verification-matrix.json`](verification-matrix.json); do not edit by hand.

## Verification tiers

| Tier | Meaning |
| --- | --- |
| `live_service` | Real vendor CLI completed a real upstream model turn recorded for this commit. |
| `real_cli_mock_llm` | Real vendor CLI ran end-to-end against Bellwood's loopback mock LLM server (non-live model backend) on this commit. |
| `fake_cli_offline` | Covered by fake CLI smoke or offline driver protocol and contract unit tests recorded on this platform for this commit. |
| `unverified` | No real-CLI or platform-specific vendor driver test run was recorded on this platform for this commit. |
| `not_applicable` | This vendor CLI does not support or ship on this platform. |

## Configured verification surfaces

Static workflows and benches configured in the repository (having a configured surface does not prove it ran on this commit; see recorded runs below).

| Surface | Platform | CLI | Model backend | Workflow or command | Scope |
| --- | --- | --- | --- | --- | --- |
| PR check and verify-smoke | `linux` | `fake` | `fake` | `.github/workflows/check.yml` | Ubuntu 4-shard unit/e2e suite and pnpm verify smoke using test/fake-claude/fake-claude.ts. |
| macOS CI test suite | `macos` | `fake` | `fake` | `.github/workflows/macos.yml` | Full pnpm test:ci on macos-15 with offline driver protocol tests and no real vendor CLIs (runs on nightly and release tags). |
| Windows integration and real-CLI mock-LLM | `windows` | `real` | `mock_llm` | `.github/workflows/windows.yml` | Real codex and pi CLIs inside fusa-run.exe against loopback mock LLM, plus core unit and sandbox integration tests. |
| Nightly Ubuntu real-CLI mock-LLM | `linux` | `real` | `mock_llm` | `.github/workflows/nightly.yml` | Scheduled nightly Ubuntu run with real claude, codex, pi, and deepseek CLIs in Linux bwrap against loopback mock LLM, plus Codex schema drift check. |
| Resident live-service bench | `multi` | `real` | `live_service` | `pnpm tester` | Real Feishu, real relay, and real vendor turns on owner Mac (claude, agy, codex) and Tokyo Linux host (claude); ingested on demand. |

## Recorded runs for this commit

| Run ID | Source | Platform | Kind | Commit | Completed | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `gh-run:46132355340` | `check.yml` | Linux | `fake_cli_offline` | `6f6eed41` | 2026-11-28 | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` |
| `gh-run:46132355360:mock-llm` | `windows.yml` | Windows | `real_cli_mock_llm` | `6f6eed41` | 2026-11-28 | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355360` |
| `gh-run:46132355360:core` | `windows.yml` | Windows | `fake_cli_offline` | `6f6eed41` | 2026-11-28 | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355360` |

## Vendor x platform matrix

| Vendor | macOS | Windows | Linux |
| --- | --- | --- | --- |
| **Claude Code** (`claude`) | `unverified` | `fake_cli_offline` | `fake_cli_offline` |
| **Antigravity** (`agy`) | `unverified` | `unverified` | `fake_cli_offline` |
| **Codex** (`codex`) | `unverified` | `real_cli_mock_llm` (windows.yml, CLI 0.169.0) | `fake_cli_offline` |
| **Pi** (`pi`) | `unverified` | `real_cli_mock_llm` (windows.yml, CLI 1.5.2) | `fake_cli_offline` |
| **DeepSeek** (`deepseek`) | `unverified` | `unverified` | `fake_cli_offline` |
| **Cursor** (`cursor`) | `unverified` | `unverified` | `fake_cli_offline` |
| **OpenCode** (`opencode`) | `unverified` | `unverified` | `fake_cli_offline` |
| **Kimi Code** (`kimi`) | `unverified` | `unverified` | `fake_cli_offline` |

## Detailed coverage and gaps

| Vendor | Platform | Tier | CLI / Model / Workflow | Evidence | Coverage notes and fallback tests |
| --- | --- | --- | --- | --- | --- |
| `claude` | macOS | `unverified` | - | - | No macos.yml or resident Mac pnpm tester run is recorded for commit 6f6eed41 yet (both are configured and run on nightly/release or on demand). Fallback: `src/vendors/claude/protocol.test.ts`, `src/vendors/contract.test.ts`. |
| `claude` | Windows | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355360` | Covered by Windows settings and guard unit tests in windows.yml run 46132355360 on commit 6f6eed41; no real Claude CLI turn runs in Windows CI or on a resident Windows bench. Fallback: `src/vendors/claude/settings.test.ts`, `src/shared/vendor-guard.test.ts`. |
| `claude` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by Ubuntu 4-shard offline driver tests and fake-claude verify-smoke in check.yml run 46132355340; nightly.yml real-CLI mock-LLM and Tokyo Linux pnpm tester have no recorded run on commit 6f6eed41 yet. Fallback: `src/vendors/claude/protocol.test.ts`, `src/vendors/contract.test.ts`. |
| `agy` | macOS | `unverified` | - | - | No macos.yml or resident Mac pnpm tester run is recorded for commit 6f6eed41 yet (both are configured and run on nightly/release or on demand). Fallback: `src/vendors/agy/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `agy` | Windows | `unverified` | - | - | Neither real Antigravity CLI nor agy-specific driver tests ran in windows.yml run 46132355360, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`. |
| `agy` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by offline ACP driver and contract tests in check.yml run 46132355340 on commit 6f6eed41; not installed in nightly.yml and marked accepted_gap on the Tokyo Linux bench. Fallback: `src/vendors/agy/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `codex` | macOS | `unverified` | - | - | No macos.yml or resident Mac pnpm tester run is recorded for commit 6f6eed41 yet (both are configured and run on nightly/release or on demand). Fallback: `src/vendors/codex/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `codex` | Windows | `real_cli_mock_llm` | CLI 0.169.0 via `windows.yml` | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355360` | Windows CI run 46132355360 on commit 6f6eed41 ran real Codex CLI inside fusa-run.exe against loopback mock LLM only; no resident Windows live-account bench exists. Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/shared/vendor-guard.test.ts`. |
| `codex` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by offline app-server driver and contract tests in check.yml run 46132355340; nightly.yml real-CLI mock-LLM has no recorded run on commit 6f6eed41 yet and Tokyo Linux bench marks codex accepted_gap. Fallback: `src/vendors/codex/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `pi` | macOS | `unverified` | - | - | No macos.yml run is recorded for commit 6f6eed41 yet; no real-CLI macOS CI exists and pi is marked accepted_gap on the resident Mac bench. Fallback: `src/vendors/pi/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `pi` | Windows | `real_cli_mock_llm` | CLI 1.5.2 via `windows.yml` | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355360` | Windows CI run 46132355360 on commit 6f6eed41 ran real Pi CLI inside fusa-run.exe against loopback mock LLM only; no resident Windows live-account bench exists. Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/shared/vendor-guard.test.ts`. |
| `pi` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by offline RPC driver and contract tests in check.yml run 46132355340; nightly.yml real-CLI mock-LLM has no recorded run on commit 6f6eed41 yet and Tokyo Linux bench marks pi accepted_gap. Fallback: `src/vendors/pi/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `deepseek` | macOS | `unverified` | - | - | No macos.yml run is recorded for commit 6f6eed41 yet; no real-CLI macOS CI exists and deepseek is marked accepted_gap on the resident Mac bench (no test account). Fallback: `src/vendors/deepseek/deepseek.test.ts`, `src/vendors/contract.test.ts`. |
| `deepseek` | Windows | `unverified` | - | - | Neither real DeepSeek Harness CLI nor deepseek-specific driver tests ran in windows.yml run 46132355360, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`. |
| `deepseek` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by offline driver and contract tests in check.yml run 46132355340; nightly.yml real-CLI mock-LLM has no recorded run on commit 6f6eed41 yet and resident bench marks deepseek accepted_gap. Fallback: `src/vendors/deepseek/deepseek.test.ts`, `src/vendors/contract.test.ts`. |
| `cursor` | macOS | `unverified` | - | - | No macos.yml run is recorded for commit 6f6eed41 yet; cursor-agent uses proprietary Protobuf/ConnectRPC (unsupported_protocol in mock-LLM) and is accepted_gap on the resident bench. Fallback: `src/vendors/cursor/cursor.test.ts`, `src/vendors/contract.test.ts`. |
| `cursor` | Windows | `unverified` | - | - | Neither real cursor-agent CLI nor cursor-specific driver tests ran in windows.yml run 46132355360; cursor-agent is unsupported_protocol for mock-LLM and no Windows live bench exists. Fallback: `src/shared/vendor-guard.test.ts`. |
| `cursor` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by offline driver and contract tests in check.yml run 46132355340 on commit 6f6eed41; cursor-agent uses proprietary Protobuf/ConnectRPC (unsupported_protocol in mock-LLM) and is accepted_gap on the resident bench. Fallback: `src/vendors/cursor/cursor.test.ts`, `src/vendors/contract.test.ts`. |
| `opencode` | macOS | `unverified` | - | - | No macos.yml run is recorded for commit 6f6eed41 yet; no real-CLI macOS CI exists and opencode is marked accepted_gap on the resident Mac bench (no test account). Fallback: `src/vendors/opencode/opencode.test.ts`, `src/vendors/contract.test.ts`. |
| `opencode` | Windows | `unverified` | - | - | Neither real OpenCode CLI nor opencode-specific driver tests ran in windows.yml run 46132355360, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`. |
| `opencode` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by offline driver and contract tests in check.yml run 46132355340 on commit 6f6eed41; not installed in nightly.yml and marked accepted_gap on the resident bench (no test account). Fallback: `src/vendors/opencode/opencode.test.ts`, `src/vendors/contract.test.ts`. |
| `kimi` | macOS | `unverified` | - | - | No macos.yml run is recorded for commit 6f6eed41 yet; no real-CLI macOS CI exists and kimi is marked accepted_gap on the resident Mac bench (no test account). Fallback: `src/vendors/kimi/kimi.test.ts`, `src/vendors/contract.test.ts`. |
| `kimi` | Windows | `unverified` | - | - | Neither real Kimi Code CLI nor kimi-specific driver tests ran in windows.yml run 46132355360, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`. |
| `kimi` | Linux | `fake_cli_offline` | - | `https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340` | Covered by offline driver and contract tests in check.yml run 46132355340 on commit 6f6eed41; not installed in nightly.yml and marked accepted_gap on the resident bench (no test account). Fallback: `src/vendors/kimi/kimi.test.ts`, `src/vendors/contract.test.ts`. |

## Reproduce and update

```sh
node scripts/verification-matrix.ts check
node scripts/verification-matrix.ts render --write
node scripts/verification-matrix.ts ingest-tester --run <run-record.json> --write
```
