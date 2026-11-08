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

- **普通 Worker（`bwrapArgs`）**：`--unshare-user --disable-userns --unshare-pid --proc /proc --bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> --ro-bind <dataDir> <dataDir> --bind <writableDir> <writableDir> ...`
  - 数据目录只读挂载，再把 Worker 自己的可写目录可写绑定回去；
  - `--unshare-pid --proc /proc` 隐藏沙箱外进程（防读 `/proc/<外部pid>/environ` 偷令牌）并让外层 `bwrap` 退出时由内核自动清掉整个 PID namespace 的残留后代；
  - `--perms 0700 --tmpfs /run/user/<uid>` 遮住宿主机 systemd user / D-Bus socket，防止借宿主机用户服务代跑写穿；
  - `--disable-userns` 禁止沙箱内再建嵌套 userns 重新挂载。
- **只读 Worker**：
  - claude、codex 继续用各自自带的只读沙箱（claude 用 `bubblewrap + socat`，codex 用 `bwrap + Landlock + seccomp`）；
  - agy 外层套只读 `bwrap`（`readonlyBwrapArgs`）：`--ro-bind / /`，仅放开私有 `tmpDir`、运行时目录/已存在的匹配文件与缓存目录可写，存在的敏感目录用 `--tmpfs` 遮空、敏感文件（含启动时 `scanSecretGlobs` 在 `cwd` 与 `addDirs` 扫出的 `.env` 等）用 `--ro-bind /dev/null` 遮空。
- **Ubuntu 24.04+ 一次性配置**：首次部署或 CI 跑 `sudo scripts/linux-sandbox-setup.sh`（装 `bubblewrap`、`socat` 并配置 `/etc/apparmor.d/bwrap` 放行 userns）。`osSandboxAvailable` 只缓存 `true`、不缓存 `false`，配置完成后无需重启守护进程即可派 Worker。

## 沙箱不可用时：一律拒绝启动 Worker（不留规则兜底）

无论普通 Worker 还是只读 Worker、无论哪家厂商，只要当前机器 OS 沙箱未就绪（`!osSandboxAvailable()`），派活（`workers.ts` 的 `startIn`）与驱动层起进程（`spawnInWriteScope` / 只读 agy）**一律直接报错拒绝启动**，并给出修复命令 `sudo scripts/linux-sandbox-setup.sh`，不再退回工具参数或命令行字面规则兜底。
