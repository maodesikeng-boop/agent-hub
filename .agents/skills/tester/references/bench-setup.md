# Bench setup

One-time setup of the test bench. **[Owner]** steps need the owner's hands or accounts. **[PM]** steps are for the Project Manager, after the owner approves them. Nothing here touches the owner's real data directories, real Feishu bot, or own GitHub account in the mesh.

Commands marked "implementation step" land with the tester implementation; this runbook names them so the steps can be reviewed now.

## 1. Accounts

1. **[Owner]** Create a GitHub machine account for the bench (about 5 minutes). It needs no repository access; the repository is public.
2. **[Owner]** Decide which vendor accounts the bench uses (design decision 4). For a vendor without an account, write the reason under `acceptedGaps` in `bench.json` (step 3.3). The vendor still shows in every summary.

## 2. Remote test computer (the server)

1. **[PM]** On the server, with the owner's approval: create a Linux user `bellwood-test` without sudo, and enable lingering for it so its user service survives logout.
2. **[PM]** Provision it with `scripts/provision-linux.sh --user bellwood-test --port 4417 --mesh-port 4421 --service bellwood-tester` (implementation step). This installs Node, the code, all eight vendor CLIs from their product install commands, and a loopback-only systemd user service. It opens no port.
3. **[PM]** Install the restricted key: generate a dedicated key on the Mac, and add it to `~bellwood-test/.ssh/authorized_keys` as
   `command="/home/bellwood-test/bin/tester-remote",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <key>`.
   `tester-remote` is `test/tester/remote-command.sh` (implementation step). It accepts only `status`, `start`, `stop`, `restart`, `deploy <40-hex commit>`, and `logs <n>`.
4. **[PM]** Add a `Host bellwood-tester` entry for that key to the Mac's `~/.ssh/config`, and check `ssh bellwood-tester status`.
5. **[PM]** Check the server has about 1 GB of free memory and 5 GB of free disk for the test user (`free -m`, `df -h`). Report if it does not.

## 3. Local test computer (this Mac)

1. **[PM]** Create `~/.bellwood-tester/` with `local/home`, `local/user-home`, `secrets/` (mode 0700), and `runs/`, and clone the public repository into `~/.bellwood-tester/src`.
2. **[PM]** Create the sandbox project: a small git repository under `~/.bellwood-tester/projects/sandbox` on each computer.
3. **[PM]** Write `~/.bellwood-tester/bench.json` (shape: `BenchConfig` in `test/tester/bench.ts`). Under `guards`, list the owner's real data directories, ports 4317, 4318, and 4320, the real Feishu bot's app id, and the owner's own GitHub login. This file never goes into the repository.
4. **[PM]** Install the vendor CLIs into the bench `HOME`: `node test/tester/cli.ts vendors install`. It uses each vendor's product install command with `HOME` and the npm prefix inside `local/user-home`, so nothing lands in the owner's own tool directories.

## 4. Mesh

1. **[Owner]** Sign both test computers in to the machine account: start the local test instance (`node test/tester/cli.ts bench up`, implementation step) and open its workbench, then Settings, Computers, Sign in; do the same on the remote through the local workbench once it is paired, or with `AGENT_HUB_HOME` set for the test user on the server. Each sign-in is a GitHub device code (about 2 minutes each).
2. **[Owner]** Verify the two test computers with the six-digit code on both screens.
3. **[Owner]** Set Hub order: the remote first, the Mac second.

## 5. Feishu

1. **[Owner]** Create the test bot from the local test workbench: Settings, Feishu, scan the QR code (about 2 minutes). Name it so it cannot be mistaken for the real bot.
2. **[Owner]** Send the test bot one direct message, so it binds you as owner.
3. **[Owner]** Create the driver app in the Feishu developer console (about 10 minutes): a custom app with user-identity scopes `im:message`, `im:message.send_as_user`, and `offline_access`; the redirect URL `http://127.0.0.1:47123/callback` under Security settings; then create and publish a version. If the tenant asks for admin approval, approve it.
4. **[PM]** Put the driver app's id and secret in `~/.bellwood-tester/secrets/feishu-driver.json` (mode 0600).
5. **[Owner]** Run `node test/tester/cli.ts authorize-feishu` in your own terminal, outside any agent sandbox, and approve in the browser (1 minute). Repeat once a year: Feishu ends the consent after 365 days, and the tester reports it as a bench alert.
6. **[Owner]** Mute the test bot's chats and project groups in Feishu.

## 6. Vendor sign-ins

Sign in each vendor on each test computer with the bench `HOME`, so the owner's own CLI logins stay untouched. On the Mac, prefix each command with `HOME=~/.bellwood-tester/local/user-home`; on the server, run it as `bellwood-test`.

| Vendor | Sign in |
| --- | --- |
| Claude Code | `claude setup-token` once, and save the token in `secrets/claude-oauth-token`; both computers use it as `CLAUDE_CODE_OAUTH_TOKEN` |
| Antigravity | run `agy` and paste the code, or save `GEMINI_API_KEY` in `secrets/` |
| Codex | `codex login --device-auth` |
| Pi | run `pi`, then `/login` |
| DeepSeek | write `DEEPSEEK_API_KEY=<key>` to `<bench HOME>/.dsh/.env` |
| Cursor | `NO_OPEN_BROWSER=1 cursor-agent login` |
| OpenCode | `opencode auth login`, or save `OPENCODE_API_KEY` in `secrets/` |
| Kimi Code | `kimi login` |

Then run `node test/tester/cli.ts preflight`. Its coverage matrix lists all eight vendors on both computers. Each entry that is not `ready` carries its fix; either do it or accept the gap in `bench.json` with a reason.

## 7. Permissions and schedule

1. **[Owner]** If design decision 5 is A: allow `Bash(node test/tester/cli.ts:*)` in Claude Code's permission settings, so AI tester sessions can run flows that restart the remote test computer.
2. **[PM]** Install the nightly job: `~/Library/LaunchAgents/com.bellwood.tester.nightly.plist` from the template (implementation step), running `node test/tester/cli.ts run --cadence nightly` at 23:30. launchd runs it at the next wake if the Mac was asleep.
3. **[PM]** Add to the 00:00 review: read `~/.bellwood-tester/runs/latest/summary.md`; dispatch a tester triage step for a product alert; raise a card for the owner for a bench or coverage alert.

## 8. Upkeep

- Feishu driver consent: once a year (step 5.5).
- Vendor tokens: renew when preflight reports `signed_out`; `claude setup-token` tokens last a year.
- Accepted gaps: review them at each release candidate.
