# Running Bellwood on Linux

Guide for deploying the Bellwood daemon on Ubuntu 22.04 or 24.04+ as a non-root user.

## Key runtime rules

- **Loopback-only HTTP listener**: `src/daemon/ui-server/server.ts` binds strictly to `127.0.0.1` (`4317` by default) and validates `Host` and `Origin` headers against DNS rebinding. Never expose this port on `0.0.0.0` or a public firewall; reach a Linux server through [Account mesh](account-mesh-design.md), [Feishu](feishu-design.md), or `ssh -L`.
- **Headless capabilities**: `/api/state` reports server capabilities so the web UI hides desktop-only OS pickers (`Choose...` and `Show in Finder`); enter absolute folder paths directly and download files from the browser or Feishu.
- **Mandatory `bubblewrap` Worker sandbox**: Linux enforces Worker write and `dataDir` read boundaries with `bubblewrap` (`bwrap`). Run `sudo scripts/linux-sandbox-setup.sh` once during setup; if `osSandboxAvailable()` fails, the daemon refuses to start Workers rather than running unsandboxed ([Linux sandbox design](linux-sandbox-design.md)).

## 1. Install Node.js, pnpm, and sandbox prerequisites

Bellwood requires **Node.js >= 24.12** (`node:sqlite` and native TypeScript execution), **pnpm 10**, `git`, and `procps` (`ps`):

```sh
sudo apt-get update && sudo apt-get install -y git procps
# Install Node.js 24 LTS from https://nodejs.org/en/download into /usr/local or ~/.local, then enable pnpm:
corepack enable pnpm

git clone https://github.com/maodesikeng-boop/agent-hub.git ~/agent-hub
cd ~/agent-hub
pnpm install --frozen-lockfile
pnpm build
sudo scripts/linux-sandbox-setup.sh
```

`sudo scripts/linux-sandbox-setup.sh` installs `bubblewrap` and `socat`, loads `/etc/apparmor.d/bwrap` so unprivileged user namespaces work under Ubuntu 24.04's AppArmor policy, and prints `bwrap-ok`.

## 2. Install and sign in to agent CLIs

You can install and authenticate any supported CLI from **Settings → Providers** in the web UI (including headless device-code and loopback callback paste flows), or run `scripts/provision-linux.sh` or manual commands as the daemon's OS user:

| Vendor | Install on Linux | Headless sign-in |
| --- | --- | --- |
| Claude Code (`claude`) | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| Codex (`codex`) | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex login --device-auth` |
| Antigravity (`agy`) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | Run `agy` (paste auth code) or set `GEMINI_API_KEY` |
| Pi (`pi`) | `curl -fsSL https://pi.dev/install.sh \| sh` | Run `pi`, then `/login` |
| DeepSeek Harness (`dsh`) | `npm install -g @deepseek-ai/dsh@0.2.2-rc.1` | Write `DEEPSEEK_API_KEY=<key>` to `~/.dsh/.env` |
| Cursor (`cursor-agent`) | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| OpenCode (`opencode`) | `curl -fsSL https://opencode.ai/v2/install \| bash` | `opencode auth login`, or set `OPENCODE_API_KEY` |
| Kimi Code (`kimi`) | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | `kimi login` (device code) |

When resolving CLI binaries on Linux (`src/shared/paths.ts` `linuxInstallDirs`), the daemon checks `AGENT_HUB_<VENDOR>`, then `PATH`, then `~/.local/bin`, `~/.npm-global/bin`, `/usr/local/bin`, and `/home/linuxbrew/.linuxbrew/bin`.

## 3. Run as a `systemd --user` service

Create `~/.config/systemd/user/agent-hub.service`:

```ini
[Unit]
Description=Bellwood daemon (agent-hub)

[Service]
WorkingDirectory=%h/agent-hub
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node src/daemon/main.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=40

[Install]
WantedBy=default.target
```

Enable the service and keep it running after SSH logout:

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-hub
loginctl enable-linger "$USER"
journalctl --user -u agent-hub -f
```

Keep `AGENT_HUB_HOME` (`~/.agent-hub` by default) short enough that `<AGENT_HUB_HOME>/run/hub.sock` stays under the `103`-byte Unix domain socket path limit. If you run more than one Bellwood instance on the same Linux host, set `AGENT_HUB_PORT` (`4317` by default) and `FUSA_MESH_PORT` (`4320` by default; `0` asks the OS for a free port) in the unit file so the two instances do not collide. When running under `systemd` (`INVOCATION_ID` set), `hub self-reload [--build]` drains active turns (up to `SELF_RELOAD_DRAIN_MAX_MS`) and exits with code `75` (`apps/desktop/contract.json`) so `Restart=on-failure` launches the updated daemon cleanly.

## 4. Connect from your laptop or phone

- **Account mesh (recommended)**: Run `node src/mesh/main.ts login` on the server, sign in to the same GitHub account on your Mac or Windows desktop, and confirm the six-digit verification code.
- **Feishu**: Run `node src/feishu/main.ts connect` and scan the QR code in Feishu on your phone.
- **Direct SSH port forward (standalone web access)**:
  ```sh
  ssh -N -L 4317:127.0.0.1:4317 <user>@<server>
  ```
  Use the **same local port** (`4317`) as `AGENT_HUB_PORT` on the server so `Host` and `Origin` port validation succeeds, then open the login link from `journalctl --user -u agent-hub` (token stored in `~/.agent-hub/state/ui-token`).

## 5. Platform differences summary

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Desktop shell | Native Swift (`Bellwood.app`) | Native Rust + Tauri 2 (`fusa-desktop.exe`) | Headless daemon + browser, mesh, or Feishu |
| Worker OS sandbox | `sandbox-exec` (`seatbelt`) | `fusa-run.exe` Job Object + restricted token + NTFS ACLs + Win11 24H2+ MXC | `bubblewrap` (`bwrap`) + `/etc/apparmor.d/bwrap` |
| Agent IPC | `run/hub.sock` (`<= 103` bytes) | Named pipe (`\\.\pipe\...`) | `run/hub.sock` (`<= 103` bytes) |
| Folder picker & reveal | `NSOpenPanel` / `osascript` / `open` | `tauri-plugin-dialog` / `explorer.exe` | Hidden in UI; enter absolute path and download files |
| Sleep inhibition | `/usr/bin/caffeinate -i -w <pid>` | `SetThreadExecutionState` | None (always-on server) |
