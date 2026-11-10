# Fusa

**English** | [中文](#中文)

**Manage an entire project through a single conversation.**

Fusa is a self-hosted web app built around one idea: **for each project, you only talk to one Project Manager (PM) agent.** You tell the PM what you want; the PM breaks down the work, dispatches **Worker** agents (called **Pieces** in the UI) into isolated git worktrees, reviews their diffs and test results, and merges their PRs. Every role—PM or Worker—can independently run a different vendor's official command-line agent (`claude`, `agy`, or `codex`) under your own account.

![Fusa home screen](docs/screenshots/readme-home.png)

### Why a single conversation per project?

When you run multiple coding agents in parallel, the bottleneck quickly shifts from writing code to **managing agent sessions**: creating git worktrees, picking models, copying background context between threads, watching terminals to see who stalled, and reviewing diffs across half a dozen tabs.

Fusa is designed from the ground up so **one conversation manages the whole project**—the shape it has had since day one. Instead of opening and babysitting individual worktree sessions yourself, you stay in one continuous conversation with your project's PM, and the UI, context lifecycle, sub-agent orchestration, and token-saving mechanisms are all built around that single thread.

It is built for **one person across multiple devices** (your Mac, a Linux server, your phone)—not a multi-user shared server.

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
- **Message batching, slim initial load, and idle process reaping:** Consecutive messages sent while an agent is busy are delivered mid-turn or batched into a single turn; initial page load fetches only the 20 most recent messages per active conversation and 0 messages for finished Workers; and agent processes idle for 10 minutes are automatically closed and resumed on demand.

See [docs/mid-turn-messages.md](docs/mid-turn-messages.md) for details.

## Other features

- **Currently supported agent CLIs:** Claude Code (`claude`), Antigravity (`agy`), and Codex (`codex`) (list defined in [`src/shared/vendors.ts`](src/shared/vendors.ts) as `AGENT_VENDORS`).
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
pnpm app:mac                              # builds build/Fusa.app
bash scripts/build-mac-app.sh --install   # builds and copies to /Applications/Fusa.app
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

Fusa does not call model provider APIs directly. Instead, it launches each vendor's **official command-line agent** on your machine, under **your own account**, in non-interactive/headless mode, and drives it automatically. Whether using an external orchestrator to drive the official CLI is permitted under your subscription or terms of service is for you to review and decide; this project does not grant permission or guarantee that your account will remain in good standing.

- **Google Antigravity:** Section 6 of the [Google Antigravity Additional Terms](https://antigravity.google/terms/) states:
  > "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."

  Google has not explicitly clarified whether driving the official `agy` CLI in headless mode from a local tool like Fusa falls under this prohibition. Treat it as a **risk of account suspension or termination** and decide for yourself.
- **Claude Code:** Review and comply with Anthropic's terms and compliance docs: <https://code.claude.com/docs/en/legal-and-compliance>.
- **Codex:** Review and comply with OpenAI's terms of use: <https://openai.com/policies/row-terms-of-use/>.

Vendor terms change over time; always check the latest official documents yourself.

## Security notes

Workers edit files and execute shell commands on your machine with your OS user's permissions. Understand the actual boundaries before running agents on important repositories or machines:

- **Worker write scope (`src/shared/write-scope.ts`, `src/daemon/driver/write-scope.ts`):** Inside the Fusa data directory (`~/.agent-hub`), a normal worker is only allowed to write to its own git worktree (`worktrees/<project>/<worker>`); `state/` (SQLite database, tokens, personas) and other workers' worktrees are write-protected. This is enforced by wrapping the worker process in an OS sandbox (`sandbox-exec` on macOS; `bubblewrap` / `bwrap` on Linux after running the one-time `sudo scripts/linux-sandbox-setup.sh` setup—see [docs/write-scope.md](docs/write-scope.md)). If the OS sandbox is unavailable, workers refuse to start. **Outside the data directory (`~/.agent-hub`), there are no write restrictions:** a worker can modify your project folder and any other user-writable files, run arbitrary commands, and access the network just like any program you run.
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

[English](#fusa) | **中文**

**通过一个会话管理整个项目。**

Fusa 是一个自托管的个人多 Agent 协作网页应用，核心设计只有一件事：**每个项目你只需要跟一个项目经理（PM）聊。** 你把需求告诉项目经理，拆任务、派 **Worker**（界面里叫 **Pieces**）到各自独立的 git worktree 里并行干活、审代码跑测试、合 PR，都由项目经理去做。项目经理和每个 Worker 都可以各自任选不同厂商的官方命令行 Agent（`claude`、`agy` 或 `codex`），使用你自己的账号。

### 为什么要“一个会话管住整个项目”？

同时用多个编程 Agent 并行干活时，瓶颈很快就会从“写代码”变成**“管会话”**：建 git worktree、选模型、在不同会话之间来回贴背景、盯一堆终端看谁卡住了、在十几个标签页里挨个审 diff。

Fusa 从最早开始开发时就是按**“一个会话管住整个项目”**设计的：你不用自己去开、去盯每个 worktree 和 Agent 会话，界面布局、上下文生命周期、子 Agent 编排和省 Token 机制全都是为了让你始终留在这一个项目经理对话里。

它是为**一个人、多台设备**（你自己的 Mac、Linux 服务器、手机）设计的自用工具，不是多人共用的服务端。

## 怎么做到的

### 1. 围绕“和项目经理聊天”设计的界面

- **一个项目只有一条主线对话**：左侧栏只列项目经理（一个项目对应一个项目经理），Worker 的会话不会混进左侧对话列表。
- **过程默认收起，主对话只看结论和状态**：项目经理每轮的中间工具调用和派活事件默认折成一行 `Worked for Xs ›`；Worker 每做完一轮，主对话里只出现一个带状态圆点的简短汇报气泡（最多 120 字）。
- **需要时再点开看过程**：正在干活的 `Pieces`、等你拍板的问题（`Needs You`）和默认收起的 `Completed` 放在右侧栏（手机端为底部抽屉），想看具体步骤或插话时再点开对应 Worker。

详见 [docs/prototype-design.md](docs/prototype-design.md)。

### 2. 无感的上下文压缩

- **满 200,000 Token 后台自动写交接**：当项目经理会话的上下文达到 200,000 Token 时，系统会在后台复制当前会话生成约 2,000 字的结构化交接文档，你这边继续聊天完全不卡顿。
- **轮次间隙无缝切换新会话**：在两轮对话之间，系统自动切到新会话，并带入性格记忆、结构化交接文档、切点前最多 30,000 字的对话原文（加切点后的全部对话）以及近期 Worker 汇报目录。你在网页上始终留在同一个对话里；在资料页中途切换项目经理的厂商也复用同一套交接机制。

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
- **忙时连发合并、首屏按需加载与空闲进程回收**：Agent 忙时你连发的消息会轮中送达或合并成一轮处理；打开网页首屏每个活跃会话只带最近 20 条消息、已收工的 Worker 带 0 条消息（点开再拉）；空闲满 10 分钟的 Agent 进程自动关闭回收，有新消息时按需恢复。

详见 [docs/mid-turn-messages.md](docs/mid-turn-messages.md)。

## 其他特性

- **目前支持的 Agent 命令行**（名单以 [`src/shared/vendors.ts`](src/shared/vendors.ts) 的 `AGENT_VENDORS` 为准）：Claude Code（`claude`）、Antigravity（`agy`）、Codex（`codex`）。
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
pnpm app:mac                              # 在 build/Fusa.app 生成应用
bash scripts/build-mac-app.sh --install   # 同上，并复制到 /Applications/Fusa.app
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

Fusa 本身不直接请求任何模型 API，而是在你的电脑上、使用**你自己的账号**，以无头（非交互）模式调用各厂商的**官方命令行工具**并自动驱动它。这种用法是否符合你所用订阅套餐及各厂商的服务条款，需要你自行查阅并判断；本项目不替任何厂商下“允许”的结论，也不保证你的账号不会受到影响。

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
