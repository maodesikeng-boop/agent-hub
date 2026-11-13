# Worker 可写范围

用户 2026-11-06 定的硬规则：**数据目录（`~/.agent-hub`）里 Worker 只能写自己的工作目录**，别处（`state/` 的数据库、令牌、性格设定，别的 Worker 的 worktree，新建的目录……）一律不能新建、改动；数据目录以外原样不管。项目经理不受限。

- 能写哪儿：`src/shared/write-scope.ts` 的 `workerWriteScope`（跟厂商无关），放在 `LaunchFiles.writeScope` 交给驱动层。
- 每家怎么落实：`src/daemon/driver/write-scope.ts` 的 `WRITE_SCOPE_ENFORCERS`，驱动起进程都走 `spawnInWriteScope`。

## macOS：整个进程包进 sandbox-exec

三家（claude、agy、codex）的 Worker 进程都包在 `sandbox-exec` 里：`(allow default)`、数据目录 `deny file-write*`、自己的工作目录再 `allow file-write*`。编辑工具、shell、它们起的所有子进程都在里面，按真实路径判断，不靠猜命令行。

macOS 沙箱不能嵌套：已经在沙箱里的进程再起 `sandbox-exec` 报 `sandbox_apply: Operation not permitted`（exit 71）。所以包了的进程不能再开自带的沙箱：

| 厂商 | 自带的沙箱 | 怎么关 |
|---|---|---|
| claude | `sandbox.enabled`（用户、项目设置都能开） | Worker 的 `--settings` 写 `sandbox.enabled: false`（`policy.ts` 的 `buildSessionSettings`），`--settings` 压过用户和项目设置。实测：项目设置开着、不关时 Bash 全部 exit 71；关了照常（smoke S32claude） |
| codex | `workspace-write`、`read-only`（每条命令起 `sandbox-exec`） | turn/start 的 `sandboxPolicy` 用 `externalSandbox`（codex 0.162 起有：codex 不再自己起沙箱，由外面那层管）。只读 Worker 例外：不包进程，照用 codex 自己的 `readOnly`。实测：apply_patch 改名到 `state/`、`ls …; touch state/…`、`cd ~ && cd .agent-hub/state && touch …` 都写不进去；worktree 里 `git commit`（写主仓库的 `.git`）、`pnpm install`（写 pnpm 的 store、上网）照常（smoke S31codex、S32codex） |
| agy | 终端沙箱（`--sandbox`、用户设置里 `enableTerminalSandbox: true`） | 包了的进程加 `--settings {"enableTerminalSandbox":false}`（`write-scope.ts` 的 `AGY_SANDBOX_OFF_ARGS`）。实测：开着时在 sandbox-exec 里命令 exit 71 |

审批（codex 的 `decideCommandApproval`、`decideFileChangeApproval`）照样按范围判断，在 macOS 上只是多一道，漏了也写不进数据目录。

## Linux：整个进程包进 bubblewrap (`bwrap`)

Linux 上同样由外层 OS 沙箱（`bwrap`）强制执行（详细设计见 `docs/linux-sandbox-design.md`）：

- **普通 Worker（`bwrapArgs`）**：`--unshare-user --disable-userns --unshare-pid --bind / / --proc /proc --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> --ro-bind <dataDir> <dataDir> --bind <writableDir> <writableDir> ...`
  - 数据目录只读挂载，再把 Worker 自己的可写目录可写绑定回去；
  - `--unshare-pid --proc /proc` 隐藏沙箱外进程（防读 `/proc/<外部pid>/environ` 偷令牌）并让外层 `bwrap` 退出时由内核自动清掉整个 PID namespace 的残留后代；
  - `--perms 0700 --tmpfs /run/user/<uid>` 遮住宿主机 systemd user / D-Bus socket，防止借宿主机用户服务代跑写穿；
  - `--disable-userns` 禁止沙箱内再建嵌套 userns 重新挂载。
- **只读 Worker**：
  - claude、codex 继续用各自自带的只读沙箱（claude 用 `bubblewrap + socat`，codex 用 `bwrap + Landlock + seccomp`）；
  - agy 外层套只读 `bwrap`（`readonlyBwrapArgs`）：`--ro-bind / /`，仅放开私有 `tmpDir`、运行时目录/已存在的匹配文件与缓存目录可写，存在的敏感目录用 `--tmpfs` 遮空、敏感文件（含启动时 `scanSecretGlobs` 在 `cwd` 与 `addDirs` 扫出的 `.env` 等）用 `--ro-bind /dev/null` 遮空。
- **Ubuntu 24.04+ 一次性配置**：首次部署或 CI 跑 `sudo scripts/linux-sandbox-setup.sh`（装 `bubblewrap`、`socat` 并配置 `/etc/apparmor.d/bwrap` 放行 userns）。`osSandboxAvailable` 只缓存 `true`、不缓存 `false`，配置完成后无需重启守护进程即可派 Worker。

## Windows：写受限令牌（`WRITE_RESTRICTED`）+ 受保护根拒写 ACL + 低版本只读回退

Windows 原生版通过 `apps/windows/crates/fusa-win-helper`（`fusa-run.exe`）在同一会话的 `KILL_ON_JOB_CLOSE` Job Object 内施加内核级写隔离（详细设计见 `docs/windows-native-design.md` 第 4.4 节）：

- **跨卷同盘受保护根（`WriteScope.protectedRoots`）**：
  - 数据目录（`%USERPROFILE%\.agent-hub`）以及跨盘项目同卷上的 `<卷根>\.fusa-wt\<数据目录指纹8>` 一并纳入 `protectedRoots`（macOS `seatbeltProfile`、Linux `bwrapArgs` 与 Windows ACL 三平台语义一致）。
- **普通 Worker（`fusa-run.exe --sandbox worker --state-dir <state> --worker <id>`）**：
  - 无需管理员权限，Win10 1809+ / Win11 通用；
  - 持久化两个随机能力 SID（`state\win-sandbox-sids.json`）：所有 Worker 共用的 `FusaWorker` 与每个 Worker 独立的 `FusaWorker-<id>`；
  - 在每个受保护根设置可继承的 `DENY FusaWorker`（拒绝写、追加、删除、子项删除、`WRITE_DAC`、`WRITE_OWNER`）与 `OWNER RIGHTS (S-1-3-4): READ_CONTROL`（压掉文件所有者的隐含 `WRITE_DAC`，防止 `icacls` / `Set-Acl` 自改权限绕过），先读 DACL 已满足则幂等跳过；
  - 新建 worktree 时先建空目录并设置可继承的 `ALLOW FusaWorker-<id>` 修改权限，再执行 `git worktree add`，checkout 与 `pnpm install` 子文件自动继承、零传播开销；
  - `CreateRestrictedToken(..., DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED, ...)` 完整复制当前令牌用户 SID + 全部已启用组 SID（保证 `D:\` 等靠 `Authenticated Users` 赋权的数据卷、工具链缓存、`%TEMP%` 与命名管道照常读写）+ `FusaWorker` + `FusaWorker-<id>`，并在 Job 上附加 `JOB_OBJECT_UILIMIT_HANDLES | UILIMIT_DESKTOP | UILIMIT_GLOBALATOMS` 收窄 UI 句柄边界。
- **只读 Worker**：
  - `codex`：继续使用其自带的 `readOnly` 沙箱与驱动审批回调；
  - 其余 5 家（`claude, agy, pi, deepseek, cursor`）：在支持微软官方 MXC `processcontainer` 的 Win11 24H2+ 环境将走 MXC 容器（由 `registerWin32MxcReadonlyProvider` 接入）；**在尚未启用 MXC 或低于 Win11 24H2 / Windows Server 等无 `processcontainer` 的机器上绝不硬拒启动，自动回退为「4.4.2 写受限令牌（`--readonly-fallback`，仅带 `FusaWorker` 使全部受保护根连本 worktree 一并禁写）+ 各家现有工具层只读拦截规则（如 `--mode plan`、`--exclude-tools edit,write`、只读补丁与审批拒绝）」**，同时在后台日志与会话事件（`driver.warning`）输出清晰的降级告警说明。
- **已知边界**：
  - 写受限令牌拦截的是本进程树（含全部子孙进程）的直接文件写入与改权；若借外部不受限系统服务代跑（如 `schtasks`、WMI `Win32_Process.Create`、进程外 COM），属于与 macOS `(allow default)` 下 `launchctl`/AppleEvents 同类的已知边界（设计目标是防误写与常规越权，而非防高对抗恶意逃逸）；
  - 低版本 Windows 只读回退模式下，写受限令牌只管受保护根禁写、不管文件读权限，受保护根以外目录的禁写与敏感文件禁读依赖各家 CLI 的工具权限层拦截；`agy` 存于 Windows 凭据管理器中的令牌不受文件级规则遮蔽。

## 基础 OS 沙箱不可用时：一律拒绝启动 Worker

在任何平台上，只要基础 OS 沙箱探针未就绪（`!osSandboxAvailable()`，例如 Linux 未装好 `bubblewrap`/AppArmor，或 Windows 缺少 `fusa-win-helper` / 文件系统为不支持 ACL 的 FAT/exFAT），派活（`workers.ts` 的 `startIn`）与驱动层起进程（`spawnInWriteScope` / `wrapInReadonlyOsSandbox`）**一律直接报错拒绝启动**，并给出对应平台的修复指引。
