# Bench setup

One-time setup of the test bench. **[Owner]** steps need the owner's hands or accounts. **[PM]** steps are for the Project Manager, after the owner approves them. Nothing here touches the owner's real data directories, real Feishu bot, or own GitHub account in the mesh.

Owner time is about 34 minutes in total: 5 for accounts, 7 for Mesh, 15 for Feishu, 5 for vendor sign-ins, and 2 for the permission rule.

## 1. Accounts

1. **[Owner]** Create a GitHub machine account for the bench (about 5 minutes). It needs no repository access; the repository is public.
2. Vendor accounts are decided (design decision 4): Use existing subscriptions. Sign in to Claude Code, Codex, and Antigravity on the Mac, and Claude Code in Tokyo. See `VENDOR_BENCH` in `test/tester/vendors.ts` for the coverage decision by computer.

## 2. Remote test computer (the server)

1. **[PM]** On the server, with the owner's approval: create a Linux user `bellwood-test` without sudo, and enable lingering for it so its user service survives logout.
2. **[PM]** Provision it with `scripts/provision-linux.sh --user bellwood-test --port 4417 --mesh-port 4421 --service bellwood-tester bellwood-test@<server>` (or run as `ubuntu@<server>` with `--user bellwood-test`). This installs the code into `~/agent-hub`, all eight vendor CLIs from their product install commands, `~/bin/tester-remote`, and a loopback-only systemd user service. It opens no port.
3. **[PM]** Install the restricted key: generate a dedicated key on the Mac, and add it to `~bellwood-test/.ssh/authorized_keys` as
   `command="/home/bellwood-test/bin/tester-remote",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <key>`.
   `tester-remote` is `test/tester/remote-command.sh`. It accepts only `status`, `start`, `stop`, `restart`, `deploy <40-hex commit>`, and `logs <n>`. Use `status presence` to read online state and `status router-chats` to read the test bot's Router chat IDs from the Tokyo test instance.
4. **[PM]** Add a `Host bellwood-tester` entry for that key to the Mac's `~/.ssh/config`, and check `ssh bellwood-tester status`.
5. **[PM]** Check the server has about 1 GB of free memory and 5 GB of free disk for the test user (`free -m`, `df -h`). Report if it does not.

## 3. Local test computer (this Mac)

1. **[PM]** Create `~/.bellwood-tester/` with `local/home`, `local/user-home`, `secrets/` (mode 0700), and `runs/`, and clone the public repository into `~/.bellwood-tester/src`.
2. **[PM]** Create the sandbox project: a small git repository under `~/.bellwood-tester/projects/sandbox` on each computer.
3. **[PM]** Write `~/.bellwood-tester/bench.json` (shape: `BenchConfig` in `test/tester/bench.ts`). Under `guards`, list the owner's real data directories, ports 4317, 4318, and 4320, the real Feishu bot's app id, and the owner's own GitHub login. This file never goes into the repository.
4. **[PM]** Install the vendor CLIs into the bench `HOME`: `node test/tester/cli.ts vendors install`. It uses each vendor's product install command with `HOME` and the npm prefix inside `local/user-home`, so nothing lands in the owner's own tool directories.

Start the Mac test daemon from a host terminal or the nightly LaunchAgent. A Bellwood Worker sandbox blocks the daemon from applying its own macOS sandbox. The tester checks this before starting a daemon; read-only preflight can still reuse a daemon that is already running.

## 4. Mesh

1. **[Owner]** Sign both test computers in to the machine account: start the local test instance (`node test/tester/cli.ts bench up`) and open its workbench, then Settings, Computers, Sign in; do the same on the remote through the local workbench once it is paired, or with `AGENT_HUB_HOME` set for the test user on the server. Each sign-in is a GitHub device code (about 2 minutes each).
2. **[Owner]** Verify the two test computers with the six-digit code on both screens (about 2 minutes).
3. **[Owner]** Set Hub order: the remote first, the Mac second (about 1 minute).

## 5. Feishu

1. **[Owner]** Create the test bot in the terminal (`Settings` in the web workbench has no Feishu tab). Start the local test daemon in one terminal (`node "$HOME/.bellwood-tester/src/test/tester/cli.ts" bench up`), then run in another terminal (use `$HOME` instead of `=` followed by `~`, which zsh does not expand):
   `AGENT_HUB_HOME="$HOME/.bellwood-tester/local/home" node "$HOME/.bellwood-tester/src/src/feishu/main.ts" connect`
   Scan the QR code printed in the terminal and name it so it cannot be mistaken for the real bot.
2. **[Owner]** Send the test bot one direct message, so it binds you as owner (about 1 minute).
3. **[Owner]** Set up the driver app in the Feishu developer console (about 10 minutes): either create a separate custom app or reuse the test bot app above, with user-identity scopes `im:message`, `im:message.send_as_user`, and `offline_access`, and redirect URL `http://127.0.0.1:47123/callback` under Security settings; then create and publish a version. If the tenant asks for admin approval, approve it.
4. **[PM]** Put the driver app's id and secret in `~/.bellwood-tester/secrets/feishu-driver.json` (mode 0600).
5. **[Owner]** Run `node "$HOME/.bellwood-tester/src/test/tester/cli.ts" authorize-feishu` in your own terminal, outside any agent sandbox, and approve in the browser (1 minute). The nightly run refreshes the access token automatically and saves the new refresh token's expiration time. Preflight prints the expiration time and the authorization command when that token has less than two days left.
6. **[Owner]** Mute the test bot's chats and project groups in Feishu (about 1 minute).

## 6. Vendor sign-ins

Use the bench `HOME` for each sign-in. On the Mac, prefix the command with `HOME="$HOME/.bellwood-tester/local/user-home"`. On the server, run the command as `bellwood-test`.

| Vendor | Sign in | Time |
| --- | --- | --- |
| Claude Code | **[Owner]** Run `claude setup-token`. **[PM]** Connect the bench token as described below. | 2 min |
| Codex | **[Owner]** `codex login --device-auth` on the Mac only | 1.5 min |
| Antigravity | **[Owner]** run `agy` and paste the code on the Mac only | 1.5 min |

To connect the Claude Code token on the Mac:

1. Save the bench token to `secrets/claude-oauth-token` under the bench root with mode 0600.
2. In `bench.json`, add this entry to the local instance's `env`:

   ```json
   "CLAUDE_CODE_OAUTH_TOKEN": "@secrets/claude-oauth-token"
   ```

3. If the local bench daemon is running, restart it so it reads the new environment.

On the server, set `CLAUDE_CODE_OAUTH_TOKEN` in the test daemon's service environment and restart that daemon.

The remaining vendor and computer pairs require no sign-in. Install every CLI as described in sections 2 and 3. The summary lists the skipped turns as accepted gaps.

Then run `node test/tester/cli.ts preflight`. Confirm all four pairs from the table are `ready`. The matrix lists all eight vendors on both computers, including skipped turns. A missing CLI or broken probe still raises an alert.

## 7. Permissions and schedule

1. **[Owner]** Per design decision 5, allow `Bash(node test/tester/cli.ts:*)` in Claude Code's permission settings, so AI tester sessions can run flows that restart the remote test computer (about 2 minutes).
2. **[PM]** Install the nightly job: copy `test/tester/com.bellwood.tester.nightly.plist` to `~/Library/LaunchAgents/com.bellwood.tester.nightly.plist` with the placeholders replaced, running `node test/tester/cli.ts run --cadence nightly` at 23:30. launchd runs it at the next wake if the Mac was asleep. Stop any manual `bench up` before a run so the tester can restart the local instance itself. Read-only preflight can use a running instance.
3. **[PM]** Read `~/.bellwood-tester/runs/latest/summary.md` in the 00:00 review. Dispatch a tester for a product alert. Raise a card for the owner for a bench or coverage alert, or a Feishu expiry warning.

## 8. Upkeep

- Feishu driver consent: repeat step 5.5 when preflight warns that the refresh token is expiring or reports that it has expired.
- Vendor tokens: renew when preflight reports `signed_out`; `claude setup-token` tokens last a year.
- Accepted gaps: review them at each release candidate. Changing one means editing `VENDOR_BENCH` in `test/tester/vendors.ts` through a PR.
