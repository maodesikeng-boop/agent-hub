# Linux 上的 Worker 沙箱（方案，已拍板）

2026-11-08。目标：Linux（东京 Lightsail，Ubuntu 24.04）上 Worker 的可写范围和只读 Worker 跟 macOS 一样，由 OS 强制执行，不靠规则兜底。现状见 `docs/write-scope.md`。

## 0. 结论

**用 bubblewrap（`bwrap`）把整个 Worker 进程包起来，相当于 Linux 上的 `sandbox-exec`。** 东京上用 `sudo` 做一次：装 AppArmor profile 放行 `/usr/bin/bwrap` 并装 `socat`（已完成）。厂商自带沙箱照 macOS 的做法关掉（只读 claude、只读 codex 继续用各自自带的沙箱）。
沙箱起不来时**拒绝启动 Worker**（普通 Worker 也一样），不留关闭开关，不再警告后退回规则兜底。

## 1. 东京与容器实测（2026-11-08）

环境：东京 Ubuntu 24.04.4，内核 7.0.0-1012-aws，内存 1906 MB，2 核；claude 2.1.319、codex 0.167.0、agy 1.5.3；`apparmor_restrict_unprivileged_userns=1`、`yama ptrace_scope=1`。另有本机 Ubuntu 24.04 容器 `bw` 对照。

| 试了什么 | 实测结果 |
|---|---|
| 没装 AppArmor profile 时跑 `bwrap` / `codex sandbox` | `setting up uid map: Permission denied`；codex 的 `workspace-write`、只读 claude、只读 codex 全挂 |
| 装第 6 节 `/etc/apparmor.d/bwrap` + `socat` 后 | `bwrap --unshare-user --disable-userns --unshare-pid --proc /proc …` 在东京真机正常跑 |
| **实验 1：`/proc` 与进程隔离**（沙箱外起同 uid 假守护进程 `OUT=38014`，cwd 在数据目录并打开 `state/db.sqlite`） | **不开 `--unshare-pid`**：因建 userns/mountns 后进程 `dumpable=0`（加 `ptrace_scope=1`），读写 `/proc/38014/{cwd,root,fd/3}` 均报 `Permission denied`；但沙箱内可读 `/proc/38014/cmdline`，且 **`kill -STOP 38014` 成功停住沙箱外假守护进程**（同理可发 `SIGTERM`/`SIGKILL`）。<br>**加 `--unshare-pid --proc /proc`**：沙箱内 `/proc` 仅见自身 namespace 进程（`1 2 4 5 6 7`），`/proc/38014` 不存在，`kill -STOP 38014` 报 `No such process` |
| **实验 2：`systemd --user` 与 tmux 绕过**（东京 `Linger=yes`，`/run/user/1000/bus` 与 `systemd/private` 常驻，`agent-hub` 是 user 服务） | **不盖 `/run/user/1000`**：直接 `touch state/direct` 报 `Read-only file system`，但 `systemd-run --user --wait touch state/escaped-systemd` 返回 `rc=0`，**借宿主机 `systemd --user` 在沙箱外写穿 `state/`**（同理可 `systemctl --user stop agent-hub`）。<br>**加 `--perms 0700 --tmpfs /run/user/1000`**：`systemd-run --user` 和 `systemctl --user`（含清空 `DBUS_SESSION_BUS_ADDRESS`）全报 `Failed to connect to bus`（`rc=1`），`state/` 未被写入；沙箱内跑 `claude/codex/agy --version` 均正常。<br>**tmux 对照**：沙箱外起 `tmux -S /tmp/sbx/tmux.sock`，沙箱内 `tmux -S … run-shell 'touch state/escaped-tmux'` 成功写穿（见第 8 节） |
| **实验 3：`/dev` 挂载**（东京真机 `--bind / /`） | `bwrap` 的 `--bind` 默认带 `MS_NODEV`，只写 `--bind / /` 时沙箱内 `echo ok >/dev/null` 报 `Permission denied`；补 `--dev-bind /dev /dev` 后正常 |
| Landlock（ABI 8，对照备选） | 规则只授权不拒绝；要在 `~` 下禁写 `.agent-hub` 只能拆开兄弟目录逐个放行，导致无法直接在 `~` 下新建文件（`~/.claude.json` 原子写失败） |

## 2. 候选逐项比较

| | A. bwrap 外层包进程（已选） | B. Landlock 外层（自写辅助程序） | C. 厂商自带的沙箱 |
|---|---|---|---|
| 怎么做的 | `--bind / / --dev-bind /dev /dev` 后，`--ro-bind <数据目录>`，再 `--bind <worktree>`，后面的挂载盖住前面的，和 seatbelt 语义一致 | 只能放行不能拒绝；得把 `/`→`/home`→`~`→`.agent-hub`→`worktrees` 沿途兄弟目录逐个放行 | claude：bwrap + seccomp，只管 Bash。codex：bwrap。agy：自己建 namespace |
| (a) 只许写指定目录 | ✅ 准确。数据目录里后来新建的东西也自动只读 | ⚠️ 给 `~` 加 `MAKE_REG` 会带到 `.agent-hub`，不加则 `~/.claude.json` 原子写失败 | ❌ claude 拒绝总压过放行，没法在数据目录里放行 worktree；codex、agy 只管命令不管内置编辑工具 |
| (b) home 能读，凭据禁读 | ✅ 目录用 `--tmpfs`，文件用 `--ro-bind /dev/null` 盖掉；通配（`**/.env`）在启动时扫一次 `cwd` 和 `addDirs` | ⚠️ 拆 home 逐个放行，父目录不能 `ls`；通配同样靠启动扫描 | claude、codex 能表达（只读继续用它们自带的）；agy 沙箱起不来时悄悄不生效 |
| (c) 联网与 IPC | ✅ 不加 `--unshare-net`，网络与 `hub.sock` 照常；用 `--tmpfs /run/user/<uid>` 堵住 `systemd --user` 逃逸 | ✅ ABI ≤8 不管网络和 unix socket，但同样挡不住連外部 socket | claude、codex 默认断网走代理 |
| (d) 嵌套处理 | 关掉自带沙箱（沿用现有代码，只看 `osSandboxed`）；加 `--disable-userns` 禁止内部再建 userns | 关掉 | — |
| (e) 进程形状 | 多 2 个 `bwrap` 进程（外层 `B` + namespace 1 号 `I`），信号发给内层 CLI `C`（第 4.3 节） | exec 成 CLI，pid 不变 | — |

## 3. 探测与起不来时的处理

- **探测命令（必须带齐真正起 Worker 时的关键隔离参数）**：
  ```
  bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
        --bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> -- /bin/true
  ```
- **只缓存成功，不缓存失败**：`osSandboxAvailable()` 在 Linux 上跑一次上述探测（东京实测 4.6 ms）。**只有返回 `true` 才缓存**；若返回 `false`（未装 `bwrap`、未加载 AppArmor profile 或 `/run/user/<uid>` 异常），不缓存，下次真正起 Worker（`prepareLaunch` / `spawnInWriteScope` / 派只读 agy）时再探测一次，**无任何轮询**。管理员在东京跑完修复脚本后**无需重启 `agent-hub` 守护进程**，下次派 Worker 即刻生效。（`launch.ts` 的 `createLaunchPreparer` 改为在每次 `prepareLaunch(session)` 调用时取 `osSandboxAvailable()`，不在初始化时固定。）
- **起不来一律拒绝启动**：普通 Worker 和只读 Worker 在 `osSandboxAvailable()` 为 `false` 时均拒绝启动，报错进 `LOCAL_ERRORS` 并附上第 6 节修复命令 `sudo scripts/linux-sandbox-setup.sh`。不留“没沙箱也照跑”的开关。项目经理（`scope === null`）不受影响。

## 4. 数据形状与统一设计

信号目标、探测、沙箱参数全部只在一处定义，三家驱动（claude、codex、agy）共用；macOS 与 Linux 走同一张后端表。

### 4.1 后端表（`src/daemon/driver/write-scope.ts`）

```ts
interface OsSandboxBackend {
  available(): boolean; // darwin: true；linux: 跑第 3 节探测，仅 true 缓存
  wrap(base: SpawnCommand, scope: WriteScope, ownOff: readonly string[]): SpawnCommand;
  wrapReadonly(base: SpawnCommand, input: ReadonlySandboxInput): SpawnCommand;
}
const OS_SANDBOX_BACKENDS: Partial<Record<NodeJS.Platform, OsSandboxBackend>> = { darwin: seatbelt, linux: bubblewrap };
export function osSandboxAvailable(platform = process.platform) { return OS_SANDBOX_BACKENDS[platform]?.available() ?? false; }
```

- `wrapInSeatbelt` / `wrapInReadonlySeatbelt` 改名为 `wrapInOsSandbox` / `wrapInReadonlyOsSandbox`，按平台查 `OS_SANDBOX_BACKENDS`。
- `ReadonlySandboxInput` 的 `writableFileRegexes` 改为平台无关的 `writableFileGlobs: string[]`（或展开后的路径 + 模式）：seatbelt 后端转成 `regex`，bubblewrap 后端展开已存在的匹配文件并 `--bind`。

### 4.2 `bwrap` 参数与只读通配扫描

**普通 Worker**：

```
bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
      --bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> \
      --ro-bind <dataDir> <dataDir> \
      --bind <writableDir> <writableDir> … \
      -- <cli> <ownSandboxOffArgs…> <args…>
```

**只读 Worker（目前只有只读 agy 及其连接器探测）**：

```
bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
      --ro-bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> \
      --bind <tmpDir> <tmpDir> --bind <writableDir> … --bind <writableFile> … \
      --tmpfs <秘密目录> … --ro-bind /dev/null <秘密文件> … \
      -- <cli> <args…>
```

- 路径一律先 `realpath`；只对**已存在**的路径生成 `--bind` / `--tmpfs` / `--ro-bind /dev/null`（不存在的路径 `bwrap` 会报错退出）。
- **只读通配扫描（每次启动只扫一遍，连接器探测直接复用）**：
  - 在启动只读 agy 时（`agy-driver.ts` 的 `#spawn` 开头，调 `#catalogFor` 之前），对去重后的 `[row.cwd, ...row.addDirs]` 调用一次 `scanSecretGlobs(roots, readonlyPolicy.secretGlobs)`，将扫出的敏感文件绝对路径并入本次启动的 `readonlyPolicy.secretPaths`，再同时传给 `#catalogFor(policy)`（起各个 stdio MCP 服务器探测 `tools/list`）和 `agyReadonlySandboxInput({ ..., policy })`。
  - **扫描实现与上限**：用 `readdirSync(dir, { withFileTypes: true })` 非递归栈遍历，跳过 `.git`、`node_modules` 及符号链接目录；匹配 `READONLY_SECRET_GLOBS`（`**/.env`、`**/.env.*`、`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/id_ed25519*`）。设硬上限：**最多遍历 20,000 个目录项、耗时不超过 200 ms、命中敏感文件不超过 500 个**。
  - **超限处理（fail-closed）**：任一上限触发时**立即中止并拒绝启动该只读 Worker**（抛 `DriverError("spawn_failed", ...)` 说明哪个目录超限），绝不截断后带漏绑的沙箱启动。
  - **实测耗时**：扫描 `agent-hub` 仓库（跳过 `.git`、`node_modules`），本机 Mac（172 目录 / 1,150 文件）平均 **3.9 ms**；东京真机（175 目录 / 1,549 文件）平均 **2.5 ms**。

### 4.3 信号发给谁与进程清理（`src/daemon/driver/process.ts`）

开启 `--unshare-pid`（不加 `--as-pid-1`）后，进程树固定为三层（东京真机实测 `ps --forest`）：
- `B`（宿主机外层 `/usr/bin/bwrap`，即驱动拿到的 `child.pid`，`detached: true` 的进程组长 `PGID = B`，`NSpid: B`）
- `I`（PID namespace 内 1 号进程 `/usr/bin/bwrap`，`PPID = B`，`PGID = B`，`NSpid: I, 1`，负责在 namespace 内 `wait()` 收尸并通过 `eventfd` 把 `C` 的退出码传给 `B`）
- `C`（真正的 CLI 进程，`PPID = I`，`PGID = B`，`NSpid: C, 2`）

**现有代码三处靠信号或 pid 的地方及统一改法**：
1. **信号目标统一函数 `signalTarget(pid)`（放在 `process.ts`，三家驱动共用）**：
   - `platform !== "linux"` 或 `readlinkSync(/proc/<pid>/exe)` 不是 `bwrap` 时，直接返回 `pid`（macOS、PM、只读 claude/codex 行为完全不变）。
   - 是 `bwrap` 时，从 `pid`（`B`）沿 `/proc/<p>/task/<p>/children` 找 `/proc/<c>/status` 中 `NSpid:` 末位为 `2` 的子孙进程 `C` 返回（还没 fork 出来或已死返回 `null`）。再包一个 `signalChild(child, sig)`：对 `signalTarget(child.pid)` 发信号。
   - **中断与优雅关机**：`claude-driver.ts`、`agy-driver.ts`、`codex-driver.ts` 的 `#sigintForInterrupt`、`#closeStdin`（grace 到期发 SIGINT）和 `shutdown` 全部改调 `signalChild(proc.child, "SIGINT")`。
2. **退出收尾 `termGroupAfterExit(child)` 与强制结束 `forceKillTree` / `killFreshGroup`**：
   - **实测发现的坑**：当 `C` 自己退出或收到 `SIGINT` 退出时，`I` 通过 `eventfd` 通知 `B` 立即退出（原样带回 `C` 的退出码）；但若 `C` 留下了未退出的子孙进程（特别是真 claude Bash 工具在新进程组起的后台命令），`I` 会留在 `do_init` 里继续 `wait()`，且 `I` 作为 namespace 的 PID 1 **对 `SIGTERM` 免疫**，导致原 `termGroupAfterExit`（只发 `SIGTERM`）杀不死 `I` 和新进程组的后代。
   - **改法**：`termGroupAfterExit(child)` 在 `B` 确认退出后，在 Linux 上对 `-child.pid` 补发 `SIGKILL`（`signalPid(-child.pid, "SIGKILL")`）。因为 `I` 的 `PGID` 等于 `B`，`I` 收到 `SIGKILL` 死亡时，**Linux 内核会销毁该 PID namespace 并强制 `SIGKILL` 里面所有残留进程（包括新进程组的后代）**。
   - `forceKill`、`forceKillTree(B, true)`、`killFreshGroup(child)` **不用改**：宿主机 `ps` 里 `B → I → C → 后代` 父子链完整，按进程树和进程组 `SIGSTOP` + `SIGKILL` 直接把 `B`、`I`、`C` 和所有后代全部杀掉。
3. **账本 `row.pid` 与守护进程重启后清残留（`cleanupStale`）**：
   - **账本 `row.pid` 照旧记 `child.pid`（`B`）**。
   - **`claudeOfSession(B, sid)` / `agyOfSession(B, sid)` / `codexOfSession(B)` 不用改**：`B` 的命令行 `bwrap … -- claude --resume <sid>` 本身就包含厂商命令名和 `vendorSessionId`，且 `B` 就是进程组长（`pgid === B`）。
   - **`cleanupStale`**：认出 `row.pid`（`B`）后，改为 `const target = signalTarget(pid); if (target) signalPid(target, "SIGINT");`，然后照旧 `waitForExit(pid, grace)` 等 `B` 退出；若 `B` 正常退出且 `pgid === pid`，调 `termGroupAfterExit({ pid })` 杀掉可能被后台进程拖住的 `I`；若超时未退，照旧调 `forceKillTree(pid, pgid === pid)`。

**为什么不用 `--info-fd`、`--as-pid-1`、`--die-with-parent`（实测对比）**：

| 选项 | 实测表现 | 结论 |
|---|---|---|
| `--info-fd <fd>` | 开了 `--unshare-pid` 时输出 `{ "child-pid": 38412 }`，给的是**内层 1 号 bwrap `I`**（38412），不是 CLI `C`（38413）；且多一根 pipe，`cleanupStale` 重启后也没有 fd 可读 | ❌ 不用；读 `/proc` 找 `NSpid=2` 在运行期和 `cleanupStale` 都能直接拿到 `C` |
| `--as-pid-1` | 省掉 `I`，让 `C` 当 PID 1。但：① 内核对 PID 1 丢弃所有 `SIG_DFL` 信号，实测未装 handler 时发 `SIGINT` 被内核忽略（1 s 后仍活着）；② CLI 不 `waitpid(-1)` 收养孤儿，实测沙箱内堆积僵尸进程（`Z sh`、`Z sleep`），而不加时由 `I` 收尸（僵尸为 0） | ❌ 不用 |
| `--die-with-parent` | 守护进程退出时内核立即 `SIGKILL` 掉 `B` 和整个沙箱（实测旧守护进程退出后 Worker 立即死光），破坏现有的“守护进程重启不误杀、由 `cleanupStale` 优雅 `SIGINT` 收尾”机制 | ❌ 不用 |

**容器 `bw` 与东京真机 `/tmp/sbx` 4 项实测结果**：
1. **中断能送到 CLI，bwrap 不会先死**：直接 `child.kill("SIGINT")` 会先杀 `B`（`signal=SIGINT`）留 `C` 成孤儿；改发 `signalTarget(B)` 后，`C` 打出 `cli: got SIGINT` 并退出 130，`B` 2–5 ms 后以 `code=130 signal=null` 退出。
2. **停 Worker 不留孤儿进程**：运行中 `forceKill(child)`、刚启动 `killFreshGroup(child)`、以及 `B` 退出后对 `-B` 发 `SIGKILL` 杀 `I` 触发内核清空 PID namespace，同组与新进程组（`sleep 7771`）后代残留均为 0。
3. **CLI 自己退出后 bwrap 跟着退出，退出码原样传回**：`C` 退出 7 → `B` 返回 `code=7 signal=null`；`C` 被 `SIGKILL` → `B` 返回 `code=137 signal=null`。
4. **守护进程重启后清残留能找到旧 CLI 并结束它**：旧守护进程退出后 `B` 存活（`ppid=1`），`claudeOfSession(B, sid)` 返回 `pgid=B`，`signalTarget(B)` 定位到 `C`；`C` 处理 `SIGINT` 时 1.5 s 内退出，忽略 `SIGINT` 时超时进入 `forceKillTree(B, true)` 全部清零。

## 5. 性能（基于东京真机与容器实测）

- **进程与内存**：每起一个包了 `bwrap` 的 Worker 多 **2 个 `bwrap` 进程**（外层 `B` + namespace 1 号 `I`），东京真机实测常驻 RSS 为 **2,140 kB + 1,488 kB ≈ 3.6 MB**（容器实测 1,852 + 1,296 kB ≈ 3.1 MB）。相对于每个 CLI 几百 MB 的内存可忽略。
- **启动耗时**：东京真机 20 次平均，直接跑 `/bin/true` **1.9 ms**，全套普通 `bwrap` + `/bin/true` **4.6 ms**，只读 `bwrap` + `/bin/true` **4.4 ms**（容器实测 0.8 ms vs 2.4 ms），建 namespace 与挂载仅多花 **约 2.7 ms**。参数直接在命令行上，不写临时规则文件。
- **只读通配扫描**：只读 agy 启动时扫一次 `cwd` + `addDirs`，本仓库实测 **2.5 ms（东京）/ 3.9 ms（Mac）**，同次启动的连接器探测直接复用。
- **探测**：成功即缓存（守护进程生命周期内跑 1 次，约 4.6 ms）；失败不缓存，仅在下次起 Worker 时再试，**无任何轮询**。

## 6. 东京一次性配置（`scripts/linux-sandbox-setup.sh`，已完成）

```bash
# 1) [sudo] AppArmor profile：给 /usr/bin/bwrap 放行 userns（先确认 grep -l /usr/bin/bwrap /etc/apparmor.d/* 无别的文件）
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
# 2) [sudo] 只读 claude 自带沙箱要 socat
sudo apt-get install -y socat
# 3) 验证
bwrap --unshare-user --disable-userns --unshare-pid --proc /proc --bind / / --dev-bind /dev /dev --perms 0700 --tmpfs "/run/user/$(id -u)" -- /bin/true && echo bwrap-ok
codex sandbox -- true && echo codex-sandbox-ok
```

- 不选 `kernel.apparmor_restrict_unprivileged_userns=0`（放开整机）或 `bwrap-userns-restrict`（会弄坏只读 claude 自带沙箱的 `apply-seccomp`）。我们的外层沙箱带了 `--disable-userns`，Worker 在里面不能再建 userns。

## 7. 测试与验收

**CI（GitHub `ubuntu-24.04`）**
- 纯函数单测（各平台都跑）：`bwrapArgs` / `readonlyBwrapArgs` 顺序、`--unshare-pid --proc /proc`、`--tmpfs /run/user/<uid>`、realpath、跳过不存在路径、`scanSecretGlobs`（含超限抛错与复用）；`osSandboxAvailable` 仅缓存 `true`、失败下次重测并拒绝启动 Worker。
- Linux 真跑 `bwrap` job（先跑 `sudo scripts/linux-sandbox-setup.sh`，再跑 `write-scope.linux.test.ts` 和信号/进程清理测试）：
  - 普通 Worker：worktree 能写；`state/` 四种方式（直接、变量、python、软链接）均写不进；`/dev/null` 能写；`/proc` 看不到外部进程；`/run/user/<uid>` 为空 tmpfs；`unshare -U` 失败；信号中断、退出码透传、停 Worker 与 `cleanupStale` 均无残留。
  - 只读 Worker：除私有 `tmpDir` 外禁写；凭据与扫出的 `.env` 禁读。

**东京真机验收**（代码合入后照 macOS smoke S31、S32 跑）
1. 跑 `write-scope.linux.test.ts`（不调模型）。
2. 派普通与只读 claude Worker，验证 `state/` 四种方式禁写、worktree 正常提交、只读凭据禁读。
3. codex、agy 登录后分别补测普通与只读 Worker（含只读 agy 的 `writableFileGlobs` 与连接器探测复用）。

## 8. 已知局限（含外部服务绕法与 macOS 对比）

- **禁读只对启动时已存在的路径有效**：Worker 运行期间新建的凭据文件读得到；通配只覆盖启动时扫过的 `cwd` 和 `addDirs`。macOS seatbelt 用正则动态匹配，无此局限。
- **沙箱外同用户服务代跑绕法**（因为普通 Worker 保留网络且共享 `/tmp`，只要宿主机上有同用户进程监听沙箱内可达的 socket/端口，就能请它代跑命令绕过文件系统限制）：
  - **systemd 用户实例 / D-Bus（`/run/user/<uid>`）**：Linux **已通过 `--perms 0700 --tmpfs /run/user/<uid>` 堵住**（第 1 节实测）。macOS 上对应 `launchd` user domain：seatbelt `(allow default)` 只拦 `file-write*` 未拦 `mach-lookup`，可通过 `launchctl` 让沙箱外 `launchd` 代跑（**推断**）。
  - **tmux / screen socket（如 `/tmp/tmux-<uid>/`）**：东京实测沙箱内可连沙箱外 tmux socket 执行 `run-shell` 写穿 `state/`。不要在跑 `agent-hub` 的同账号下开着不设防的 tmux server（或实现时顺手对已存在的 `/tmp/tmux-<uid>` 加 `--tmpfs`，但自定义 `-S` 路径仍拦不住）。macOS seatbelt 普通 Worker 同样不拦 `/tmp` 下的 unix socket（**推断**）。
  - **SSH 连本机 / 本机 TCP 服务**：不禁网，普通 Worker 能读 `~/.ssh`（若 `authorized_keys` 放行本机可 `ssh localhost` 逃逸；只读 Worker 已禁读 `~/.ssh`）。macOS seatbelt 完全一样（**推断**）。
- **AppArmor 路径绑定**：profile 绑定 `/usr/bin/bwrap`，若换路径或 Ubuntu 更新自带冲突 profile 需重跑脚本检查。

## 9. 已拍板事项（全部已拍板）

1. **已拍板**：用 `bubblewrap` 外层包进程 + 第 6 节 `flags=(unconfined) userns` AppArmor profile。
2. **已拍板**：沙箱起不来时普通 Worker 与只读 Worker 一律**拒绝启动**并给出修复命令，不再退回规则兜底。
3. **已拍板**：**不留**“没沙箱也照跑”的开关。
4. **已拍板**：只读通配扫描只扫会话的 `cwd` 和 `addDirs`（每次启动扫一遍，连接器探测直接复用，超限拒绝启动）；只读 claude、只读 codex 继续用各自自带的沙箱，只读 agy 套我们的外层只读 `bwrap`。

## 出处

- Claude Code 沙箱（Linux 用 bubblewrap + socat，Ubuntu 24.04 AppArmor profile）：https://code.claude.com/docs/en/sandboxing ；`bwrap-userns-restrict` 下 `apply-seccomp` 失败：issues #81799、#93130
- sandbox-runtime（Linux 用 bwrap，`--unshare-pid --proc /proc`，deny 清单启动时扫描）：https://github.com/anthropics/sandbox-runtime
- Codex Linux 沙箱（默认 bwrap，含 `--unshare-pid --proc /proc`）：https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox
- Antigravity 终端沙箱（Linux 用 namespaces，不可用时不生效）：https://antigravity.google/docs/cli-sandbox
- Landlock 文档：https://docs.kernel.org/userspace-api/landlock.html
- Ubuntu userns AppArmor 限制说明：https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007
