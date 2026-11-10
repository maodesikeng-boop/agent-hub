# Windows 桌面版与 README 定位方案

状态：待用户拍板。本轮只提交方案，不改代码和 README。核对基线为 `4e18b20`，官方资料查阅于 2026-11-10。预计阅读 12–15 分钟。

## 1. 推荐先做 WSL2 后台 + Tauri 桌面壳

Windows 用户双击 Fusa，在独立应用窗口里使用现有界面。外壳负责安装引导、后台监管、登录、托盘和更新；Node 后台及 Worker 在 WSL2 的 Linux 环境运行。手机继续通过网页或添加到主屏幕的 PWA 访问。

推荐 **A 路线：WSL2 + Tauri 2**，首发支持 Windows 11 x64，使用独立的 Ubuntu 24.04 发行版实例。Mac 保留 Swift 外壳。Windows ARM64 和 Windows 10 暂不承诺，等有对应真机再扩展。

主要理由是后台已经有 Linux 的 bwrap 沙箱和进程清理实现。原生 Windows 的最大工作量是重新建立所有厂商共用的隔离边界，远超过做一个应用窗口。WSL2 的代价也必须明确：首次安装需要管理员授权、可能重启，运行时有虚拟机内存开销，不能直接把 Windows 工作目录当作推荐项目目录。

| 路线 | 可复用部分 | 新工作和主要风险 | 判断 |
| --- | --- | --- | --- |
| A：Windows 壳，WSL2 后台 | Node 后台、Linux bwrap、Unix socket、Linux CLI、git worktree | WSL 安装、登录、Windows 与 Linux 边界、冷启动、真机验证 | 首发推荐，约 15–24 人日，详见第 8 节 |
| B：后台原生 Windows | 网页、账本、HTTP 协议、厂商协议的大部分 | 通用 OS 沙箱、Job Object、命名管道、脚本与路径移植 | 暂缓，后台额外约 27–45 人日，再加外壳和发行工作 |

以上都是设计估算，按一名熟悉项目的工程师计算，不是实测工期，不含等用户验收和签名账号开通的时间。

当前代码 `src/daemon/driver/write-scope.ts` 已登记 Linux bwrap 后端，探测失败会阻止 Worker。`docs/linux.md` 第 6 节仍写“规则兜底”，与代码不符；实现时同步纠正，不能照旧文档降低 Windows 的保护要求。关联设计见 [Linux 沙箱](linux-sandbox-design.md)、[Mac 与手机](mac-app-and-mobile-design.md)、[厂商插件化](vendor-plugin-design.md)。

## 2. A 路线的首次安装与日常运行

### 2.1 首次安装有引导，平时直接开窗口

外壳先显示本地的准备页面，缺后台时也能给出原因和操作入口。所有首次准备按阶段记录完成状态，失败可重试，不覆盖已有项目和登录信息。

1. 用 `wsl.exe --status`、`wsl.exe --version`、`wsl.exe --list --verbose` 检查 WSL 和发行版。按退出码及结构化后的结果判断，不能匹配某一句英文报错；测试覆盖中文系统与 UTF-16 输出。
2. 缺 WSL 时，用户在引导中选择安装，外壳通过系统提权执行 `wsl --install --no-distribution`。检测虚拟化和系统组件失败时显示微软排障入口。需要重启就保存阶段，用户重启后再打开 Fusa；外壳本身始终以普通用户运行。
3. 默认创建名为 `Fusa` 的独立 WSL2 实例。按 Ubuntu 官方安装资料取得 Ubuntu 24.04 官方镜像，锁定下载地址、版本、校验值和许可，采用微软支持的 `wsl --import Fusa <安装目录> <rootfs.tar> --version 2`。镜像格式必须先在真机确认可导入；不自行发布来路不明的根文件系统。安装目录放当前用户的本地应用数据目录，不能放网络盘。
4. 导入后以 root 仅执行系统依赖安装及创建普通 Linux 用户 `fusa`，日常命令显式带 `--distribution Fusa --user fusa`，不依赖用户的默认发行版。发现同名而无安装标记的发行版时停止导入，提示解决名称冲突，不能删除或接管。
5. 第一版不自动改已有 Ubuntu。高级用户复用现有发行版的入口后置，因为下述 interop 隔离设置会影响其工作流。卸载 Windows 壳也保留发行版和数据；删除数据另行明确操作。

微软说明新安装默认使用 WSL2、安装可能要求重启，并提供发行版导入方法。来源：[安装 WSL](https://learn.microsoft.com/en-us/windows/wsl/install)、[WSL 命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)、[WSL 发行版导入](https://learn.microsoft.com/en-us/windows/wsl/use-custom-distro)、[Ubuntu WSL 安装](https://ubuntu.com/wsl/docs/stable/howto/install-ubuntu-wsl2/)。具体镜像版本与自动化导入产物尚未在 Windows 验证，是第 1 步实现的验证项。

### 2.2 Node、项目和 CLI 都装在 Linux 用户下

准备器在发行版内装 `git`、`procps`、`curl`、`ca-certificates`、`bubblewrap`、`socat`，复用并检查 `scripts/linux-sandbox-setup.sh` 的适用条件，不能假设 WSL 内核和东京服务器的 AppArmor 状态相同。先运行现有 bwrap 探测，再运行写入拒绝测试；失败就禁用派 Worker 并显示修复原因。

Node 使用官方 Linux 预编译包，锁定经验证的 Node 24 补丁版本且不低于仓库要求 24.12，校验官方校验值，装到应用管理的 Linux 用户目录。pnpm 按 `package.json` 的 `packageManager` 锁到当前 `10.34.5`，例如用该 Node 的 npm 安装指定版本到用户前缀，不用 `latest`，不依赖系统预装 Corepack。来源：[Node 下载](https://nodejs.org/en/download)、[pnpm 安装](https://pnpm.io/installation)。

首发在首次准备阶段下载经过校验的 Fusa 发布包，包含后台源码、锁文件和已构建的 `dist/web`，在版本目录内完成依赖安装。开发模式才从仓库运行 `pnpm install --frozen-lockfile`、`pnpm build`。平时直接用确定的 Node 路径运行 `src/daemon/main.ts`，不走会重建网页的 `pnpm start`。

外壳从厂商注册表读取“支持的平台、安装说明、登录命令、探测结果”，只显示用户选用的厂商。安装和登录动作放在各家 `src/vendors/<id>/` 内；按插件方案扩展可选的安装元数据，不能在 Windows 壳或公共准备器里写三家分支。下表只是本次核查现有插件的事实，不是新的公共名单。

| 现有 CLI | WSL 内安装和登录 | 原生 Windows 官方情况 |
| --- | --- | --- |
| claude | 官方 Linux 安装脚本 `https://claude.ai/install.sh`；在同一 Linux 用户下运行 `claude auth login`，浏览器授权在 Windows 完成，必要时按官方 WSL 登录排障粘回授权码 | 官方提供 PowerShell、CMD、WinGet 安装，并单列 WSL 安装说明，不能再写“不支持 Windows” |
| agy | 官方 Linux 安装脚本 `https://antigravity.google/cli/install.sh`；运行 `agy` 登录，授权链接交给 Windows 浏览器。Linux 使用 Secret Service 和 D-Bus，需同一用户可访问并已解锁的钥匙环 | 官方提供 PowerShell 与 CMD 安装；凭据使用 Windows Credential Manager |
| codex | 在 Linux 用户前缀用 `npm install -g @openai/codex@<已验证版本>`；优先 `codex login --device-auth`，用户在 Windows 浏览器输入设备码，账号或组织需允许设备码登录 | 官方已有原生 Windows 方案和 Windows 沙箱，也保留 WSL 路线；本项目仍需验证 app-server 驱动契约 |

来源：[Claude 安装](https://code.claude.com/docs/en/setup)、[Claude 登录排障](https://code.claude.com/docs/en/troubleshoot-install)、[Antigravity CLI 快速开始](https://antigravity.google/docs/getting-started?tab=cli)、[Antigravity 钥匙环排障](https://antigravity.google/docs/cli/troubleshooting)、[Codex CLI](https://developers.openai.com/codex/cli)、[Codex 登录](https://developers.openai.com/codex/auth)、[Codex Windows](https://developers.openai.com/codex/windows/)。旧的 agy 安装文档地址已重定向，采用当前官方入口。

登录命令由外壳打开交互式 WSL 终端执行，不把密码或登录码交给模型。凭据保存在发行版的 Linux 用户下，不从 Windows 复制一份。每家成功后独立显示可用，其余未安装或未登录不阻止窗口和其他厂商运行。

agy 在无桌面 WSL 中的钥匙环初始化、解锁以及 bwrap 遮住 `/run/user/<uid>` 后能否持续认证，**未确认**。原理不能替代实测。先验证厂商正常认证与 Worker 隔离可同时成立；不为“能登录”直接把宿主 D-Bus socket 放进 Worker。若不成立，首发该插件显示不可用和原因，不能把整个平台悄悄降到无沙箱。

### 2.3 WSL 不自动等于已有 Linux 沙箱安全

微软默认允许 WSL 调用 Windows 程序，也挂载 Windows 磁盘。照搬 bwrap 后，Worker 若能调用 `powershell.exe` 或 `wsl.exe`，可能在沙箱外执行操作。它是首发阻断项。

在新建的专用发行版内设置 `wsl.conf`：`[interop] enabled=false`、`appendWindowsPath=false`，并关闭 Windows 磁盘自动挂载。配置应用前只终止本应用尚未启动任务的专用实例，不执行全局 `wsl --shutdown`。来源：[WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)。

在 Worker 里验证无法启动 Windows exe、重开非沙箱 WSL、访问 interop socket，无法借宿主 D-Bus、tmux 或额外挂载写穿数据目录。普通用户不能有免密码 sudo。具体 bwrap 需要遮住哪些 WSL 专属入口，以真机验证结果集中补到 Linux 后端，不能把“已关 PATH”当作已封住调用。专用发行版内不开 Windows 浏览器，授权链接由外壳取出后在 Windows 打开。

### 2.4 后台监管和端口连接

Windows 外壳通过带独立参数的 `wsl.exe -d Fusa -u fusa --exec <node绝对路径> <后台入口>` 启动，工作目录和环境通过固定的 Linux 启动入口设置。不要拼接用户输入形成 `sh -c`。保存发行版、Linux 用户、版本目录、实例编号和本次启动所有权。

日常只由外壳负责自动拉起，不同时启用 Linux systemd 的 Restart。`wsl.exe` 是 Windows 侧代理，结束它不能直接视为 Linux 子孙已经结束。停止通过发行版内的受认证控制入口触发后台优雅退出；以启动实例编号和 Linux 进程身份确认完成。后台关闭预算目前是 30 秒，外壳留 40 秒；超时仅清理自己这次启动的进程树，不能 `pkill node` 或终止整个发行版。需验证 wsl 代理退出码、异常断开、后台子孙残留，不能只测代理 PID。

后台继续监听 `127.0.0.1:4317`，Windows WebView 访问同一个地址。微软支持 Windows 通过 localhost 访问 WSL2 网络应用；默认 NAT 的 `localhostForwarding` 配置与 mirrored 模式分别测试。首次先在 WSL 内探活，再在 Windows 探活，定位后台失败和转发失败。来源：[WSL 网络](https://learn.microsoft.com/en-us/windows/wsl/networking)、[localhostForwarding 设置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)。

不加常驻 `netsh portproxy`，不把后台绑定到 `0.0.0.0` 兜底。若默认端口被 Windows 或其他发行版占用，提示用户选择端口，并让后台、外壳与 Cookie 使用同一个端口，保持现有 Host 和 Origin 校验。VPN、企业防火墙和自定义 WSL 网络配置能否正常转发，要真机验证。

### 2.5 文件和登录令牌只有一个主位置

- 发行版内 `~/.agent-hub` 存账本、日志、worktree 和运行 socket；用户项目放 `/home/fusa/projects`。Fusa 运行包另放 `/home/fusa/.local/share/fusa/releases/<版本>`。数据库和 `node_modules` 不落在 `/mnt/c`。
- Windows 侧只存壳设置、WebView 用户数据、引导日志及发行版 VHDX 的安装位置。VHDX 物理上在 Windows 盘，不等于从 `/mnt/c` 读写项目文件。
- 选项目用应用内的 Linux 目录选择器，Windows 本地仓库通过明确的“导入到 Linux”流程复制或重新 clone；展示其新位置。不能偷偷复制后继续让用户编辑旧目录。
- 文件上传和下载通过现有 HTTP 服务。需要在资源管理器显示文件时由壳打开 `\\wsl$\Fusa\home\fusa\...`，只在用户操作时访问，不在那里扫描项目。
- 壳通过固定的 `wsl.exe` 调用读取 Linux `state/ui-token`，只在内存中用于本机 `POST /auth` 兑换会话 Cookie。Cookie 进入当前 WebView 的 Cookie 存储，不能只留在 Rust HTTP 客户端。令牌不进 URL、日志、命令参数或网页通用桥接对象。

微软明确建议 Linux 工具把文件放 WSL 文件系统以提高性能，并说明 `\\wsl$` 访问方式；没有可直接套用到本项目的固定减速倍数。[跨文件系统说明](https://learn.microsoft.com/en-us/windows/wsl/filesystems)。

## 3. B 路线需要真正移植后台

以下工作量是后台额外成本，不能用 Electron 自带 Node 抵消。

| 项目与现有位置 | 原生 Windows 的做法 | 估算与验收 |
| --- | --- | --- |
| `driver/write-scope.ts` 与 `src/shared/write-scope.ts` | 成熟 OS 原语是 AppContainer、受限令牌、独立低权限用户及文件 ACL。先做 AppContainer 可行性验证；不把 Job Object 当文件沙箱，不直接改当前用户整个 home 的 ACL | 12–20 人日。验证动态目录放行、数据目录拒写、凭据禁读、junction 和符号链接、子进程继承、CLI 和连接器兼容；无等价保护就阻止 Worker |
| `driver/process.ts`、driver spawn、setup 和 shutdown | 用 Win32 Job Object 管理整个进程树，设置 kill-on-job-close，创建时先挂 Job 再运行，限制 breakaway。正常退出走应用协议，超时关 Job；不能沿用负 PID、`ps` 和 POSIX 信号语义 | 4–6 人日。孙进程、脱离父进程、启动即取消、后台崩溃后均无残留；检查 CI 已有 Job 的嵌套行为 |
| `run-socket.ts`、hub CLI、agent API、ui 与 peer 入口 | 用 Node 支持的 Windows 命名管道 `\\.\pipe\fusa-<用户>-<实例>-hub`；统一生成端点，保留 `HUB_SOCK` 为端点字符串。Unix 分支才做 realpath、chmod、路径长度检查和 unlink；Windows 处理管道生命周期与当前用户 ACL | 3–5 人日。hub、ui、peer、public 端点一起梳理；跨用户连接拒绝。Token 校验继续保留。公网转发工具是否支持管道另验，不能照抄 Unix socket 配置 |
| `setup/setup.ts`、`installHubShim`、`scripts/`、测试假程序 | 准备命令显式支持 PowerShell 或选定 Bash，写清项目脚本兼容要求；hub 启动器生成 `.cmd` 或原生入口；安装与发布用 Tauri 和标准 CI 工具 | 3–5 人日。去掉 `/bin/sh`、shebang、chmod、osascript 等假设；同测退出码、空格、中文、参数引用和 Ctrl+C |
| `shared/paths.ts`、worktree、文件分享与各插件 paths | 用 `node:path`、`path.delimiter`、文件 URL；区分磁盘路径、URL 和容器路径；处理盘符、UNC、大小写、长路径、junction、`.exe` 与 `.cmd` 查找 | 3–5 人日。路径测试和真 git worktree 通过，不对所有字符串统一替换斜杠 |
| 各家 `src/vendors/<id>/` | 各插件声明平台支持并提供安装、登录及 CLI 参数。官方支持 Windows 不等于 Fusa 的流式协议、恢复、审批和沙箱组合已通过 | 2–4 人日。逐家跑驱动契约与真实一轮、停止、恢复、连接器；不支持的能力明确禁用 |

[AppContainer 官方说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)提供文件、网络与进程隔离原语；把任意开发工具跑进去仍是本项目的适配工作。[Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)提供进程集合管理。[Node IPC](https://nodejs.org/api/net.html#ipc-support)确认 Windows 使用命名管道。未找到可以直接替换本项目 bwrap、适用于所有 CLI 且已验证的成熟通用库，不能宣称装一个包就完成隔离。Codex 的官方 Windows 沙箱也不等于其他插件的通用沙箱。

`HUB_SOCK` 统计可在本轮基线重跑：

```sh
rg -l HUB_SOCK src scripts test apps
rg -l HUB_SOCK src scripts test apps | wc -l
rg -l HUB_SOCK src scripts test apps | rg -v '(test|smoke)' | wc -l
```

共 **31 文件，其中 11 个非测试文件**，含注释命中。这不是 31 处都要改传输。11 个文件是 `src/hub/cli.ts`、`src/shared/{hub,limits,driver}.ts`、`src/daemon/{run-socket,daemon,launch}.ts`、`src/daemon/agent-api/server.ts`、`src/daemon/handover/forker.ts`、`src/vendors/{agy,claude}/handover.ts`。另有未出现该字面量的 ui、peer、public socket 调用方，也要从 `listenOnRunSocket` 调用链核查。

## 4. 外壳选 Tauri，Mac 先保留 Swift

| 方案 | 大小与内存的依据 | 更新、签名、托盘、自启 | 本项目取舍 |
| --- | --- | --- | --- |
| Tauri 2 | Windows 复用 WebView2，不额外带一份 Chromium；实际包体和工作集须测，不能引用空白示例当 Fusa 数据 | 官方有 NSIS/MSI 打包、updater、Windows 签名、托盘、autostart 插件 | 推荐。安装、托盘和更新直接用成熟组件，新增少量 Rust 负责 WSL 进程监管 |
| Electron + Forge | 随程序分发 Chromium 和 Node；不能免掉 WSL 内后台。具体 MB、启动秒数未对本项目实测 | Forge 是官方推荐打包工具；有 autoUpdater、Tray、登录启动 API 和签名流程 | 成熟度足够，但重复携带浏览器和 Node，不符合当前轻量外壳的优先级 |
| C#/.NET + WPF + WebView2 | 同样复用 WebView2；自包含 .NET 包还要带运行时，依赖安装模式则需先装 .NET | 托盘可用 NotifyIcon；需另选 MSIX/App Installer 或其他成熟安装更新体系，并接 Windows 签名与自启 | Windows 原生集成合适，但本项目需要更多安装更新组装，没有跨平台外壳复用收益 |

官方依据：[Tauri Windows 安装包](https://v2.tauri.app/distribute/windows-installer/)、[updater](https://v2.tauri.app/plugin/updater/)、[托盘](https://v2.tauri.app/learn/system-tray/)、[autostart](https://v2.tauri.app/plugin/autostart/)、[Windows 签名](https://v2.tauri.app/distribute/sign/windows/)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[Electron 打包](https://www.electronjs.org/docs/latest/tutorial/application-distribution/)、[Electron 更新](https://www.electronjs.org/docs/latest/tutorial/updates)、[Electron 托盘](https://www.electronjs.org/docs/latest/tutorial/tray)、[WebView2 分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[.NET 托盘组件](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/notifyicon-component-windows-forms)、[MSIX 更新](https://learn.microsoft.com/en-us/windows/msix/app-installer/auto-update-and-repair--overview)。

Windows 发布用 Tauri 的 NSIS 用户安装包和 WebView2 Evergreen 检测、引导安装。首发在线安装，WSL、Linux 镜像和 CLI 的下载量另计，不把缺运行时的几 MB 壳宣传成完整离线产品。离线包后置。日常无需管理员权限。

自动更新用 Tauri updater 的签名校验，Windows 安装包和 exe 另做 Authenticode 签名；两种签名用途不同。签名证书、服务账号及密钥保管要项目所有者配置。未签名内测包明确标注，不能承诺 SmartScreen 一定不提示。更新先下载并验证壳与后台的同版本发布清单，后台版本目录切换失败可回滚；有任务时只提示，用户选择维护时再退出后台和更新。数据库迁移有版本检查与备份，不承诺旧程序能打开新数据库。

窗口使用现有 `src/web`，只给受信任的本机界面必要的窄桥接能力。网页不能传任意 shell 命令或任意 WSL 路径让壳执行。外链交给系统浏览器，远程页面不获得本地能力。初版用系统标题栏，避免先做一套自绘 Windows 控件。

菜单与 Mac 对齐：显示 Fusa、重启后台服务、上次崩溃时间与原因、打开日志、登录时启动、彻底退出。关闭窗口只隐藏到托盘，彻底退出才停自己拉起的后台；复用外部后台时显示“外部管理”，不把退出壳说成停掉了所有服务。自启默认关闭，指“Windows 用户登录后启动壳并准备后台”，不是未登录时开机运行系统服务。

Mac 保留已经工作的 Swift/AppKit/WKWebView，不为 Windows 首发重写。两端共用前端、发布版本和监管约定，比立即迁移外壳风险小。若未来两套壳频繁重复修改，再用 Tauri 的 Mac 原型对比现有功能、体积与启动性能，另提迁移方案。

## 5. 统一的是约定和验收，不再多起一个监管后台

新增 `apps/desktop/contract.json` 作为两种壳构建时读取或生成常量的来源，包含协议版本、探测接口、重试预算、日志上限和菜单动作编号。Swift 与 Rust 分别实现系统操作，共用故障场景数据；不为复用少量状态逻辑增加一个常驻 Node 监管进程。

| 约定 | Mac 与 Windows 的一致行为 |
| --- | --- |
| 就绪 | 默认端口 4317，探测 `/api/auth/status`。新增能识别产品、协议版本、实例编号的轻量响应；先核验身份再给令牌，不能沿用 Mac 目前“任何 HTTP 响应都算自己的后台” |
| 所有权 | 已有兼容后台只复用、不接管；自己启动的才自动重启和停止。身份不符或端口冲突就报错，不误杀其他进程 |
| 启动 | 先出准备窗口，再异步探测。普通启动沿用 Mac 500ms 单次超时、150ms 准备轮询与 15s 就绪预算；WSL 冷启动独立给最多 60s 并显示阶段。就绪后停止准备轮询 |
| 崩溃 | 只监听拥有的进程；退避 1、2、4 秒至最多 30 秒，60 秒内 5 次停止重试。手动重启清计数，恢复成功仍显示上次崩溃原因 |
| 停止 | 先禁止自动重启，再请求优雅关闭。统一 40s 停止预算，修正 Mac 当前最多约 3s 即强杀与后台 30s 预算不一致的问题；确认旧实例结束才起新实例 |
| 日志 | 相对数据根均为 `state/logs/desktop-daemon.log`，2 MiB 加一份轮转，stderr 尾缓冲 4 KiB、摘要最多 8 行。Windows 后台日志主位置在 WSL；Windows 壳自己的引导日志同样限额，并提供打开入口 |
| 界面与认证 | 共用前端和既有 WebSocket；本机 token 换 Cookie，桥接不暴露主令牌。不新增后台模型探测或常驻轮询 |

以后增加平台，改平台启动与停止适配器、安装打包、文件打开桥接和 CI 验证；Node 后台若原生跑在新 OS，才增加该 OS 的沙箱、IPC、进程和路径后端。加厂商只动插件目录及注册表，桌面壳不变。

## 6. 性能目标是验收预算，不是已测结果

基准机约定为 Windows 11 x64、4 核、16 GiB、SSD。固定版本和空闲项目数据，分别测应用首次准备、WSL 已运行、WSL 已停止、后台已在跑四种状态。各测 20 次，报告中位数和 P95；首次联网安装单列，不混进启动成绩。

| 指标 | 首发目标 |
| --- | --- |
| 点击到可见外壳窗口 | P95 ≤ 1s |
| 后台已运行，点击到可操作对话列表 | P95 ≤ 2s |
| WSL 已运行、后台未运行，点击到可用 | P95 ≤ 5s |
| WSL 冷启动，点击到可用 | P95 ≤ 12s；超出显示具体阶段，60s 超时给可重试错误 |
| 常驻外壳 | 空闲 5 分钟后，壳 + 本应用 WebView2 子进程私有工作集总计 ≤ 200 MiB，不只报 Rust 主进程 |
| 安装包 | 压缩在线壳安装包 ≤ 25 MiB；明确另列 Linux 镜像、Node、依赖和 CLI 的下载量与安装后占用 |
| 后台回归 | 同一 WSL 内，同版本同数据直接启动到就绪的 P95，较改前增加不超过 10% 且不超过 100ms；WSL 唤醒另算 |

WSL 虚拟机内存不能算进“200 MiB 壳”后隐藏不报。单独记录 Node RSS、WSL VM 在后台空闲和一个真实 Worker 工作时的占用；暂以无 Worker 空闲 WSL VM ≤ 1.5 GiB 为验证目标，超出先查原因，不直接改用户全局 `.wslconfig`。

避免变慢的具体做法：后台源码、数据库、git 和依赖都在 ext4；启动不访问 `/mnt/c`，不扫描 Windows PATH，不 `pnpm build`、不安装依赖、不做 CLI 登录或模型查询。已运行后台先探测复用，安装状态只在引导、版本变化和失败修复时检查。WSL 环境准备不塞进 `src/daemon/main.ts` 的关键路径。

## 7. Mac 上能验证什么，哪些必须用户做

现行 `AGENTS.md` 规定云端 CI 只跑 Ubuntu 四分片。本轮不改 CI；以下 Windows 专项是实现期需要项目经理批准加入的发布验证例外，不能悄悄扩大现有流水线。

| 环境 | 可验证内容 | 不能据此声称通过的内容 |
| --- | --- | --- |
| 本机 Mac + 既有 Ubuntu CI | 类型检查、后台及沙箱回归、注册表驱动的安装元数据、监管状态契约；Ubuntu 可测 Linux 准备脚本和假厂商链路 | Windows 包可安装、WSL2 行为、Windows CLI 登录 |
| GitHub Actions `windows-2022` 专项 | Rust/MSVC 构建、NSIS 打包、签名存在性和校验；无 GUI 的 WSL 输出解析、引用与停止逻辑；用假 WSL 程序跑故障场景。可在有桌面会话和 WebView2 的条件下启动壳、用 WebDriver 检查窗口及加载假 HTTP 后台，失败上传日志截图 | 普通 hosted runner 不能承诺提供可交互桌面，进程启动也不证明窗口可用；假后台不证明 Linux 后台可用 |
| 支持 WSL2 的 Windows 自托管运行器或用户真机 | 真实镜像导入、Linux 后台起停、Windows localhost 探活、bwrap 拒写与 interop 绕过测试、真实 CLI | 未覆盖的企业策略、其他 CPU 架构、其他 Windows 版本 |

GitHub 官方说明 hosted runner 的嵌套虚拟化不受正式支持，因此不把普通 Windows CI 里安装 WSL2、重启后启动真实后台设为可靠门禁。[GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)。可以尝试运行能力探测，但不支持时必须明确记为未覆盖，不能绿灯冒充 WSL2 冒烟完成。

用户本人需要完成一次 Windows 11 真机验收，工程师提供签名或明确标记的内测安装包、逐项脚本和脱敏日志导出：

1. 同意安装 WSL、启用虚拟化或按提示进 BIOS、必要时重启。双击 Fusa 完成发行版准备，确认可直接进应用窗口。
2. 对自己要用的各家 CLI 在指定 Linux 用户下登录，处理浏览器授权和钥匙环。无需把凭据发给项目经理。
3. 在 WSL 内导入测试仓库，派一个 Worker，验证允许写工作目录、拒写数据目录，不能从 Worker 调用 Windows 程序绕过限制。
4. 测试停止、手动重启、后台故意崩溃五次、托盘隐藏、彻底退出、再次打开、睡眠唤醒、登录自启、更新及卸载保留数据；用系统工具核对 Linux 子孙进程已退出。
5. 在常用 VPN 下检查转发，试中文路径、文件上传下载、长消息和手机原有入口。手机依然经既有 HTTPS 设备入口，不把 Windows 的 localhost 直接当手机地址。

首次发布至少要有这一份真机记录。没有 Windows 机器时，方案与编译可以完成，不能宣称 Windows 版可交付。

## 8. 分六步实现，各步单独合并验证

| 步骤 | 独立 PR 范围和规模 | 验证结束点 | 用户操作 |
| --- | --- | --- | --- |
| 1 | WSL 可行性与准备器，4–6 人日。镜像导入、普通用户、Node/pnpm、依赖、bwrap、interop、插件安装与登录引导 | Mac 测准备器解析；Ubuntu 测安装幂等；Windows 真机跑后台和沙箱、逐家认证。关键隔离或认证失败先解决再继续承诺支持 | 安装 WSL、重启、授权登录；提供真机执行结果 |
| 2 | 共用监管约定与 Mac 对齐，2–3 人日。轻量身份探测、版本、停止预算、契约文件、故障场景 | Mac 回归：复用、重启、崩溃、外部进程不接管；后台单独启动性能不回退 | 无 |
| 3 | Tauri Windows 壳与 WSL 监管，4–6 人日。窗口、Cookie、托盘、日志、Linux 实例起停与清理 | Windows 编译；假 WSL 故障测试；真机双击启动、崩溃恢复、退出无残留 | 真机试装、退出与睡眠唤醒 |
| 4 | 文件操作与项目入口，2–3 人日。Linux 目录选择、仓库导入、上传下载、资源管理器桥接 | Windows 真机用中文名项目完成一轮，明确 Windows 与 Linux 路径归属 | 选一个测试项目、验证文件操作 |
| 5 | 安装、更新、签名、自启与发布专项，2–4 人日。后台版本包、回滚、受控 Windows CI | 安装升级卸载、更新失败恢复；打包产物验证；基准指标记录 | 所有者配置签名账号和密钥；用户试升级及登录自启 |
| 6 | README 中英文与发布说明，1–2 人日。按下节草稿替换定位、安装及平台要求，纠正过时 Linux 说明 | 安装链接可用，命令逐条核对，真机验收记录齐全后与 Windows 正式版同一发布批次 | 确认桌面版整体体验达标 |

合计约 15–24 人日。各 PR 可独立审查和合并，未完成的 Windows 功能保持内测，不先在 README 宣称已发布。第 1 步是技术门槛，若 WSL 中认证和隔离不能同时满足，就回报具体阻碍重新评估，不能让第 3 步漂亮窗口掩盖后台不可用。

## 9. README 开头与安装草稿

以下文字在实现及发行产物可用后才采用。下载链接指向实际 Releases，不先写不存在的安装包；Mac 当前是从源码构建的壳，不把可选下载表述成已有自包含发行版。

### 中文开头

> # Fusa
> Fusa 是管理多个 AI 助手的桌面应用。你把项目交给项目经理，由它拆分任务、安排 Worker，并在一个窗口里查看进度、参与讨论和确认结果。
>
> Mac 打开 Fusa.app，Windows 安装 Fusa。需要常开的后台时，也可以部署到 Linux 服务器。手机用浏览器访问，或添加到主屏幕，继续查看和回复同一批对话。

### 中文“安装”结构

- **Mac 桌面应用**：正式下载包可用时列下载入口和依赖说明；从源码使用下列命令，生成并安装 Fusa.app，再双击打开。现有壳仍需要本机 Node、已构建网页和源码目录，不能移动源码后声称应用独立运行。
- **Windows 桌面应用**：下载 Windows 安装包，安装后双击 Fusa。首次按引导安装 Linux 运行环境，可能需要管理员授权和重启；在引导里安装并登录要用的助手。项目保存在应用的 Linux 环境里，附导入项目的说明链接。
- **Linux 服务器**：链接 `docs/linux.md`，说明安装依赖、启动后台和安全连接。将原来的 clone、build、start 教程移到这里及开发文档。
- **手机访问**：在已登录的电脑里生成手机登录入口，扫码并批准。手机用网页，也可添加到主屏幕；链接已有公网入口和通知配置。

Mac 源码安装命令：

```sh
git clone https://github.com/maodesikeng-boop/agent-hub.git
cd agent-hub
pnpm install --frozen-lockfile
pnpm build
bash scripts/build-mac-app.sh --install
```

### English opening

> # Fusa
> Fusa is a desktop app for managing multiple AI assistants. Give a project to a project manager, let it split the work and assign Workers, and use one window to follow progress, discuss changes, and approve results.
>
> Open Fusa.app on Mac or install Fusa on Windows. You can also run the backend on a Linux server. On your phone, use the web app or add it to your home screen to read and reply to the same conversations.

### English “Install” structure

- **Mac desktop app**: Link the download when a release is available and state its requirements. For a source build, use the commands above to build and install Fusa.app, then open it. The current shell requires local Node, built web assets, and the source directory.
- **Windows desktop app**: Download the Windows installer, install Fusa, and open it. Follow the first-run setup to install the Linux runtime and sign in to the assistants you use. Setup may need administrator approval and a restart. Projects live in the app's Linux environment; link the project import guide.
- **Linux server**: Link the backend setup and secure connection guide. Keep the clone, build, and service commands here or in the development guide.
- **Phone**: Create a phone sign-in link on an already signed-in computer, scan it, and approve access. Use the web app or add it to the home screen. Link the existing remote access and notification guide.

正文同时把“可选 macOS 壳”“一张网页管理”改成桌面应用入口；保留网页技术说明、手机 PWA 和 Linux 后台。平台要求按桌面与服务器分别写，不堆环境变量，也不引用其他产品来解释 Fusa。
