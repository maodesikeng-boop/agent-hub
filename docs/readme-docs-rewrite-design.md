# README and user documentation rewrite

> Snapshot: 2026-11-28 (commit `88d616f1`)

Bellwood has landed 76 commits since `README.md`, `README.zh-CN.md`, and `docs/screenshots/readme/` were last updated (`9dd20f40`, 2026-11-24). Those 76 commits replaced the yellow-gold shell with the wood shell, retired the `Pieces` side panel in favor of the wide Work panel (`Active`, `Completed`, `Info`), added the top-bar quick Router input, shipped live in-chat progress checklists, added Settings pages for `Capabilities` and `Resources`, added user-confirmed Computer Use sandbox exceptions and per-app approval cards, switched default vendor selection to the first usable CLI on the machine, migrated Antigravity to ACP, added `hub watch` and `hub caps`, and removed workflow overfitting from shipped prompts (`88d616f1`, PR #513). This plan audits every factual discrepancy across Bellwood's user-facing docs and visuals, compares three documentation architectures, defines user decisions for sign-off, and commits an executable pre-implementation doc-consistency test suite.

## Plan review and decisions

### Files to review

- [This design document](readme-docs-rewrite-design.md): full codebase-to-doc audit at commit `88d616f1`, three candidate documentation architectures, user decision tables, file-by-file change scope, 18-asset visual refresh manifest, and the nine-category verification plan.
- [`docs/README.md`](README.md): adds this design document to the documentation index so `src/docs-guard.test.ts` stays green.
- [`src/user-docs-consistency.test.ts`](../src/user-docs-consistency.test.ts): executable doc-consistency validator helpers and acceptance tests covering new/changed requirements (`A1` through `A10`, expected to fail before implementation) and unchanged documentation contracts (`R1` through `R6`, expected to pass before implementation).

### Project Manager plan review

- **User sentences to scenarios.** Both quoted user requests in Section 1 (`Q1` and `Q2`) and all four decision items (`D1` through `D4`) map to runnable acceptance scenarios in Section 8 and executable test cases in `src/user-docs-consistency.test.ts`.
- **Verification categories.** Section 8 addresses every verification category from `docs/plan-standard.md` and every matching `Trigger:` rule from `origin/main:REVIEW.md`, with an explicit one-sentence rationale where a runtime-only category cannot apply to a documentation and static-guard change.
- **Structurally distinct designs.** Section 3 compares three structurally distinct candidates: patching the existing essay-style README in place (Candidate A), a task-oriented Diátaxis split paired with a code-derived automated doc-truth contract (Candidate B, recommended and day-one design), and moving content out of README into a split bilingual `docs/guide/` handbook (Candidate C).

### Decisions needed

#### D1. README information architecture and documentation verification model

Today `README.md` and `README.zh-CN.md` are 314-line narrative essays structured around "7 mechanisms", "5 Router points", and "5 Feishu points" with no automated checks tying their claims to code registries.

| Option | What external developers see |
| --- | --- |
| **1. Candidate B: Task-oriented layered README + user-first `docs/README.md` + automated doc-truth guard (recommended)** | Readers get a focused ~200-line landing page ordered by reader intent: (1) concise value summary and fresh wood-shell hero screenshot, (2) Quick start with installers, SHA-256 + `gh attestation verify`, Providers setup, and Linux/source links, (3) How Bellwood works (updated 8-vendor + 3-platform architecture SVG, PM + Work panel `Active`/`Completed`/`Info` + Task Graph + cross-vendor memory/sync + live checklists + `hub watch`/`schedule`), (4) Multi-computer Router (top-bar quick input + Router workbench + account mesh), (5) Feishu mobile and team loop, (6) Security and vendor terms (including Computer Use approvals). `docs/README.md` puts a "User guides" section ahead of internal design snapshots, and `src/user-docs-consistency.test.ts` prevents silent drift on every PR. |
| 2. Candidate A: Patch existing 314-line essay structure in place | Keeps the existing "7 mechanisms / 5 Router / 5 Feishu" essay skeleton, replaces `Pieces` with `Work panel`, removes workflow-overfit sentences, and appends bullets for new features. Leaves `docs/README.md` burying user guides beneath 45+ internal design docs and keeps README prose long. |
| 3. Candidate C: Thin README (~60 lines) + split bilingual `docs/guide/` handbook | Turns `README.md` and `README.zh-CN.md` into short indexes linking into separate `docs/guide/en/` and `docs/guide/zh/` pages. Forces GitHub visitors to click across multiple files to see core flows and doubles bilingual maintenance overhead. |

#### D2. Visual asset refresh scope (`docs/screenshots/readme/`)

All 9 PNG screenshots in `docs/screenshots/readme/` were captured on the retired yellow-gold shell (`9dd20f40`), showing the removed `Pieces` panel, old rail computer badges, and only 5 of 8 providers. All 4 `architecture*.svg` diagrams list only 6 vendors (missing `opencode` and `kimi`) and omit Linux.

| Option | What external developers see |
| --- | --- |
| **1. Refresh all 9 outdated PNGs on the live wood shell and update all 4 `architecture*.svg` diagrams (recommended)** | Every landing-page screenshot matches the current release: wood shell, top-bar Router input, Work panel (`Active` / `Completed` / `Info`), live progress checklist, Info-row Settings showing all 8 providers, and Router workbench without rail computer count badges. All 4 architecture SVGs show all 8 vendors and macOS, Windows, and Linux. The 4 factually accurate `feishu-group*.svg` diagrams remain after light/dark contrast verification. |
| 2. Fix only the 4 broken `architecture*.svg` files now; defer the 9 PNG screenshots | Fixes the missing `opencode` and `kimi` diagram error, but external users visiting the new release still see the retired yellow shell and removed `Pieces` UI in every screenshot. |

#### D3. Handling third-party product names in the Google Antigravity terms notice

`README.md:303` and `README.zh-CN.md:303` quote Section 6 of the Google Antigravity Additional Terms verbatim, including the parenthetical `(e.g. using OpenClaw with Antigravity OAuth)`. Repository rules forbid naming reference products in public docs.

| Option | Concrete before and after |
| --- | --- |
| **1. Paraphrase Section 6 with a direct link, omitting the third-party tool name (recommended)** | **Before:** `Section 6 of the Google Antigravity Additional Terms states: "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement..."` <br> **After:** `Section 6 of the Google Antigravity Additional Terms prohibits using third-party software, tools, or services to access the service and warns that violations may result in suspension or termination of your Antigravity or Gemini CLI account. Google has not clarified whether driving the official agy CLI locally in headless mode falls under this clause. Treat it as a real risk of account suspension or termination and decide for yourself.` |
| 2. Keep the verbatim legal quote including `(e.g. using OpenClaw...)` | Keeps the literal quote from Google's terms as a legal-citation exception, which requires exempting the terms paragraph from the public-doc third-party-name guard. |

#### D4. Companion user-facing documentation sync scope

Beyond `README.md`, `README.zh-CN.md`, and `docs/README.md`, our audit found concrete factual errors and omissions in `SECURITY.md`, `docs/write-scope.md`, `docs/linux.md`, and `CONTRIBUTING.md`.

| Option | Files updated in implementation |
| --- | --- |
| **1. Sync all user-facing docs in the same PR (recommended)** | Updates `README.md`, `README.zh-CN.md`, `docs/README.md`, `SECURITY.md` (adds `--no-outer-sandbox` and per-app Computer Use approval cards while preserving the `0.4.x` check), `docs/write-scope.md` (fixes `AGENT_HUB_TOKEN` to `HUB_TOKEN` and `other five vendors` to `other seven vendors`), `docs/linux.md` (adds `FUSA_MESH_PORT` and provenance note, aligns wording), and `CONTRIBUTING.md` (links `docs/review-and-merge.md`). Leaves `AGENTS.md` untouched in this PR. |
| 2. Rewrite only `README.md`, `README.zh-CN.md`, and `docs/README.md` | Leaves known factual errors in `docs/write-scope.md` (`AGENT_HUB_TOKEN`, `five vendors`) and missing Computer Use sandbox disclosures in `SECURITY.md` for a separate PR. |

## For Workers and reviewers

### 1. User goal

Original user instructions:

> Q1: 「新版本 + readme 以及相关文档重写 + 提示词去过拟合」
> Q2: 「先去过拟合」

Intended outcome: with prompt de-overfitting (`88d616f1`, PR #513) merged to `main`, rewrite `README.md`, `README.zh-CN.md`, `docs/README.md`, and companion user-facing docs (plus outdated README screenshots and architecture diagrams) so an unfamiliar external developer reading the new release gets an accurate, workflow-neutral, jargon-free guide backed by an automated doc-to-code consistency guard.

### 2. Current state and history

#### Design history

1. **Bilingual README expansion (`72bcd37b`, 2026-11-19) [Measured]:** Split the original README into `README.md` and `README.zh-CN.md`, added 9 Playwright screenshots and 8 light/dark SVGs under `docs/screenshots/readme/`, and structured both files around 7 single-conversation mechanisms, 5 Router points, and 5 Feishu points. At that point Bellwood supported 6 vendors (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`).
2. **Incremental doc patches (`e8ed3389`, `95fb1e59`, `6b6a4bac`, `02743478`, `60fc1413`, `9dd20f40`, 2026-11-20 to 2026-11-24) [Measured]:** Later PRs patched individual bullets when OpenCode and Kimi Code landed (`e8ed3389`), when the official public relay launched (`95fb1e59`), when Feishu group warnings were added (`6b6a4bac`), and when the honey-yellow shell landed (`9dd20f40`). Those patches updated README text in places without updating `architecture*.svg` (still 6 vendors) or `docs/write-scope.md` (still "other five vendors").
3. **76 commits of product evolution without README updates (`9dd20f40..88d616f1`, 2026-11-24 to 2026-11-28) [Measured]:** Major user-visible changes landed without touching `README.md`, `README.zh-CN.md`, or `docs/screenshots/readme/`:
   - Wood workbench shell (`8ea09acb`, PR #439).
   - Wide Work panel (`Active`, `Completed`, `Info`) replacing the `Pieces` panel and standalone PM settings panel (`596b5b1c`, PR #445).
   - Persistent PM column across widths and compact Worker rows (`f6ab7798`, PR #448).
   - Centered 40px top-bar quick Router input and non-modal reply popover (`08ee5151`, PR #449).
   - Info-row rollout across Settings, New PM dialog, and small surfaces (`9e7a7f1e`, PR #469).
   - Live in-chat progress checklists in every multi-step turn (`25fa8da4` PR #441, `ba3dd616` PR #468).
   - User-confirmed `--no-outer-sandbox` Computer Use mode and per-app approval cards (`fd5c1170` PR #443, `28059661` PR #451).
   - Default vendor selection following the first usable CLI on the computer (`40624c8a`, PR #494).
   - Daemon-managed external waits (`hub watch`) and unified `hub` CLI registry + `hub caps` (`9c7a9311` PR #497, `1bd1d2a3` PR #509).
   - Antigravity migration to ACP (`4a3fdac6`, PR #501).
   - Shipped prompt de-overfitting making review, planning, and PR merging strictly opt-in (`88d616f1`, PR #513).

The current user documentation is therefore a stack of partial edits layered over a retired visual design and a retired prompt workflow.

#### Core concepts

| Documentation surface | Current owner | Facts it duplicates from code | Automated guard today |
| --- | --- | --- | --- |
| `README.md`, `README.zh-CN.md` | Manual edits | Vendor list (`VENDOR_LIST`), CLI install/login commands (`VENDOR_PATHS`), installer names (`RELEASE_INSTALLER_FILES`), `hub` CLI examples (`HUB_CLI_REGISTRY`), Feishu commands (`FEISHU_SETTINGS_COMMANDS`), env vars (`src/shared/limits.ts`), UI panes (`src/web/`) | None |
| `docs/screenshots/readme/*.svg` | Manual SVG edits | Vendor list (`VENDOR_LIST`), platform entry points, handover threshold (`HANDOVER_TOKEN_THRESHOLD`), Feishu context limits (`FEISHU_CONTEXT_MAX_LINES`, `FEISHU_CONTEXT_MAX_CHARS`) | None |
| `docs/screenshots/readme/*.png` | Manual Playwright capture | Live Web UI shell, Work panel, Settings, Router | None |
| `docs/README.md` | Manual index | File list of `docs/**/*.md` | `src/docs-guard.test.ts` (index completeness + design snapshot headers only) |
| `SECURITY.md` | Manual edits | Supported version series (`package.json`, `Cargo.toml`), default port (`DEFAULT_UI_PORT`), socket/token names (`ENV_HUB_TOKEN`), sandbox rules, Feishu guest tiers (`FEISHU_GUEST_TIERS`) | `scripts/release-assets.ts` (version series `X.Y.x` only) |
| `docs/write-scope.md` | Snapshot doc linked by README | `ENV_HUB_TOKEN`, vendor count (`VENDOR_LIST`), platform sandbox mechanisms | `src/docs-guard.test.ts` (snapshot header only) |
| `docs/linux.md` | Living guide | Vendor install/login table (`VENDOR_PATHS`), `linuxInstallDirs` (`src/shared/paths.ts`), env vars | None |
| `CONTRIBUTING.md` | Manual guide | Local gate commands (`package.json`), CI wait command (`scripts/wait-checks.ts`) | None |

Missing concept: a single automated **user-docs consistency contract** (`src/user-docs-consistency.test.ts`, registered in `ALWAYS_RUN_TESTS` in `scripts/test-related.ts`) that imports `VENDOR_LIST`, `VENDOR_PATHS`, `RELEASE_INSTALLER_FILES`, `HUB_CLI_REGISTRY`, `FEISHU_SETTINGS_COMMANDS`, `ENV_HUB_TOKEN`, and `MESH_LISTEN_PORT` directly so factual drift in user docs or architecture SVGs fails CI immediately.

#### Verified evidence

Every item below was verified directly against `HEAD` (`88d616f1`).

1. **`Pieces` UI terminology retired `[Measured]`** (checked via `grep -rn "Pieces" src/web/ --exclude='*.test.*'` -> 0 matches; inspected `src/web/components/WorkPanel.tsx:45-57`): `README.md:17,29,108` and `README.zh-CN.md:17,29,108` still name the UI side panel `Pieces` and describe a separate PM settings panel, whereas `src/web/components/WorkPanel.tsx:45-57` renders `Work panel` with tabs `Active`, `Completed`, and `Info`.
2. **Workflow-overfit README claims contradict PR #513 `[Measured]`** (inspected `README.md:9,29,99`, `README.zh-CN.md:9,29,99`, and `docs/prompt-deoverfitting-design.md:26-71`): READMEs still state that the PM "merges their PRs" / "合 PR" and that "critical changes run through an independent read-only review on a second model vendor" / "碰到关键改动，还会自动排入另一家模型的独立只读审查", whereas PR #513 (`88d616f1`) made review, planning, and merging strictly opt-in.
3. **`hub persona edit` misdescribed as project memory `[Measured]`** (inspected `README.md:88`, `README.zh-CN.md:88`, and `src/hub/registry.ts:184-195`): both READMEs annotate `hub persona edit --stdin` as `# update cross-vendor project memory` / `# 更新跨厂商项目记忆`, whereas `src/hub/registry.ts:189-191` defines `hub persona edit` as editing the PM's mode or persona (`改模式或性格设定`). Project memory (`MEMORY.md` and topic files) lives in `state/pm-memory/<pmId>/` (`src/shared/paths.ts:456-462`) and is edited as Markdown files or via the Work panel's `Info` tab (`src/web/components/PmMemoryFilesGroup.tsx`).
4. **Rail badge claim disagrees with `AppRail.tsx` `[Measured]`** (inspected `README.md:105`, `README.zh-CN.md:105`, and `src/web/components/AppRail.tsx:80-106,157-160`): READMEs say paired computers on the left rail show "status dots and attention badges" / "各台已配对电脑及待处理角标", whereas `AppRail.tsx:157-160` explicitly documents "computer cells with no count" (only the Router tile shows a waiting count badge, and the Settings gear shows a red dot when Resources has items to review).
5. **Major shipped features missing from both READMEs `[Measured]`** (inspected `src/web/components/RouterTopBar.tsx:53-189`, `src/web/components/TurnProgress.tsx`, `src/web/components/SettingsDialog.tsx:45-52`, `src/web/components/CapabilitiesSettings.tsx`, `src/web/components/ResourcesSettings.tsx`, `src/web/components/SandboxApprovalCard.tsx`, `src/web/components/AppApprovalCard.tsx`, `src/shared/vendors.ts:326-343`, `src/hub/registry.ts:207-218,393-512`, `CHANGELOG.md:21,39`): neither README documents the 40px top-bar quick Router input and reply popover, live in-chat progress checklists, `Settings -> Capabilities` (`Project defaults` + per-project overrides + Worker `inherit`/`none`/`custom` modes), `Settings -> Resources` cleanup self-check, `hub watch` / `hub schedule` / `hub caps`, automatic default vendor selection (`firstUsableVendor`), user-confirmed Computer Use `--no-outer-sandbox` and per-app approval cards, or `gh attestation verify` provenance checks.
6. **All 4 `architecture*.svg` diagrams miss 2 of 8 vendors and Linux `[Measured]`** (inspected `docs/screenshots/readme/architecture.svg:19-47`, `architecture-zh.svg:19-47`, and `grep` across all 4 files): all 4 SVGs list only 6 vendors (`claude`, `codex`, `agy`, `cursor-agent`, `pi`, `dsh`), omitting `opencode` and `kimi` from `VENDOR_LIST` (`src/vendors/registry.ts:11`), and omit Linux `systemd` under entry points.
7. **All 9 README PNG screenshots show the retired pre-wood-shell UI `[Measured]`** (inspected `git log -- docs/screenshots/readme/` -> last updated `9dd20f40`, visually inspected `workspace-en.png`, `workspace-zh.png`, `task-graph-en.png`, `memory-en.png`, `router-en.png`, `router-zh.png`, `providers.png` vs `docs/ui-polish/baseline/baseline.png`): all 9 PNGs show the retired yellow-gold frame, the removed `Pieces` header/panel, old rail computer count badges, and `providers.png` cuts off after 5 of 8 vendors.
8. **`docs/write-scope.md` has two factual errors `[Measured]`** (inspected `docs/write-scope.md:26,72`, `src/shared/hub.ts:38`, and `src/vendors/claude/driver.ts:369,396`): line 26 names the session token env var `AGENT_HUB_TOKEN` instead of `HUB_TOKEN` (`ENV_HUB_TOKEN = "HUB_TOKEN"`), and line 72 says "the other five vendors use `@microsoft/mxc-sdk`" instead of the other **seven** vendors (`claude`, `agy`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`; `codex` uses its native `readOnly` sandbox).
9. **`SECURITY.md` omits Computer Use sandbox exceptions `[Measured]`** (inspected `SECURITY.md:26-33,82-89`): neither English nor Chinese section documents macOS `--no-outer-sandbox` human-only single-run confirmation cards or per-app Computer Use approval cards (`src/web/components/SandboxApprovalCard.tsx`, `src/web/components/AppApprovalCard.tsx`).
10. **Public READMEs include a third-party product name inside a quoted terms excerpt `[Measured]`** (inspected `README.md:303` and `README.zh-CN.md:303`): both files contain `OpenClaw` inside a verbatim quote of Google Antigravity's terms.
11. **Env vars and internal links in README need cleanup `[Measured]`** (inspected `README.md:220-224,264,274-285`, `src/shared/limits.ts:256-267,656`, `.github/workflows/windows-desktop.yml:150`): `FUSA_MESH_PORT` (`4320`) is omitted from the env table, `AGENT_HUB_<VENDOR>` variables are abbreviated without prefixes, Windows source build omits `-- --locked`, and 5 manual CLI install items link end users to internal architecture snapshot `docs/vendor-plugin-design.md`.
12. **Existing links, vendor install URLs, and Feishu SVG limits currently match code `[Measured]`** (verified via link-check script, `VENDOR_PATHS` dump, and `src/shared/limits.ts:591-592`): all existing relative links and anchors resolve, all 8 POSIX/Windows CLI install commands match `src/vendors/*/paths.ts`, installer filenames match `RELEASE_INSTALLER_FILES` (`src/shared/update.ts:7-10`), `SECURITY.md` lists `0.4.x` matching `package.json:3`, and `feishu-group*.svg` matches `FEISHU_CONTEXT_MAX_LINES = 30` and `FEISHU_CONTEXT_MAX_CHARS = 4_000`.

### 3. Reference designs and approach comparison

#### Mature open-source reference designs

1. **[Zed (`zed-industries/zed`)](https://github.com/zed-industries/zed):** Opens with a one-sentence product definition and one crisp UI screenshot, puts installation and platform links near the top, keeps the root README concise by delegating deep reference topics to a structured docs index, and avoids marketing filler.
2. **[Tailscale (`tailscale/tailscale`)](https://github.com/tailscale/tailscale):** Explains a multi-device mesh networking tool concretely (what runs locally, what talks peer-to-peer vs relay, what stays private) in plain operational prose, and pairs the root README with a separate security policy and platform-specific guides (`docs/linux.md` equivalent).
3. **[Vite (`vitejs/vite`)](https://github.com/vitejs/vite):** Applies Diátaxis separation cleanly: the root README orients a first-time developer in under two minutes, links to task guides and reference pages without duplicating deep internals, and keeps repository contributor rules separate from end-user onboarding.

#### Candidate architectures

| Dimension | Candidate A: Patch existing README in place | **Candidate B: Task-oriented layered README + user-first `docs/README.md` + automated doc-truth contract (Recommended, day-one design)** | Candidate C: Thin README stub + split bilingual `docs/guide/` handbook |
| --- | --- | --- | --- |
| Reader flow for a first-time external developer | Reads 314 lines of mechanism essays before reaching Quick start at line 195 | Sees what Bellwood is, fresh wood-shell screenshot, and Quick start in the first two screens; reads How it works, Router, Feishu, and Security in logical order (~200–240 lines) | Must click out of GitHub README into 6+ separate subpages just to see how PMs, Router, and Feishu work |
| `docs/README.md` discoverability | Keeps user guides (`linux.md`, `write-scope.md`, naming map) buried beneath 45+ internal design docs | Places "User guides and references" at the top of `docs/README.md`, followed by "Standards" and "Architecture and design archive", preserving `src/docs-guard.test.ts` | Adds a new bilingual directory tree (`docs/guide/en/`, `docs/guide/zh/`) requiring `docs-guard.test.ts` changes and duplicating navigation |
| Drift prevention | None; next vendor or UI rename silently breaks docs again | `src/user-docs-consistency.test.ts` (registered in `ALWAYS_RUN_TESTS`) cross-checks docs and SVGs against `VENDOR_LIST`, `VENDOR_PATHS`, `RELEASE_INSTALLER_FILES`, `HUB_CLI_REGISTRY`, and `limits.ts` | Splits claims across 12+ files, multiplying bilingual drift surface |
| Prose quality and workflow neutrality | High risk of leftover marketing/AI cadence and workflow-overfit framing | Clean rewrite under `.agents/skills/technical-writing/SKILL.md` and `.agents/skills/unslop/SKILL.md`, workflow-neutral throughout | Clean prose, but heavy maintenance cost per release |
| Scope discipline | Smallest initial diff, highest long-term drift | Focused on existing public doc files plus one test guard; zero runtime code changes | Creates a large new doc tree outside current conventions |

**Recommendation:** Adopt **Candidate B** (also the day-one design). It gives first-time external developers fast orientation and download access, reorganizes `docs/README.md` without inventing a second docs hierarchy, fixes every verified inaccuracy across companion user docs, refreshes outdated screenshots and SVGs, and prevents future drift with a single code-derived test suite.

#### Screening against design red flags

Screened all three candidates against `.agents/skills/architect/references/design-red-flags.md`:

- **Hand-synced list:** Candidate A leaves vendor lists, install commands, installer names, env vars, and `hub` CLI examples hand-synced across `README.md`, `README.zh-CN.md`, `docs/linux.md`, `docs/write-scope.md`, and `architecture*.svg`. Candidate B eliminates silent hand-sync drift by making CI fail in `src/user-docs-consistency.test.ts` whenever any user doc or SVG disagrees with `VENDOR_LIST`, `VENDOR_PATHS`, `RELEASE_INSTALLER_FILES`, `HUB_CLI_REGISTRY`, or `limits.ts`.
- **Split ownership:** Candidate C splits user explanations across two new bilingual trees plus the root READMEs. Candidate B keeps one authoritative home per topic (README for overview + quick start, `SECURITY.md` for threat model and sandbox guarantees, `docs/linux.md` for Linux deployment, `docs/write-scope.md` for OS sandbox technical details, `CONTRIBUTING.md` for contributor workflow).
- **Information leakage:** Current `README.md:220-224` leaks internal architecture snapshot `docs/vendor-plugin-design.md` into end-user CLI installation bullets. Candidate B removes internal snapshot links from end-user onboarding steps and separates user guides from internal design archives in `docs/README.md`.
- **Two ways to do one task:** Candidate B uses one consistent terminology set everywhere (`Work panel` with `Active`, `Completed`, `Info`; `Project Manager (PM)`; `Worker`; `Router`; `Settings -> Providers / Capabilities / Resources / Computers / Security & Access`), removing retired `Pieces` aliases.
- **Shallow module / Temporal decomposition / Pass-through method / Importable internals:** Not applicable to Markdown documents; in `src/user-docs-consistency.test.ts`, validator helpers stay pure, concise, and domain-grouped (links, vendor coverage, SVG coverage, factual contracts) with zero runtime exports.

#### Target file-by-file change scope

| File | Action | Concrete changes |
| --- | --- | --- |
| `README.md` | Rewrite | Restructure under Candidate B: crisp value pitch + fresh wood-shell hero; Quick start near the top (DMG/NSIS + `.sha256` + `gh attestation verify`, Providers setup, manual CLI install without internal design links, Feishu/mesh/Linux, source build with `-- --locked`, full env table including `FUSA_MESH_PORT` and all 8 `AGENT_HUB_<VENDOR>` names); How it works (updated 8-vendor + 3-platform SVG, Work panel `Active`/`Completed`/`Info`, opt-in review, cross-vendor memory & sync, background renewal & instant switch, worktrees & OS sandboxes, live checklists, `hub` CLI including `hub watch`/`schedule`/`caps` and corrected `hub persona edit`, default vendor auto-selection, Settings `Capabilities` & `Resources`); Router (top-bar quick input + popover + workbench + 2-tier catalog + mesh); Feishu (outbound WS, 1-on-1 Router + slime groups, `@bot` team loop, `/settings` & `/model`, 3 guest tiers + unsandboxed PM warning); Security & vendor terms (sandbox boundaries + Computer Use `--no-outer-sandbox` & per-app approvals + paraphrased Antigravity ToS without third-party tool names); clean prose per `technical-writing` + `unslop`. |
| `README.zh-CN.md` | Rewrite | Full Chinese counterpart matching Candidate B section-for-section with natural, restrained Chinese technical copy (zero marketing filler, zero `Pieces`, zero workflow-overfit claims, zero third-party tool names). |
| `docs/README.md` | Reorganize | Keep every existing `.md` link (`src/docs-guard.test.ts`), add a top `## User guides and references` section (`linux.md`, `write-scope.md`, `../SECURITY.md`, `../CONTRIBUTING.md`, `#naming-lineage`) above `## Standards` and `## Architecture and security`. |
| `SECURITY.md` | Update | Add macOS Computer Use `--no-outer-sandbox` human-only confirmation and per-app approval cards in both English and Chinese sections; keep `0.4.x` version series, port `4317`, `HUB_TOKEN`, and Feishu guest tiers intact. |
| `docs/write-scope.md` | Fix | Fix line 26 `AGENT_HUB_TOKEN` -> `HUB_TOKEN`, fix line 72 `other five vendors` -> `other seven vendors`, and bump its `> Snapshot:` line to the implementation commit. |
| `docs/linux.md` | Update | Add `FUSA_MESH_PORT` (`4320`), align wording with rewritten README, verify all 8 vendor install/login commands and `linuxInstallDirs` paths. |
| `CONTRIBUTING.md` | Light update | Link `docs/review-and-merge.md` alongside `AGENTS.md` and `docs/README.md` so contributors find full CI/review rules directly. |
| `scripts/test-related.ts` | Register guard (Step 2) | Add `"src/user-docs-consistency.test.ts"` to `ALWAYS_RUN_TESTS` so every future PR runs the user-docs consistency guard automatically. |
| `src/user-docs-consistency.test.ts` | Committed in Step 1 | Executable acceptance tests (`A1`–`A10`) and regression tests (`R1`–`R6`); unchanged during Step 2 implementation. |

#### Visual asset audit and refresh plan (`docs/screenshots/`)

| Asset | Current status at `88d616f1` | Action in Step 2 | Verification criteria |
| --- | --- | --- | --- |
| `docs/screenshots/icon-256.png` | Current app icon | Keep | Exists and renders in README header |
| `docs/screenshots/readme/architecture.svg` | Broken: only 6 vendors (no `opencode`/`kimi`), omits Linux | Update | Lists all 8 vendor CLIs + macOS/Windows/Linux + current components; clean light-mode render |
| `docs/screenshots/readme/architecture-dark.svg` | Broken: only 6 vendors, omits Linux | Update | Same factual parity as light variant; clean dark-mode contrast |
| `docs/screenshots/readme/architecture-zh.svg` | Broken: only 6 vendors, omits Linux | Update | Chinese counterpart with all 8 vendor CLIs + 3 platforms |
| `docs/screenshots/readme/architecture-zh-dark.svg` | Broken: only 6 vendors, omits Linux | Update | Dark Chinese counterpart with clean contrast |
| `docs/screenshots/readme/feishu-group.svg` | Accurate (`30` msgs / `4,000` chars, `@Bellwood`, JSON 2.0 card) | Keep (contrast check) | Matches `FEISHU_CONTEXT_MAX_LINES` / `CHARS`, crisp in light mode |
| `docs/screenshots/readme/feishu-group-dark.svg` | Accurate | Keep (contrast check) | Same facts, crisp in dark mode |
| `docs/screenshots/readme/feishu-group-zh.svg` | Accurate | Keep (contrast check) | Matches Chinese copy and limits |
| `docs/screenshots/readme/feishu-group-zh-dark.svg` | Accurate | Keep (contrast check) | Same facts, crisp in dark mode |
| `docs/screenshots/readme/workspace-en.png` | Outdated: yellow shell, `Pieces` panel, rail badges | Refresh via Playwright on isolated live daemon | Shows wood shell, top-bar Router input, PM chat with live progress checklist + decision card, wide Work panel (`Active`/`Completed`/`Info`) |
| `docs/screenshots/readme/workspace-zh.png` | Outdated: yellow shell, `Pieces` panel, rail badges | Refresh via Playwright on isolated live daemon | Chinese data counterpart on wood shell with Work panel and checklist |
| `docs/screenshots/readme/task-graph-en.png` | Outdated: yellow shell backdrop, `Pieces 3` | Refresh via Playwright on isolated live daemon | Task Graph full DAG dialog over wood shell |
| `docs/screenshots/readme/task-graph-zh.png` | Outdated: yellow shell backdrop, `Pieces 3` | Refresh via Playwright on isolated live daemon | Chinese Task Graph full DAG dialog over wood shell |
| `docs/screenshots/readme/memory-en.png` | Outdated: yellow shell, old standalone Memory panel | Refresh via Playwright on isolated live daemon | Shows Work panel `Info` tab / Memory files editor in wood shell |
| `docs/screenshots/readme/memory-zh.png` | Outdated: yellow shell, old standalone Memory panel | Refresh via Playwright on isolated live daemon | Chinese counterpart showing Work panel `Info` tab / Memory files |
| `docs/screenshots/readme/router-en.png` | Outdated: yellow shell, computer count badges | Refresh via Playwright on isolated live daemon | Wood-shell Router workbench with pending decisions + cross-device reply, no rail computer count badges |
| `docs/screenshots/readme/router-zh.png` | Outdated: yellow shell, computer count badges | Refresh via Playwright on isolated live daemon | Chinese Router workbench on wood shell |
| `docs/screenshots/readme/providers.png` | Outdated: yellow Settings modal, only 5 of 8 vendors visible | Refresh via Playwright on isolated live daemon | Info-row Settings (`wood-rings` nav) showing Providers list covering all 8 vendors |

### 4. Performance and bounds

None. This change modifies only static Markdown documentation, static SVG/PNG documentation assets, and a build-time Vitest guard (`src/user-docs-consistency.test.ts` plus its `ALWAYS_RUN_TESTS` entry in `scripts/test-related.ts`). It touches no runtime caches, snapshots, SQLite tables, or growing in-memory collections. Refreshed PNG assets overwrite the 9 existing files under `docs/screenshots/readme/` without adding unbounded asset growth.

### 5. Cross-vendor and cross-platform unification

- **Single source of truth for vendors:** `src/user-docs-consistency.test.ts` imports `VENDOR_LIST` (`src/vendors/registry.ts`) and `VENDOR_PATHS` (`src/vendors/paths-registry.ts`) directly. It asserts that every registered vendor's CLI command, `AGENT_HUB_<VENDOR>` env var, POSIX install command, Windows install command, and architecture SVG entry appear accurately across `README.md`, `README.zh-CN.md`, `docs/linux.md`, `docs/write-scope.md`, and `docs/screenshots/readme/architecture*.svg`. When a future vendor is added, implementing `src/vendors/<vendor>/spec.ts` and `src/vendors/<vendor>/paths.ts` and registering it in `src/vendors/registry.ts` automatically expands the doc-consistency checks so missing docs fail CI immediately.
- **Single source of truth for platforms and installers:** `src/user-docs-consistency.test.ts` imports `RELEASE_INSTALLER_FILES` (`src/shared/update.ts`) and `MESH_LISTEN_PORT` / `DEFAULT_UI_PORT` (`src/shared/limits.ts`) and verifies coverage across all three supported platforms (`macOS` Apple silicon, `Windows` x64, and `Linux` `systemd` + `bubblewrap` via `src/daemon/platform/index.ts`).

### 6. Deletions

Delete or overwrite in the implementation PR so old and new claims never coexist:

- Every `Pieces` UI label and "Pieces side panel" description in `README.md` and `README.zh-CN.md`.
- Workflow-overfit defaults in `README.md` and `README.zh-CN.md` (claiming PMs automatically merge PRs or automatically schedule cross-vendor read-only review on critical changes).
- Incorrect `# update cross-vendor project memory` annotation on `hub persona edit --stdin`.
- Incorrect rail "attention badges" claim for computer icons in `README.md` and `README.zh-CN.md`.
- End-user install links pointing to internal snapshot `docs/vendor-plugin-design.md` in `README.md` and `README.zh-CN.md`.
- Third-party product name inside the Antigravity Terms of Service quote in `README.md` and `README.zh-CN.md` (per D3 Option 1).
- Incorrect `AGENT_HUB_TOKEN` and `"other five vendors"` statements in `docs/write-scope.md`.
- All 4 stale 6-vendor `architecture*.svg` diagrams (replaced in place) and all 9 retired yellow-shell PNG screenshots (overwritten in place with wood-shell captures).

### 7. Skeleton files

Delivered in Step 1 (planning commit):

- [`docs/readme-docs-rewrite-design.md`](readme-docs-rewrite-design.md): design plan, audit inventory, architecture comparison, user decision tables, visual refresh manifest, and verification plan.
- [`docs/README.md`](README.md): indexes `readme-docs-rewrite-design.md` so `src/docs-guard.test.ts` passes.
- [`src/user-docs-consistency.test.ts`](../src/user-docs-consistency.test.ts): pure typed doc-validation helpers (`extractLocalDocTargets`, `slugifyMarkdownHeading`, `validateUserDocLinks`, `extractHubCommandsFromMarkdown`) plus executable acceptance tests (`A1`–`A10`, failing pre-implementation) and regression tests (`R1`–`R6`, passing pre-implementation).

Target files for Step 2 (implementation, after user decision sign-off):

- `README.md`, `README.zh-CN.md`, `docs/README.md`, `SECURITY.md`, `docs/write-scope.md`, `docs/linux.md`, `CONTRIBUTING.md`: rewritten/synced user-facing documentation satisfying `A1`–`A8` and `R1`–`R5`.
- `docs/screenshots/readme/architecture*.svg` (4 files) and `docs/screenshots/readme/*.png` (9 workbench screenshots): updated SVGs and refreshed wood-shell PNG captures satisfying `A4` and `A9`.
- `scripts/test-related.ts`: adds `"src/user-docs-consistency.test.ts"` to `ALWAYS_RUN_TESTS` satisfying `A10`.

### 8. Verification plan

#### Acceptance scenarios

Mapping of quoted user goals (`Q1`, `Q2`) and decisions (`D1`–`D4`) to concrete scenarios:

1. **S1 (Maps to Q1, D1, A1, A3, A7): New developer reads `README.md` and `README.zh-CN.md` for the current release.**
   - *First:* An unfamiliar developer opens `README.md` or `README.zh-CN.md` on GitHub.
   - *Next:* They read the opening overview, Quick start, workbench layout, `hub` examples, Router, Feishu, and optional environment variables.
   - *User sees:* Accurate current UI names (`Work panel` with `Active`, `Completed`, `Info`, zero `Pieces`), top-bar quick Router input, live progress checklists, `Settings -> Capabilities` and `Settings -> Resources`, `hub watch` / `hub schedule` / `hub caps`, corrected `hub persona edit`, `FUSA_MESH_PORT`, all 8 `AGENT_HUB_<VENDOR>` names, `gh attestation verify`, no computer count badges claimed on the rail, and no internal design-doc links inside end-user install steps.
2. **S2 (Maps to Q1, Q2, A2): External developer evaluates Bellwood's workflow expectations after prompt de-overfitting.**
   - *First:* A developer whose team does not use cross-vendor review or automatic PR merging reads `README.md` and `README.zh-CN.md`.
   - *Next:* They check how PMs, Workers, and Task Graphs operate out of the box.
   - *User sees:* Clear documentation that independent or cross-vendor review is optional (opt-in by user request or project rules), with zero claims that Bellwood automatically schedules cross-vendor reviews or merges PRs by default.
3. **S3 (Maps to Q1, D2, A4, A9, R5): Visual assets match the shipped wood-shell UI and all 8 vendors.**
   - *First:* A developer views the embedded screenshots and light/dark architecture SVGs in `README.md` and `README.zh-CN.md`.
   - *Next:* They compare the diagrams and screenshots against the running app and supported CLI list.
   - *User sees:* All 4 `architecture*.svg` files include all 8 vendor CLIs (`claude`, `agy`, `codex`, `pi`, `dsh`, `cursor-agent`, `opencode`, `kimi`) and macOS, Windows, and Linux; all 9 workbench PNGs are fresh wood-shell captures (none match the retired `9dd20f40` yellow-shell SHA-256 hashes); `feishu-group*.svg` matches `30` messages / `4,000` chars.
4. **S4 (Maps to Q1, D3, A5, A8): Public documentation has clean prose and zero reference product names.**
   - *First:* A reviewer runs automated doc-consistency checks and reads `README.md`, `README.zh-CN.md`, and companion public docs end to end.
   - *Next:* Checks scan for forbidden third-party product names, em dashes in English README, and AI/marketing filler phrases.
   - *User sees:* Crisp, concrete technical writing in both English and Chinese with zero external product names in public docs.
5. **S5 (Maps to Q1, D4, A6, A7, A10, R1–R4): Companion user docs and `docs/README.md` match current code and stay guarded in CI.**
   - *First:* A developer follows links from `README.md` into `docs/README.md`, `SECURITY.md`, `docs/write-scope.md`, `docs/linux.md`, and `CONTRIBUTING.md`.
   - *Next:* They inspect sandbox rules, Linux deployment steps, and contributor commands, and CI runs `pnpm test:related`.
   - *User sees:* `docs/README.md` leads with a User guides section before internal design docs; `SECURITY.md` documents `--no-outer-sandbox` and per-app Computer Use approval cards while keeping `0.4.x`, `4317`, `HUB_TOKEN`, and all 3 Feishu guest tiers accurate; `docs/write-scope.md` uses `HUB_TOKEN` and `seven` non-Codex Windows vendors; every relative link and anchor resolves; `ALWAYS_RUN_TESTS` includes `src/user-docs-consistency.test.ts`.

#### Nine-category coverage check (`docs/plan-standard.md` and `origin/main:REVIEW.md`)

1. **Two consecutive turns in the same conversation:** Not applicable because this change modifies only static Markdown docs, static SVG/PNG assets, and a build-time Vitest guard with zero runtime conversation code.
2. **A restart in the middle of the operation:** Not applicable because documentation files and static consistency tests have no persistent daemon operation that can be interrupted mid-flight (clean daemon start/stop remains verified by `pnpm verify`).
3. **A state or configuration change while work or a notice waits in a queue:** Not applicable because no daemon queue, action lane, scheduler, or notice delivery path is touched.
4. **Existing rules or boundaries touched (every matching `Trigger:` in `origin/main:REVIEW.md`):**
   - `**/*.test.ts` ("Tests wait for events, not for time"): `src/user-docs-consistency.test.ts` performs synchronous file reads and pure assertions with zero timers, zero sleeps, zero child processes, and zero wall-clock assertions.
   - `**` ("Planned acceptance scenarios cover every requirement and pass real tests"): Every quoted user sentence (`Q1`, `Q2`), settled decision (`D1`–`D4`), and applicable category maps to executable Vitest assertions (`A1`–`A10`, `R1`–`R6`) with zero `it.todo` placeholders and a recorded pre-implementation baseline where `A1`–`A10` fail and `R1`–`R6` pass.
   - `scripts/**` (Step 2 edit to `scripts/test-related.ts`, "Detached child processes and temp dirs stay inside the session boundary"): Step 2 only appends one static test path string to `ALWAYS_RUN_TESTS` without modifying process spawning or temporary directory handling.
   - Existing guards preserved: `src/docs-guard.test.ts` (index completeness, design doc snapshot header, `AGENTS.md` untouched), `scripts/release-assets.ts` (`SECURITY.md` `0.4.x` version parity), `src/code-hygiene.test.ts` (file/function size caps and comment rules).
5. **Reopening a closed view after cached data becomes stale:** Not applicable because no frontend state store, React Query cache, or UI view code is changed.
6. **Large data volume (300 finished Workers, 30,000 messages, 50,000 step logs):** Not applicable because static documentation files and the doc-consistency test guard do not read or grow with runtime ledger volumes.
7. **Malformed or dirty data:** Covered by `R6` in `src/user-docs-consistency.test.ts`, where validator helpers handle empty strings, broken links, missing files, invalid cross-file anchors, duplicate headings, and malformed Markdown syntax cleanly without throwing.
8. **Cross-vendor coverage across all 8 registered vendors and prompt-cache preservation:** Covered by `A4`, `A6`, `A7`, and `R2`. Every vendor in `VENDOR_LIST` (`claude`, `agy`, `codex`, `pi`, `deepseek`, `cursor`, `opencode`, `kimi`) is verified across `README.md`, `README.zh-CN.md`, `docs/linux.md`, `docs/write-scope.md`, and all 4 `architecture*.svg` diagrams. Prompt-cache preservation: this change makes zero edits to session prompts, messages, tools, or MCP definitions, so `TokenUsage.cacheRead` across all 8 vendors is strictly unchanged.
9. **Cross-platform coverage (macOS, Windows, Linux):** Covered by `A4`, `A6`, `R2`, and `R3`. The suite verifies macOS Apple silicon DMG and `.sha256`, Windows x64 NSIS and `.sha256` plus 7-vendor Windows MXC read-only scope, Linux `systemd` and `bubblewrap` (`docs/linux.md`), and all three platforms in `architecture*.svg`.
10. **Cross-entry-point and layout coverage (wide/narrow web screens, Feishu, `hub` CLI, multiple computers):** Covered by `A1`, `A3`, `A7`, `R4`, and `R5`. The suite verifies desktop wood shell, top-bar Router input, Work panel, responsive mobile shell mentions, Feishu 1-on-1 Router, project groups, `/settings` and `/model`, guest tiers, SVG limits, `hub` CLI examples against `HUB_CLI_REGISTRY`, and multi-computer mesh with `FUSA_MESH_PORT`.

#### Real-environment and real-CLI verification

- Per `docs/review-and-merge.md`, a PR that changes only documentation, visual assets, and doc-consistency tests runs the independent logic review track (plus an independent README prose review specified by the task graph) and does not require live vendor CLI, Feishu, or multi-computer mesh runtime runs because no runtime code changes.
- For the Step 2 visual asset refresh (`D2` Option 1), every refreshed PNG screenshot in `docs/screenshots/readme/` is captured against a real isolated Bellwood daemon with a temporary `AGENT_HUB_HOME` in headless Chromium via Playwright, and every updated light/dark SVG and PNG is visually inspected in rendered browser views before handoff.
- The final local gate runs `pnpm verify` (real daemon + headless Chromium smoke check) alongside `pnpm lint`, `pnpm typecheck`, and `pnpm test:related`.

#### Commands and visual checks

Planning step (pre-implementation baseline):

- `pnpm typecheck` (must exit 0)
- `pnpm lint` (must exit 0)
- `pnpm exec vitest run src/docs-guard.test.ts src/code-hygiene.test.ts` (must pass)
- `pnpm exec vitest run src/user-docs-consistency.test.ts` (must run with zero syntax/type errors; all 10 new-behavior tests `A1`–`A10` must fail and all 6 regression tests `R1`–`R6` must pass)

Implementation step (final gate before handoff):

- `pnpm exec vitest run src/user-docs-consistency.test.ts` (all 16 tests `A1`–`A10` and `R1`–`R6` must pass with zero edits or weakening of the planning tests)
- `pnpm lint && pnpm typecheck && pnpm test:related && pnpm verify` (all four must pass cleanly)
- Visual inspection of all 9 refreshed PNG screenshots and all 8 light/dark SVGs under `docs/screenshots/readme/`.
