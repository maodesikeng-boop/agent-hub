# M3 计划：Worker

> 状态：用户 2026-11-03 看过并改了一轮，总的原则是“设计的时候不要限制太多了”。第 4 节的问题都已经定了，没有待定的。硬限制只留一条：Worker 不能写记忆（第 2.2 节）。其余的靠提示词里的规矩、`auto` 档的分类器和项目经理自己判断。
> 依据：[prototype-design.md](prototype-design.md)（下文简称“设计”）第 2.3、3.3、5.1、7.7、8.4、11、12 章；[m0-report.md](m0-report.md)；main 上 `ace2901` 的 M2 实现；Claude Code 官方文档（链接在文末）；2026-11-03 用 `claude` 2.1.314 实测过一次（第 2.1 节）。
> 写于 2026-11-03。
> 进度：W0～W5 都做完了（PR #30～#34 和 W5 的 PR）。各块和计划不一样的地方见第 6 节。

## 1. 范围

**用户 11-03 定的样子**：“pm 一个会话，它的 worker 们在这个会话里回复它，我也可以点进去看 worker 做了什么”，还说了“先不要做复杂了”。体验照用户现在每天用的 T3 Code：项目经理派出子任务，Worker 在自己的 git worktree 里干活，干完结果作为一条消息回到项目经理的会话，点开能看 Worker 的完整过程。

**做完用户能看到什么**：

1. 跟项目经理说“派个 Worker 修一下 X”，会话里出现一行“Worker · 修 X · 已派出”。
2. 过一会儿又出现一行“Worker · 修 X · 做完了：……”，项目经理接着说它验收的结论。
3. 点这一行，右边打开 Worker 自己的过程：它收到的任务、它说的话、每一步操作，和项目经理的会话长得一样。
4. 项目经理觉得不行，会让它接着改，会话里再多一行汇报。
5. 用户说“合并吧”，项目经理自己用 git 在本地合并、收拾 worktree，不推送。

**最小的那条路**

| 步骤 | 怎么做 |
|---|---|
| 派活 | 项目经理在 shell 里敲 `hub worker start --title "修 X" --stdin <<'EOF' …任务说明… EOF`（第 2.4 节）。账本在 `workers` 表里记一行，在项目经理的会话里发一行“Worker · 修 X · 已派出” |
| 定在哪干活 | 主文件夹是 git 仓库（而且至少有一次提交）：默认由守护进程建 worktree，命令是 `git worktree add -b hub/<编号>-<短名> <数据目录>/worktrees/<项目编号>/<编号> HEAD`（设计 7.7）。不是 git 仓库：Worker 直接在主文件夹里干活。项目经理也可以用 `--no-worktree` 自己选在主文件夹里干（第 2.6 节） |
| 起 Worker | Worker 有自己的对话（kind `worker`，左栏不显示）和会话（role `worker`，cwd 是 worktree 或主文件夹）。第一条消息就是任务说明。驱动层不用改：会话照常启动、恢复、停止、结束 |
| 回到项目经理 | Worker 每一轮结束（`result`），账本取这一轮最后一段文字当汇报。在项目经理的会话里发一行“Worker · 标题 · <状态>：<摘要>”，再把汇报原文用 `session.send`（`source: system`）交给项目经理，开头带“【Worker #3 · 修 X 的汇报】”。这一轮出错、被停止，也发一行，说明原因 |
| 点开看过程 | 点那一行，右边打开 Worker 的对话。直接复用现有的 `MessageList`，翻页、操作折叠、状态行、停止按钮都是现成的 |
| 验收、打回 | 项目经理自己看改动、跑测试（worktree 的根目录用 `--add-dir` 加给它）。不行就 `hub worker send 3 --stdin`，同一个 Worker 会话接着做，回到上一步 |
| 合并、收工 | 用户在会话里说一句，项目经理自己在主文件夹里 `git merge`、`git worktree remove`，然后 `hub worker end 3` 结束 Worker 会话。只在本地合并，不推送（第 2.3 节） |

**M3 不做**（括号里是哪个里程碑做，或者为什么不做）

- 工单卡片（设计里的，M3 不做）的多种状态、原地更新：一行一行的汇报就够看了，状态只在 `workers` 表里留一列。M3 也不另立“工单”这个叫法，每个 Worker 一条记录就叫 Worker（2026-11-03 定，见第 3 节接口约定）。
- 收件箱、“待你验收”分组、通知、权限钩子、审批卡片（M4）：M3 没人能中途批准，所以默认档用 `auto`（第 2.1 节）。
- `@Worker`、用户直接跟 Worker 说话：用户的话都经过项目经理，少一条路要测。用户想纠正 Worker，跟项目经理说就行。
- 汇报格式不对时自动让它重写：每一轮结束都当成一份汇报交给项目经理，格式不对就标“没按格式”，由项目经理看原文判断。
- 合并按钮、“通过”“打回”按钮、Worker 详情页（设计里的工单详情页）、改动预览：合并由用户在会话里说一句，项目经理用 git 做。
- 守护进程替 agent 合并、删 worktree、合并前检查：都交给项目经理用 git 做，少一套要测的代码。
- Worker 的数量上限：不限，额度让用户自己看（第 2.7 节）。
- 看门狗：卡住、原地打转、总时长上限（M7）。M3 靠用户看得见、能点停止（第 2.4 节）。
- 合并队列、自动变基：项目经理一次合一个，冲突它自己处理或者让 Worker 先更新。
- 过期的 worktree 自动删、启动时 `git worktree prune`（M7）：M3 由项目经理收拾。
- Worker 读原始消息（设计 2.3 的“按工单号读原始消息”，M3 里就是按 Worker 编号）：任务说明里写够就行。

## 2. 关键决定

### 2.1 Worker 的权限：默认和项目经理一样，两边都用 `auto` 档

**实测出的问题**：M2 给项目经理的设置文件里只有 `Bash(hub:*)` 和 `allowUnixSockets`，没设权限模式。官方文档说 2.1.302 起，`-p` 没设模式就是 Manual 档，“要批准的调用一律拒绝，除非允许规则、钩子或 `--permission-prompt-tool` 批准”（[headless][cc-headless] 的 Auto-approve tools 一节）。用户全局的 `~/.claude/settings.json` 里也没有 `permissions`。2026-11-03 用 haiku 实测了一次：照这个设置，Write 和 `mkdir && git add && git commit` 都被拒绝了（`permission_denials` 里两条）。也就是说，“自己也干活”的项目经理现在其实改不了文件，Worker 照抄这套也干不了活。

**结论（用户 11-03 定的）**：项目经理和 Worker 都用 `auto` 档，不加拒绝规则。只有 Worker 多一组“不能写记忆”的规则（第 2.2 节）。

- **`auto` 是什么**：分类器替人审每一步。工作区里读文件、改文件直接放行，其他操作由分类器判断是不是符合任务（[permission-modes][cc-modes]）。
  - 所有套餐都能用。模型要 Opus 4.6、Sonnet 4.6 或更新的，或者 Haiku 5.5、Fable。
  - 在 `-p` 下被连续拦 3 次或者累计 20 次，那个动作就不做，Claude 接着干，不会卡死。
  - 订阅账号的分类器调用不算用量，只有企业版和 API 账号算（[permission-modes][cc-modes] 的 Cost and latency 一节）。
- **推送、合并、装软件**：不用规则拦，写成提示词里的规矩，两边都有，放在 `prompt.ts` 的 `ASK_FIRST_RULES`：“推送、合并、装软件（`brew`、全局安装）、`sudo` 之前，先问用户。”项目经理直接问用户；Worker 问不了用户，就在汇报的“问题”里写，由项目经理去问。其余的交给分类器和项目经理自己判断。要知道的一点：文档写明 `auto` 默认允许“推送到当前仓库的任何分支”，所以推送前问不问用户，全靠这条规矩。
- **写进哪里**：设置文件的 `permissions.defaultMode: "auto"`，不加命令行参数。这样内容进 `fingerprint`，改了下一条消息前自动重启（M2 现成的机制）。`--settings` 文件里的 `defaultMode` 管用：冒烟 S11 用 `claude` 2.1.314 + haiku 实测，`system/init` 里的 `permissionMode` 是 `auto`，Write、`git commit`、`hub status` 都没被拦。

**“一样”具体指什么**：以 `src/daemon/launch.ts` 现在给项目经理的做法为准，Worker 走同一个函数：

- 照样加载全局 `~/.claude`：全局 `CLAUDE.md`、钩子、插件都进来，不用 `--bare`；
- 生成同样的三份文件：`prompt.md`、`settings.json`、空的 `mcp.json`（`--strict-mcp-config`）；
- 同样的环境变量：`HUB_TOKEN`（Worker 自己的令牌）、`HUB_SOCK`、`PATH`；
- 同一个默认档 `auto`；
- 工作目录不一样：在 worktree 里干活时是 worktree，不带项目的附加文件夹；在主文件夹里干活时和项目经理一样，主文件夹加附加文件夹。

**哪些地方和项目经理不一样**，各有理由：

| 哪里 | Worker | 理由 |
|---|---|---|
| 提示词 | 角色、任务说明、汇报格式、“不能改记忆文件”，没有性格设定和模式 | Worker 没有名字和性格，做完就散（设计 2.3） |
| `hub` 命令 | 只能用 `hub status`（我是哪个 Worker、任务是什么、在哪干活）。`project.*`、`persona.*`、`worker.*` 都返回 `forbidden` | 这是分工：Worker 不建项目、不挂文件夹、不改性格设定、不再派 Worker。Worker 用 Claude 自带的子 agent 不受影响。按角色放行的表只有一张：`src/shared/hub.ts` 的 `HUB_COMMAND_ROLES`，账本 `hubCall` 按会话的 role 查 |
| 记忆 | 不能写（第 2.2 节） | 用户定的，唯一的硬限制 |
| 派活时的开关 | 可以只读、选模型（下面） | 用户定的 |

**以后单独调的入口**：权限相关的东西都放在新文件 `src/shared/policy.ts` 里：

- 默认档 `DEFAULT_PERMISSION_MODE`；
- Worker 不能写记忆的规则 `WORKER_MEMORY_DENY_RULES`，以及要设的环境变量 `WORKER_ENV`；
- 只读开关用哪一档 `READONLY_PERMISSION_MODE`；
- 一个函数 `buildSessionSettings({ role, readonly, hubSock, hubHome })`，取代 M2 的 `buildHubSettings`。

`launch.ts` 只调这个函数。以后想让 Worker 默认和项目经理不一样，或者想加回某条拒绝规则，只改 `policy.ts`。M4 加权限钩子也加在这里。

**派活时的开关**（只留两个）：

- `--readonly`：Worker 只看不改，比如做调查、写方案。用 `dontAsk` 档：要批准的一律拒绝，读文件和只读命令照常能用（[permission-modes][cc-modes]）。
- `--model <模型>`：见第 2.4 节。

开关记在 Worker 的记录上，Worker 被打回、重启都沿用。开过只读的，“已派出”那一行上会写明。不管开关怎么写，记忆规则都不去掉：`buildSessionSettings` 最后无条件加上，有一条单元测试专门测这个。

### 2.2 Worker 不能写记忆（唯一的硬限制）

只管 Worker，项目经理照常能写。

**“记忆”包括什么**：

| 类 | 具体 | 怎么拦 |
|---|---|---|
| agent-hub 的性格设定 | `hub persona edit` | `HUB_COMMAND_ROLES` 不给 Worker，返回 `forbidden` |
| 同上，直接改文件 | `<数据目录>/state/personas/pm-<编号>.md`。M2 启动时会把手改的内容记成一次 `actor: file` 的修改，所以直接改文件也算改设定 | `Edit(//<数据目录真实路径>/state/**)`，`launch.ts` 按 `paths.ts` 生成（`policy.ts` 的 `stateDirDenyRule`，路径里的 `[`、`]`、`*`、`?`、`\` 转义）。顺带挡住数据库、令牌这些（设计 11.2） |
| 项目的约定文件 | 任何位置的 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`，以及 `.claude/` 下的东西（`.claude/CLAUDE.md`、`.claude/rules/`、项目的 `settings.json`、技能）：工作目录里、`--add-dir` 带进来的附加文件夹里都算 | `Edit(//**/AGENTS.md)`、`Edit(//**/CLAUDE.md)`、`Edit(//**/CLAUDE.local.md)`、`Edit(//**/.claude/**)`：`//` 开头的绝对通配。不用 `Edit(AGENTS.md)` 这种相对写法：它锚在当前目录（[permissions][cc-perms] 的 How path patterns match 一节），“任何深度”只在工作目录之下成立，附加文件夹里的拦不住。PR #31 审查用真 `claude` 加 `--add-dir` 实测过：相对写法下附加文件夹里的 `AGENTS.md`、`CLAUDE.md` 被改了；换成绝对通配后全部被拒，普通文件照样能写。在 worktree 里、在主文件夹里都一样 |
| Claude Code 的用户级记忆 | `~/.claude/` 整个：`CLAUDE.md`、`rules/`，以及 `settings.json`、`skills/`、`agents/`、`commands/`，这些改了会影响以后每个 agent | `Edit(~/.claude/**)`。`claude` 自己存会话记录不经过工具，不受影响 |
| Claude Code 的自动记忆 | `~/.claude/projects/<项目>/memory/`。文档说“同一个仓库的所有 worktree 共用一个自动记忆目录”（[memory][cc-memory] 的 Storage location 一节），所以 Worker 写进去，项目经理下次就会读到 | 给 Worker 设环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`，设置文件里再写 `autoMemoryEnabled: false`（[memory][cc-memory] 的 Enable or disable auto memory 一节）。上面的 `Edit(~/.claude/**)` 也兜着。代价是 Worker 也读不到自动记忆；项目约定在 `AGENTS.md` 和任务说明里 |

- `Edit` 规则也管 Write 工具、Bash 里认得出的 `sed`、`tee` 和重定向（[permissions][cc-perms] 的 What Read and Edit rules cover 一节）。拒绝规则在所有模式下都先于别的规则（同一页的 Manage permissions 一节）。
- **局限**：Worker 自己写 Python、Node 脚本去改文件，这些规则就拦不住了。文档也说这类规则“不是安全边界”，要真隔开得开沙箱，原型不做（设计第 11 章）。M3 不在合并前再查一道（用户定的）。合并是项目经理做的，它看改动时能看出来。
- **实测过**（冒烟 S12，2.1.314 + haiku）：`auto` 档下这几条拒绝规则生效，工作目录里的 `AGENTS.md`、附加文件夹里的 `AGENTS.md` 和 `CLAUDE.md`、`~/.claude/` 下的探针都在 `permission_denials` 里、文件没变；自动记忆目录前后一样；同一个 Worker 在工作目录和附加文件夹里写普通文件都成功。只读的 Worker（`dontAsk`）读得到、写入被拒。

**Worker 的任务本身就要改 `AGENTS.md` 怎么办**：由项目经理来改。Worker 的提示词写明：“记忆文件（`AGENTS.md`、`CLAUDE.md`、`.claude/` 下的东西）你不能改。觉得需要改，就在汇报的‘问题’里写清楚要改成什么。”项目经理验收时在主文件夹里自己改，它有写权限。

### 2.3 合并：用户在会话里说一句，项目经理用 git 做

- 用户说“合并吧”，项目经理在主文件夹里执行：
  1. `git status` 确认是干净的；
  2. `git merge --no-ff hub/<分支>`；
  3. 有冲突，就自己解决，或者打回给 Worker，让它基于最新的分支更新；
  4. 合并完 `git worktree remove <路径>`，分支留着；
  5. `hub worker end <编号>`。
- 只在本地合并，不推送。推送同样要先问用户（第 2.1 节）。
- 这几步写在项目经理的提示词里（`prompt.ts`），守护进程不碰 git，只建 worktree。
- 和设计不一样的地方：设计 11.1、15.3 是“用户点‘通过并合并’，守护进程合并”。现在改成用户在会话里说一句，项目经理来合。“合并要用户点头”还在，只是从按钮变成了一句话，靠的是提示词。

### 2.4 派活命令、模型、并发、卡住

- **命令**（`hub worker …`，只给项目经理）：
  - `start --title <标题> [--model <模型>] [--readonly] [--no-worktree] --stdin`：任务说明从标准输入读，要写清目标和验收标准；
  - `send <编号> --stdin`：打回，或者回答它的问题，同一个 Worker 会话接着做；
  - `end <编号>`：结束 Worker 会话。worktree 由项目经理自己删；
  - `list`：我派出去的 Worker、各自在哪干活、状态。
- **模型**：项目经理用 `--model` 定。不写就用项目经理自己的模型。提示词里建议：简单的活用便宜的模型。
- **同时跑几个**：不限，照设计 7.6。
- **卡住、失败**：M3 不做看门狗。
  - Worker 的对话和项目经理的一样有“正在运行 `xxx`”和停止按钮，用户看得见、点得停。
  - 这一轮出错、崩溃、被停止，项目经理都会收到一行，写明原因，由它决定 `send` 让 Worker 接着做，还是 `end` 收工。
  - 建 worktree 失败（重试 3 次后），项目经理的会话里发一行，写明原因，这个 Worker 标 `ended`。
  - 守护进程重启后照 M2 的做法用 `--resume` 恢复。关机打断的那一轮和 M1 不一样：Worker 的消息不标“已停止”，也不发“这一轮没做完”，重启后接着做完再汇报（第 6 节 W5 第 3 条）。

### 2.5 汇报格式和“做完了”

- 照设计 8.4，删掉了“证据”一项。Worker 每一轮最后一条回复以这段结尾：

  ```
  === 汇报 ===
  状态: 做完了 | 有问题 | 放弃了
  摘要: 一两句
  提交: <提交号>（没有写“无”）
  测试: <跑了什么，结果>
  问题: <要项目经理回答什么、要问用户什么，或者建议改哪个记忆文件>
  === 汇报结束 ===
  ```

- **守护进程怎么认出“做完了”**：不靠格式。Worker 只在收到任务或者项目经理的话时才跑一轮，所以每一轮的 `result` 都算一份汇报。
  - 账本在这一轮最后一段文字里找这段格式。
  - 找到了，就取“状态”和“摘要”放进那一行。
  - 找不到，就写“没按格式”，原文照样交给项目经理。
  - 格式说明和解析函数放在同一个文件：`src/shared/worker.ts`。
- **打回以后接着用同一个会话**：`hub worker send` 往 Worker 的对话里登记一条 `session.send`，发给同一个会话（第一次以后都是 `--resume`，M1 现成的）。聊过的、改过的都在。

### 2.6 在哪干活：worktree 还是主文件夹

- **默认**：主文件夹是 git 仓库、而且至少有一次提交（`git -C <主文件夹> rev-parse --verify HEAD` 成功），就建 worktree。不是 git 仓库，或者还没有提交，就在主文件夹里干活。系统不拦。
- **项目经理自己选**：`--no-worktree` 让 Worker 在主文件夹里干。
- **提示词里讲清楚两种做法的利弊**：

  | | worktree | 主文件夹 |
  |---|---|---|
  | 好处 | 和主文件夹、和别的 Worker 互不干扰；不满意整个扔掉就行；合并前能看清改了什么 | 不用合并；能看到主文件夹里还没提交的改动；不是 git 仓库也能用 |
  | 坏处 | 要合并；看不到主文件夹里没提交的改动；依赖要重新装（比如 `pnpm install`） | 两个 Worker、或者 Worker 和项目经理同时改同一个文件，会互相覆盖；改坏了不好退 |
  | 适合 | 改代码，尤其是同时派好几个的时候 | 很小的改动、不是代码的活、只读的调查 |

- 用 worktree 时，主文件夹里有没提交的改动，`start` 返回的话里会提醒：“Worker 是从最后一次提交开始的，看不到这些改动。”

### 2.7 额度

- 会话顶栏显示“5 小时额度已用 N% · 7 天 N%”。数据是现成的，每个会话每一轮都有 `rate_limit_event`，取最近一次的。
- 顶栏同时显示“N 个 Worker 在跑”。
- 项目经理的提示词里写：能自己几句话做完的就不派；简单的活派便宜的模型。
- 不做按 Worker 统计花了多少：`total_cost_usd` 是本地估算，订阅账号不按钱算，意义不大。

## 3. 拆分

6 块，每块一个 Worker、一个 PR。W0 和 W1 同时开工；W0 合并后 W2、W3、W4 同时开工；W5 等所有块合并后做。

```
W0 接口、迁移、policy ──┬── W2 账本：Worker、hub 命令、汇报 ┐
                        ├── W3 启动文件和提示词 ────────────┼── W5 组装 + 端到端 + 冒烟
                        └── W4 网页 + 界面服务 ──────────────┤
W1 建 worktree（不依赖别的） ──────────────────────────────────┘
```

**Worker 相关的东西各放在哪**（用户要求重要的部分放在一起）：

| 东西 | 放在哪 |
|---|---|
| 权限：默认档、记忆规则、只读档、生成设置文件的函数 | `src/shared/policy.ts`（新） |
| 汇报格式说明和解析 | `src/shared/worker.ts`（新） |
| 可调的数：任务说明多长、worktree 目录名 | `src/shared/limits.ts`、`src/shared/paths.ts` |
| `hub worker` 命令和按角色放行的表 | `src/shared/hub.ts`、`src/hub/cli.ts`；给 agent 看的用法在 `prompt.ts` |
| 提示词里的规矩：先问用户的事、合并和收拾 worktree 的步骤、worktree 和主文件夹的利弊 | `src/daemon/prompt.ts` |
| Worker 的提示词 | `src/daemon/prompt.ts` 的 `buildWorkerPrompt` |
| git：判断是不是仓库、建 worktree | `src/daemon/git/`（新） |
| 启动文件（两种角色一个函数） | `src/daemon/launch.ts` |
| 驱动层 | 不改，`claude` 的启动参数还在 `driver/protocol.ts` |

| 块 | 只改这些 | 依赖 |
|---|---|---|
| W0 接口和迁移 | `src/shared/`（`policy.ts`、`worker.ts`，以及 `domain.ts`、`hub.ts`、`api.ts`、`actions.ts`、`limits.ts`、`paths.ts` 里新增的部分）、`migrations/0004_workers.sql`、`test/migration.test.ts`；只为编译通过的占位 | 无 |
| W1 建 worktree | `src/daemon/git/`：`isRepoWithCommit`、`hasUncommittedChanges`、`addWorktree`（重复执行算成功） | 无 |
| W2 账本 | `src/daemon/ledger/`（新文件 `workers.ts`）、`hub-commands.ts`（`hubCall` 按 `HUB_COMMAND_ROLES` 放行）、`src/daemon/agent-api/`（请求体规格）、`src/hub/cli.ts`（`hub worker …` 的命令行解析） | W0 |
| W3 启动文件和提示词 | `src/daemon/launch.ts`、`src/daemon/prompt.ts`、`test/fake-claude/`（按会话选剧本） | W0 |
| W4 网页 + 界面服务 | `src/web/`、`src/daemon/ui-server/` | W0 |
| W5 组装 | `src/daemon/daemon.ts`、`handlers.ts`（`worktree.create` 的处理函数接到 W1）、`main.ts`、`test/e2e/`、`test/smoke/`、`HANDOVER.md`、本文档；名字收拢到 `src/shared/names.ts`（第 6 节）；修了关机打断 Worker 的 bug（驱动层、账本各一处） | W1～W4 |

**接口约定**（W0 写进 `src/shared/`，之后要改得在 PR 里说明）：

- 数据（迁移 `0004`）：
  - 新表 `workers`（每个 Worker 一行；类型叫 `WorkerRecord`、`WorkerId`，不叫 `Worker`：网页的 DOM 库里有全局的 `Worker`）：`id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, readonly, workspace(worktree|main), branch, worktree_path, base_commit, status(open|ended), created_at, updated_at`。用主文件夹时，`branch`、`worktree_path`、`base_commit` 是空的；
  - `conversations.kind` 加 `worker`（要重建表，迁移器 M2 就支持）；
  - `agent_sessions.ticket_id`、`messages.ticket_id`（0001 就留好的）改名 `worker_id`，在 `0004` 里用 `ALTER TABLE … RENAME COLUMN`；
  - 消息 `kind` 加 `worker`：项目经理会话里的那一行。`meta` 里带 `workerId`、`event`（`started`、`report`、`turn_failed`、`worktree_failed`、`ended`）、`status`、`summary`。
- 动作：加 `worktree.create`，去重键是 Worker 编号（`{ workerId }`），重试 3 次，做完再登记 Worker 的 `session.start` 和第一条 `session.send`。在主文件夹里干活的，不登记这个动作，直接登记这两样。`hub worker start` 同步判断用哪种，真正建 worktree 放到动作里做。
- 账本给驱动层事件的钩子：Worker 会话的这一轮结束（`result`、出错、停止）时，在同一个事务里发那一行、给项目经理登记 `session.send`。
- `LaunchContext` 加 `role`、`worker`（`WorkerRecord`：标题、任务、只读、在哪干活、分支）。项目经理的 `addDirs` 加 `<数据目录>/worktrees/<项目编号>/`：根目录是账本的构造参数 `LedgerOptions.worktreesDir`（默认 `<dataHome>/worktrees`，W5 显式传）；这一层目录由 W3 的启动准备在启动前 `mkdir -p`（`--add-dir` 要求目录在），每个 Worker 那一层由 `git worktree add` 建。
- 那一行的去重键带事件类型（`workerMessageDedupeKey`）：同一条消息先出错、重发后又跑出结果，两行都有。守护进程关机打断的一轮不发这一行，重启后接着做完再汇报。
- 标题超过 80 个字符截断，不报错；任务说明超过 100 KB 报 `invalid`。没按格式时那一行的摘要是原文第一行（截断）。

### 测试表（TDD，先写测试）

**W0**

| 测什么 | 期望 |
|---|---|
| 迁移 | M2 的库升到 4；`conversations` 能插 `kind='worker'`；老数据都在；升级前留了备份 |
| `buildSessionSettings`：项目经理 | `defaultMode: auto`；有 `Bash(hub:*)`、`allowUnixSockets`；没有任何拒绝规则；没有 `autoMemoryEnabled` |
| `buildSessionSettings`：Worker | 和项目经理的一样，再加记忆规则、`autoMemoryEnabled: false` |
| 只读 | `readonly: true` → `defaultMode: dontAsk`，记忆规则一条不少 |
| 汇报解析 | 标准格式、前面有别的文字、写了两段（取最后一段）、没有格式、状态写错 → 各自的状态和摘要，或者“没按格式” |

**W1**（真 git，临时目录）

| 测什么 | 期望 |
|---|---|
| 判断仓库 | 有提交的仓库 → 是；刚 `git init` 没提交的 → 否；普通文件夹 → 否 |
| 没提交的改动 | 干净 → 否；有改动、有没跟踪的文件 → 是 |
| 建 worktree | 分支和目录都对；再建一次算成功；目录被别的分支占着时报清楚的错 |

**W2**

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 派活（worktree） | 主文件夹是仓库，项目经理调 `worker.start` | `workers` 一行（`workspace: worktree`）、Worker 的对话和会话、会话里一行“已派出”、登记 `worktree.create`、`hub_calls` 一行 |
| 派活（主文件夹） | 主文件夹不是仓库；或者是仓库但带 `noWorktree` | `workers` 一行 `workspace: main`；会话 cwd 是主文件夹，`add_dirs` 和项目经理的一样；不登记 `worktree.create`，直接登记 `session.start` |
| 边界 | 没有项目、任务说明是空的或太长 | `invalid`，什么都没写 |
| 不限数量 | 连派 10 个 | 都成功 |
| 按角色放行 | Worker 调 `persona.edit`、`project.create`、`worker.start` | `forbidden`；`status` 能用，返回自己的记录 |
| 汇报回来 | Worker 这一轮 `result` | 项目经理会话里一行（状态、摘要）；给项目经理的 `session.send`，开头是“【Worker #N”；重放同一个 `result` 不会出两行 |
| 出错、停止 | Worker 这一轮失败、被停；建 worktree 失败 | 一行写明原因，同样交给项目经理；后一种这个 Worker 标 `ended` |
| 打回 | `worker.send 3` | 发给同一个 Worker 会话；别的项目经理派的 Worker → `forbidden` |
| 收工 | `worker.end 3` | 登记 `session.end`；Worker 标 `ended`；会话里一行“已收工” |

**W3**

| 测什么 | 期望 |
|---|---|
| Worker 的启动文件 | cwd 是 worktree（或主文件夹）；设置文件就是 `buildSessionSettings(worker)` 的结果；`env` 里有 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 和自己的 `HUB_TOKEN` |
| 和项目经理的差别 | 同一个项目的项目经理和 Worker，两份设置文件只差记忆那几条 |
| Worker 提示词 | 有任务、汇报格式、在哪干活、“不能改记忆文件，要改就写进汇报”、“推送、合并、装软件写进汇报的问题里”、只有 `hub status` 的用法；没有性格设定 |
| 项目经理提示词 | “只管理”模式写成派 Worker、验收；有 `ASK_FIRST_RULES`；合并和收拾 worktree 的步骤；worktree 和主文件夹的利弊；`hub worker` 用法 |
| 假 claude | 按会话（cwd 或 role）选剧本 |

**W4**

| 测什么 | 期望 |
|---|---|
| 那一行 | 推一条 `kind: worker` 的消息 → 显示成“Worker · 标题 · 状态：摘要”，不显示成普通的气泡；只读的有标记 |
| 点开 | 右边打开 Worker 的对话，有消息和折叠的操作；停止按钮停的是 Worker |
| 顶栏 | 显示额度百分比、在跑的 Worker 数 |

**W5 端到端**（真守护进程 + 假 `claude` + 临时 git 仓库）

| 测什么 | 期望 |
|---|---|
| 整条路：项目经理的剧本跑 `hub worker start`；Worker 的剧本在 worktree 里写文件、`git commit`，最后回一段汇报 | 项目经理会话里先“已派出”后“做完了”；项目经理收到“【Worker #1 …”；Worker 的 cwd 是 worktree |
| 打回：剧本跑 `hub worker send 1` | Worker 用 `--resume` 起同一个会话，会话里多一行汇报 |
| 收工：剧本跑 `hub worker end 1` | Worker 会话 `ended`、令牌作废，会话里一行“已收工” |
| 不是仓库：主文件夹不是 git 仓库，派活 | 能派；Worker 的 cwd 是主文件夹 |
| Worker 越权：剧本跑 `hub persona edit` | 退出码 1，`forbidden` |
| 重启：Worker 跑到一半 SIGTERM，再启动 | Worker 用 `--resume` 接着做，worktree 还在；关机时不发“这一轮没做完”，重启后只有一行汇报（验收第 11 条） |
| 重启：worktree 还没建好（第一次建失败、在等重试）就关机 | 再启动后接着建，Worker 照常开工、汇报 |
| 连派 10 个（用 worktree） | 都成功，10 个不同的 worktree，10 行汇报 |
| 建 worktree 失败：分支名已被占 | 重试 3 次后项目经理收到一行 `worktree_failed`，Worker 标 `ended`，没起 Worker 会话 |
| Worker 的对话 | 快照里有（kind `worker`）；`GET …/messages?before=` 能往前翻；`POST …/stop` 停的是 Worker，项目经理收到“被停止了” |

实现在 `test/e2e/m3.test.ts`（7 条）。

**真 `claude` 冒烟**（`pnpm smoke`，用 haiku，在一次性的小 git 仓库里跑，三次调用就够；M1、M2 的照跑）：

- **S11 默认档**：项目经理（`auto`）写一个文件、`git commit`，再跑 `hub status`。期望：都成功，`hub` 也没被拦，证明 `--settings` 里的 `defaultMode` 管用。
- **S12 Worker 写不了记忆**：一个 Worker 依次做三件事：
  - 写 `AGENTS.md`；
  - 写 `~/.claude/agent-hub-smoke-probe.md`（一个不存在的文件，跑完删掉，不碰用户真的 `CLAUDE.md`）；
  - “记住暗号 X，以后都用得上”。

  期望：前两件都在 `permission_denials` 里，`AGENTS.md` 和探针文件都没变；这个仓库的自动记忆目录跑前跑后一样。同一个 Worker 写一个普通文件能成功，证明不是整个都被拦了。
  - 带附加文件夹：项目挂一个附加文件夹（里面放 `AGENTS.md` 和 `CLAUDE.md`），派一个在主文件夹里干活的 Worker（带 `--add-dir`），让它改附加文件夹里这两个文件。期望：都在 `permission_denials` 里，文件没变；同一个附加文件夹里的普通文件能写。
- **S13 整条路**：项目经理一句话派一个 haiku Worker，改一行、提交；Worker 的汇报回到项目经理会话；用户说“合并吧”，主文件夹里有这次改动，worktree 删了。

实现在 `test/smoke/m3.ts`。2026-11-03 用 `claude` 2.1.314 + haiku 各跑一次，S11、S12、S13 都通过；顺带看了额度：`rate_limit_event` 里各窗口的 `utilization` 是 0～1 的小数（这次是 0.4、0.19），W4 按这个显示是对的。为了稳，S12 让项目经理原样跑一条现成的命令（任务说明放在文件里，`--stdin < 文件`），不靠它转述。

## 4. 要用户拍板的问题

都已定（用户 2026-11-03）：

1. **默认档**：项目经理和 Worker 都用 `auto`，不加拒绝规则。项目经理以前改不了文件，改成 `auto` 以后能改了。“自己也干活”的项目经理正好也需要这个，以前它其实干不了活。
2. **合并**：不做按钮。用户在会话里说一句，项目经理自己用 git 在本地合并、收拾 worktree。
3. **推送**：不是硬限制，也不留 `--allow-push` 开关。写进提示词：推送、合并、装软件之前先问用户。
4. **自动记忆**：Worker 关掉，代价是它也读不到。
5. **`~/.claude/`**：Worker 整个禁写。
6. **不是 git 仓库**：照样能派，Worker 在主文件夹里干活；项目经理也可以自己选。
7. **数量**：不限。

还没定的：无。

## 5. 验收

M3 所有 PR 合并后，用户在本机：

1. `pnpm install && pnpm build && pnpm check`：全部通过。`pnpm start`，M2 的项目经理、项目、聊天记录都在。
2. 准备一个小 git 仓库 `<仓库 A>`，至少提交过一次。新建一个“只管理”的项目经理，主文件夹填 `<仓库 A>`。
3. 说“派个 Worker 在 README 末尾加一行‘hello’，用 haiku”：会话里出现“Worker · … · 已派出”，顶栏显示“1 个 Worker 在跑”和额度百分比。
4. 点那一行：右边能看到 Worker 收到的任务、它的回复和操作，包括 `git commit`。
5. 过一会儿出现“Worker · … · 做完了：……”，项目经理接着说它验收的结论。
6. 说“让它把 hello 改成 hi”：项目经理打回，同一个 Worker 接着改（右边的记录是接着的），再来一行汇报。
7. 说“合并吧”：项目经理在 `<仓库 A>` 里合并、删 worktree、收工，会话里一行“已收工”。在终端里看 `<仓库 A>`：`git log` 有合并提交，README 末尾是 hi，`git worktree list` 里没有它了，`hub/…` 分支还在，没有推送。
8. 再派一个，任务说明里让它“顺便在 AGENTS.md 里记一下约定”：它的汇报里说改不了 AGENTS.md，在“问题”里写了建议；项目经理在主文件夹里自己改。
9. 再派一个，在它干活的时候点停止：项目经理收到“被停止了”。
10. 一个不是 git 仓库的文件夹，建成另一个项目经理的项目，让它派 Worker：照样能派，Worker 直接在那个文件夹里改。
11. 派一个慢的 Worker，Ctrl+C 再 `pnpm start`：Worker 接着做完，汇报照样回来。
12. `pnpm smoke`：S1～S6、S8～S13 全部通过。

## 6. 实际做法和计划不一样的地方（W5 组装后补）

各块 PR 里写明的差别，汇总在这里，以代码为准。

**W0（PR #31）**

1. `buildSessionSettings` 的参数用 `stateDir`（`state/` 的真实路径），不是 `hubHome`。
2. `WorkerMessageMeta` 多带 `workerConversationId`、`title`、`readonly`，网页显示那一行、点开对话都不用另查。
3. 消息发送方加了 `pm`：Worker 对话里项目经理说的话（任务说明、打回）。
4. 汇报和出错那一行就是交给项目经理的那条消息：`text` 以“【Worker #N · 标题 的汇报】”开头，走 `session.send`；`started`、`ended` 只给人看。
5. 标题超过 80 个字符截断；任务说明最多 100 KB。

**W2（PR #34）**

1. 项目经理的 `--add-dir` 里的 `worktrees/<项目编号>/` 是这个项目派过 worktree Worker 之后才加，没用 Worker 的项目经理不会因此重启。
2. 在主文件夹里干活的 Worker，`addDirs` 只带项目的附加文件夹。
3. 派活前由 agent 接口异步探 git（`probeWorkspace`，每次最多 5 秒），账本的事务里不做 I/O；git 没跑成就拒绝派活，提示重试或加 `--no-worktree`，不默默改成在主文件夹里干。
4. Worker 收工后，正在跑的那一轮照样汇报。
5. Worker 的消息发不出去（`session.send` 次数用完）也给项目经理发一行 `turn_failed`。

**W3（PR #33）**：`createPmLaunchPreparer` 改名 `createLaunchPreparer`，两种角色一个函数；`buildHubSettings` 删了，放行规则挪到 `policy.ts`。

**W5（组装）**

1. `worktree.create` 的处理函数在 `handlers.ts`：先 `getWorktreeTask`（null 或已收工 → 做完），再 `addWorktree`，再 `onWorktreeCreated`；git 出错抛给执行器重试，次数用完执行器调 `onActionFailed`。
2. `worktrees/` 启动时先 `mkdir -p` 再 realpath，账本和启动准备用同一个真实路径（`state/` 也是）。这样 Worker 的 cwd、项目经理的 `--add-dir` 和主文件夹、附加文件夹一样都是真实路径（macOS 上 `/var` 是 `/private/var`）。
3. **修了一个 bug：关机打断的一轮。** 关机时驱动层给忙着的 `claude` 发 SIGINT，`claude` 回一条被打断的 `result`。原来账本把它当成“用户点了停止”：Worker 的消息标“已停止”，项目经理收到“这一轮没做完：被停止了”，重启后也不会接着做，和接口约定、验收第 11 条对不上。现在：
   - 驱动层：关机时结束的那一轮，`turn.ended` 带 `shutdown: true`（`shared/driver.ts` 的 `TurnEndedEvent`）；
   - 账本：Worker 的会话遇到它（或者 `session.exited` 的 `shutdown`），消息不改状态，还是已送达、处理中，重启恢复把它重发给同一个会话；也不发那一行（`ledger/messages.ts` 的 `resumesAfterShutdown`、`ledger/workers.ts` 的 `turnOutcome`）；
   - 项目经理的会话照 M1：关机打断的消息标“已停止”，用户自己再发。
4. **名字收拢**：命令名、产品名只在 `src/shared/names.ts` 定（`HUB_COMMAND`、`PRODUCT_NAME`，加上由它们拼出来的 `LOG_PREFIX`、`DATA_DIR_NAME`、`WORKER_BRANCH_PREFIX`）。用到的地方：提示词、放行规则、`hub` 外壳的文件名、`hub/cli.ts` 的用法和报错、账本回给 agent 的话、Worker 的分支名、数据目录的默认名、日志开头、网页标题（`vite.config.ts` 把 `index.html` 里的 `%PRODUCT_NAME%` 换掉）和左上角。测试里的断言和假 `claude` 的剧本也用这些常量：把 `names.ts` 里的两个值改掉再跑 `pnpm check`，全部通过（W5 实测过）。
   - 没跟着变的：环境变量名（`AGENT_HUB_HOME` 这些，在 `limits.ts`），用户可能已经在 shell 里设了；`hub.sock`、`hub.sqlite` 这些内部文件名。
   - 还没做的：改了 `PRODUCT_NAME` 以后默认数据目录跟着变，已经有 `~/.agent-hub` 的用户要自己搬，或者用 `AGENT_HUB_HOME` 指过去。

[cc-headless]: https://code.claude.com/docs/en/headless
[cc-modes]: https://code.claude.com/docs/en/permission-modes
[cc-perms]: https://code.claude.com/docs/en/permissions
[cc-memory]: https://code.claude.com/docs/en/memory
