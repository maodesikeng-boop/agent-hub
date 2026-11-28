# Verification matrix

> Snapshot: 2026-11-28 (commit `6f6eed41`)

Commit-bound verification status for Bellwood **v0.4.0** across all 8 registered agent CLIs and 3 platforms. Generated from [`docs/verification-matrix.json`](verification-matrix.json); do not edit by hand.

## Verification tiers

| Tier | Meaning |
| --- | --- |
| `live_service` | Real vendor CLI completed a real upstream model turn recorded for this commit. |
| `real_cli_mock_llm` | Real vendor CLI ran end-to-end against Bellwood's loopback mock LLM server (non-live model backend). |
| `fake_cli_offline` | Covered by fake CLI smoke or offline driver protocol and contract unit tests on this platform. |
| `unverified` | No real-CLI or platform-specific vendor driver test ran on this platform for this commit. |
| `not_applicable` | This vendor CLI does not support or ship on this platform. |

## Verification surfaces

| Surface | Platform | CLI | Model backend | Workflow or command | Scope |
| --- | --- | --- | --- | --- | --- |
| PR check and verify-smoke | `linux` | `fake` | `fake` | `.github/workflows/check.yml` | Ubuntu 4-shard unit/e2e suite and pnpm verify smoke using test/fake-claude/fake-claude.ts. |
| macOS CI test suite | `macos` | `fake` | `fake` | `.github/workflows/macos.yml` | Full pnpm test:ci on macos-15 with offline driver protocol tests and no real vendor CLIs. |
| Windows integration and real-CLI mock-LLM | `windows` | `real` | `mock_llm` | `.github/workflows/windows.yml` | Real codex and pi CLIs inside fusa-run.exe against loopback mock LLM, plus core unit and sandbox integration tests. |
| Nightly Ubuntu real-CLI mock-LLM | `linux` | `real` | `mock_llm` | `.github/workflows/nightly.yml` | Real claude, codex, pi, and deepseek CLIs in Linux bwrap against loopback mock LLM, plus Codex schema drift check. |
| Resident live-service bench | `multi` | `real` | `live_service` | `pnpm tester` | Real Feishu, real relay, and real vendor turns on owner Mac (claude, agy, codex) and Tokyo Linux host (claude); ingested on demand. |

## Vendor x platform matrix

| Vendor | macOS | Windows | Linux |
| --- | --- | --- | --- |
| **Claude Code** (`claude`) | `fake_cli_offline` | `fake_cli_offline` | `real_cli_mock_llm` (nightly.yml, CLI latest) |
| **Antigravity** (`agy`) | `fake_cli_offline` | `unverified` | `fake_cli_offline` |
| **Codex** (`codex`) | `fake_cli_offline` | `real_cli_mock_llm` (windows.yml, CLI 0.169.0) | `real_cli_mock_llm` (nightly.yml, CLI latest) |
| **Pi** (`pi`) | `fake_cli_offline` | `real_cli_mock_llm` (windows.yml, CLI 1.5.2) | `real_cli_mock_llm` (nightly.yml, CLI latest) |
| **DeepSeek** (`deepseek`) | `fake_cli_offline` | `unverified` | `real_cli_mock_llm` (nightly.yml, CLI 0.2.2-rc.1) |
| **Cursor** (`cursor`) | `fake_cli_offline` | `unverified` | `fake_cli_offline` |
| **OpenCode** (`opencode`) | `fake_cli_offline` | `unverified` | `fake_cli_offline` |
| **Kimi Code** (`kimi`) | `fake_cli_offline` | `unverified` | `fake_cli_offline` |

## Detailed coverage and gaps

| Vendor | Platform | Tier | CLI / Model / Workflow | Evidence | Coverage notes and fallback tests |
| --- | --- | --- | --- | --- | --- |
| `claude` | macOS | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in macos.yml; resident Mac live-service turn (pnpm tester) is configured in test/tester/vendors.ts and not yet ingested for this commit. Fallback: `src/vendors/claude/protocol.test.ts`, `src/vendors/contract.test.ts`. |
| `claude` | Windows | `fake_cli_offline` | - | - | Covered by Windows settings and guard tests in windows.yml; no real Claude CLI turn runs in Windows CI or on a resident Windows bench. Fallback: `src/vendors/claude/settings.test.ts`, `src/shared/vendor-guard.test.ts`, `src/vendors/contract.test.ts`. |
| `claude` | Linux | `real_cli_mock_llm` | CLI latest via `nightly.yml` | `.github/workflows/nightly.yml` | Nightly Ubuntu CI runs real Claude CLI against loopback mock LLM only; resident Linux live-service turn (pnpm tester) is not yet ingested for this commit. Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/vendors/claude/protocol.test.ts`, `src/vendors/contract.test.ts`. |
| `agy` | macOS | `fake_cli_offline` | - | - | Covered by offline ACP driver and contract tests in macos.yml; resident Mac live-service turn (pnpm tester) is configured in test/tester/vendors.ts and not yet ingested for this commit. Fallback: `src/vendors/agy/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `agy` | Windows | `unverified` | - | - | Neither real Antigravity CLI nor agy-specific driver tests run in windows.yml, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`, `src/vendors/agy/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `agy` | Linux | `fake_cli_offline` | - | - | Covered by offline ACP driver and contract tests in check.yml; not installed in nightly.yml and marked accepted_gap on the Tokyo Linux bench. Fallback: `src/vendors/agy/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `codex` | macOS | `fake_cli_offline` | - | - | Covered by offline app-server driver and contract tests in macos.yml; resident Mac live-service turn (pnpm tester) is configured in test/tester/vendors.ts and not yet ingested for this commit. Fallback: `src/vendors/codex/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `codex` | Windows | `real_cli_mock_llm` | CLI 0.169.0 via `windows.yml` | `.github/workflows/windows.yml` | Windows CI runs real Codex CLI inside fusa-run.exe against loopback mock LLM only; no resident Windows live-account bench exists. Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/vendors/codex/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `codex` | Linux | `real_cli_mock_llm` | CLI latest via `nightly.yml` | `.github/workflows/nightly.yml` | Nightly Ubuntu CI runs real Codex CLI against loopback mock LLM (plus 0.169.0 vs latest schema drift); marked accepted_gap on the Tokyo Linux bench. Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/vendors/codex/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `pi` | macOS | `fake_cli_offline` | - | - | Covered by offline RPC driver and contract tests in macos.yml; no real-CLI macOS CI and marked accepted_gap on the resident Mac bench. Fallback: `src/vendors/pi/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `pi` | Windows | `real_cli_mock_llm` | CLI 1.5.2 via `windows.yml` | `.github/workflows/windows.yml` | Windows CI runs real Pi CLI inside fusa-run.exe against loopback mock LLM only; no resident Windows live-account bench exists. Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/vendors/pi/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `pi` | Linux | `real_cli_mock_llm` | CLI latest via `nightly.yml` | `.github/workflows/nightly.yml` | Nightly Ubuntu CI runs real Pi CLI against loopback mock LLM only; marked accepted_gap on the Tokyo Linux bench. Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/vendors/pi/driver.test.ts`, `src/vendors/contract.test.ts`. |
| `deepseek` | macOS | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in macos.yml; no real-CLI macOS CI and marked accepted_gap on the resident Mac bench (no test account). Fallback: `src/vendors/deepseek/deepseek.test.ts`, `src/vendors/contract.test.ts`. |
| `deepseek` | Windows | `unverified` | - | - | Neither real DeepSeek Harness CLI nor deepseek-specific driver tests run in windows.yml, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`, `src/vendors/deepseek/deepseek.test.ts`, `src/vendors/contract.test.ts`. |
| `deepseek` | Linux | `real_cli_mock_llm` | CLI 0.2.2-rc.1 via `nightly.yml` | `.github/workflows/nightly.yml` | Nightly Ubuntu CI runs real DeepSeek Harness CLI against loopback mock LLM only; marked accepted_gap on the resident bench (no test account). Fallback: `test/mock-llm/real-cli-e2e.test.ts`, `src/vendors/deepseek/deepseek.test.ts`, `src/vendors/contract.test.ts`. |
| `cursor` | macOS | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in macos.yml; cursor-agent uses proprietary Protobuf/ConnectRPC (unsupported_protocol in mock-LLM) and is accepted_gap on the resident bench. Fallback: `src/vendors/cursor/cursor.test.ts`, `src/vendors/contract.test.ts`. |
| `cursor` | Windows | `unverified` | - | - | Neither real cursor-agent CLI nor cursor-specific driver tests run in windows.yml; cursor-agent is unsupported_protocol for mock-LLM and no Windows live bench exists. Fallback: `src/shared/vendor-guard.test.ts`, `src/vendors/cursor/cursor.test.ts`, `src/vendors/contract.test.ts`. |
| `cursor` | Linux | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in check.yml; cursor-agent uses proprietary Protobuf/ConnectRPC (unsupported_protocol in mock-LLM) and is accepted_gap on the resident bench. Fallback: `src/vendors/cursor/cursor.test.ts`, `src/vendors/contract.test.ts`. |
| `opencode` | macOS | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in macos.yml; no real-CLI macOS CI and marked accepted_gap on the resident Mac bench (no test account). Fallback: `src/vendors/opencode/opencode.test.ts`, `src/vendors/contract.test.ts`. |
| `opencode` | Windows | `unverified` | - | - | Neither real OpenCode CLI nor opencode-specific driver tests run in windows.yml, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`, `src/vendors/opencode/opencode.test.ts`, `src/vendors/contract.test.ts`. |
| `opencode` | Linux | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in check.yml; not installed in nightly.yml and marked accepted_gap on the resident bench (no test account). Fallback: `src/vendors/opencode/opencode.test.ts`, `src/vendors/contract.test.ts`. |
| `kimi` | macOS | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in macos.yml; no real-CLI macOS CI and marked accepted_gap on the resident Mac bench (no test account). Fallback: `src/vendors/kimi/kimi.test.ts`, `src/vendors/contract.test.ts`. |
| `kimi` | Windows | `unverified` | - | - | Neither real Kimi Code CLI nor kimi-specific driver tests run in windows.yml, and no resident Windows live-account bench exists. Fallback: `src/shared/vendor-guard.test.ts`, `src/vendors/kimi/kimi.test.ts`, `src/vendors/contract.test.ts`. |
| `kimi` | Linux | `fake_cli_offline` | - | - | Covered by offline driver and contract tests in check.yml; not installed in nightly.yml and marked accepted_gap on the resident bench (no test account). Fallback: `src/vendors/kimi/kimi.test.ts`, `src/vendors/contract.test.ts`. |

## Reproduce and update

```sh
node scripts/verification-matrix.ts check
node scripts/verification-matrix.ts render --write
node scripts/verification-matrix.ts ingest-tester --run <run-record.json> --write
```
