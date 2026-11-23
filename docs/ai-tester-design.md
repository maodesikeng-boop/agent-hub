# AI tester design

## For the user

### Files to review

- [docs/ai-tester-design.md](ai-tester-design.md): this plan. It covers the resident test bench, the two layers (nightly scripts and the AI tester), the flow list, when each layer runs, how false alarms are kept down, the two new `pnpm verify` checks, cost, and what still needs a person.
- [.agents/skills/tester/SKILL.md](../.agents/skills/tester/SKILL.md): the tester handbook that any model loads to test Bellwood on the bench.
- [.agents/skills/tester/references/bench-setup.md](../.agents/skills/tester/references/bench-setup.md): the one-time setup runbook, with every step you do by hand marked.
- [test/tester/flows.ts](../test/tester/flows.ts): the user flow list with pass rules and evidence, as data.
- [test/tester/vendors.ts](../test/tester/vendors.ts): how each of the eight vendors is installed, signed in, and reported when it is not ready.
- [scripts/verify-steps.ts](../scripts/verify-steps.ts): the two checks `pnpm verify` gains.

### Decisions needed

1. **Where the second test computer runs.** Multi-computer flows need two Bellwood instances on a test account.
   - A. **Recommended.** A test instance on this Mac plus a test instance under a separate Linux user on the Tokyo server. The Tokyo one is always on and holds the test bot's Feishu connection, like your real setup. The Mac one starts only while a test runs, so it sleeps with your Mac and uses no memory otherwise. This is the topology where the recent Feishu and relay bugs happened.
   - B. Two instances on the Tokyo server in separate containers. Always on and nothing runs on the Mac, but it never sees your home network or macOS, and Tokyo needs Docker.
   - C. Mac only. No multi-computer, failover, or relay flows.
2. **How test computers stay apart from yours.** The relay groups computers by GitHub account.
   - A. **Recommended.** A GitHub machine account (GitHub's terms allow one for automation) signed in on the official relay. Test computers then live in a separate relay account and can never appear in your Computers list or take your Feishu connection.
   - B. A second relay deployment with your own GitHub account. No new account, but it tests a relay that users do not use.
3. **Who "the user" is in Feishu.**
   - A. **Recommended.** Your own Feishu account, through a small driver app you authorize once. The tester posts as you, but only into the test bot's chats; the code refuses any other chat. Test groups appear in your Feishu, so you mute them.
   - B. A second Feishu account. Needs another phone number, and also lets the tester cover team mode and guest permissions.
4. **Accounts for all eight vendors on both test computers.** Every vendor in `VENDOR_LIST` is installed and probed on every run. A vendor that is not installed or not signed in shows in every summary with the reason and the fix command, and raises a coverage alert until it is fixed or you accept the gap.
   - A. **Recommended.** Use the accounts you already pay for (Claude, ChatGPT, Cursor, Google), add pay-as-you-go API keys where they cost cents (DeepSeek, and Pi through a DeepSeek key), and decide for OpenCode and Kimi Code whether to sign up. A vendor you decide not to cover is recorded as an accepted gap with your reason. It stays listed in every summary but stops alerting.
   - B. Dedicated API keys for every vendor with a 10 USD monthly cap. Cleaner billing, but not every vendor offers keys, and more to set up.
5. **Whether AI tester sessions may restart the Tokyo test instance.** Claude Code refused my attempt to SSH to Tokyo from this Worker, which is the right default.
   - A. **Recommended.** A dedicated key for the Tokyo test user that can only run six commands (status, start, stop, restart, deploy, logs), plus one Claude Code permission rule for the tester command. Restart, failover, and catch-up flows then work in AI sessions too.
   - B. No rule. Those flows run only in the nightly job, which is not a Claude Code session; AI sessions read its results and run the other flows.
6. **One small product change.** A second Bellwood on the same computer currently tries the default LAN port 4320. If it starts first, your own instance loses its LAN path until restart. I recommend a `FUSA_MESH_PORT` setting so test instances use their own port. The alternative is option 1B only.

## For Workers and reviewers

### 1. User goal

> 「不是，这个人不是一个人，而是ai，不是一个固定的ai而是一个工作在特定环境的ai，他知道怎么测试？」「verify是不是也得更新了」「给测试员做一个环境的成本？」「按这个思路开工，先做方案」
>
> Added later: the test environment must cover every vendor in `src/vendors/registry.ts` `VENDOR_LIST`, not only the common ones. OpenCode and Kimi Code are not installed on this Mac, so they never show in the workbench and nobody tests them. State how each vendor is installed and signed in on the bench, and how a vendor that cannot be installed or signed in is marked. Never skip one silently.

The tester is a resident test bench plus a handbook in this repository. Any model that loads the handbook can test Bellwood the way a user does: real Feishu, the real relay over real networks, all eight real vendor CLIs, and two computers. A nightly script layer runs the flows without model tokens. The AI layer triages failures, tests release candidates in full, and tests PRs that touch Feishu, the mesh, or vendor drivers. `pnpm verify` gains two cheap checks.

### 2. Current state

- [Measured] `pnpm verify` stops once the composer renders (`scripts/verify-smoke.ts:156`). It sends no message and never restarts the daemon. Three runs in this Worker passed with a median of 4.04 s against a 20 s budget (`VERIFY_SMOKE_BUDGET_MS`, `src/shared/limits.ts:241`). Output: `/tmp/ai-tester/verify-baseline/smoke-runs.txt`.
- [Measured] Every test that crosses an external boundary uses a stand-in: the fake claude (`test/fake-claude/fake-claude.ts`), a fake Feishu hub (`test/e2e/fake-feishu-hub.ts`), a fake gh (`test/fake-gh.ts`), fake devices (`test/fake-devices/main.ts`), and jsdom for web tests. `pnpm smoke` drives the real claude, but only by hand and only claude (`test/smoke/main.ts:1-3`). The nightly workflow runs that same suite (`.github/workflows/nightly.yml`).
- [Measured] Six of the eight vendor CLIs are installed on this Mac (claude 2.1.330, agy 1.5.14, codex 0.169.0, pi 1.5.2, dsh 0.2.2-rc.1, cursor-agent 2026.11.10). `opencode` and `kimi` are not on PATH. Checked with `command -v` and `--version`. Sign-in state was not probed, so the developer's own CLI accounts stayed untouched.
- [Measured] The product already knows how to install and sign in each vendor: `installCommand`, `windowsInstallCommand`, and `headlessLoginCommand` in each `src/vendors/<id>/paths.ts`, `cli.loginCommand` in each spec, and the table in `docs/linux.md` section 2. `scripts/provision-linux.sh` installs every vendor's CLI on Ubuntu from those commands. The daemon reports each vendor as `available`, `not_installed`, or `signed_out` (`src/shared/vendors.ts:240-249`, `src/daemon/daemon.ts:523-526`).
- [Measured] Inside this Worker's macOS sandbox: outbound HTTPS works (`curl` to `open.feishu.cn` and to the official relay returned HTTP 404 in 0.05 s and 0.88 s), loopback works (`pnpm verify` passed), writes outside the data directory work (a probe directory in `$HOME` was created and removed), and the production state directory is unreadable (`ls ~/.agent-hub/state`: "Operation not permitted"). The sandbox denies outbound connections only to Unix sockets inside the data directory (`src/daemon/driver/write-scope.ts:250`).
- [Measured] Claude Code's auto-mode classifier refused `ssh` to the Tokyo host with the existing key as unauthorized access. That is a harness policy, not the OS sandbox, so the AI tester needs an explicit permission to reach Tokyo (decision 5). Tokyo's memory and CPU were therefore not checked.
- [Measured] The repository is public (`GET https://api.github.com/repos/maodesikeng-boop/agent-hub` returns 200 without a token), so a bench computer can fetch any PR head by commit without credentials.
- [Measured] A relay account is derived from the GitHub user id (`src/relay/auth.ts:29`). A second device in an account registers as `pending` while another is active (`src/relay/core.ts:160-162`). A test computer signed in with the developer's GitHub account would therefore appear in the developer's account.
- [Measured] The mesh LAN listener uses port 4320 unless the UI port is 0 (`src/shared/limits.ts:574`, `src/daemon/daemon.ts:729`). When the bind fails the daemon logs it and runs relay-only (`src/daemon/mesh/index.ts:479-494`), publishing no LAN candidates (`src/daemon/mesh/index.ts:199`). So whichever instance starts first on a computer owns the LAN path. `scripts/provision-linux.sh` sets the Tokyo production UI port to 4318.
- [Measured] Vendor config sync writes into the daemon's `HOME`, which is why `pnpm verify` gives the daemon a scratch `HOME` (`scripts/verify-smoke.ts:52-59`). A test instance must do the same or it rewrites the developer's CLI config.
- [Inferred] From Feishu's docs: the send-message API accepts a `user_access_token` when the app holds `im:message` and `im:message.send_as_user` (https://open.feishu.cn/document/server-docs/im-v1/message/create). The bot receive event fires for messages from users and bots (https://open.feishu.cn/document/server-docs/im-v1/message/events/receive). The refresh token is single-use, rotates on every refresh, and ends 365 days after consent (https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3).
- [Inferred] From Feishu's docs: chat history returns recalled messages with `deleted: true` and the content "This message was recalled", and `card_msg_content_type=user_card_content` returns the original card JSON (https://open.feishu.cn/document/server-docs/im-v1/message/list). The recall bug in PR #411 is therefore visible through the API.
- [Inferred] From Feishu's docs: a card callback fires only when a person taps a card in the Feishu client (https://open.feishu.cn/document/feishu-cards/card-callback-communication). No API simulates a tap, so tapping a decision card or Stop on the phone stays manual.
- [Measured] The test bot gets `im:message:readonly` and `im:message.group_msg` from the product's own setup (`src/daemon/feishu/scopes.ts:5-35`), so its tenant token can read every test chat. Only sending as the owner needs the extra driver app.
- [Inferred] Whether Feishu delivers a driver-app message to the test bot exactly like a hand-typed one is supported by the docs above but not yet measured. It is the first probe of the implementation step.
- [Inferred] From `man launchd.plist`: launchd runs a `StartCalendarInterval` job at the next wake when the computer was asleep at the scheduled time.

### 3. Approach comparison

| Option | Real boundaries | Cost per month | Catches #409, #411, #415 | Upkeep |
| --- | --- | --- | --- | --- |
| **Resident bench (Mac test instance and Tokyo test user) with nightly scripts and an AI layer** | Feishu, relay over home and cloud networks, eight vendor CLIs, two computers | about 0 to 10 USD | Yes: group round trip, offline replay, failed-turn card, cold dial, presence | Bench logins, yearly Feishu consent |
| More stand-ins in the unit suite (a stricter fake Feishu, network shaping in tests) | None; each fake is still a guess about the real service | 0 | Only what the fake's author already imagined | Low |
| Nightly cloud runners (GitHub Actions) driving a test bot | Feishu, relay from a data center | 0 | Partly: no home network, no persistent second computer, vendor logins as CI secrets | Secrets for eight vendors in CI |
| Hand testing before each release | Everything | your time | When someone remembers to try it | High |

Recommendation: the resident bench. The recent escapes came from where fakes and real services differ (Feishu recalling a card, real relay latency, a hub judging a live Mac offline). Only real boundaries catch that class. Tokyo and the Mac already exist, so the bench costs accounts and logins, not servers. Stricter fakes still help for regressions once a real behavior is known, so each confirmed bench failure should also update the matching fake.

Where the nightly job runs:

| Option | Results reach the Project Manager | Mac flows | Credentials |
| --- | --- | --- | --- |
| **launchd job on the Mac at 23:30, run on wake if missed** | Local files in the bench root, read by the 00:00 review | Yes | Driver token and secrets stay on the Mac |
| systemd timer on Tokyo | Needs a channel back (SSH, Feishu, or an issue) | Only when the Mac is awake | Driver token on the server |

### 4. Performance and bounds

No product cache or collection changes. The tester's own growth is capped in `test/tester/limits.ts`, following `test/eval/limits.ts`, because none of it ships:

| Constant | Value | Sizing |
| --- | --- | --- |
| `TESTER_HISTORY_MAX_RUNS` | 120 | One nightly run for two months plus PR and RC runs; one record is about 10 KB, so about 1.2 MB |
| `TESTER_EVIDENCE_KEEP_RUNS` | 20 | 20 runs × about 35 flow results × at most 2 MB, in practice under 100 KB each, so about 70 MB |
| `TESTER_EVIDENCE_MAX_BYTES_PER_FLOW` | 2 MB | Caps a runaway daemon log tail |
| `TESTER_NIGHTLY_BUDGET_MS` | 30 min | A full nightly run is an estimated 12 min; the cap stops a hung flow from holding the bench |

The bench's long-lived data directories are the point of `lifecycle.restart-keeps-data`: they grow like a real user's, and the product's own retention rules keep them bounded.

`pnpm verify` grows from a 4 s median to an estimated 6 to 7 s with the two new checks, still well inside the 20 s budget.

### 5. Cross-vendor and cross-platform unification

- One flow, `model.turn.<id>`, is generated from `VENDOR_LIST` for every vendor and runs on both bench computers, with results keyed `model.turn.<id>@local` and `@remote`. `model.provider-status` checks that the daemon reports every vendor's real state.
- Install and login commands come from the product (`VENDOR_PATHS` and each spec), the same ones Settings, `docs/linux.md`, and `scripts/provision-linux.sh` use.
- A future vendor implements one entry in `test/tester/vendors.ts` `VENDOR_BENCH` (its cheapest model and account note). The record is typed over `AgentVendor`, so typecheck fails until the entry exists. Its flows appear automatically.
- Platforms: the bench covers macOS (local) and Linux (remote). Windows has no resident machine; it stays covered by the `windows.yml` job and the manual candidate acceptance in `docs/release-flow-design.md`. The tester code itself uses Node APIs and spawns without a shell, so it can run from any of the three.

### 6. Deletions

None. `pnpm smoke` stays: it drives the real claude through scenarios the bench does not repeat. The two new verify checks extend `runOnce` in `scripts/verify-smoke.ts` rather than adding a second smoke script.

### 7. Skeleton files

- `test/tester/types.ts`: flow specs, observations, verdicts (including `not_ready`), run records, and alerts.
- `test/tester/flows.ts`: the flow catalog, the per-vendor flow generator, the runner map, and `selectFlows`.
- `test/tester/flows/feishu.ts`, `flows/mesh.ts`, `flows/model.ts`, `flows/lifecycle.ts`: one runner per flow.
- `test/tester/vendors.ts`: vendor readiness, `VENDOR_BENCH`, install and probe helpers, and open coverage gaps.
- `test/tester/bench.ts`: bench config, production guards, and the instance client and control interfaces.
- `test/tester/feishu-driver.ts`: send as the owner into test chats only, read with the test bot, detect recalls.
- `test/tester/preflight.ts`: checks every boundary and builds the full vendor coverage matrix before flows run.
- `test/tester/verdict.ts`: classification and alert rules.
- `test/tester/history.ts` and `test/tester/report.ts`: bounded history, evidence pruning, and summaries.
- `test/tester/remote.ts`: the six remote commands sent over the restricted SSH key.
- `test/tester/run.ts` and `test/tester/cli.ts`: orchestration and the command line.
- `test/tester/limits.ts`: the caps above.
- `test/tester/*.test.ts`: `it.todo` cases for every contract.
- `scripts/verify-steps.ts` and its test: the message round trip and the restart check for `pnpm verify`.
- `src/daemon/mesh/listen-port.ts` and its test, plus `ENV_MESH_PORT` in `src/shared/limits.ts`: decision 6.
- `.agents/skills/tester/SKILL.md` and `references/bench-setup.md`: the handbook and the setup runbook.

The implementation step also adds: the `tester` script in `package.json`, the remote forced command (`test/tester/remote-command.sh`), the launchd job template for the Mac, a `--user`, `--port`, and `--mesh-port` mode for `scripts/provision-linux.sh` so it can provision the Tokyo test user, the wiring of `meshListenPort` in `src/daemon/daemon.ts`, the two verify phases in `scripts/verify-smoke.ts`, and the matching lines in `.agents/skills/verify/SKILL.md`.

### 8. Verification plan

- `pnpm typecheck`, `pnpm test:related`, and every `test/tester/*.test.ts`, `scripts/verify-steps.test.ts`, and `src/daemon/mesh/listen-port.test.ts` case filled in. `vendors.test.ts` asserts a recipe for every vendor in `VENDOR_LIST`.
- `pnpm verify --runs 3`: all pass, the screenshot shows the sent message and the reply, `smoke-runs.txt` lists the two new phases, and the median stays under 10 s.
- First probe on the real bench: one driver-app message to the test bot's 1-on-1 chat produces a receive event and a Router reply. Save the message list as JSON.
- `node test/tester/cli.ts preflight` on the real bench: the coverage matrix lists all eight vendors on both computers. Save the output.
- `node test/tester/cli.ts run --cadence nightly` on the real bench, with output and `runs/<runId>/summary.md` saved as files and attached to the PR.
- Fault check: stop the Tokyo test instance and run `feishu.group-round-trip`; it must come out `env_unavailable` or `product_fail` with the hub's offline notice as evidence, never `pass`. Then rename one vendor's CLI on the bench; preflight must show it `not_installed` with the install command as the fix, and the summary status must be `bench`.
- Guard check: point a copy of `bench.json` at the production data directory and the production bot; `run` must exit 2 with ProductionGuardError before any instance is touched.

### 9. Design details

#### The bench

| Part | Local (this Mac) | Remote (Tokyo) |
| --- | --- | --- |
| Runs as | a child process of the tester, only during a run | systemd user service of a separate Linux user, always on |
| Data directory | `~/.bellwood-tester/local/home` | the test user's own `~/.agent-hub` |
| `HOME` for the daemon and CLIs | `~/.bellwood-tester/local/user-home` | the test user's home |
| UI port, mesh port | 4417, 4421 (loopback UI) | 4417, 4421 (loopback UI, no inbound port opened) |
| Code | a dedicated checkout at `~/.bellwood-tester/src` (or the AI tester's worktree), at the commit under test | `~/src`, deployed by commit through the restricted key |
| Vendor CLIs | all eight, installed into the bench `HOME` with the product's install commands | all eight, installed by `scripts/provision-linux.sh` |
| Role in the test account | second in Hub order, sleeps with the Mac | first in Hub order, holds the test bot's Feishu connection |

Accounts: a GitHub machine account for the mesh, a test Feishu bot created through the product's QR flow, a Feishu driver app authorized once by the owner, and the owner's vendor accounts. A small git repository on each computer is the test project, with one PM per vendor on its cheapest model.

Isolation, enforced in code before any flow runs (`assertNotProduction`, `openBench`, `FeishuDriver.sendAsUser`):

- Production data directories, UI ports (4317, 4318), the mesh port (4320), the production bot app id, and the developer's GitHub login are listed in `bench.json`, which stays on the developer machine and out of the repository. A config that touches any of them is refused.
- Each instance must report the machine account's GitHub login before a flow gets its client.
- The driver posts only into chats the test bot belongs to, because a user token could post into the owner's real groups.
- The Worker sandbox already keeps every Worker, including the AI tester, out of the production data directory.

#### The handbook

`.agents/skills/tester/SKILL.md` is loaded by any vendor. Sections: what the tester is and its hard rules; the bench and how to reach it; the three modes (triage a nightly alert, release candidate pass, PR check), each with exact steps; how to judge a result (the verdict table); the exploratory checklist per area for what a script cannot judge (wording, layout on the phone, latency that feels wrong); the report format; and how to add a flow when a user finds a bug the bench missed. The flow list itself lives only in `test/tester/flows.ts` and prints with `node test/tester/cli.ts list`, so the handbook never drifts from the code.

#### Flows

| Flow | What the user does | Pass rule (summary) | Guards |
| --- | --- | --- | --- |
| `feishu.dm-router` | DMs the bot | Router replies within 90 s, final card, nothing recalled | |
| `feishu.group-round-trip` | Posts in a group owned by the second computer | No offline notice, reply within 30 s, exact text, nothing recalled | #409, #415 |
| `feishu.failed-turn-card` | Triggers a failing turn | Reason shown within 30 s, nothing recalled | #411 |
| `feishu.offline-inbox-replay` | Posts to a sleeping computer | One offline notice, reply within 60 s of wake, answered once | #411 |
| `feishu.reconnect-catch-up` | DMs during a hub restart | Answered once within 120 s | |
| `feishu.hub-failover` | Hub stops, second computer takes over | Lease moves within 60 s, DM answered, lease returns | |
| `feishu.desktop-answer-syncs-card` | Answers a question in the workbench | Feishu card updates in place within 15 s | |
| `feishu.tap-card-on-phone` | Taps a card option on the phone (manual) | Workbench settles within 5 s | |
| `feishu.stop-on-phone` | Taps Stop on the phone (manual) | Stops within 3 s | |
| `mesh.cold-dial` | Opens the other computer after idle | 9 of 10 dials succeed, p90 under 6 s | #409, #415 |
| `mesh.router-sees-online` | Starts the second computer | Online within 15 s, no flap in 120 s | #409, #415 |
| `mesh.cross-device-chat` | Chats with a PM on the other computer | Reply within 120 s over the live stream | |
| `model.provider-status` (each computer) | Opens Settings | Every vendor listed with its real state | |
| `model.turn.<vendor>` (8 vendors × 2 computers) | Sends a PM a message | Reply within 120 s, no leftover process | |
| `model.worker-round-trip` | Asks a PM for a one-line change | Worker commits and reports within 10 min | |
| `lifecycle.restart-keeps-data` | Restarts on months-old data | Conversations and trust kept | |
| `lifecycle.upgrade-from-release` | Upgrades from the last release | Backup written, data opens | |

Every flow saves evidence: Feishu message lists as JSON (including deleted ones), daemon log tails, dial timings, and state snapshots.

#### Vendor coverage

Every run probes all eight vendors on both computers without spending tokens: the CLI resolves from the bench `HOME` (ignoring the developer's own tool directories), prints a version, the daemon reports it available, and the vendor's status command shows an account. The result is one of `ready`, `not_installed`, `install_failed`, `signed_out`, `login_blocked`, or `unknown`, each with the fix command.

| Vendor | Install (from the product) | Sign in on the bench | Turn model |
| --- | --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN` | haiku |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | run `agy` and paste the code, or `GEMINI_API_KEY` | gemini-3.8-flash |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex login --device-auth` with `CODEX_HOME` in the bench `HOME` | account default |
| Pi | `curl -fsSL https://pi.dev/install.sh \| sh` | run `pi`, then `/login` | deepseek/deepseek-flash |
| DeepSeek | `npm install -g @deepseek-ai/dsh@0.2.2-rc.1` (npm prefix in the bench `HOME`) | `DEEPSEEK_API_KEY` in `<bench HOME>/.dsh/.env` | deepseek-flash |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | `NO_OPEN_BROWSER=1 cursor-agent login` | gemini-3.8-flash |
| OpenCode | `curl -fsSL https://opencode.ai/v2/install \| bash` | `opencode auth login`, or `OPENCODE_API_KEY` | opencode/big-pickle |
| Kimi Code | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | `kimi login` (device code) | kimi-code/k3 |

Rules:

- A vendor that is not ready gives `not_ready` for its flows on that computer, with the status and fix in the reason. It is never dropped from a run or a summary.
- Each open gap raises a `coverage` alert on every run. The owner can accept a gap in `bench.json` with a reason (for example, no account yet). An accepted gap stays in the coverage matrix of every summary but stops alerting.
- A failed install is retried by `node test/tester/cli.ts vendors install` and saves the command's exit code and last 20 stderr lines.
- If a vendor's macOS login cannot live in the bench `HOME` (for example, a credential kept only in the login keychain), it is `login_blocked`. The owner then decides between accepting the gap on the Mac and letting that one vendor use the developer's own login.
- `model.provider-status` fails when the daemon's reported state differs from the probe, which catches a vendor that is installed but missing from the workbench.

#### Two layers

| | Script layer | AI tester |
| --- | --- | --- |
| Who | `node test/tester/cli.ts`, no model | a Bellwood Worker on any vendor with the tester skill |
| When | every night at 23:30 on the Mac; in PR and RC runs | after a nightly alert; before accepting a release candidate; after review on PRs that touch Feishu, the mesh, relay, or vendor drivers |
| Does | preflight, flows, verdicts, history, summary | reproduces failures, separates product defects from bench trouble, runs the exploratory checklist, writes the report with evidence, proposes a new flow for each confirmed escape |
| Never | retries a failed product check to make it pass | fixes product code in the same step, or touches production data, bots, or accounts |

The Project Manager's 00:00 review reads `~/.bellwood-tester/runs/latest/summary.md`. A product alert dispatches an AI tester triage step; a bench or coverage alert becomes a card for the owner. For a PR, the Project Manager adds a tester step after review: the step deploys the PR head to both computers, runs `run --cadence pr --changed <files>`, then explores the changed area. For a release candidate, the step runs `run --cadence rc` plus the manual items, which it hands to the owner as a short phone checklist.

#### Keeping false alarms down

- Preflight runs first. An unreachable computer, a Feishu or relay outage, an expired driver token, or a vendor's quota gives `env_unavailable` or `quota`, never a product failure.
- Flows over the real network alert on rate: fewer than 6 passes in the last 7. Other flows alert after two product failures in a row. PR and RC runs alert on any product failure, because someone is waiting on the answer.
- No retries inside a product check.
- Three nights of `env_unavailable` in a row raise a bench alert, so a rotting bench is noticed.
- Each confirmed bench failure also fixes the matching fake in the unit suite, so the regression is caught before the bench next time.

#### `pnpm verify` additions

1. Message round trip: open the default PM, type a message, send it, and wait until the fake claude's reply renders and the message is stored as replied.
2. Restart: stop the daemon, start a second one on the same data directory, and check that the conversation and both messages are unchanged.

Feishu, the relay, real vendor CLIs, and a second computer stay out of verify; they belong to the bench.

#### Cost

| Item | Monthly |
| --- | --- |
| Servers | 0: Tokyo and the Mac exist. If Tokyo lacks about 1 GB of free memory for the test user, a larger plan costs about 5 USD. |
| Relay, Feishu, GitHub | 0: free tiers and free accounts |
| Script layer vendor turns | 16 turns a night on the cheapest models: inside existing subscriptions, plus cents for DeepSeek and Pi keys |
| AI tester sessions | about 4 to 6 a month (RC and triage): inside existing subscriptions; 2 to 10 USD each if paid by API instead |

One-time owner time is about 40 to 50 minutes, more than the 30 minutes first estimated, because sixteen vendor sign-ins (eight vendors on two computers) take 15 to 20 minutes of it. Each later year needs one Feishu consent and renewed vendor tokens.

#### What the bench cannot do

- Tapping card buttons or Stop in the Feishu client: no API, so these are manual items in the RC checklist (about 2 minutes on the phone).
- How cards look on the phone: a manual glance during the RC pass.
- Windows: no resident machine; the Windows CI job and manual candidate acceptance stay.
- The macOS app shell: the bench runs the daemon from source; the shell stays in manual candidate acceptance.
- Team mode and guest permissions: need a second Feishu account (decision 3B).
- Vendors without an account: listed as gaps in every summary until an account exists or the owner accepts the gap.
