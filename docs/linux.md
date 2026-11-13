# 在 Linux（Ubuntu）上用 Fusa

适用 Ubuntu 22.04 / 24.04，普通用户（不是 root）跑。每一步后面附官方出处，命令以出处为准（版本号会变）。

## 1. 先弄清楚几件事

- 守护进程只听 `127.0.0.1`（`src/daemon/ui-server/server.ts`），不能直接从别的电脑打开，也**不要**改成听 `0.0.0.0` 或在防火墙/安全组里开端口。从别的电脑用第 5 节的 SSH 隧道。
- 网页的“选择…”（选文件夹）和“在 Finder / 资源管理器中显示、用默认程序打开”仅在桌面环境提供（macOS 用 `osascript` / `open`，Windows 原生桌面版经桌面外壳 `tauri-plugin-dialog` 与 `explorer.exe` 提供），Linux 服务器没有桌面。服务端把能力放在 `/api/state` 的 `server` 里，网页按它隐藏这些控件；主文件夹手填绝对路径，文件用“下载”。
- Windows 桌面应用现已改为脱离 WSL2 的纯原生版（详见 `docs/windows-native-design.md`）；如果你的项目专门依赖 Linux 工具链并希望跑在自己的 WSL2 发行版内，可直接在你自己的 WSL2 Ubuntu 终端按本文部署 Linux 版守护进程，再从 Windows 浏览器访问 `http://127.0.0.1:4317`。
- Worker 隔离（数据目录里普通 Worker 只能写自己的工作目录，只读 Worker 全盘禁写且禁读敏感凭据）在 Linux 上与 macOS 一样由 OS 沙箱强制执行：Linux 使用 `bubblewrap`（`bwrap`）包住进程（首次部署需跑一次 `sudo scripts/linux-sandbox-setup.sh` 配置 `bubblewrap`、`socat` 与 AppArmor）；若 OS 沙箱探测失败，守护进程直接拒绝派发和启动 Worker，不再退回规则兜底（见第 6 节）。

## 2. 装依赖

**Node.js ≥ 24.12**（`package.json` 的 `engines`）。Ubuntu 自带的 apt 源版本太旧，从官方下载页装预编译包：<https://nodejs.org/en/download>（选 Linux、v24，下载 `node-v24.x.y-linux-x64.tar.xz` 或 `linux-arm64`，解压到 `/usr/local` 或 `~/.local`，保证 `node` 在 PATH 里）。

**pnpm**（`packageManager` 写的是 pnpm 10）：Node 24 自带 Corepack，`corepack enable pnpm`；或 `npm install -g pnpm@latest-10`。出处：<https://pnpm.io/10.x/installation>。

**git**、**ps**：`sudo apt install git procps`（Ubuntu Server 默认就有；最小镜像/容器可能没有。守护进程用 `ps` 认残留进程、`git` 管 worktree）。

取代码、装依赖并完成 Worker 沙箱一次性配置：

```sh
git clone https://github.com/maodesikeng-boop/agent-hub.git ~/agent-hub && cd ~/agent-hub
pnpm install --frozen-lockfile
pnpm build                          # 生成 dist/web（网页），之后 systemd 直接起守护进程，不用每次重新构建
sudo scripts/linux-sandbox-setup.sh # 一次性安装 bubblewrap + socat 并配置 AppArmor（见第 6 节）
```

## 3. 装各厂商 CLI 并登录

厂商清单以 `src/vendors/registry.ts` 的名单为准，现在是 claude、agy、codex；用哪家装哪家。`scripts/provision-linux.sh` 装的命令、最后提示的登录命令都读各家 `src/vendors/<厂商>/paths.ts` 的 `installCommand`、`headlessLoginCommand`（`node scripts/print-vendors.ts` 可以直接看）。**以守护进程所在的这个用户登录**（凭据存在这个用户的家目录里）。

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

热重启（项目经理 `hub self-reload [--build]`、网页 `POST /api/self-reload`）：守护进程看到 systemd 设的 `INVOCATION_ID` 就知道退出后有人拉起；
等全库空闲后正常关机，以退出码 75（`apps/desktop/contract.json` 的 `reloadExitCode`）退出，`Restart=on-failure` 过 `RestartSec` 拉起新进程。
`--build` 先把网页构建到 `dist/` 下的暂存目录，构建失败就取消，不动正在用的 `dist/web`。不是 systemd、也不是 Fusa 应用拉起的（终端里 `pnpm start`）不接受热重启。

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
4. **添加到主屏幕与开启推送**：在 iPhone Safari 底部点“分享”→**“添加到主屏幕”**→“添加”；从手机主屏幕打开 `Fusa` 全屏图标，点左下角“设置”打开**“通知”**开关并在系统弹窗点“允许”，即可收到端到端加密的 iOS 原生锁屏推送。

## 6. Worker 沙箱：Linux 上由 `bubblewrap`（`bwrap`）强制隔离

Linux 与 macOS 走同一套外层 OS 沙箱后端表（`src/daemon/driver/write-scope.ts` 的 `OS_SANDBOX_BACKENDS`），**不再退回提示词或命令行字面规则兜底**：

- **普通 Worker（`bwrapArgs`）**：整个 Worker 进程包进 `bwrap`（`--unshare-user --disable-userns --unshare-pid --bind / / --proc /proc --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid>`），先把数据目录（`~/.agent-hub`）以 `--ro-bind` 只读挂载保护 `state/` 与其他 Worker 目录，再把当前 Worker 自己的可写目录（worktree）以 `--bind` 可写挂回；同时隔离 `/proc`（隐藏沙箱外进程）、用空 `tmpfs` 遮住 `/run/user/<uid>`（防借宿主机 `systemd --user` / D-Bus 写穿）、加 `--disable-userns` 禁止嵌套新建 userns，并自动关闭各厂商 CLI 自带沙箱避免嵌套报错。与 macOS 一样，**数据目录之外不做写入限制**，Worker 仍以当前系统用户权限读写项目目录与外部路径。
- **只读 Worker**：`claude` 与 `codex` 使用各自原生只读沙箱（`claude` 依赖 `bubblewrap` + `socat`，`codex` 使用自带 Linux 沙箱）；`agy` 包进外层只读 `bwrap`（`readonlyBwrapArgs`，全盘 `--ro-bind / /`，仅放行会话私有临时目录、运行时与缓存目录，已存在的敏感目录挂 `--tmpfs`、敏感文件及启动时 `scanSecretGlobs` 在 `cwd`/`addDirs` 扫出的 `.env` 等密钥文件挂 `--ro-bind /dev/null`）。
- **Ubuntu 24.04+ 一次性初始化（`scripts/linux-sandbox-setup.sh`）**：Ubuntu 24.04 默认开启 `kernel.apparmor_restrict_unprivileged_userns=1`，未配 AppArmor profile 时非特权 `bwrap` 建 userns 会报 `Permission denied`。首次部署跑一次幂等脚本：
  ```sh
  sudo scripts/linux-sandbox-setup.sh
  ```
  脚本会自动安装 `bubblewrap` 与 `socat`，写入并加载 `/etc/apparmor.d/bwrap` 放行 `/usr/bin/bwrap` 的 `userns`，最后切回普通用户跑一次探测命令验证（输出 `bwrap-ok`）。
- **探测失败一律阻断（无规则兜底）**：守护进程通过 `probeLinuxBwrap`（`osSandboxAvailable`）执行与真实启动一致的 `bwrap` 探测命令；若沙箱不可用，普通 Worker 与只读 Worker **一律报错拒绝派发和启动**，并提示执行 `sudo scripts/linux-sandbox-setup.sh`。探测结果**只缓存 `true`、不缓存 `false`**，管理员跑完配置脚本后无需重启 `agent-hub` 守护进程，下次派 Worker 即刻生效。项目经理（`scope === null`）不受沙箱限制。

完整设计与已知边界（如只读通配启动时扫描、勿在同用户下开不设防的外部 `tmux` socket 等）见 `docs/write-scope.md` 与 `docs/linux-sandbox-design.md`。

## 7. 跟 macOS 不一样的地方（汇总）

| 项 | macOS | Linux |
| --- | --- | --- |
| 选择文件夹（“选择…”） | 弹系统对话框（osascript） | 隐藏，手填绝对路径 |
| 在 Finder 中显示 / 用默认程序打开 | `open` | 隐藏，用“下载” |
| Worker 沙箱 | `sandbox-exec` 强制（系统自带） | `bubblewrap`（`bwrap`）强制（首次需跑 `sudo scripts/linux-sandbox-setup.sh` 配置 `bubblewrap`、`socat` 与 AppArmor；不可用时拒绝起 Worker） |
| CLI 查找 | `PATH`；codex 另看 ChatGPT.app 里带的 | `PATH`，再 `~/.local/bin`、`~/.npm-global/bin`、`/usr/local/bin`、Linuxbrew |
| agent 接口 socket 路径上限 | 103 字节 | 107 字节（用同一个更保守的 103，不放宽） |
| 发给用户的文件，不许分享的路径 | 另含 `Library/Keychains` 等 | 另含 `~/.local/share/keyrings`、浏览器配置、`/proc` |
| 防闲置睡眠 | 有会话在干活时起 `/usr/bin/caffeinate -i -w <守护进程 pid>`，全闲下来 2 分钟后结束（合盖用电池照样会睡，macOS 强制） | 无（服务器常开；以后支持 Linux 笔记本再加 `systemd-inhibit`） |
