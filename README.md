# Agent Hub

**English** | [中文](#中文)

Agent Hub is a self-hosted web app that lets you run a small team of AI coding agents on your own machine: a **project manager** agent per project talks to you, splits the work, and dispatches tasks to **worker** agents, each working in its own git worktree. Every role can use a different vendor's official command-line agent under your own account.

![Agent Hub home screen](docs/screenshots/readme-home.png)

It is built for **one person across multiple devices** (your Mac, a Linux server, your phone)—not a multi-user shared server.

## Features

- **Project managers & workers:** each role independently selects its vendor, model, and thinking effort level.
- **Currently supported agent CLIs:** Claude Code (`claude`), Antigravity (`agy`), and Codex (`codex`) (list defined in [`src/shared/vendors.ts`](src/shared/vendors.ts) as `AGENT_VENDORS`).
- **Isolated git worktrees:** each worker runs in its own git worktree (`~/.agent-hub/worktrees/<project>/<worker>`); read-only workers are available for code review and investigation.
- **Rich web UI:** works on desktop and mobile, installable as a PWA with optional Web Push notifications, Markdown rendering, syntax highlighting, Mermaid and Vega-Lite charts, and file uploads.
- **Quota tracking:** displays usage quota windows for the supported vendors.
- **Optional macOS desktop shell & multi-device view:** manage agents across your Mac and Linux machines from a single web page (see below).

## Requirements

- **Node.js >= 24.12** (runs `.ts` natively and uses the built-in `node:sqlite`; see `package.json` `engines`) and **pnpm** (`pnpm@10.x`). `git` is required for worktrees.
- At least one supported agent CLI **installed and logged in in your terminal** (the UI shows the login command if signed out):
  - Claude Code: `claude auth login`
  - Antigravity: `agy`
  - Codex: `codex login`
- macOS or Linux (Ubuntu; see [docs/linux.md](docs/linux.md)). Windows is not covered.

## Install and run

```bash
git clone https://github.com/maodesikeng-boop/agent-hub.git
cd agent-hub
pnpm install
pnpm build
pnpm start
```

- `pnpm build` builds the frontend web assets into `dist/web`.
- `pnpm start` runs `prestart` (`vite build`) and starts the daemon (`node src/daemon/main.ts`).
- On startup, the daemon prints a login link such as `http://127.0.0.1:4317/auth?token=…`. Open it once in your browser to set a session cookie. The link contains your local master token—do not share it. The first start automatically creates a default project manager.
- Stop the daemon with `Ctrl+C`.

To use a custom port or data directory:

```bash
AGENT_HUB_PORT=4400 AGENT_HUB_HOME=~/my-hub pnpm start
```

## macOS app

```bash
pnpm app:mac                              # builds build/Agent Hub.app
bash scripts/build-mac-app.sh --install   # builds and copies to /Applications/Agent Hub.app
```

The macOS app (`apps/macos/`) is a lightweight native WebKit shell that supervises the local daemon. Building requires Xcode Command Line Tools (`swiftc`) and built web assets (`pnpm build`, or pass `--build-web` to `scripts/build-mac-app.sh`).

**You must compile the app yourself for your own machine:** `scripts/build-mac-app.sh` writes your repository's absolute path (`AgentHubRepoDir`) and your Node.js binary path (`AgentHubNodePath`) directly into `Contents/Info.plist`, and signs the bundle ad-hoc (`codesign -s -`). **If you move the repository or change your Node installation path, you must recompile** (or override them at runtime via `AGENT_HUB_REPO_DIR` and `AGENT_HUB_NODE`). Do not distribute the compiled `.app` bundle.

## Multiple devices

Each machine runs its own daemon, and a single web page can view and operate all of them. Devices connect through a central Linux server over SSH tunnels (or optionally Tailscale); a phone can reach the central server over HTTPS (for example via Tailscale Funnel) and sign in by scanning a one-time QR code and approving the new browser session on an already signed-in device.

Multi-device and public access are completely optional: by default the daemon listens only on `127.0.0.1`, and nothing is exposed externally unless you explicitly configure SSH tunnels, run `tailscale serve`, or enable the public entry in settings. For architecture and setup details, see:
- [docs/multi-device-design.md](docs/multi-device-design.md)
- [docs/hub-tunnel-design.md](docs/hub-tunnel-design.md)
- [docs/linux.md](docs/linux.md)

## Configuration

All environment variables are optional.

| Variable | Default | Description |
|---|---|---|
| `AGENT_HUB_HOME` | `~/.agent-hub` | Data directory (SQLite database, tokens, worktrees, uploads, logs). Keep the path short: Unix sockets inside `run/` must fit within 103 bytes (`MAX_UNIX_SOCKET_PATH_BYTES`). |
| `AGENT_HUB_PORT` | `4317` | Web UI port (listens on `127.0.0.1` only). Set to `0` to let the OS pick a free port. |
| `AGENT_HUB_CLAUDE` | `claude` | Command name or path to the Claude Code CLI (`~/` is expanded; searched in `PATH` and standard fallback directories). |
| `AGENT_HUB_AGY` | `agy` | Command name or path to the Antigravity CLI (`~/` is expanded; searched in `PATH` and standard fallback directories). |
| `AGENT_HUB_CODEX` | `codex` | Command name or path to the Codex CLI (`~/` is expanded; searched in `PATH`, `ChatGPT.app` on macOS, and standard fallback directories). |
| `AGENT_HUB_DEFAULT_MODEL` | unset | Model ID for the default project manager created on first start; when unset, uses the vendor CLI's own default. |
| `AGENT_HUB_TAILSCALE` | `/Applications/Tailscale.app/Contents/MacOS/Tailscale` on macOS (if present), else `tailscale` | Path or command name for the `tailscale` CLI. |
| `AGENT_HUB_TAILNET_NAME` | detected via `tailscale status --json` | Override the machine's tailnet DNS name (`<machine>.<tailnet>.ts.net`). |
| `AGENT_HUB_TAILNET_OWNER` | detected via `tailscale status --json` | Override the device owner's Tailscale login name (required on tagged Tailscale devices, where `tailscale status` has no owner). |
| `AGENT_HUB_SERVE_TARGET` | `unix` on Linux, `tcp` on macOS | How `tailscale serve` forwards to the daemon (`unix` for `run/ui.sock`, or `tcp` for `127.0.0.1:<port>`). |
| `AGENT_HUB_REPO_DIR` | `AgentHubRepoDir` in `Info.plist` | macOS app only: override the repository directory path at runtime. |
| `AGENT_HUB_NODE` | `AgentHubNodePath` in `Info.plist` | macOS app only: override the Node.js executable path at runtime. |
| `AGENT_HUB_DAEMON_PORT` | unset | Development only (`pnpm dev`): daemon port that Vite proxies `/api`, `/auth`, and `/d` requests to. |
| `CODEX_HOME`, `CLAUDE_CONFIG_DIR` | `~/.codex`, `~/.claude` | Vendor CLI configuration directories read by the daemon for auth status, model catalog cache fingerprints, and session transcripts. |

*(Note: when a project's worktree setup command runs via `hub project setup`, the daemon also provides `AGENT_HUB_ROOT_PATH` and `AGENT_HUB_WORKTREE_PATH` to the setup script.)*

## Vendor terms & account risks

Agent Hub does not call model provider APIs directly. Instead, it launches each vendor's **official command-line agent** on your machine, under **your own account**, in non-interactive/headless mode, and drives it automatically. Whether using an external orchestrator to drive the official CLI is permitted under your subscription or terms of service is for you to review and decide; this project does not grant permission or guarantee that your account will remain in good standing.

- **Google Antigravity:** Section 6 of the [Google Antigravity Additional Terms](https://antigravity.google/terms/) states:
  > "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."

  Google has not explicitly clarified whether driving the official `agy` CLI in headless mode from a local tool like Agent Hub falls under this prohibition. Treat it as a **risk of account suspension or termination** and decide for yourself.
- **Claude Code:** Review and comply with Anthropic's terms and compliance docs: <https://code.claude.com/docs/en/legal-and-compliance>.
- **Codex:** Review and comply with OpenAI's terms of use: <https://openai.com/policies/row-terms-of-use/>.

Vendor terms change over time; always check the latest official documents yourself.

## Security notes

Workers edit files and execute shell commands on your machine with your OS user's permissions. Understand the actual boundaries before running agents on important repositories or machines:

- **Worker write scope (`src/shared/write-scope.ts`, `src/daemon/driver/write-scope.ts`):** Inside the Agent Hub data directory (`~/.agent-hub`), a normal worker is only allowed to write to its own git worktree (`worktrees/<project>/<worker>`); `state/` (SQLite database, tokens, personas) and other workers' worktrees are write-protected. This is enforced by wrapping the worker process in an OS sandbox (`sandbox-exec` on macOS; `bubblewrap` / `bwrap` on Linux after running the one-time `sudo scripts/linux-sandbox-setup.sh` setup—see [docs/write-scope.md](docs/write-scope.md)). If the OS sandbox is unavailable, workers refuse to start. **Outside the data directory (`~/.agent-hub`), there are no write restrictions:** a worker can modify your project folder and any other user-writable files, run arbitrary commands, and access the network just like any program you run.
- **Read-only workers (`src/shared/readonly-policy.ts`):** Read-only workers can read files and run commands, and can only call read-only MCP connector tools (`readOnlyHint: true`). Sensitive paths are blocked from reading (`state/ui-token`, vendor credential files, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, etc., plus globs like `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, `**/id_ed25519*`), and writes are blocked everywhere except a per-session private temporary directory (and required runtime/cache directories). Claude Code and Codex use their native read-only sandboxes; Antigravity is wrapped in the outer read-only OS sandbox. See [docs/readonly-worker-design.md](docs/readonly-worker-design.md).
- **Project managers are not sandboxed.**
- Do not expose the local daemon port (`4317`) to untrusted networks. To report a security vulnerability privately, see [SECURITY.md](SECURITY.md).

## Third-party assets and licenses

- The 16 fruit avatar images in `src/web/assets/avatars/` are AI-generated.
- Third-party npm dependencies are distributed under their respective licenses (see `pnpm-lock.yaml`). In particular, `mermaid` pulls in transitive dependencies `elkjs` (licensed under `EPL-2.0 OR GPL-3.0-or-later`) and `khroma` (no `license` field published in the npm package metadata; upstream repository is MIT). Please verify transitive licenses if you redistribute bundled builds.

## License

[MIT](LICENSE)

---

# 中文

[English](#agent-hub) | **中文**

Agent Hub 是一个自托管的个人多 Agent 协作网页应用：在你的电脑或服务器上，每个项目配一个**项目经理（PM）**负责与你沟通、拆分任务，再派给多个 **Worker** 在各自独立的 git worktree 里并行干活。每个角色都可以任选不同厂商的官方命令行 Agent，使用你自己的账号。

它是为**一个人、多台设备**（你自己的 Mac、Linux 服务器、手机）设计的自用工具，不是多人共用的服务端。

## 特性

- **项目经理 + Worker 分工**：每个角色可独立选择厂商、模型与思考程度（effort）。
- **目前支持的 Agent 命令行**（名单以 [`src/shared/vendors.ts`](src/shared/vendors.ts) 的 `AGENT_VENDORS` 为准）：Claude Code（`claude`）、Antigravity（`agy`）、Codex（`codex`）。
- **独立 git worktree**：每个 Worker 在自己的 git worktree 中工作；支持只读 Worker（用于代码审查与问题排查）。
- **网页界面**：适配桌面与手机（可安装为手机主屏幕 PWA，支持可选的 Web Push 锁屏通知），支持 Markdown、代码高亮、Mermaid 与 Vega-Lite 图表、文件上传与预览。
- **额度面板**：显示各支持厂商的用量窗口剩余比例与重置时间。
- **可选的 macOS 原生应用外壳与多设备联机**：一个网页同时查看和操作多台设备（见下）。

## 环境要求

- **Node.js >= 24.12**（原生运行 `.ts` 并使用内置 `node:sqlite`，见 `package.json` 的 `engines`）与 **pnpm**（`pnpm@10.x`）；管理 worktree 需要 `git`。
- 至少在终端里安装并登录一家支持的 Agent 命令行（未登录时界面会提示对应登录命令）：
  - Claude Code：`claude auth login`
  - Antigravity：`agy`
  - Codex：`codex login`
- macOS 或 Linux（Ubuntu 部署说明见 [docs/linux.md](docs/linux.md)）。不包含 Windows 支持。

## 安装和启动

```bash
git clone https://github.com/maodesikeng-boop/agent-hub.git
cd agent-hub
pnpm install
pnpm build
pnpm start
```

- `pnpm build` 构建前端网页到 `dist/web`。
- `pnpm start`（含 `prestart` 自动构建网页）启动守护进程（`node src/daemon/main.ts`）。
- 启动后终端会打印形如 `http://127.0.0.1:4317/auth?token=…` 的登录链接。在浏览器中打开一次即可种下登录 Cookie。链接里包含本机主令牌，请勿分享给他人。首次启动会自动创建一个默认项目经理。
- 按 `Ctrl+C` 停止守护进程。

如需更换端口或数据目录：

```bash
AGENT_HUB_PORT=4400 AGENT_HUB_HOME=~/my-hub pnpm start
```

## Mac 应用

```bash
pnpm app:mac                              # 在 build/Agent Hub.app 生成应用
bash scripts/build-mac-app.sh --install   # 同上，并复制到 /Applications/Agent Hub.app
```

Mac 应用（`apps/macos/`）是包在守护进程外的一层轻量原生外壳，需要 Xcode 命令行工具（`swiftc`）以及构建好的前端网页（先跑 `pnpm build`，或加 `--build-web` 参数）。

**只能自己本机编译、自己用：** `scripts/build-mac-app.sh` 编译时会把当前仓库的绝对路径（`AgentHubRepoDir`）和本机 Node 路径（`AgentHubNodePath`）写进应用包内的 `Contents/Info.plist`，且仅做本机临时签名（`codesign -s -`）。**挪动仓库目录或更换 Node 路径后，必须重新编译**（或者在运行时通过环境变量 `AGENT_HUB_REPO_DIR`、`AGENT_HUB_NODE` 覆盖）。请勿分发编译好的 `.app`。

## 多设备简介

每台设备各跑一个守护进程，在一个网页里即可查看并操作所有设备。各设备可通过中心服务器建立 SSH 隧道连接（也可选用 Tailscale）；手机可通过公网 HTTPS（如 Tailscale Funnel）访问中心服务器，由已登录设备生成一次性二维码、手机扫码后在已登录设备上点击“允许”完成登录批准。

多设备与公网入口均为可选功能：默认守护进程只监听本机 `127.0.0.1`，除非你主动配置隧道、执行 `tailscale serve` 或在设置中开启公网入口，否则不会对外暴露任何端口。详细设计见：
- [docs/multi-device-design.md](docs/multi-device-design.md)
- [docs/hub-tunnel-design.md](docs/hub-tunnel-design.md)
- [docs/linux.md](docs/linux.md)

## 配置（环境变量）

所有环境变量均为可选：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `AGENT_HUB_HOME` | `~/.agent-hub` | 数据目录（数据库、令牌、worktrees、上传文件、日志）。macOS/Linux 上 Unix socket 路径上限为 103 字节（`MAX_UNIX_SOCKET_PATH_BYTES`），请保持路径简短。 |
| `AGENT_HUB_PORT` | `4317` | 网页服务端口，只监听 `127.0.0.1`。设为 `0` 时由系统分配空闲端口。 |
| `AGENT_HUB_CLAUDE` | `claude` | Claude Code CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH` 再找常见安装路径）。 |
| `AGENT_HUB_AGY` | `agy` | Antigravity CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH` 再找常见安装路径）。 |
| `AGENT_HUB_CODEX` | `codex` | Codex CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH`、macOS 上的 `ChatGPT.app` 及常见安装路径）。 |
| `AGENT_HUB_DEFAULT_MODEL` | 未设置 | 首次启动自动创建默认项目经理时使用的模型；未设置时使用厂商 CLI 自身的默认模型。 |
| `AGENT_HUB_TAILSCALE` | macOS 优先用 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，其余用 `tailscale` | `tailscale` 命令路径。 |
| `AGENT_HUB_TAILNET_NAME` | 由 `tailscale status --json` 自动探测 | 手动指定本机 tailnet 域名（`<机器>.<tailnet>.ts.net`）。 |
| `AGENT_HUB_TAILNET_OWNER` | 由 `tailscale status --json` 自动探测 | 手动指定设备主人的 Tailscale 登录名（打了 tag 的设备查不到主人，必须设置此项，否则经 tailnet 访问会回 403）。 |
| `AGENT_HUB_SERVE_TARGET` | Linux 为 `unix`，macOS 为 `tcp` | `tailscale serve` 的转发目标类型（`unix` 转发至 `run/ui.sock`，`tcp` 转发至 `127.0.0.1:<端口>`）。 |
| `AGENT_HUB_REPO_DIR` | 编译进 `Info.plist` 的 `AgentHubRepoDir` | 仅 Mac 应用：运行时覆盖仓库目录路径。 |
| `AGENT_HUB_NODE` | 编译进 `Info.plist` 的 `AgentHubNodePath` | 仅 Mac 应用：运行时覆盖 Node.js 可执行文件路径。 |
| `AGENT_HUB_DAEMON_PORT` | 未设置 | 仅开发时（`pnpm dev`）使用：Vite 将 `/api`、`/auth`、`/d` 代理到该端口上的守护进程。 |
| `CODEX_HOME`、`CLAUDE_CONFIG_DIR` | `~/.codex`、`~/.claude` | 各厂商 CLI 自身的配置目录，守护进程读取它们以检查登录状态、模型缓存指纹与会话记录。 |

（注：当项目配置了 worktree 准备命令 `hub project setup` 时，守护进程会在执行准备脚本时自动注入 `AGENT_HUB_ROOT_PATH` 与 `AGENT_HUB_WORKTREE_PATH`。）

## 厂商条款风险（使用前必读）

Agent Hub 本身不直接请求任何模型 API，而是在你的电脑上、使用**你自己的账号**，以无头（非交互）模式调用各厂商的**官方命令行工具**并自动驱动它。这种用法是否符合你所用订阅套餐及各厂商的服务条款，需要你自行查阅并判断；本项目不替任何厂商下“允许”的结论，也不保证你的账号不会受到影响。

- **Google Antigravity**：[Google Antigravity 附加条款](https://antigravity.google/terms/)第 6 条写明：
  > "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."
  > （使用第三方软件、工具或服务访问本服务属于违约，可能导致暂停或终止你的 Antigravity 和/或 Gemini CLI 账号。）

  用本工具在本地调用官方 `agy` 命令行的无头模式是否属于这一条，官方没有明确说法。请将其视为**可能导致账号被暂停或终止的真实风险**，由你自己判断和承担。
- **Claude Code**：请自行查阅并遵守 Anthropic 的条款与合规说明：<https://code.claude.com/docs/en/legal-and-compliance>
- **Codex**：请自行查阅并遵守 OpenAI 的使用条款：<https://openai.com/policies/row-terms-of-use/>

各厂商条款可能随时变更，请以官方最新文本为准。

## 安全提示

Worker 会在你的电脑上以当前系统用户的权限修改文件、执行任意终端命令。在重要机器或仓库上使用前，请先了解实际的安全机制与边界：

- **写入范围限制（`src/shared/write-scope.ts`、`src/daemon/driver/write-scope.ts`）**：在数据目录（`~/.agent-hub`）内部，普通 Worker 只能写自己的 worktree，数据库、令牌（`state/`）和其他 Worker 的目录均受保护。这一限制由包在 Agent 进程外层的操作系统沙箱强制执行（macOS 使用 `sandbox-exec`，Linux 使用 `bubblewrap` `bwrap`，Linux 首次使用需跑一次 `sudo scripts/linux-sandbox-setup.sh`，详见 [docs/write-scope.md](docs/write-scope.md)）；若系统沙箱不可用，Worker 会拒绝启动。**但数据目录之外没有任何写入限制**：Worker 可以修改你的项目文件夹及当前用户可写的其他路径，也可以像普通程序一样跑命令、联网和读取文件。
- **只读模式（`src/shared/readonly-policy.ts`）**：只读 Worker 可以读文件、跑命令，连接器（MCP）只能调用标有 `readOnlyHint: true` 的只读工具；禁读本机界面令牌（`state/ui-token`）、各厂商令牌凭据文件、`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gh` 等敏感目录以及 `**/.env`、`**/.env.*`、`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/id_ed25519*` 等密钥文件；除会话私有临时目录（及必要的运行时/缓存目录）外禁止写入任何位置（Claude Code 与 Codex 使用各自原生只读沙箱，Antigravity 使用外层只读系统沙箱）。详见 [docs/readonly-worker-design.md](docs/readonly-worker-design.md)。
- **项目经理不受沙箱限制。**
- 请勿将本机端口直接暴露到公网。安全漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 第三方素材与许可

- `src/web/assets/avatars/` 中的 16 张水果头像为 AI 生成。
- 第三方依赖遵循各自的许可证（见 `pnpm-lock.yaml`）。其中 `mermaid` 引入的传递依赖 `elkjs` 许可证为 `EPL-2.0 OR GPL-3.0-or-later`，`khroma` 在 npm 包中未标注 `license` 字段（其上游仓库为 MIT）。如需打包再分发，请自行核对相关许可要求。

## License

[MIT](LICENSE)
