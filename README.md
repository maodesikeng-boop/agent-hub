# Fusa

**English** | [中文](#中文)

**Manage an entire project through a single conversation.**

Fusa is a desktop-first personal multi-agent coding app built around one idea: **for each project, you only talk to one Project Manager (PM) agent.** You align on goals and make decisions with the PM in one conversation. The PM breaks down the work, dispatches **Worker** agents (called **Pieces** in the UI) into isolated git worktrees in parallel, reviews their diffs and test results, and merges their PRs. Every role, PM or Worker, can independently run any supported command-line agent (`claude`, `agy`, `codex`, `pi`, `dsh`, or `cursor-agent`) under your own account or API key.

![Fusa home screen](docs/screenshots/readme-home.png)

### Why a single conversation per project?

When you run multiple coding agents in parallel, the bottleneck quickly shifts from writing code to **managing agent sessions**: creating git worktrees, picking models, copying background context between threads, watching terminals to see who stalled, and reviewing diffs across half a dozen tabs.

Fusa is designed from the ground up so **one conversation manages the whole project**. Instead of opening and babysitting individual worktree sessions yourself, you stay in one continuous conversation with your project's PM, and the UI, context lifecycle, sub-agent orchestration, and token-saving mechanisms are all built around that single thread.

It is built for **one person across multiple devices**, not as a multi-user shared server. Open `Fusa.app` on your Mac or install the unsigned preview desktop app on Windows 11 (backed by a dedicated WSL 2 runtime) to work in a dedicated window without manual browser URLs or tokens. Run an always-on daemon on a Linux server when needed, and check in or reply from your phone in a browser or home-screen PWA.

## How it works

### 1. A UI built around the PM conversation

- **One project, one main chat:** The left sidebar only lists Project Managers—one per project—so Worker sessions never clutter your conversation list.
- **Process collapsed by default, conclusions up front:** The PM's intermediate tool calls and dispatch events within a turn fold into a single `Worked for Xs ›` line, and when a Worker finishes a round, only a status dot and a short summary bubble (up to 120 characters) appear in the main chat.
- **Drill down only when you want to:** Active `Pieces`, questions waiting for your decision (`Needs You`), and a collapsed-by-default `Completed` list sit in the right rail (or bottom drawer on mobile); click any summary bubble or row in `Pieces` to open that Worker's full session.

See [docs/prototype-design.md](docs/prototype-design.md) for details.

### 2. Seamless context compaction

- **Automatic background handover at 200,000 tokens:** When a PM session's context reaches 200,000 tokens, Fusa forks the session in the background to write a ~2,000-character structured handover while you continue chatting with the PM without interruption.
- **Zero-interruption session switch:** Between turns, the PM switches to a fresh underlying session preloaded with its persona memory, the structured handover, up to 30,000 characters of recent verbatim dialogue before the fork point (plus all messages after it), and a directory of recent Worker reports. You stay in the exact same conversation in the UI, and switching a PM's vendor on its profile page uses the same handover transition.

See [docs/background-handover-design.md](docs/background-handover-design.md) for details.

### 3. Convenient sub-agent (Worker) management

- **Isolated git worktrees with automatic cleanup:** The PM dispatches each Worker (`hub worker start`) into its own git worktree and branch with optional automatic project setup, and finished worktrees are automatically cleaned up once their branch merges into `main` or 3 days after completion.
- **Per-worker vendor, model, effort, and read-only mode:** Each Worker can independently use a different vendor, model, thinking effort, and per-turn time reminder (default 30 minutes, alerting the PM without killing the Worker), or run in a read-only sandbox for code review and investigation.
- **Talk to a Worker directly or pick who gets dispatched:** You can click any item in `Pieces` to message that Worker directly (the PM automatically receives a copy so context never diverges), or type `/hub:worker` in the PM input box to specify which vendor, model, and effort to use for Workers dispatched from that message.

See [docs/readonly-worker-design.md](docs/readonly-worker-design.md) for details.

### 4. Token saving & efficiency

- **Offload heavy work and match model to difficulty:** Multi-file searches, log investigation, and code changes are delegated to short-lived Workers—using lighter models and lower thinking effort for routine tasks—so bulky tool outputs never bloat the PM's context. Once a Worker's context exceeds 200,000 tokens or needs major rework, the PM closes it and starts a fresh Worker instead of paying to re-read a huge context every turn.
- **Structured reports and layered on-demand inspection:** Workers return a concise structured summary at the end of each turn; when the PM needs more detail, it queries step statistics or the last 20 steps on demand rather than reading raw session transcripts.
- **~97% prompt cache reuse and tool-stripped handovers:** Background handover forks keep the identical model, system prompt, and tool definitions to hit ~97% of the parent session's prompt cache, while new sessions strip out historical tool outputs and full Worker logs.
- **Message batching, slim initial load, and idle process reaping:** Consecutive messages sent while an agent is busy are delivered mid-turn or batched into a single turn; initial load fetches only the 20 most recent messages per active conversation and 0 messages for finished Workers; and agent processes idle for 10 minutes are automatically closed and resumed on demand.

See [docs/mid-turn-messages.md](docs/mid-turn-messages.md) for details.

## Other features

- **Supported agent CLIs:** Claude Code (`claude`), Antigravity (`agy`), Codex (`codex`), Pi (`pi`), DeepSeek Harness (`dsh`), and Cursor (`cursor-agent`), registered in [`src/vendors/registry.ts`](src/vendors/registry.ts) (`AGENT_VENDORS` in [`src/shared/vendors.ts`](src/shared/vendors.ts)).
- **Native macOS desktop app (`Fusa.app`):** opens in a dedicated desktop window, automatically starts and supervises the local daemon, authenticates locally without manual URLs or tokens, shows live worker and question counts in the menu bar and Dock badge, and delivers native macOS notifications.
- **Windows 11 desktop app (unsigned preview):** Tauri 2 desktop window that provisions an isolated Ubuntu 24.04 WSL 2 distribution (`Fusa`), supervises the Linux daemon inside it, signs in locally, and stays running in the system tray.
- **Rich conversation UI & mobile PWA:** Markdown rendering, syntax highlighting, Mermaid and Vega-Lite charts, and file uploads and previews; accessible on your phone in a browser or installed via **Add to Home Screen** (PWA) with optional Web Push lock-screen notifications.
- **Multi-device view & quota tracking:** view and operate agents across your desktop machines and Linux server in one window, and track usage quota windows and reset times for vendors that report them (`claude`, `agy`, and `codex`).

## Requirements

- **macOS 13+** with Xcode Command Line Tools (`swiftc`) to build `Fusa.app`, **Windows 11 (x64)** with **WSL 2** enabled for the Windows desktop preview, or an Ubuntu **Linux** server (see [docs/linux.md](docs/linux.md)).
- **Node.js >= 24.12** (runs `.ts` natively and uses the built-in `node:sqlite`; see `package.json` `engines`), **pnpm** (`pnpm@10.x`), and `git` when building on macOS, deploying on Linux, or running the daemon directly. On Windows 11, the desktop app provisions Node.js 24, pnpm, `git`, and `bubblewrap` automatically inside its dedicated `Fusa` WSL 2 distribution.
- At least one supported agent CLI **installed and signed in in your terminal** (on Windows, inside the `Fusa` WSL 2 terminal; the UI shows the login command if signed out):
  - Claude Code (`claude`): install via `curl -fsSL https://claude.ai/install.sh | bash`, sign in with `claude auth login`
  - Antigravity (`agy`): install via `curl -fsSL https://antigravity.google/cli/install.sh | bash`, sign in by running `agy` (or set `GEMINI_API_KEY`)
  - Codex (`codex`): install via `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (or `npm install -g @openai/codex`), sign in with `codex login` (or `codex login --device-auth` in headless terminals)
  - Pi (`pi`, [docs/vendors/pi.md](docs/vendors/pi.md)): install via `curl -fsSL https://pi.dev/install.sh | sh` (or `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), run `pi` and type `/login` to connect a model provider, or set that provider's API key environment variable
  - DeepSeek Harness (`dsh`, developer preview, [docs/vendors/deepseek.md](docs/vendors/deepseek.md)): install the verified preview version with `npm install -g @deepseek-ai/dsh@0.2.2-rc.1`, then run `dsh` to sign in interactively or write `DEEPSEEK_API_KEY=<key>` to `~/.dsh/.env`
  - Cursor (`cursor-agent`, [docs/vendors/cursor.md](docs/vendors/cursor.md)): install via `curl https://cursor.com/install -fsS | bash`, sign in with `cursor-agent login` (or `NO_OPEN_BROWSER=1 cursor-agent login` in headless terminals, or set `CURSOR_API_KEY`)

## Install and run

### 1. macOS desktop app (`Fusa.app`, primary entry)

Build from source and install `/Applications/Fusa.app`:

```sh
git clone https://github.com/maodesikeng-boop/agent-hub.git
cd agent-hub
pnpm install --frozen-lockfile
pnpm build
bash scripts/build-mac-app.sh --install
```

*(To build `build/Fusa.app` without copying to `/Applications`, run `pnpm app:mac`.)*

Once installed, open **`Fusa.app`** directly from `/Applications` or Spotlight. `Fusa.app` (`apps/macos/`) automatically launches and supervises the local daemon (`node src/daemon/main.ts`), authenticates using your local token, and creates a default Project Manager on first start.

**Source-build notes (compile on your own machine):** There is no standalone prebuilt macOS installer download yet. `scripts/build-mac-app.sh` embeds your repository's absolute path (`AgentHubRepoDir`) and your Node.js executable path (`AgentHubNodePath`) into `Contents/Info.plist` and signs the bundle ad-hoc (`codesign -s -`), so running `Fusa.app` still depends on your local Node installation, built assets (`dist/web`), and source directory. **If you move the repository or change your Node path, re-run the build script** (or override them at runtime via `AGENT_HUB_REPO_DIR` and `AGENT_HUB_NODE`). Do not distribute the compiled `.app` bundle.

### 2. Windows desktop app (unsigned preview)

**Preview status:** The Windows desktop app is currently an **unsigned preview** that has not yet completed release code-signing or final on-device acceptance sign-off. When you launch the installer or app for the first time and Windows SmartScreen shows a warning, click **More info -> Run anyway**.

**System prerequisite:** Windows 11 (x64) with WSL 2 enabled. If WSL 2 is not enabled yet, open PowerShell as Administrator, run the following command, and restart Windows when prompted:

```powershell
wsl --install --no-distribution
```

You can install Fusa on Windows 11 in two ways:

1. **Install from the GitHub Actions artifact (recommended):** Open the **`windows-desktop`** workflow ([`.github/workflows/windows-desktop.yml`](.github/workflows/windows-desktop.yml)) under this repository's GitHub Actions tab, open the latest successful run (or click **Run workflow** to trigger one), download **`fusa-windows-x64-nsis-unsigned-preview`** under **Artifacts** at the bottom of the page, extract the zip archive, and run `Fusa_0.1.0_x64-setup-unsigned-preview.exe`.
2. **Build the installer from source on Windows (optional):** Install Node.js >= 24.12, pnpm 10, and the Rust stable `x86_64-pc-windows-msvc` toolchain (with Visual Studio C++ Build Tools), then run the following commands in Git Bash to build the web assets, stage the WSL backend release archive, and bundle the NSIS installer:

```sh
git clone https://github.com/maodesikeng-boop/agent-hub.git
cd agent-hub
pnpm install --frozen-lockfile
pnpm build
mkdir -p apps/windows/crates/fusa-desktop/resources
tar --exclude='*.test.ts' --exclude='*.test.tsx' \
	-czf apps/windows/crates/fusa-desktop/resources/fusa-release.tar.gz \
	package.json pnpm-lock.yaml tsconfig.json apps/desktop/contract.json \
	migrations scripts src dist
cd apps/windows/crates/fusa-desktop
pnpm dlx @tauri-apps/cli@^2 build --bundles nsis
```

*(If `tauri-cli` is installed via Cargo, you can run `cargo tauri build --bundles nsis` in `apps/windows/crates/fusa-desktop` instead. The compiled NSIS installer is written to `apps/windows/target/release/bundle/nsis/`.)*

**First-run setup, tray behavior, and workspace isolation:**

- **Automatic dedicated WSL 2 runtime:** On first launch, the built-in setup screen downloads and verifies the official Ubuntu 24.04 WSL rootfs image and imports a dedicated **`Fusa`** WSL 2 distribution (with non-root user `fusa`, Node.js 24, pnpm, `git`, the `bubblewrap` Worker sandbox, and the Fusa daemon) without modifying any existing WSL distributions on your machine. Click **Open terminal** on the setup screen to open an interactive `Fusa` shell, install and sign in to your preferred agent CLIs, and click **Continue**.
- **System tray lifecycle:** Clicking the window close button hides Fusa to the system tray while the daemon keeps running in the background. To exit completely and gracefully stop the managed daemon inside WSL, right-click the Fusa system tray icon and choose the quit action (**彻底退出 Fusa**).
- **Workspace and host isolation:** To prevent sandboxed Workers from reading or modifying host files or invoking Windows executables, the `Fusa` distribution disables Windows drive automounting and interoperability by default (`automount=false` and `interop=false` in `/etc/wsl.conf`, so `C:\` is not mounted and Windows `.exe` binaries cannot be launched from inside WSL). Clone and keep the Git repositories you manage inside the `Fusa` Linux filesystem (for example under `/home/fusa/projects` via `wsl -d Fusa`). See [docs/windows-desktop-design.md](docs/windows-desktop-design.md) for architecture details.

### 3. Linux server (always-on daemon & multi-device hub)

When you want a 24/7 background daemon or a central relay connecting multiple machines, deploy the daemon on a Linux (Ubuntu) server as a `systemd` user service. For full setup instructions, including one-time `bubblewrap` Worker sandbox configuration (`sudo scripts/linux-sandbox-setup.sh`), SSH tunnels, and optional public access, see [docs/linux.md](docs/linux.md).

### 4. Mobile access (browser & PWA)

To check progress and reply to the same conversations from your phone: on an already signed-in computer, open **Settings → Security & Access → Sign in on phone** (`Show QR code`), scan the one-time QR code (or open the one-time sign-in link) on your phone, and click **Allow** under **Signed-in browsers** on the computer. You can use Fusa directly in your mobile browser or tap **Add to Home Screen** to install it as a full-screen PWA (with optional Web Push notifications).

### 5. Running the daemon directly from the terminal (optional)

For local development or running without the desktop shell, you can start the daemon directly:

```sh
pnpm start
```

- `pnpm start` runs `prestart` (`vite build` into `dist/web`) and starts `node src/daemon/main.ts` (stop with `Ctrl+C`).
- On startup, the terminal prints a local login link (`http://127.0.0.1:4317/auth?token=…`) containing your local master token. Do not share that link.
- Custom port or data directory: `AGENT_HUB_PORT=4400 AGENT_HUB_HOME=~/my-hub pnpm start`.

## Multiple devices

Each machine runs its own daemon, and you can view and operate all of them from one Fusa window (or from an approved phone session). Devices connect through a central Linux server over SSH tunnels (or optionally Tailscale); a phone can reach the central server over HTTPS (for example via Tailscale Funnel) and sign in via one-time QR code approval on an already signed-in device.

Multi-device and public access are completely optional: by default the daemon listens only on `127.0.0.1`, and nothing is exposed externally unless you explicitly configure SSH tunnels, run `tailscale serve`, or enable the public entry in settings. For architecture and setup details, see:
- [docs/multi-device-design.md](docs/multi-device-design.md)
- [docs/hub-tunnel-design.md](docs/hub-tunnel-design.md)
- [docs/linux.md](docs/linux.md)

## Configuration

All environment variables are optional.

| Variable | Default | Description |
|---|---|---|
| `AGENT_HUB_HOME` | `~/.agent-hub` | Data directory (SQLite database, tokens, worktrees, uploads, logs). Keep the path short: Unix sockets inside `run/` must fit within 103 bytes (`MAX_UNIX_SOCKET_PATH_BYTES`). |
| `AGENT_HUB_PORT` | `4317` | Local UI server port (listens on `127.0.0.1` only). Set to `0` to let the OS pick a free port. |
| `AGENT_HUB_CLAUDE` | `claude` | Command name or path to the Claude Code CLI (`~/` is expanded; searched in `PATH` and standard fallback directories). |
| `AGENT_HUB_AGY` | `agy` | Command name or path to the Antigravity CLI (`~/` is expanded; searched in `PATH` and standard fallback directories). |
| `AGENT_HUB_CODEX` | `codex` | Command name or path to the Codex CLI (`~/` is expanded; searched in `PATH`, `ChatGPT.app` on macOS, and standard fallback directories). |
| `AGENT_HUB_PI` | `pi` | Command name or path to the Pi CLI (`~/` is expanded; searched in `PATH` and standard fallback directories). |
| `AGENT_HUB_DEEPSEEK` | `dsh` | Command name or path to the DeepSeek Harness CLI (`~/` is expanded; searched in `PATH` and standard fallback directories). |
| `AGENT_HUB_CURSOR` | `cursor-agent` | Command name or path to the Cursor CLI (`~/` is expanded; searched in `PATH` and standard fallback directories). |
| `AGENT_HUB_DEFAULT_MODEL` | unset | Model ID for the default project manager created on first start; when unset, uses the vendor CLI's own default. |
| `AGENT_HUB_TAILSCALE` | `/Applications/Tailscale.app/Contents/MacOS/Tailscale` on macOS (if present), else `tailscale` | Path or command name for the `tailscale` CLI. |
| `AGENT_HUB_TAILNET_NAME` | detected via `tailscale status --json` | Override the machine's tailnet DNS name (`<machine>.<tailnet>.ts.net`). |
| `AGENT_HUB_TAILNET_OWNER` | detected via `tailscale status --json` | Override the device owner's Tailscale login name (required on tagged Tailscale devices, where `tailscale status` has no owner). |
| `AGENT_HUB_SERVE_TARGET` | `unix` on Linux, `tcp` on macOS | How `tailscale serve` forwards to the daemon (`unix` for `run/ui.sock`, or `tcp` for `127.0.0.1:<port>`). |
| `AGENT_HUB_REPO_DIR` | `AgentHubRepoDir` in `Info.plist` | macOS app only: override the repository directory path at runtime. |
| `AGENT_HUB_NODE` | `AgentHubNodePath` in `Info.plist` | macOS app only: override the Node.js executable path at runtime. |
| `AGENT_HUB_DAEMON_PORT` | unset | Development only (`pnpm dev`): daemon port that Vite proxies `/api`, `/auth`, and `/d` requests to. |
| `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `DSH_HOME` | `~/.codex`, `~/.claude`, `~/.pi/agent`, `~/.pi/agent/sessions`, `~/.dsh` | Vendor CLI configuration and session directories read by the daemon for auth status, model catalog cache fingerprints, read-only sandboxing, and session transcripts. |

*(Note: when a project's worktree setup command runs via `hub project setup`, the daemon also provides `AGENT_HUB_ROOT_PATH` and `AGENT_HUB_WORKTREE_PATH` to the setup script.)*

## Vendor terms & account risks

Fusa does not call model provider APIs directly. Instead, it launches each supported command-line agent on your machine, under **your own account or API key**, in non-interactive (headless, RPC, or ACP) mode, and drives it automatically. Whether using an external orchestrator to drive a vendor CLI is permitted under your subscription or terms of service is for you to review and decide. This project does not grant permission or guarantee that your account will remain in good standing.

- **Google Antigravity (`agy`):** Section 6 of the [Google Antigravity Additional Terms](https://antigravity.google/terms/) states:
  > "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."

  Google has not explicitly clarified whether driving the official `agy` CLI in headless mode from a local tool like Fusa falls under this prohibition. Treat it as a **risk of account suspension or termination** and decide for yourself.
- **Claude Code (`claude`):** Review and comply with Anthropic's terms and compliance docs: <https://code.claude.com/docs/en/legal-and-compliance>.
- **Codex (`codex`):** Review and comply with OpenAI's terms of use: <https://openai.com/policies/row-terms-of-use/>.
- **Pi (`pi`):** `@earendil-works/pi-coding-agent` (<https://pi.dev>) is MIT-licensed open-source software that connects to third-party model providers via `/login` (OAuth) or API keys. Review and comply with the terms of service of each model provider you connect in Pi.
- **DeepSeek Harness (`dsh`):** `@deepseek-ai/dsh` is MIT-licensed open-source software (currently in developer preview). Review and comply with the DeepSeek Open Platform terms of service when calling DeepSeek models: <https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html>.
- **Cursor (`cursor-agent`):** Review and comply with Cursor's terms of service: <https://cursor.com/terms-of-service>.

Vendor terms change over time. Always check the latest official documents yourself.

## Security notes

Workers edit files and execute shell commands on your machine with your OS user's permissions. Understand the actual boundaries before running agents on important repositories or machines:

- **Worker write scope (`src/shared/write-scope.ts`, `src/daemon/driver/write-scope.ts`):** Inside the Fusa data directory (`~/.agent-hub`), a normal worker is only allowed to write to its own git worktree (`worktrees/<project>/<worker>`). Both `state/` (SQLite database, tokens, personas) and other workers' worktrees are write-protected. Fusa enforces this boundary by wrapping the worker process in an OS sandbox (`sandbox-exec` on macOS, `bubblewrap` / `bwrap` on Linux after running the one-time `sudo scripts/linux-sandbox-setup.sh` setup; see [docs/write-scope.md](docs/write-scope.md)). On Windows 11, the desktop app enforces the exact same Worker write-scope and read-only boundaries via Linux `bubblewrap` inside the dedicated `Fusa` WSL 2 distribution, with `automount=false` and `interop=false` so Workers cannot mount host drives or launch Windows executables. If the OS sandbox is unavailable, workers refuse to start. **Outside the data directory (`~/.agent-hub`), there are no write restrictions:** a worker can modify your project folder and any other user-writable files in that OS environment, run arbitrary commands, and access the network just like any program you run.
- **Read-only workers (`src/shared/readonly-policy.ts`):** Read-only workers can read files and run commands, and can only call read-only MCP connector tools (`readOnlyHint: true`). Sensitive paths are blocked from reading (`state/ui-token`, vendor credential files, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, and globs like `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, `**/id_ed25519*`), and writes are blocked everywhere except a per-session private temporary directory (and required runtime and cache directories). Claude Code and Codex use their native read-only sandboxes; Antigravity, Pi, DeepSeek Harness (`dsh`), and Cursor (`cursor-agent`) are wrapped in the outer read-only OS sandbox. See [docs/readonly-worker-design.md](docs/readonly-worker-design.md).
- **Project managers are not sandboxed.**
- Do not expose the local daemon port (`4317`) to untrusted networks. To report a security vulnerability privately, see [SECURITY.md](SECURITY.md).

## Third-party assets and licenses

- The 16 fruit avatar images in `src/web/assets/avatars/` are AI-generated.
- Third-party npm dependencies are distributed under their respective licenses (see `pnpm-lock.yaml`). In particular, `mermaid` pulls in transitive dependencies `elkjs` (licensed under `EPL-2.0 OR GPL-3.0-or-later`) and `khroma` (no `license` field published in the npm package metadata; upstream repository is MIT). Please verify transitive licenses if you redistribute bundled builds.

## License

[MIT](LICENSE)

---

# 中文

[English](#fusa) | **中文**

**通过一个会话管理整个项目。**

Fusa 是一个以桌面应用为主的个人多 Agent 协作工具，核心设计只有一件事：**每个项目你只需要跟一个项目经理（PM）聊。** 你在一个对话里和项目经理对齐目标、拍板决策；拆任务、调度多个 **Worker**（界面里叫 **Pieces**）到各自独立的 git worktree 里并行写代码、审代码跑测试、合 PR，都由项目经理去做。项目经理和每个 Worker 都可以各自任选已支持的命令行 Agent（`claude`、`agy`、`codex`、`pi`、`dsh` 或 `cursor-agent`），使用你自己的账号或 API 密钥运行。

### 为什么要“一个会话管住整个项目”？

同时用多个编程 Agent 并行干活时，瓶颈很快就会从“写代码”变成**“管会话”**：建 git worktree、选模型、在不同会话之间来回贴背景、盯一堆终端看谁卡住了、在十几个标签页里挨个审 diff。

Fusa 从最早开始开发时就是按**“一个会话管住整个项目”**设计的：你不用自己去开、去盯每个 worktree 和 Agent 会话，界面布局、上下文生命周期、子 Agent 编排和省 Token 机制全都是为了让你始终留在这一个项目经理对话里。

它是为**一个人、多台设备**设计的自用工具，不是多人共用的服务端。在 Mac 上双击打开 `Fusa.app`，或在 Windows 11 上安装桌面预览版（内置独立 WSL 2 运行环境），即可在独立桌面窗口中使用，不用自己开浏览器输地址或粘令牌。需要常驻后台时可部署在 Linux 服务器上，出门在手机上用浏览器或“添加到主屏幕”（PWA）查看和回复同一批对话。

## 怎么做到的

### 1. 围绕“和项目经理聊天”设计的界面

- **一个项目只有一条主线对话**：左侧栏只列项目经理（一个项目对应一个项目经理），Worker 的会话不会混进左侧对话列表。
- **过程默认收起，主对话只看结论和状态**：项目经理每轮的中间工具调用和派活事件默认折成一行 `Worked for Xs ›`；Worker 每做完一轮，主对话里只出现一个带状态圆点的简短汇报气泡（最多 120 字）。
- **需要时再点开看过程**：正在干活的 `Pieces`、等你拍板的问题（`Needs You`）和默认收起的 `Completed` 放在右侧栏（手机端为底部抽屉），想看具体步骤或插话时再点开对应 Worker。

详见 [docs/prototype-design.md](docs/prototype-design.md)。

### 2. 无感的上下文压缩

- **满 200,000 Token 后台自动写交接**：当项目经理会话的上下文达到 200,000 Token 时，系统会在后台复制当前会话生成约 2,000 字的结构化交接文档，你这边继续聊天完全不卡顿。
- **轮次间隙无缝切换新会话**：在两轮对话之间，系统自动切到新会话，并带入性格记忆、结构化交接文档、切点前最多 30,000 字的对话原文（加切点后的全部对话）以及近期 Worker 汇报目录。你在界面里始终留在同一个对话中；在资料页中途切换项目经理的厂商也复用同一套交接机制。

详见 [docs/background-handover-design.md](docs/background-handover-design.md)。

### 3. 方便的子 Agent（Worker）管理

- **独立 git worktree 与自动清理**：项目经理通过 `hub worker start` 把每个 Worker 派到独立的 git worktree 和分支里干活（可配置建好 worktree 后自动跑准备脚本），分支合并进 `main` 或收工满 3 天后自动清理 worktree 目录。
- **按任务选厂商、模型、思考程度与只读模式**：每个 Worker 可独立选择厂商、模型、思考程度、单轮超时提醒（默认 30 分钟，到点提醒项目经理而不强杀 Worker），或开启只读沙箱用于代码审查与问题排查。
- **随时直接对 Worker 说话或指定派谁**：你可以从 `Pieces` 点开任意 Worker 直接给它发消息（项目经理会同步收到副本，两边不脱节），也可以在项目经理输入框里用 `/hub:worker` 指定这条消息派出的 Worker 用哪家厂商、模型和思考程度。

详见 [docs/readonly-worker-design.md](docs/readonly-worker-design.md)。

### 4. 省 Token 与提效率

- **重活外包给 Worker，按难度选模型与档位**：读大文件、查日志、改多处代码都交给短命的 Worker（简单活选轻量模型和低档思考），大段工具输出不进项目经理的上下文；Worker 上下文超过 200,000 Token 或需多轮返工时直接收工换新，避免背着大上下文反复计费。
- **结构化汇报与分层按需查看**：Worker 每轮只向项目经理交回简短的结构化汇报；项目经理需要深究时再按需查看步数统计或最近 20 步摘要，不用读整份原始记录。
- **后台交接复用约 97% 缓存，新会话剔除工具噪音**：后台复制会话写交接时保持模型、系统提示词和工具列表不变，约 97% 输入直接命中原会话缓存；切到新会话时自动剔除历史工具输出和完整 Worker 汇报。
- **忙时连发合并、首屏按需加载与空闲进程回收**：Agent 忙时你连发的消息会轮中送达或合并成一轮处理；首屏加载每个活跃会话只带最近 20 条消息、已收工的 Worker 带 0 条消息（点开再拉）；空闲满 10 分钟的 Agent 进程自动关闭回收，有新消息时按需恢复。

详见 [docs/mid-turn-messages.md](docs/mid-turn-messages.md)。

## 其他特性

- **支持的 Agent 命令行**（注册表见 [`src/vendors/registry.ts`](src/vendors/registry.ts)，导出为 [`src/shared/vendors.ts`](src/shared/vendors.ts) 的 `AGENT_VENDORS`）：Claude Code（`claude`）、Antigravity（`agy`）、Codex（`codex`）、Pi（`pi`）、DeepSeek Harness（`dsh`）、Cursor（`cursor-agent`）。
- **macOS 桌面应用（`Fusa.app`）**：双击打开独立应用窗口，自动拉起并监管本机后台守护进程、免手输地址自动登录，支持菜单栏运行状态摘要、Dock 角标与 macOS 原生通知。
- **Windows 原生桌面应用（未签名预览版）**：基于 Tauri 2 的独立桌面窗口，随包内置校验过的 Node.js 24 LTS 与 `fusa-win-helper` 原生进程监管/沙箱组件，无需管理员权限或 WSL 2；项目直接留在 `C:\`、`D:\` 或 Dev Drive 本机目录并可直接调用 Visual Studio、MSVC、Rust 等本机工具链，支持单实例聚焦、原生目录选择与系统托盘常驻。
- **富文本对话界面与手机 PWA**：支持 Markdown、代码高亮、Mermaid 与 Vega-Lite 图表、文件上传与预览；手机端可用浏览器访问或通过“添加到主屏幕”作为 PWA 使用（支持可选的 Web Push 锁屏通知）。
- **多设备联机与额度面板**：在一个窗口里同时查看和操作桌面端与 Linux 服务器上的会话，并显示支持额度窗口查询的厂商（`claude`、`agy`、`codex`）的剩余比例与重置时间。

## 环境要求

- **macOS 13+**（编译 `Fusa.app` 需安装 Xcode 命令行工具 `swiftc`）、**Windows 10（1809+）/ Windows 11（x64）**，或 **Linux** 服务器（Ubuntu 部署说明见 [docs/linux.md](docs/linux.md)）。
- 在 macOS、Linux 服务器或直接从源码终端运行守护进程时，需安装 **Node.js >= 24.12**（原生运行 `.ts` 并使用内置 `node:sqlite`，见 `package.json` 的 `engines`；Windows 11 24H2+ 启用 MXC 只读容器需 Node.js >= 24.21）、**pnpm**（`pnpm@10.x`）与 `git`。Windows 桌面安装包已随包内置官方 Node.js 24 LTS 运行时，无需另装 Node；管理 Git 仓库与派发 Worker worktree 需安装 Git for Windows（`winget install --id Git.Git -e --source winget`，纯聊天场景不强制）。
- 至少在本机终端里安装并登录一家支持的 Agent 命令行（未登录时界面与首次启动引导页会提示对应命令）：
  - Claude Code（`claude`）：macOS/Linux `curl -fsSL https://claude.ai/install.sh | bash`，Windows PowerShell `irm https://claude.ai/install.ps1 | iex`；登录 `claude auth login`
  - Antigravity（`agy`）：macOS/Linux `curl -fsSL https://antigravity.google/cli/install.sh | bash`，Windows PowerShell `irm https://antigravity.google/cli/install.ps1 | iex`；运行 `agy` 登录（或配置 `GEMINI_API_KEY`）
  - Codex（`codex`）：macOS/Linux `curl -fsSL https://chatgpt.com/codex/install.sh | sh`（Windows 用 `npm install -g @openai/codex` 或 `winget install OpenAI.Codex`）；登录 `codex login`（无浏览器环境用 `codex login --device-auth`）
  - Pi（`pi`，详见 [docs/vendors/pi.md](docs/vendors/pi.md)）：macOS/Linux `curl -fsSL https://pi.dev/install.sh | sh`，Windows PowerShell `irm https://pi.dev/install.ps1 | iex`（或 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`）；在终端运行 `pi` 后输入 `/login` 连接模型商，或配置对应模型商的 API key 环境变量
  - DeepSeek Harness（`dsh`，开发者预览版，详见 [docs/vendors/deepseek.md](docs/vendors/deepseek.md)）：安装已验证的固定版本 `npm install -g @deepseek-ai/dsh@0.2.2-rc.1`，随后在终端运行 `dsh` 交互登录，或向 `~/.dsh/.env` 写入 `DEEPSEEK_API_KEY=<key>`
  - Cursor（`cursor-agent`，详见 [docs/vendors/cursor.md](docs/vendors/cursor.md)）：macOS/Linux `curl https://cursor.com/install -fsS | bash`，Windows PowerShell `irm 'https://cursor.com/install?win32=true' | iex`；登录 `cursor-agent login`（无浏览器环境用 `NO_OPEN_BROWSER=1 cursor-agent login`，或配置 `CURSOR_API_KEY`）

## 安装和启动

### 1. Mac 桌面应用（`Fusa.app`，主入口）

从源码构建并安装 `/Applications/Fusa.app`：

```sh
git clone https://github.com/maodesikeng-boop/agent-hub.git
cd agent-hub
pnpm install --frozen-lockfile
pnpm build
bash scripts/build-mac-app.sh --install
```

（若只想在 `build/Fusa.app` 生成应用包而不复制到 `/Applications`，可执行 `pnpm app:mac`。）

装好后直接打开 **`Fusa.app`** 即可使用，无需自己打开浏览器输入地址或粘贴令牌。`Fusa.app`（`apps/macos/`）会自动拉起并监管本机后台守护进程（`node src/daemon/main.ts`），读取本机令牌自动完成登录，首次启动会自动创建默认项目经理。

**源码构建说明（仅限本机编译自用）：** 当前尚未发布独立打包的 Mac 下载安装包，需在本机从源码构建。`scripts/build-mac-app.sh` 编译时会把当前仓库的绝对路径（`AgentHubRepoDir`）和本机 Node 可执行文件路径（`AgentHubNodePath`）写入 `Contents/Info.plist`，并仅做本机临时签名（`codesign -s -`），运行时仍依赖本机 Node、构建产物（`dist/web`）与源码目录。**挪动仓库目录或更换 Node 路径后，请重新运行上述构建脚本**（或在运行时通过环境变量 `AGENT_HUB_REPO_DIR`、`AGENT_HUB_NODE` 覆盖）。请勿直接分发编译好的 `.app`。

### 2. Windows 桌面应用（未签名预览版）

**预览版状态说明：** 当前 Windows 桌面版为**未签名预览版（unsigned preview，尚未在真机完成正式发行代码签名与验收）**。首次运行安装包或应用时，若遇到 Windows SmartScreen 拦截提示，请点击**更多信息 -> 仍要运行**（英文系统为 **More info -> Run anyway**）。

**系统环境要求：** Windows 10（1809+）或 Windows 11（x64，推荐 Windows 11 24H2+ 以启用原生 MXC 只读沙箱容器）。安装包采用当前用户模式（`currentUser`），**无需管理员权限，也无需安装或开启 WSL 2**。若需要使用 Git worktree 派发并行 Worker，请在本机安装 Git for Windows（PowerShell 执行 `winget install --id Git.Git -e --source winget`）。

可通过以下两种方式获取并安装：

1. **直接用云端构建产物安装（推荐）：** 打开本仓库 GitHub Actions 的 **`windows-desktop`** 工作流页面（[`.github/workflows/windows-desktop.yml`](.github/workflows/windows-desktop.yml)），点开最近一次成功构建，在页面底部 **Artifacts** 下载 **`fusa-windows-x64-nsis-unsigned-preview`**，解压后双击 `Fusa_0.1.0_x64-setup-unsigned-preview.exe` 即可免管理员完成安装。
2. **从源码在本机编译安装包（可选）：** 在 Windows 上安装 Node.js >= 24.21、pnpm 10 与 Rust stable `x86_64-pc-windows-msvc` 构建工具链（含 Visual Studio C++ Build Tools），随后在 PowerShell 中依次执行以下命令构建前端资源、编译原生辅助程序、组装内置 Node 24 LTS 运行时并生成 NSIS 安装包：

```powershell
git clone https://github.com/maodesikeng-boop/agent-hub.git
cd agent-hub
pnpm install --frozen-lockfile
pnpm build
cargo build --release --manifest-path apps/windows/Cargo.toml --workspace --bins --locked
node scripts/stage-win-runtime.ts --out-dir apps/windows/crates/fusa-desktop/staged-runtime --helpers-dir apps/windows/target/release --target-os win32
cd apps/windows/crates/fusa-desktop
pnpm dlx @tauri-apps/cli@^2 build --bundles nsis --config tauri.bundle.conf.json
```

（生成的安装包位于 `apps/windows/target/release/bundle/nsis/`。）

**首次启动引导、跨盘工作树与系统托盘：**

- **轻量化首次引导与注册表 `PATH` 刷新：** 打开 **Fusa** 时会自动同步系统与当前用户最新注册表 `PATH`，拉起随包内置的原生守护进程并完成免输令牌登录。首次运行若检测到尚未安装 `git` 或任一厂商 CLI，会展示安装与登录命令（可点 **Open terminal** 打开本机终端，装好后点 **Refresh** 即刻生效，也可直接点 **Continue** 先进入纯聊天工作台）。
- **直接管理本机磁盘仓库与同卷 worktree：** 可直接通过原生目录选择器选取 `C:\`、`D:\` 或 Dev Drive 上的现有项目目录；当项目在 `D:\` 而数据目录在 `C:\` 时，Worker worktree 会自动创建在项目同卷受保护根 `D:\.fusa-wt\…` 下，保留 `pnpm` 硬链接共享与 Dev Drive 性能加速。
- **窗口关闭与彻底退出：** 点击窗口右上角关闭按钮只会将窗口隐藏到系统托盘，后台守护进程继续保持运行；需要彻底退出并经本机管理命名管道优雅关停守护进程及其全部子进程树时，请右键点击系统托盘图标并选择**彻底退出 Fusa**。完整架构说明见 [docs/windows-native-design.md](docs/windows-native-design.md)。

### 3. Linux 服务器（常驻后台与多设备中心）

需要 24 小时常开后台，或将一台服务器作为多设备联机中心时，可在 Linux（Ubuntu）服务器上以 `systemd` 用户服务部署守护进程。完整的依赖安装、`bubblewrap` Worker 沙箱一次性配置（`sudo scripts/linux-sandbox-setup.sh`）、SSH 隧道及公网入口说明见 [docs/linux.md](docs/linux.md)。

### 4. 手机访问（浏览器与主屏幕 PWA）

需要在手机上查看进度和回复同一批对话时：在已登录的电脑端打开 **Settings → Security & Access → Sign in on phone**（点击 `Show QR code` 生成一次性二维码和登录链接），用手机扫码并在电脑端的 **Signed-in browsers** 列表中点击 **Allow** 批准后，即可通过手机浏览器或系统**“添加到主屏幕”**（PWA，支持可选的 Web Push 锁屏通知）随时查看和回复。

### 5. 直接在终端运行守护进程（可选）

本地开发调试或不通过桌面应用启动时，也可直接在终端运行守护进程：

```sh
pnpm start
```

- `pnpm start`（含 `prestart` 自动构建网页到 `dist/web`）启动守护进程 `node src/daemon/main.ts`，按 `Ctrl+C` 停止。
- 启动后终端会打印本机登录链接（`http://127.0.0.1:4317/auth?token=…`，含本机主令牌，请勿分享给他人）。
- 如需更换端口或数据目录：`AGENT_HUB_PORT=4400 AGENT_HUB_HOME=~/my-hub pnpm start`。

## 多设备联机

每台设备各跑一个守护进程，在电脑端 Fusa 桌面窗口（或已批准登录的手机端）里即可同时查看并操作所有设备。各设备可通过中心 Linux 服务器建立 SSH 隧道连接（也可选用 Tailscale）；手机可通过公网 HTTPS（如 Tailscale Funnel）访问中心服务器，由已登录设备生成一次性二维码并在电脑端点击批准后完成登录。

多设备与公网入口均为可选功能：默认守护进程只监听本机 `127.0.0.1`，除非你主动配置隧道、执行 `tailscale serve` 或在设置中开启公网入口，否则不会对外暴露任何端口。详细设计见：
- [docs/multi-device-design.md](docs/multi-device-design.md)
- [docs/hub-tunnel-design.md](docs/hub-tunnel-design.md)
- [docs/linux.md](docs/linux.md)

## 配置（环境变量）

所有环境变量均为可选：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `AGENT_HUB_HOME` | `~/.agent-hub` | 数据目录（数据库、令牌、worktrees、上传文件、日志）。macOS 和 Linux 上 Unix socket 路径上限为 103 字节（`MAX_UNIX_SOCKET_PATH_BYTES`），请保持路径简短。 |
| `AGENT_HUB_PORT` | `4317` | 本机界面服务端口，只监听 `127.0.0.1`。设为 `0` 时由系统分配空闲端口。 |
| `AGENT_HUB_CLAUDE` | `claude` | Claude Code CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH` 再找常见安装路径）。 |
| `AGENT_HUB_AGY` | `agy` | Antigravity CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH` 再找常见安装路径）。 |
| `AGENT_HUB_CODEX` | `codex` | Codex CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH`、macOS 上的 `ChatGPT.app` 及常见安装路径）。 |
| `AGENT_HUB_PI` | `pi` | Pi CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH` 再找常见安装路径）。 |
| `AGENT_HUB_DEEPSEEK` | `dsh` | DeepSeek Harness CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH` 再找常见安装路径）。 |
| `AGENT_HUB_CURSOR` | `cursor-agent` | Cursor CLI 的命令名或可执行文件路径（支持 `~/` 展开；先找 `PATH` 再找常见安装路径）。 |
| `AGENT_HUB_DEFAULT_MODEL` | 未设置 | 首次启动自动创建默认项目经理时使用的模型；未设置时使用厂商 CLI 自身的默认模型。 |
| `AGENT_HUB_TAILSCALE` | macOS 优先用 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，其余用 `tailscale` | `tailscale` 命令路径。 |
| `AGENT_HUB_TAILNET_NAME` | 由 `tailscale status --json` 自动探测 | 手动指定本机 tailnet 域名（`<机器>.<tailnet>.ts.net`）。 |
| `AGENT_HUB_TAILNET_OWNER` | 由 `tailscale status --json` 自动探测 | 手动指定设备主人的 Tailscale 登录名（打了 tag 的设备查不到主人，必须设置此项，否则经 tailnet 访问会回 403）。 |
| `AGENT_HUB_SERVE_TARGET` | Linux 为 `unix`，macOS 为 `tcp` | `tailscale serve` 的转发目标类型（`unix` 转发至 `run/ui.sock`，`tcp` 转发至 `127.0.0.1:<端口>`）。 |
| `AGENT_HUB_REPO_DIR` | 编译进 `Info.plist` 的 `AgentHubRepoDir` | 仅 Mac 应用：运行时覆盖仓库目录路径。 |
| `AGENT_HUB_NODE` | 编译进 `Info.plist` 的 `AgentHubNodePath` | 仅 Mac 应用：运行时覆盖 Node.js 可执行文件路径。 |
| `AGENT_HUB_DAEMON_PORT` | 未设置 | 仅开发时（`pnpm dev`）使用：Vite 将 `/api`、`/auth`、`/d` 代理到该端口上的守护进程。 |
| `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`DSH_HOME` | `~/.codex`、`~/.claude`、`~/.pi/agent`、`~/.pi/agent/sessions`、`~/.dsh` | 各厂商 CLI 自身的配置与会话目录，守护进程读取它们以检查登录状态、模型缓存指纹、只读沙箱边界与会话记录。 |

（注：当项目配置了 worktree 准备命令 `hub project setup` 时，守护进程会在执行准备脚本时自动注入 `AGENT_HUB_ROOT_PATH` 与 `AGENT_HUB_WORKTREE_PATH`。）

## 厂商条款风险（使用前必读）

Fusa 本身不直接请求任何模型 API，而是在你的电脑上、使用**你自己的账号或 API 密钥**，以非交互（无头、RPC 或 ACP）模式调用各命令行 Agent 并自动驱动它。这种用法是否符合你所用订阅套餐及各服务商的使用条款，需要你自行查阅并判断；本项目不替任何厂商下“允许”的结论，也不保证你的账号不会受到影响。

- **Google Antigravity（`agy`）**：[Google Antigravity 附加条款](https://antigravity.google/terms/)第 6 条写明：
  > "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."
  > （使用第三方软件、工具或服务访问本服务属于违约，可能导致暂停或终止你的 Antigravity 和/或 Gemini CLI 账号。）

  用本工具在本地调用官方 `agy` 命令行的无头模式是否属于这一条，官方没有明确说法。请将其视为**可能导致账号被暂停或终止的真实风险**，由你自己判断和承担。
- **Claude Code（`claude`）**：请自行查阅并遵守 Anthropic 的条款与合规说明：<https://code.claude.com/docs/en/legal-and-compliance>
- **Codex（`codex`）**：请自行查阅并遵守 OpenAI 的使用条款：<https://openai.com/policies/row-terms-of-use/>
- **Pi（`pi`）**：`@earendil-works/pi-coding-agent`（<https://pi.dev>）本身是 MIT 开源工具，通过 `/login`（OAuth）或 API key 连接你选择的第三方模型商；请自行查阅并遵守所连模型商的服务条款。
- **DeepSeek Harness（`dsh`）**：`@deepseek-ai/dsh` 本身是官方 MIT 开源工具（当前为开发者预览版），调用 DeepSeek 模型服务请查阅并遵守 DeepSeek 开放平台服务条款：<https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html>
- **Cursor（`cursor-agent`）**：请自行查阅并遵守 Cursor 的服务条款：<https://cursor.com/terms-of-service>

各厂商条款可能随时变更，请以官方最新文本为准。

## 安全提示

Worker 会在你的电脑上以当前系统用户的权限修改文件、执行任意终端命令。在重要机器或仓库上使用前，请先了解实际的安全机制与边界：

- **写入范围限制（`src/shared/write-scope.ts`、`src/daemon/driver/write-scope.ts`）**：在受保护根（数据目录 `~/.agent-hub` 及跨盘同卷 `.fusa-wt` 根）内部，普通 Worker 只能写自己的 worktree，数据库、令牌（`state/`）和其他 Worker 的目录均受保护。这一限制由包在 Agent 进程外层的操作系统沙箱强制执行（macOS 使用 `sandbox-exec`；Linux 使用 `bubblewrap` `bwrap`，首次使用需跑一次 `sudo scripts/linux-sandbox-setup.sh`；Windows 原生版通过 `fusa-run.exe` 的 `KILL_ON_JOB_CLOSE` Job Object + `WRITE_RESTRICTED` 写受限令牌 + 受保护根拒写 NTFS ACL 强制执行，详见 [docs/write-scope.md](docs/write-scope.md)）。若基础系统沙箱不可用，Worker 会拒绝启动。**但受保护根之外没有任何写入限制**：Worker 可以修改你的项目文件夹及当前用户可写的其他路径，也可以像普通程序一样跑命令、联网和读取文件。
- **只读模式（`src/shared/readonly-policy.ts`）**：只读 Worker 可以读文件、跑命令，连接器（MCP）只能调用标有 `readOnlyHint: true` 的只读工具；禁读本机界面令牌（`state/ui-token`）、各厂商令牌凭据文件、`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gh` 等敏感目录以及 `**/.env`、`**/.env.*`、`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/id_ed25519*` 等密钥文件；除会话私有临时目录（及必要的运行时和缓存目录）外禁止写入任何位置。Claude Code 与 Codex 使用各自原生只读沙箱；Antigravity、Pi、DeepSeek Harness（`dsh`）与 Cursor（`cursor-agent`）使用外层只读系统沙箱。详见 [docs/readonly-worker-design.md](docs/readonly-worker-design.md)。
- **Windows 只读模式说明**：在 Windows 上，Codex 继续使用其自带只读沙箱；其余厂商在支持 ProcessContainer 的 Windows 11 24H2+ 环境优先使用微软官方 MXC 只读容器（`@microsoft/mxc-sdk`），在低于 Windows 11 24H2 或未启用容器支持的系统上自动平滑回退为「写受限令牌（受保护根禁写）+ 厂商工具层只读拦截规则」并在会话中输出降级提示。
- **项目经理不受沙箱限制。**
- 请勿将本机端口直接暴露到公网。安全漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 第三方素材与许可

- `src/web/assets/avatars/` 中的 16 张水果头像为 AI 生成。
- 第三方依赖遵循各自的许可证（见 `pnpm-lock.yaml`）。其中 `mermaid` 引入的传递依赖 `elkjs` 许可证为 `EPL-2.0 OR GPL-3.0-or-later`，`khroma` 在 npm 包中未标注 `license` 字段（其上游仓库为 MIT）。如需打包再分发，请自行核对相关许可要求。

## License

[MIT](LICENSE)
