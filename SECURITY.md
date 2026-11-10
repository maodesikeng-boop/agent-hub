# Security Policy

**English** | [中文](#安全策略)

## Supported versions

Fusa does not publish versioned releases yet (`package.json` version is `0.0.0`). Only the latest commit on `main` is supported, and security fixes land on `main`.

- **In scope:** the daemon (`src/daemon`), the web UI (`src/web`), Worker write-scope and read-only enforcement (`src/shared/write-scope.ts`, `src/shared/readonly-policy.ts`, `src/daemon/driver/`), local and multi-device authentication (UI master token, browser sessions, peer device tokens, SSH tunnels, public entry), and the macOS desktop shell (`apps/macos`).
- **Out of scope:** vulnerabilities inside the upstream vendor CLIs themselves (`claude`, `agy`, `codex`) or third-party dependencies (please report those upstream and let us know if a dependency bump is needed), and attacks that already have code execution as your OS user or physical access to an unlocked machine.

## Reporting a vulnerability

Please do **not** open a public GitHub issue or pull request for security vulnerabilities. Instead, report privately through GitHub's Private Vulnerability Reporting:

1. Open <https://github.com/maodesikeng-boop/agent-hub/security/advisories/new> (or go to the repository's **Security** tab → **Report a vulnerability**).
2. Include a description of the issue, the affected commit hash, and steps or a minimal proof-of-concept to reproduce it.

This is a personal open-source project maintained on a best-effort basis without a formal SLA, but reports are reviewed and fixed as quickly as practical. Please allow reasonable time for a fix before public disclosure.

## Security boundaries (as implemented in code)

Fusa is designed for **a single user running agents on their own machines under their own accounts**. It is not a multi-tenant service.

### 1. Local web UI port and tokens (`src/daemon/ui-server/`)

- **Loopback listener:** The web UI HTTP/WebSocket server listens on `127.0.0.1` only (default port `4317`, configurable via `AGENT_HUB_PORT`). Never bind it to `0.0.0.0` or expose the port directly in a firewall.
- **UI master token:** On first start, the daemon generates a random master token at `<AGENT_HUB_HOME>/state/ui-token` (default `~/.agent-hub/state/ui-token`) with file mode `0600` (`UI_TOKEN_FILE_MODE`), and prints a login URL (`http://127.0.0.1:<port>/auth?token=…`). Anyone who obtains this token or URL can log in and control your agents (and therefore run commands as your OS user). Do not share startup logs containing the login URL. Signing out all browsers ("Sign out all") rotates `state/ui-token` and invalidates all active browser sessions.
- **Browser sessions & cookies:** Visiting `/auth?token=…` (or redeeming a one-time 5-minute login link `/auth#link=…`) issues a random per-browser session token in an `HttpOnly`, `SameSite=Strict` cookie (`agent_hub_ui_<port>`, with `Secure` added on HTTPS entries). Only the SHA-256 digest of the session token is stored in SQLite (`browser_sessions`). Local/tailnet sessions expire after 365 days of inactivity (`SESSION_MAX_AGE_MS`).
- **DNS rebinding & cross-origin protection:** On the local port, every request must carry a `Host` header matching `127.0.0.1:<port>` or `localhost:<port>`. State-changing HTTP requests (`POST`, `PUT`, `DELETE`, etc.) and WebSocket upgrades (`/api/ws`) must carry a matching same-origin `Origin` header (`http://127.0.0.1:<port>` or `http://localhost:<port>`).
- **Same-user boundary:** Any local process running under your own OS user account can read `~/.agent-hub/state/ui-token` and `~/.agent-hub/state/hub.sqlite`. File permissions (`0600` files, `0700` `run/` directory) only protect against *other* OS users on the same machine, not malware running as you.

### 2. Agent API socket (`src/daemon/agent-api/`)

- Spawned agents communicate with the daemon (`hub` CLI) over a local Unix domain socket at `<AGENT_HUB_HOME>/run/hub.sock` (mode `0600` inside `run/` with mode `0700`), not over TCP.
- Each active agent session receives a random in-memory per-session token via `HUB_TOKEN`, which is revoked when the session ends.

### 3. Worker sandboxing and read-only mode (`src/shared/write-scope.ts`, `src/daemon/driver/write-scope.ts`)

- **Normal workers:** Inside the data directory (`<AGENT_HUB_HOME>`), a worker may only write to its own worktree (`worktrees/<project>/<worker>`); `state/` and other workers' directories are denied. This is enforced by an outer OS sandbox (`sandbox-exec` on macOS; `bubblewrap` on Linux, configured via `sudo scripts/linux-sandbox-setup.sh`). If the OS sandbox is unavailable, workers refuse to start (`spawn_failed`). **Outside `<AGENT_HUB_HOME>`, normal workers have the full permissions of your OS user**—they can modify project files, read files outside the data directory, run shell commands, and access the network.
- **Read-only workers:** Read-only workers block writes everywhere except a per-session private temporary directory (and required vendor runtime/cache directories), restrict MCP connectors to tools marked `readOnlyHint: true`, and block reads of `state/ui-token`, vendor credential files, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, etc., as well as `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, and `**/id_ed25519*` (`src/shared/readonly-policy.ts`). Note that `state/hub.sqlite` and logs remain readable to read-only workers for debugging, and read-only workers still have network access.
- **Project managers:** Project manager sessions are not sandboxed.

### 4. Multi-device & public entry (`src/daemon/peers/`, `src/daemon/tunnel/`, `src/daemon/ui-server/public-entry.ts`)

- **Peer devices & SSH tunnels:** Paired devices authenticate with per-device 32-byte tokens (stored as SHA-256 hashes on the receiving peer in `state/peers.json`, mode `0600`). SSH tunnels use a dedicated key (`state/tunnel/id_ed25519`) and a restricted `agenthub-tunnel` OS account on the central server (`restrict,port-forwarding,permitlisten=…,permitopen="127.0.0.1:4319",command="/usr/sbin/nologin"`), connecting only to the dedicated peer entry (`run/peer.sock` or `127.0.0.1:4319`), which rejects browser cookies and browser-only routes.
- **Tailscale serve:** Requests arriving via `tailscale serve` must match the machine's tailnet hostname and carry `Tailscale-User-Login` matching the device owner (on tagged devices, `AGENT_HUB_TAILNET_OWNER` must be set).
- **Public HTTPS entry (optional, off by default):** Listens only on `run/public.sock` (`0600`) when enabled. Redeeming a QR login link from the public entry creates a `pending_approval` session (10-minute TTL) that cannot access `/api/*` (other than `/api/auth/status` and self-revocation) until approved on an already signed-in device. Failed `/auth` attempts on the public entry are rate-limited (`5` per minute per IP, `30` per hour globally, followed by a 15-minute lockout), and approved public sessions expire after 30 days of inactivity (`PUBLIC_SESSION_MAX_AGE_MS`).

---

# 安全策略

[English](#security-policy) | **中文**

## 支持范围

Fusa 目前尚未发布带版本号的正式版（`package.json` 版本为 `0.0.0`），仅支持 `main` 分支的最新提交，安全修复直接合入 `main`。

- **在支持范围内**：守护进程（`src/daemon`）、网页前端（`src/web`）、Worker 写入范围与只读沙箱机制（`src/shared/write-scope.ts`、`src/shared/readonly-policy.ts`、`src/daemon/driver/`）、本机与多设备认证（界面主令牌、浏览器会话、设备令牌、SSH 隧道、公网入口）以及 macOS 桌面外壳（`apps/macos`）。
- **不在范围内**：各厂商官方 CLI（`claude`、`agy`、`codex`）自身的漏洞或第三方依赖自身的漏洞（请向上游报告；如需升级依赖版本可告知我们），以及攻击者已经在你的系统用户下执行任意代码或已物理接触未锁屏设备的情形。

## 私下报告漏洞

请**不要**通过公开的 GitHub Issue 或 Pull Request 报告安全漏洞，请使用 GitHub 的私密漏洞报告（Private vulnerability reporting）：

1. 打开 <https://github.com/maodesikeng-boop/agent-hub/security/advisories/new>（或在仓库页面点击 **Security** → **Report a vulnerability**）。
2. 说明漏洞细节、受影响的提交号（commit hash）以及复现步骤。

本项目是个人开源项目，尽力响应与修复，不设正式 SLA。在公开披露前，请留出合理的修复时间。

## 安全边界（代码实际机制）

Fusa 的安全模型是**单用户自用**（一个人在自己的多台设备上、使用自己的账号运行），不是多租户服务。

### 1. 本机网页端口与令牌（`src/daemon/ui-server/`）

- **仅监听本机回环**：网页 HTTP/WebSocket 服务只监听 `127.0.0.1`（默认端口 `4317`，可用 `AGENT_HUB_PORT` 修改）。切勿将其改为监听 `0.0.0.0` 或在防火墙上直接暴露该端口。
- **界面主令牌（`ui-token`）**：首次启动时，守护进程在 `<AGENT_HUB_HOME>/state/ui-token`（默认 `~/.agent-hub/state/ui-token`）生成权限为 `0600` 的主令牌，并在终端打印登录链接 `http://127.0.0.1:<端口>/auth?token=…`。任何拿到该令牌或链接的人都能登录并控制你的 Agent（进而以你的系统用户权限执行命令），请勿分享或在 Issue 中粘贴带令牌的日志。在界面点击“全部退出”会更换 `state/ui-token` 并作废所有已登录浏览器会话。
- **浏览器会话与 Cookie**：通过 `/auth?token=…`（或 5 分钟有效、单次使用的二维码登录链接 `/auth#link=…`）登录后，服务端下发 `HttpOnly`、`SameSite=Strict` 的随机每浏览器会话 Cookie（`agent_hub_ui_<端口>`，HTTPS 入口下自动加 `Secure`），数据库中仅保存会话令牌的 SHA-256 哈希（`browser_sessions` 表）。本机与 tailnet 会话不活动有效期为 365 天（`SESSION_MAX_AGE_MS`）。
- **防 DNS 重绑定与跨站请求**：本机端口要求所有请求的 `Host` 头严格匹配 `127.0.0.1:<端口>` 或 `localhost:<端口>`；所有修改状态的请求（`POST`、`PUT`、`DELETE` 等）及 WebSocket 握手（`/api/ws`）必须携带同源 `Origin` 头。
- **同系统用户边界**：以你当前系统用户运行的任何本机进程都能读取 `~/.agent-hub/state/ui-token` 和数据库。`0600` 文件权限与 `0700` 的 `run/` 目录仅隔离同机器上的其他系统用户，不防御已在你用户下运行的恶意软件。

### 2. Agent 接口 Socket（`src/daemon/agent-api/`）

- Agent 进程（`hub` 命令）通过 Unix Socket `<AGENT_HUB_HOME>/run/hub.sock`（`0600`，位于 `0700` 的 `run/` 目录下）与守护进程通信，不开 TCP 端口。
- 每个运行中的会话使用独立的内存随机令牌（`HUB_TOKEN`），会话结束即作废。

### 3. Worker 沙箱与只读模式（`src/shared/write-scope.ts`、`src/daemon/driver/write-scope.ts`）

- **普通 Worker**：在数据目录（`<AGENT_HUB_HOME>`）内，Worker 只能写自己的 worktree（`worktrees/<项目>/<Worker>`），`state/` 与其他 Worker 的目录禁止写入，由外层系统沙箱强制执行（macOS 为 `sandbox-exec`，Linux 为 `bubblewrap` `bwrap`，Linux 需先执行 `sudo scripts/linux-sandbox-setup.sh`）；若系统沙箱不可用，Worker 一律拒绝启动。**在数据目录之外，普通 Worker 拥有当前系统用户的完整权限**，可以改项目文件夹、读文件、跑命令和联网。
- **只读 Worker**：除会话私有临时目录（及必要的运行时/缓存目录）外禁止写入任何位置；MCP 连接器只放行标有 `readOnlyHint: true` 的工具；禁止读取 `state/ui-token`、各厂商令牌凭据文件、`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gh` 等目录及 `**/.env`、`**/.env.*`、`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/id_ed25519*`（`src/shared/readonly-policy.ts`）。注意：`state/hub.sqlite` 与日志对只读 Worker 保持可读以便排查问题，且只读 Worker 可以联网。
- **项目经理不受沙箱限制。**

### 4. 多设备与公网入口（`src/daemon/peers/`、`src/daemon/tunnel/`、`src/daemon/ui-server/public-entry.ts`）

- **设备配对与 SSH 隧道**：配对设备之间使用 32 字节随机设备令牌认证（接收方在 `state/peers.json` 中只存 SHA-256 哈希，权限 `0600`）。SSH 隧道使用专用密钥（`state/tunnel/id_ed25519`）与中心服务器上的受限系统账号 `agenthub-tunnel`（限制 `restrict,port-forwarding,permitlisten=…,permitopen="127.0.0.1:4319",command="/usr/sbin/nologin"`），仅连接到独立的设备入口（`run/peer.sock` 或 `127.0.0.1:4319`），该入口完全不认浏览器 Cookie，也不允许访问浏览器专用路径。
- **Tailscale serve**：经 `tailscale serve` 进入的请求必须匹配本机 tailnet 域名，且 `Tailscale-User-Login` 头必须等于设备主人（打了 tag 的设备需设置 `AGENT_HUB_TAILNET_OWNER`）。
- **公网 HTTPS 入口（可选，默认关闭）**：开启后仅监听 `run/public.sock`（`0600`）。手机从公网入口扫码兑换登录链接后只获得 `pending_approval` 待批准会话（10 分钟超时），在已登录设备点击“允许”批准前无法访问业务接口。公网 `/auth` 失败受速率限制（单 IP 每分钟最多 5 次、全局每小时最多 30 次，超限锁定 15 分钟），已批准的公网会话不活动有效期为 30 天（`PUBLIC_SESSION_MAX_AGE_MS`）。
