# 在 Linux（Ubuntu）上用 Piece

适用 Ubuntu 22.04 / 24.04，普通用户（不是 root）跑。每一步后面附官方出处，命令以出处为准（版本号会变）。

## 1. 先弄清楚几件事

- 守护进程只听 `127.0.0.1`（`daemon/ui-server/server.ts`），不能直接从别的电脑打开，也**不要**改成听 `0.0.0.0` 或在防火墙/安全组里开端口。从别的电脑用第 5 节的 SSH 隧道。
- 网页的“选择…”（选文件夹）和“在 Finder 中显示 / 用默认程序打开”只有 macOS 上有：它们靠 `osascript`、`open` 在运行守护进程的机器的桌面上弹窗，Linux 服务器没有桌面。服务端把能力放在 `/api/state` 的 `server` 里，网页按它隐藏这些控件；主文件夹手填绝对路径，文件用“下载”。
- Worker 可写范围（数据目录里只能写自己的工作目录）在 macOS 上由 `sandbox-exec` 强制，**Linux 上暂时没有 OS 沙箱，只有各家的“规则”兜底**（见第 6 节）。Linux 沙箱是另一个任务。

## 2. 装依赖

**Node.js ≥ 24.12**（`package.json` 的 `engines`）。Ubuntu 自带的 apt 源版本太旧，从官方下载页装预编译包：<https://nodejs.org/en/download>（选 Linux、v24，下载 `node-v24.x.y-linux-x64.tar.xz` 或 `linux-arm64`，解压到 `/usr/local` 或 `~/.local`，保证 `node` 在 PATH 里）。

**pnpm**（`packageManager` 写的是 pnpm 10）：Node 24 自带 Corepack，`corepack enable pnpm`；或 `npm install -g pnpm@latest-10`。出处：<https://pnpm.io/10.x/installation>。

**git**、**ps**：`sudo apt install git procps`（Ubuntu Server 默认就有；最小镜像/容器可能没有。守护进程用 `ps` 认残留进程、`git` 管 worktree）。

取代码并装依赖：

```sh
git clone <仓库地址> ~/agent-hub && cd ~/agent-hub
pnpm install --frozen-lockfile
pnpm build        # 生成 dist/web（网页），之后 systemd 直接起守护进程，不用每次重新构建
```

## 3. 装各厂商 CLI 并登录

厂商清单以 `src/shared/vendors.ts` 的 `VENDOR_SPECS` 为准，现在是 claude、agy、codex；用哪家装哪家。**以守护进程所在的这个用户登录**（凭据存在这个用户的家目录里）。

| 厂商 | 安装（Linux） | 登录 | 装到哪（守护进程会找） |
| --- | --- | --- | --- |
| claude（Claude Code） | `curl -fsSL https://claude.ai/install.sh \| bash`，或 `npm install -g @anthropic-ai/claude-code` | 运行 `claude`；远程没浏览器时，浏览器里登录后把页面上的登录码粘回终端，或用 `claude auth login` | `~/.local/bin/claude`（原生安装）；npm 全局 |
| agy（Antigravity CLI） | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | 运行 `agy`；SSH 里会打印授权链接，本地浏览器登录后把授权码粘回；也可用 Gemini API key。Linux 登录令牌存在系统钥匙环（Secret Service / D-Bus），无桌面时见 agy 的 troubleshooting | `~/.local/bin/agy` |
| codex（Codex CLI） | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`，或 `npm install -g @openai/codex` | `codex login --device-auth`（无浏览器的机器用设备码） | `~/.local/bin/codex`（`CODEX_INSTALL_DIR` 可改）；npm 全局 |

出处：
- claude 安装与 `~/.local/bin/claude`：<https://code.claude.com/docs/en/setup>（“Install with npm”、安装脚本一节）；登录与 SSH 里的登录码：<https://code.claude.com/docs/en/troubleshoot-install>（“OAuth login fails in WSL2, SSH, or containers”）、<https://code.claude.com/docs/en/authentication>（Linux 凭据存 `~/.claude/.credentials.json`）。
- agy 安装、默认位置 `~/.local/bin/agy`、SSH 登录、钥匙环：<https://www.agy.dev/docs/cli/install>、<https://antigravity.google/docs/cli/troubleshooting>。
- codex 安装与 `CODEX_INSTALL_DIR` 默认 `~/.local/bin`：<https://developers.openai.com/codex/cli>、<https://developers.openai.com/codex/environment-variables>；无头登录：<https://developers.openai.com/codex/auth>（“Login on headless devices”）。

### 守护进程怎么找 CLI

先看 `PATH`（命中就用命令名）；`PATH` 里没有再按顺序试这些位置（`src/shared/paths.ts` 的 `linuxInstallDirs`，每家厂商都有，`VENDOR_FALLBACK_PATHS` 保证加厂商不会漏）：

1. `~/.local/bin`：三家的安装脚本都装在这里；
2. `~/.npm-global/bin`：npm 官方“全局安装不用 sudo”的前缀做法（<https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally>）；
3. `/usr/local/bin`：npm 全局安装在 Linux 上的默认前缀；
4. `/home/linuxbrew/.linuxbrew/bin`：Homebrew 在 Linux 上的默认前缀（<https://docs.brew.sh/Homebrew-on-Linux>）。

codex 另外还认 `~/.codex/plugins/.plugin-appserver/codex-cli/bin/codex`（原有位置）。这样 systemd 用户服务的 `PATH` 里没有 `~/.local/bin` 也能找到。装在别处的用环境变量指定：`AGENT_HUB_CLAUDE`、`AGENT_HUB_AGY`、`AGENT_HUB_CODEX`（写绝对路径，`~/` 会展开）。

## 4. 以 systemd 用户服务常驻

`~/.config/systemd/user/agent-hub.service`（用户单元放这里：<https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html>，`%h` 是家目录）：

```ini
[Unit]
Description=agent-hub

[Service]
WorkingDirectory=%h/agent-hub
# systemd 用户服务的 PATH 很短，没有 ~/.local/bin；Worker 里的 node、pnpm、git 都靠它。按你装的位置改。
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node src/daemon/main.ts
Restart=on-failure
RestartSec=5
# 关机最多 30 秒（SHUTDOWN_TOTAL_MS），多留几秒
TimeoutStopSec=40

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-hub
loginctl enable-linger "$USER"   # 没登录也开机自启、退出 SSH 后不被停
journalctl --user -u agent-hub -f
```

- `Environment=`、`Restart=`、`TimeoutStopSec=`：<https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html>、<https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html>。
- `loginctl enable-linger`（让用户管理器开机就起、退出登录后不结束）：<https://www.freedesktop.org/software/systemd/man/latest/loginctl.html>。
- 想改端口、数据目录：在 `[Service]` 里加 `Environment=AGENT_HUB_PORT=4317`、`Environment=AGENT_HUB_HOME=%h/.agent-hub`（数据目录里的 `run/hub.sock` 路径有长度上限，别设太深）。
- 更新代码：`git pull && pnpm install --frozen-lockfile && pnpm build && systemctl --user restart agent-hub`。

登录链接在日志里（`journalctl --user -u agent-hub`，形如 `http://127.0.0.1:4317/auth?token=…`）；令牌也在 `~/.agent-hub/state/ui-token`，重启不变。

## 5. 从别的电脑安全访问

守护进程只听 `127.0.0.1`，所以不需要也不应该开公网端口。用 SSH 隧道，把本机端口转到服务器的 `127.0.0.1`（`ssh -L`：<https://man.openbsd.org/ssh.1>）：

```sh
ssh -N -L 4317:127.0.0.1:4317 <用户>@<服务器>
```

然后在本机浏览器打开日志里那条登录链接（`http://127.0.0.1:4317/auth?token=…`）。**本机端口必须和服务器上的 `AGENT_HUB_PORT` 一样**：界面服务会校验 `Host` 和 `Origin` 的端口（防 DNS 重绑定，`server.ts`），端口对不上回 403。

不想对公网暴露 SSH：用 Tailscale 把两台机器放进同一个私有网络，再照上面的命令 ssh 到服务器的 tailnet 名字（或 `tailscale ssh`），服务器上关掉公网的 22。出处：<https://tailscale.com/docs/features/tailscale-ssh>、<https://tailscale.com/docs/reference/ssh-over-tailscale>。注意：不要用 `tailscale serve` / 反向代理直接把网页端口转出去——请求的 `Host` 会变成 tailnet 名字，被上面的校验拒绝；要用就走 SSH 隧道。

### 手机公网访问：开启免费 Tailscale Funnel 与 iPhone 主屏 App

需要让手机在公网（5G / 任意 Wi-Fi，手机与 Mac 均无需安装或开启 Tailscale VPN）访问并接收 iOS 锁屏推送时，走守护进程独立的 `run/public.sock` 公网入口与 Tailscale Funnel（`docs/mac-app-and-mobile-design.md` 第 2 节）：

1. **开启公网入口**：在已登录电脑打开“设置 → 设备 → 公网入口”，确认公网域名（如 `tokyo.tailnet.ts.net`）并点**“开启”**，守护进程开始监听 `~/.agent-hub/run/public.sock`（权限 `0600`）。
2. **东京运行一次 Funnel 命令**：复制设置页给出的命令，在东京服务器终端执行：
   ```sh
   sudo tailscale funnel --bg unix:/home/ubuntu/.agent-hub/run/public.sock
   ```
   （若首次使用 Funnel，按终端输出的链接开启 tailnet 的 Funnel 权限即可。出处：<https://tailscale.com/kb/1223/funnel>。）
3. **iPhone 扫码与电脑批准**：在已登录电脑打开“设置 → 登录 → 在手机上登录”点“显示二维码”；用 iPhone 系统相机扫码（Safari 打开 `https://<tokyo>.<tailnet>.ts.net/auth#link=…`，显示“已扫码，请在已登录的电脑上点「允许」完成登录…”），在电脑“设置 → 已登录的浏览器”顶部点**“允许”**，手机即自动进入首页。
4. **添加到主屏幕与开启推送**：在 iPhone Safari 底部点“分享”→**“添加到主屏幕”**→“添加”；从手机主屏幕打开 `Piece` 全屏图标，点左下角“设置”打开**“通知”**开关并在系统弹窗点“允许”，即可收到端到端加密的 iOS 原生锁屏推送。

## 6. Worker 可写范围：Linux 上暂时只有“规则”

macOS 上整个 Worker 进程包在 `sandbox-exec` 里，数据目录强制不可写。Linux 上没有这层：起 Worker 不会报错、不会被拦，只在日志里记一条警告（`[write-scope] …警告：这台机器（linux）还没有 OS 沙箱…退回到规则兜底，不是强制的`），每家退回到自己的规则：

- claude：设置文件里 `state/` 的 Edit 拒绝规则（只管编辑工具，管不住 shell）；
- agy：按工具参数和命令行字面检查（看不出脚本里拼出来的路径）；
- codex：codex 自己的 workspace-write 沙箱加审批按命令行字面检查。

也就是说 Linux 上 Worker 理论上还能用 shell 写到自己工作目录以外（包括数据目录）。**不要在这台机器上放不能被 Worker 误碰的东西**，或者单独用一个只装这个服务的用户来跑。Linux 沙箱做好后这一节会更新。详细的限制见 `docs/write-scope.md`。

## 7. 跟 macOS 不一样的地方（汇总）

| 项 | macOS | Linux |
| --- | --- | --- |
| 选择文件夹（“选择…”） | 弹系统对话框（osascript） | 隐藏，手填绝对路径 |
| 在 Finder 中显示 / 用默认程序打开 | `open` | 隐藏，用“下载” |
| Worker 可写范围 | `sandbox-exec` 强制 | 只有规则，日志里有警告 |
| CLI 查找 | `PATH`；codex 另看 ChatGPT.app 里带的 | `PATH`，再 `~/.local/bin`、`~/.npm-global/bin`、`/usr/local/bin`、Linuxbrew |
| agent 接口 socket 路径上限 | 103 字节 | 107 字节（用同一个更保守的 103，不放宽） |
| 发给用户的文件，不许分享的路径 | 另含 `Library/Keychains` 等 | 另含 `~/.local/share/keyrings`、浏览器配置、`/proc` |
| 防闲置睡眠 | 有会话在干活时起 `/usr/bin/caffeinate -i -w <守护进程 pid>`，全闲下来 2 分钟后结束（合盖用电池照样会睡，macOS 强制） | 无（服务器常开；以后支持 Linux 笔记本再加 `systemd-inhibit`） |
