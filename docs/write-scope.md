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

## 别的系统（没有 sandbox-exec，以后上 Linux 服务器）

不包进程，**起 Worker 时记一条警告日志**（`[write-scope] … 警告：这台机器没有 OS 沙箱`），不报错、不拦 Worker。各家用兜底，能拦多少拦多少，不比加可写范围之前松：

- claude：设置文件里 `state/` 的拒绝规则 `Edit(//<state>/**)`（`policy.ts` 的 `stateDirDenyRule`）。只管编辑工具，管不住 shell。
- agy：按工具参数和命令行字面检查（`agy-protocol.ts` 的 `checkWorkerToolViolation`），范围是整个数据目录（之前只查 `state/`）。
- codex：自己的 `workspace-write` 沙箱，`writableRoots` 去掉数据目录里不能写的；要越出沙箱的命令、改沙箱外文件的审批按范围拒（含 apply_patch 改名的目标 `move_path`、`grantRoot`）。

### 字面检查的已知局限（没有 OS 沙箱时）

命令行检查是 `shared/write-scope.ts` 的 `commandMayWriteOutsideScope`：按 `;`、`&&`、`||`、`|`、`&`、换行拆成一段段，跟着 `cd`、`pushd` 换工作目录（`cd -`、`popd`、带变量的 `cd` 之后看不出在哪，之后的写命令一律算越界），每段看工作目录和每个词落没落在范围外。看不出来的：

- 路径不写在命令行上：变量（`D=~/.agent-hub; touch $D/x`）、`$(...)`、脚本文件里拼出来的路径、`python -c` 里拼的字符串；
- 软链接：工作目录里一个指向数据目录的链接，按字面在范围内；
- 命令自己换目录（`git -C`、`make -C` 带相对路径以外的写法、程序内部 `chdir`）。

所以 Linux 上可写范围只是“尽量拦”，要真管住得换成那边的 OS 沙箱（如 bubblewrap / Landlock），到时候在 `WRITE_SCOPE_ENFORCERS` 里加。
