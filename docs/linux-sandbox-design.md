# Linux 上的 Worker 沙箱（方案，待拍板）

2026-11-08。目标：Linux（东京 Lightsail）上 Worker 的可写范围和只读 Worker 跟 macOS 一样，由 OS 强制执行，不靠规则兜底。现状见 `docs/write-scope.md`。

## 0. 结论

**用 bubblewrap（bwrap）把整个 Worker 进程包起来，相当于 Linux 上的 sandbox-exec。** 东京上要用 sudo 做一次：装 AppArmor profile 放行 `/usr/bin/bwrap`（Anthropic、OpenAI 文档给的都是这个办法）。厂商自带的沙箱照 macOS 的做法关掉。
沙箱起不来时改成**拒绝启动 Worker**（普通 Worker 也一样），不再警告后退回规则兜底。Landlock 不要 root，但表达不了“数据目录外原样不管”，只作备选（第 2、9 节）。

## 1. 东京实测（2026-11-08，只读，没有 sudo）

环境：Ubuntu 24.04.4，内核 7.0.0-1012-aws，内存 1906 MB（可用 1379 MB），2 核；claude 2.1.319、codex 0.167.0、agy 1.5.3。
`apparmor_restrict_unprivileged_userns=1`，`apparmor_restrict_unprivileged_unconfined=0`。没有装 `apparmor-profiles`、`socat`、`rg`。

| 试了什么 | 结果 |
|---|---|
| `bwrap --ro-bind / / … true`（项目经理测的） | `setting up uid map: Permission denied` |
| `codex sandbox -- true` / `-- ls /` | 失败：`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` |
| `codex sandbox -c sandbox_mode="workspace-write" -c …network_access=true -- touch` | 失败：`setting up uid map: Permission denied` |
| `codex sandbox -c features.use_legacy_landlock=true -- true` | panic：`filesystem-restricted execution requires bubblewrap to isolate app-server sockets` |
| codex 包里带了 `codex-resources/bwrap`（“bubblewrap built for Codex”，不是 setuid） | codex 优先用 PATH 上的 `/usr/bin/bwrap`，两个都被 AppArmor 拦 |
| agy 二进制的字符串 | 有 `/proc/self/uid_map`、`setgroups`、`landlock_*`，说明它自己建 namespace，没用 bwrap |
| Landlock ABI（`landlock_create_ruleset(NULL,0,VERSION)`） | **8** |
| Landlock，只放行 `ok/`（python ctypes 写的小测试，fork 出的子进程里做） | `ok/x` 能写；`no/x`、`/tmp` 别处、`sh -c mkdir no/d`、`rename ok/x→no/y` 都是 EACCES；`no/` 下 unix socket 能连；TCP 外网能连；设置规则 0.3 ms |
| Landlock 禁读单个文件（沿路径列出兄弟目录逐个放行，共 42 条规则） | 文件被禁读了；副作用是路径上的父目录（`/tmp`）不能 `ls`；设置规则 0.7 ms |

**顺带发现的问题**：东京上的 codex 现在退回到 workspace-write 兜底，它自带的 bwrap 起不来，所以 **codex Worker 的 shell 命令会全部失败**。只读的 claude（自带沙箱，`failIfUnavailable: true`）和只读的 codex（自带 readOnly）也起不来。装好第 6 节的 profile 后这三处都能恢复。

## 2. 候选逐项比较

| | A. bwrap 外层包进程（推荐） | B. Landlock 外层（自己写辅助程序） | C. 厂商自带的沙箱 |
|---|---|---|---|
| 怎么做的 | `--bind / /` 后，`--ro-bind <数据目录>`，再 `--bind <worktree>`。mount 按路径判断，**后面的盖住前面的**，和 seatbelt 的语义一样 | 只能**放行**、不能拒绝（官方文档：规则只授权）。要做到“别处都能写、数据目录不能写”，得把 `/`→`/home`→`~`→`.agent-hub`→`worktrees` 每一层的兄弟目录逐个放行 | claude：bwrap + seccomp，只管 Bash。codex：bwrap（0.115 起，Landlock 只留作 legacy，已拒绝使用）。agy：自己建 namespace |
| (a) 只许写这几个目录 | ✅ 准确。数据目录里后来新建的东西也自动只读（bind 的是同一个目录） | ⚠️ 大致可以，但**直接在 `~` 下新建文件做不到**：给 `~` 加 MAKE_REG 会一路带到 `.agent-hub` 下面。所以 `~/.claude.json` 的原子写（建临时文件再改名）、`~/.bash_history` 之类会失败。另外按启动时的快照列目录，启动后在 `~` 下新建的目录写不进去 | ❌ claude 的拒绝规则总是压过放行，没法在数据目录里单独放行 worktree（和 macOS 上不用它的原因一样）；codex、agy 只管命令，不管 CLI 进程里的编辑工具 |
| (b) home 能读，凭据禁读 | ✅ 目录用 `--tmpfs <目录>`，文件用 `--ro-bind /dev/null <文件>` 盖掉（只对已经存在的路径有效）。⚠️ 通配（`**/.env`）只能在启动时扫描（sandbox-runtime 也是这么做的，见出处） | ⚠️ 把 home 拆开逐个放行 READ_FILE（几十到一两百条规则）。启动后新建的文件读不到，路径上的父目录要另外加 READ_DIR；通配同样只能靠启动时扫描 | claude、codex 能表达；agy 起不来时**悄悄不生效**（官方文档：v1.4.4+ 沙箱不可用时 `enableTerminalSandbox` 没有效果） |
| (c) 联网照常 | ✅ 不加 `--unshare-net`，网络 namespace 跟宿主机共用；也不需要配 loopback（东京报的 RTM_NEWADDR 错就出在这一步）。hub.sock 在只读 mount 上，连接要验收确认 | ✅ ABI ≤8 不管网络，也不管路径型 unix socket（ABI 9 才加 RESOLVE_UNIX），实测能连 | claude、codex 默认断网，走代理 |
| (d) 嵌套还是关掉 | 关掉，跟 macOS 一样：claude 写 `sandbox.enabled:false`，codex 用 `externalSandbox`，agy 加 `AGY_SANDBOX_OFF_ARGS`，**全部沿用现有代码**（它们只看 `osSandboxed`）。加 `--disable-userns`，不让沙箱里再建 userns | 关掉（Landlock 里的进程不能 mount，厂商的 bwrap 起不来） | — |
| (e) 要不要 root | 要 sudo 做一次：装 AppArmor profile（第 6 节）。之后普通用户就能跑 | 不要 root、不要 userns。但要一个辅助程序（Node 没有现成绑定）：小 C 程序在 CI 和东京上编译，或者用 python3 ctypes 写约 60 行（东京已经有 python3 3.12） | claude、codex 也要同一个 profile；agy 二进制的路径会跟着版本变，没法用 profile 稳定地放行 |
| (f) GitHub ubuntu-24.04 CI | ✅ runner 上有免密 sudo，可以跑跟东京同一份安装脚本（别的项目已经这么做，见出处） | ✅ runner 的内核开了 Landlock，不用 sudo | 要登录，CI 测不了 |
| 进程形状 | 多一个 bwrap 父进程（真正的 CLI 是它的子进程），**bwrap 不转发信号**，要处理（第 4.3 节） | 辅助程序设置好规则后 exec 成 CLI，pid 不变，跟 sandbox-exec 一样 | — |

**选 A 的理由**：(a) 只有 A 能准确表达用户定的“数据目录里只能写自己的 worktree，数据目录外原样不管”，B 会误伤直接写在 `~` 下的文件。A 只需要拼命令行参数，跟 `wrapInSeatbelt` 一样，不用另带辅助程序。东京那次 sudo 本来就躲不开：codex 的兜底、只读 claude、只读 codex 都要它（第 1 节）。照“厂商自带的够用就用”的规矩：C 在 (a) 上不够用，跟 macOS 的结论一样，只拿来当只读 claude、只读 codex 的落实手段（现有设计，不变）。

## 3. 起不来时怎么办（建议改）

- **探测**：守护进程启动时跑一次 `bwrap --unshare-user --disable-userns --bind / / true`（约 10 ms），把结果缓存起来，不轮询。没装 bwrap、内核或 AppArmor 不让建 userns，都算“没有 OS 沙箱”。
- **普通 Worker**：现在是警告后靠规则兜底。**建议改成拒绝启动**，错误信息带上第 6 节的修复命令（进错误码表 `LOCAL_ERRORS`，报成人话）。理由：用户要的是“和 macOS 一样硬”；兜底悄悄变松，只在日志里留一行，用户看不到。东京是唯一的 Linux 目标，装一次就好。项目经理（scope 是 null）不受影响。
- **只读 agy**：维持拒绝启动，只改报错文案（不再说“只有 macOS 有”）。
- 要不要留一个“明知不安全也照跑”的开关，交给项目经理拍板（第 9 节）。

## 4. 数据形状

### 4.1 后端表：在一个地方选，三家共用

```ts
// write-scope.ts
interface OsSandboxBackend {
  available(): boolean;                                          // darwin: true；linux: 第 3 节的探测（缓存）
  wrap(base: SpawnCommand, scope: WriteScope, ownOff: readonly string[]): SpawnCommand;
  wrapReadonly(base: SpawnCommand, input: ReadonlySandboxInput): SpawnCommand;
}
const OS_SANDBOX_BACKENDS: Partial<Record<NodeJS.Platform, OsSandboxBackend>> = { darwin: seatbelt, linux: bubblewrap };
export function osSandboxAvailable(platform = process.platform) { return OS_SANDBOX_BACKENDS[platform]?.available() ?? false; }
```

- `wrapInSeatbelt` 改名为 `wrapInOsSandbox`，`wrapInReadonlySeatbelt` 改名为 `wrapInReadonlyOsSandbox`，里面按平台查表。`osSandboxEnforcer`、`WRITE_SCOPE_ENFORCERS`、`spawnInWriteScope` 的形状都不变；三家驱动、`launch.ts`、`ledger/context.ts` 只认 `osSandboxed` 和 `osSandboxAvailable`，**不用改**。
- seatbelt 现有的函数（`seatbeltProfile`、`readonlySeatbeltProfile`）原样搬进 `seatbelt` 后端。新增 `bwrapArgs(scope)`、`readonlyBwrapArgs(input)`，都是纯函数。
- `ReadonlySandboxInput` 里的 `writableFileRegexes` 是 seatbelt 专用的写法，改成 `writableFiles: string[]`（绝对路径），正则由 seatbelt 后端自己生成。`readonly-agy.ts` 跟着少转一步。

### 4.2 bwrap 参数

普通 Worker：

```
bwrap --unshare-user --disable-userns --bind / / \
      --ro-bind <dataDir> <dataDir> \
      --bind <writableDir> <writableDir> …           # scope.writableDirs，按顺序
      -- <cli> <ownSandboxOffArgs…> <args…>
```

只读 Worker（目前只有 agy，加上连接器探测）：

```
bwrap --unshare-user --disable-userns --ro-bind / / --dev-bind /dev /dev \
      --bind <tmpDir> <tmpDir>  --bind <writableDir> …  --bind <writableFile> …   # 只对已存在的
      --tmpfs <秘密目录> …  --ro-bind /dev/null <秘密文件> …                        # 只对已存在的
      -- <cli> <args…>
```

- 路径一律先 realpath（跟 macOS 一样）。bind 不存在的路径会让 bwrap 报错，所以只处理已经存在的。
- 可写清单来自 `shared/write-scope.ts` 的 `workerWriteScope`；禁读清单来自 `buildReadonlyPolicy`（`secret-paths.ts` 的 `CREDENTIAL_HOME_PATHS`、`VENDOR_HOME_PATHS.readonlySecrets`、`state/ui-token`），不另写一份。
- 通配（`READONLY_SECRET_GLOBS`）：启动时在会话的 cwd 和 addDirs 里扫一遍（跳过 `node_modules`、`.git`），找到的文件按“秘密文件”盖掉；家目录的凭据由路径清单负责。扫描范围要拍板（第 9 节）。

### 4.3 进程形状要处理的两件事

- **信号**：bwrap 的父进程收到 SIGTERM 会自己退出，不会转发给里面的 CLI，CLI 会变成孤儿进程。停 Worker 要杀到里面：用 `--info-fd` 拿到子进程 pid，或者统一走 `forceKillTree`。不加 `--die-with-parent`，保持守护进程重启时现有的行为。
- **按 ps 认进程**：`claudeOfSession` 这类函数按命令行匹配，bwrap 那行命令里也带着 CLI 的参数，可能会匹配到两次，要过滤掉 bwrap 本身。实现时补测试。

## 5. 性能

- 每起一个 Worker 多一个 bwrap 父进程，常驻约 1–2 MB RSS。建 namespace 加 mount 约 5–15 ms（验收时实测）。不生成规则文件，参数直接放在命令行上。
- 只读 Worker 多一次通配扫描：在 worktree 里扫一遍，预计几十 ms，验收时实测。只在启动时做一次。
- 探测：守护进程启动时跑一次（约 10 ms）。**没有轮询**。
- 东京 2 GB：瓶颈在 CLI 本身（每个 claude 进程几百 MB），bwrap 带来的开销可以忽略。

## 6. 东京一次性要做的事（重复跑结果不变）

```bash
# 1) [sudo] AppArmor profile：只给 /usr/bin/bwrap 放行 userns（Claude Code 文档的原文）
#    先确认没有别的 profile 也挂在 /usr/bin/bwrap 上：grep -l /usr/bin/bwrap /etc/apparmor.d/* 应该没有输出
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap        # -r = 有就替换，重复跑结果不变
# 2) [sudo] 只读 claude 用的自带沙箱要 socat（rg claude 自己带了）
sudo apt-get install -y socat                        # 已经装了就什么都不做
# 3) [不用 sudo] 验证
bwrap --unshare-user --disable-userns --bind / / true && echo bwrap-ok
codex sandbox -- true && echo codex-sandbox-ok
```

- 不选 `kernel.apparmor_restrict_unprivileged_userns=0`：它会对整台机器放开限制。
- 不选 Ubuntu extras 里的 `bwrap-userns-restrict`：它会去掉沙箱内子进程的 capability，Claude Code 自带沙箱的第二阶段（`apply-seccomp` 写 setgroups）会失败（claude-code #81799、#93130）。代价是：任何程序都能借 `/usr/bin/bwrap` 建 userns。东京是单用户机器，可以接受；我们自己的沙箱加了 `--disable-userns`，Worker 在里面不能再建 userns。
- 这三步写成仓库里的 `scripts/linux-sandbox-setup.sh`，东京和 CI 跑同一份。

## 7. 测试

**CI（GitHub ubuntu-24.04）**

- 纯函数单测，各平台都跑：`bwrapArgs` 和 `readonlyBwrapArgs` 的顺序、realpath、跳过不存在的路径、通配扫描结果；按平台选后端；探测失败时 `osSandboxAvailable` 返回 false，Worker 被拒绝启动（注入 probe）。
- 真跑 bwrap，新开一个 Linux job：先 `sudo scripts/linux-sandbox-setup.sh`，再跑 `write-scope.linux.test.ts`：
  - 普通 Worker：worktree 能写、能 git commit；`state/` 不能写，用 `D=…; touch $D/x`、python 脚本拼路径、worktree 里放指向数据目录的软链接这几种方式都写不进去；数据目录外照常能写；hub.sock 能连；能访问外网；里面再 `unshare -U` 会失败。
  - 只读：哪里都写不了，私有 tmp 能写；凭据目录和文件读不到，`.env` 读不到；`/dev/null` 能写。
  - 不装 profile（在另一个 job 里跑或者先卸掉）：探测失败，Worker 被拒绝启动。
- CI 上没有登录的厂商 CLI，三家的端到端测不了。

**东京真机验收**（照现在 macOS smoke S31、S32 的清单）

1. 跑第 6 节的脚本，在东京上跑 `write-scope.linux.test.ts`（不调模型）。
2. **现在就能测（claude 已经登录）**：派一个普通 claude Worker，让它用 Bash 和编辑工具写 `state/`（直接写、带变量、python、软链接，四种方式）→ 全部被拒；worktree 里 `git commit`、`pnpm install` 正常。只读 claude Worker：`touch` 被拒，`cat ~/.claude/.credentials.json` 被拒（这一步验证 profile 下 claude 自带沙箱能起来）。记录 Worker 的启动耗时和 bwrap 的 RSS。
3. **等 codex 登录后补测**：普通 codex Worker 走 `externalSandbox`，跑同一份清单，包括 apply_patch 改名到 `state/`；只读 codex Worker（自带 readOnly，用系统 bwrap）。
4. **等 agy 登录后补测**：普通 agy Worker，确认 `AGY_SANDBOX_OFF_ARGS` 在 Linux 上也生效；只读 agy Worker（外层只读 bwrap）：凭据读不到，agy 运行时文件能写（`writableFiles` 是不是够用，主要看这一步）；连接器探测。

## 8. 已知局限

- 禁读只对**启动时已经存在**的凭据路径有效，Worker 运行期间新建的凭据文件读得到；通配只覆盖启动时扫过的目录。seatbelt 用正则动态匹配，没有这两个问题。
- bwrap 的 profile 放行的是 `/usr/bin/bwrap` 这个路径。换了 bwrap 的位置，或者 `bwrapPath` 指到别处，要重新装 profile。
- Ubuntu 以后的 apparmor 更新如果自带了挂在 `/usr/bin/bwrap` 上的 profile，可能跟我们这份冲突。验收脚本里的 `grep` 就是查这个的。

## 9. 要你拍板的事

1. **选 bwrap（A）还是 Landlock（B）**。推荐 A：只有它能准确表达“数据目录外原样不管”；东京本来就要为 codex 和只读 claude 做那一次 sudo；不用另带辅助程序。B 只在“东京绝对不能 sudo”时才考虑。
2. **沙箱起不来时普通 Worker 怎么办**。推荐改成拒绝启动并给出修复命令，理由见第 3 节。备选：保持警告加兜底。
3. **要不要留一个“没沙箱也照跑”的开关**。推荐不留：东京装好就一直可用；留了就会有人打开，硬保证又回到软的。
4. **AppArmor profile 用哪种**。推荐 Anthropic 文档里的 `flags=(unconfined) userns`，不用 `bwrap-userns-restrict`。理由：后者会弄坏只读 claude 自带的沙箱；前者的代价在单用户机器上可以接受。
5. **只读通配扫描的范围**。推荐只扫会话的 cwd 和 addDirs（预计几十 ms）。备选是连家目录一起扫：家目录的凭据已经由路径清单管住，再扫一遍大约要秒级，不值得。
6. **只读 claude 继续用它自带的沙箱，还是也套我们的外层只读 bwrap**。推荐先继续用自带的（现有设计不变），东京验收第 2 步失败了再换成外层 bwrap（agy 那套代码可以直接复用）。

## 出处

- Claude Code 沙箱，Linux 用 bubblewrap + socat，Ubuntu 24.04 要装 AppArmor profile（第 6 节就是原文）：https://code.claude.com/docs/en/sandboxing
- sandbox-runtime：Linux 用 bwrap，seccomp 两阶段，deny 清单启动时扫一次：https://github.com/anthropics/sandbox-runtime ；Ubuntu 24.04 问题：issue #74
- claude 自带沙箱在 restrict=1 下 apply-seccomp 失败：https://github.com/anthropics/claude-code/issues/93130 、#81799
- codex Linux 沙箱：bwrap 是默认，legacy Landlock 对限制文件系统的策略直接拒绝，优先用 PATH 上的 bwrap，找不到再用自带的：https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox ；PR #13996（0.115 切换）；Ubuntu 24.04 问题：issue #14919、#15057；官方说明：https://learn.chatgpt.com/docs/sandboxing
- agy 终端沙箱，Linux 用 namespaces，不可用时不生效：https://antigravity.google/docs/cli-sandbox
- Landlock：只授权、ABI 各版本的差异（v2 REFER、v3 TRUNCATE、v4 TCP、v5 IOCTL_DEV、v6 scope、v7 日志、v8 TSYNC、v9 RESOLVE_UNIX、v10 UDP、v11 NNP 标志、v12 capability 和 namespace）：https://docs.kernel.org/userspace-api/landlock.html
- Ubuntu 的 userns 限制和 bwrap profile：https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007
- CI 上装 bwrap profile 的先例：https://github.com/styin/kaguya/issues/71
