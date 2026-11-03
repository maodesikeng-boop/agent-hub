# M3 计划：Worker

> 状态：草案，第 4 节的问题等用户拍板。已经定了的：Worker 的权限默认和项目经理一样，默认档两边都用 `auto` 加拒绝规则（第 2.1 节）；派活命令里可以给 Worker 改一两个开关；Worker 不能写记忆，什么开关都放不开这一条。
> 依据：[prototype-design.md](prototype-design.md)（下文简称“设计”）第 2.3、3.3、5.1、7.7、8.4、11、12 章；[m0-report.md](m0-report.md)；main 上 `ace2901` 的 M2 实现；Claude Code 官方文档（链接在文末）；2026-11-03 用 `claude` 2.1.314 实测过一次（第 2.1 节）。
> 写于 2026-11-03。

## 1. 范围

**用户 11-03 定的样子**：“pm 一个会话，它的 worker 们在这个会话里回复它，我也可以点进去看 worker 做了什么”，还说了“先不要做复杂了”。体验照用户现在每天用的 T3 Code：项目经理派出子任务，Worker 在自己的 git worktree 里干活，干完结果作为一条消息回到项目经理的会话，点开能看 Worker 的完整过程。

**做完用户能看到什么**：跟项目经理说“派个 Worker 修一下 X”。会话里出现一行“Worker · 修 X · 已派出”。过一会儿又出现一行“Worker · 修 X · 做完了：……”，项目经理接着说它验收的结论。点这一行，右边打开 Worker 自己的过程：它收到的任务、它说的话、每一步操作，和项目经理的会话长得一样。项目经理觉得不行，会让它接着改，会话里再多一行汇报。项目经理说可以了，用户在那一行上点“合并”，改动就合进了主文件夹当前的分支，不推送。

**最小的那条路**

| 步骤 | 怎么做 |
|---|---|
| 派活 | 项目经理在 shell 里敲 `hub worker start --title "修 X" --stdin <<'EOF' …任务说明… EOF`（第 2.4 节）。账本建一张工单，在项目经理的会话里发一行“Worker · 修 X · 已派出” |
| 建 worktree | 守护进程在主文件夹里跑 `git worktree add -b hub/<编号>-<短名> <数据目录>/worktrees/<项目编号>/<编号> HEAD`（设计 7.7）。主文件夹不是 git 仓库就直接拒绝（第 2.6 节） |
| 起 Worker | Worker 有自己的对话（kind `worker`，左栏不显示）和会话（role `worker`，cwd 是 worktree）。第一条消息就是任务说明。驱动层不用改：会话照常启动、恢复、停止、结束 |
| 回到项目经理 | Worker 每一轮结束（`result`），账本取这一轮最后一段文字当汇报。在项目经理的会话里发一行“Worker · 标题 · <状态>：<摘要>”，再把汇报原文用 `session.send`（`source: system`）交给项目经理，开头带“【Worker #3 · 修 X 的汇报】”。这一轮出错、被停止，也发一行，说明原因 |
| 点开看过程 | 点那一行，右边打开 Worker 的对话。直接复用现有的 `MessageList`，翻页、操作折叠、状态行、停止按钮都是现成的 |
| 验收、打回 | 项目经理自己看 worktree 里的改动、跑测试（worktree 根目录用 `--add-dir` 加给它）。不行就 `hub worker send 3 --stdin`，同一个 Worker 会话接着做，回到上一步 |
| 合并 | 用户在 Worker 那一行上点“合并”。守护进程在主文件夹里 `git merge --no-ff hub/<分支>`，不推送。主文件夹有没提交的改动、有冲突（`--abort`）、改动里有记忆文件（第 2.2 节）时都不合并，会话里写明原因。合并成功后结束 Worker 会话，删 worktree，分支留着（第 2.3 节） |
| 不合并就收工 | 项目经理 `hub worker end 3`：结束会话。worktree 没有未提交的改动就删掉，有就留着，在那一行上注明 |

**M3 不做**（括号里是哪个里程碑做，或者为什么不做）

- 工单卡片的多种状态、原地更新：一行一行的汇报就够看了，状态只在账本里留一列。
- 收件箱、“待你验收”分组、通知、权限钩子、审批卡片（M4）：M3 没人能中途批准，所以默认档用 `auto`（第 2.1 节）。
- `@Worker`、用户直接跟 Worker 说话：用户的话都经过项目经理，少一条路要测。用户想纠正 Worker，跟项目经理说就行。
- 汇报格式不对时自动让它重写：每一轮结束都当成一份汇报交给项目经理，格式不对就标“没按格式”，由项目经理看原文判断。
- “通过”“打回”按钮、工单详情页、改动预览：验收是项目经理在会话里做的，用户只需要一个合并按钮。
- 看门狗：卡住、原地打转、总时长上限（M7）。M3 靠用户看得见、能点停止（第 2.5 节）。
- 合并队列、自动变基：一次合一个，冲突就交回项目经理。
- 失败的 worktree 过 7 天自动删、启动时 `git worktree prune`（M7）：M3 只在合并、收工时删。
- Worker 读原始消息（设计 2.3 的“按工单号读原始消息”）：任务说明里写够就行。

## 2. 关键决定

### 2.1 Worker 的权限：默认和项目经理一样

**实测出的问题**：M2 给项目经理的设置文件里只有 `Bash(hub:*)` 和 `allowUnixSockets`，没设权限模式。官方文档说 2.1.302 起，`-p` 没设模式就是 Manual 档，“要批准的调用一律拒绝，除非允许规则、钩子或 `--permission-prompt-tool` 批准”（[headless][cc-headless] 的 Auto-approve tools 一节）。用户全局的 `~/.claude/settings.json` 里也没有 `permissions`。2026-11-03 用 haiku 实测了一次：照这个设置，Write 和 `mkdir && git add && git commit` 都被拒绝了（`permission_denials` 里两条）。也就是说，“自己也干活”的项目经理现在其实改不了文件，Worker 照抄这套也干不了活。

**结论（用户 11-03 定的，第 4 节第 1 条再请用户确认一次）**：项目经理和 Worker 都用 `auto` 档，再加一组拒绝规则。

- **`auto` 是什么**：分类器替人审每一步。工作区里读文件、改文件直接放行，其他操作由分类器判断是不是符合任务（[permission-modes][cc-modes]）。所有套餐都能用；模型要 Opus 4.6、Sonnet 4.6 或更新的，或者 Haiku 5.5、Fable。在 `-p` 下被连续拦 3 次或者累计 20 次，那个动作就不做，Claude 接着干，不会卡死。订阅账号的分类器调用不算用量，只有企业版和 API 账号算（[permission-modes][cc-modes] 的 Cost and latency 一节）。
- **拒绝规则**（两边都有）：`Bash(git push *)`、`Bash(git merge *)`、`Bash(brew *)`、`Bash(npm install -g *)`、`Bash(npm i -g *)`、`Bash(pnpm add -g *)`、`Bash(pip install *)`、`Bash(sudo *)`。为什么要拦推送：文档写明 `auto` 默认允许“推送到当前仓库的任何分支”。为什么要拦 `git merge`：合并要用户点按钮（第 2.3 节）。拒绝规则在所有模式下都先于允许规则（[permissions][cc-perms] 的 Manage permissions 一节）。
- **写进哪里**：设置文件的 `permissions.defaultMode: "auto"` 和 `permissions.deny`，不加命令行参数。这样内容进 `fingerprint`，改了下一条消息前自动重启（M2 现成的机制）。`--settings` 文件里的 `defaultMode` 管不管用，要实测（冒烟 S11）；不管用就改成在 `buildClaudeArgs` 加 `--permission-mode`。
- **局限，要告诉用户**：拒绝规则只认 Claude 常写的那种命令形式，换个写法就拦不住，比如 `git -C . push`、写个脚本去推。文档原话是“不是安全边界”（[permissions][cc-perms] 的 What a Bash rule doesn't match 一节）。所以推送最后靠的是守护进程不给 agent 凭证（设计 11.3），合并靠守护进程合并前的检查。要真隔开得开沙箱，原型不做（设计第 11 章）。

**“一样”具体指什么**：以 `src/daemon/launch.ts` 现在给项目经理的做法为准，Worker 走同一个函数：

- 照样加载全局 `~/.claude`：全局 `CLAUDE.md`、钩子、插件都进来，不用 `--bare`；
- 生成同样的三份文件：`prompt.md`、`settings.json`、空的 `mcp.json`（`--strict-mcp-config`）；
- 同样的环境变量：`HUB_TOKEN`（Worker 自己的令牌）、`HUB_SOCK`、`PATH`；
- 同一个默认档（`auto` + 上面的拒绝规则）；
- 不一样的只有工作目录：换成 Worker 的 worktree，不带项目的附加文件夹。

**哪些地方必须和项目经理不一样**，各有理由：

| 哪里 | Worker | 理由 |
|---|---|---|
| 提示词 | 角色、任务说明、汇报格式、“不要改记忆文件”，没有性格设定和模式 | Worker 没有名字和性格，做完就散（设计 2.3） |
| `hub` 命令 | 只能用 `hub status`（我是哪张工单、任务是什么、worktree 在哪）。`project.*`、`persona.*`、`worker.*` 都返回 `forbidden` | Worker 不该建项目、挂文件夹、改性格设定，也不该再派 Worker（不套娃）。按角色放行的表只有一张：`src/shared/hub.ts` 的 `HUB_COMMAND_ROLES`，账本 `hubCall` 按会话的 role 查 |
| 记忆 | 不能写（第 2.2 节） | 用户定的 |
| 派活时的开关 | 可以覆盖默认档（下面） | 用户定的 |

**以后单独调的入口**：权限相关的东西都放在一个新文件 `src/shared/policy.ts` 里：

- 默认档 `DEFAULT_PERMISSION_MODE`；
- 两边共用的拒绝规则 `BASE_DENY_RULES`；
- Worker 不能写记忆的规则 `WORKER_MEMORY_DENY_RULES`，以及要设的环境变量；
- 开关 `WORKER_SWITCHES`；
- 一个函数 `buildSessionSettings({ role, switches, hubSock, hubHome })`，取代 M2 的 `buildHubSettings`。

`launch.ts` 只调这个函数。以后想让 Worker 默认和项目经理不一样，只改 `policy.ts` 里 Worker 那一份。M4 加权限钩子也加在这里。

**派活时的开关**（覆盖默认档，只留两个）：

- `--readonly`：Worker 只看不改，比如做调查、写方案。用 `dontAsk` 档：要批准的一律拒绝，读文件和只读命令照常能用（[permission-modes][cc-modes]）。
- `--allow-push`：去掉 `Bash(git push *)` 这条拒绝规则。这条碰到了红线，做不做见第 4 节第 3 条。

开关记在工单上，Worker 被打回、重启都沿用。开过的开关写在“已派出”那一行上，用户看得见。不管开关怎么写，记忆那几条规则都不去掉：`buildSessionSettings` 最后无条件加上，有一条单元测试专门测这个。

### 2.2 Worker 不能写记忆

只管 Worker，项目经理照常能写。

**“记忆”包括什么**：

| 类 | 具体 | 怎么拦 |
|---|---|---|
| agent-hub 的性格设定 | `hub persona edit` | `HUB_COMMAND_ROLES` 不给 Worker，返回 `forbidden` |
| 同上，直接改文件 | `<数据目录>/state/personas/pm-<编号>.md`（M2 启动时会把手改的内容记成一次 `actor: file` 的修改，所以直接改文件也算改设定） | `Edit(//<数据目录真实路径>/state/**)`，`launch.ts` 按 `paths.ts` 生成。顺带挡住数据库、令牌这些（设计 11.2） |
| 项目的约定文件 | worktree 里任何一层的 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.claude/` 下的东西（`.claude/CLAUDE.md`、`.claude/rules/`、项目的 `settings.json`、技能） | `Edit(AGENTS.md)`、`Edit(CLAUDE.md)`、`Edit(CLAUDE.local.md)`、`Edit(.claude/**)`。只写文件名就是“任何深度”（[permissions][cc-perms] 的 How deep a pattern matches 一节） |
| Claude Code 的用户级记忆 | `~/.claude/CLAUDE.md`、`~/.claude/rules/`；同目录下的 `settings.json`、`skills/`、`agents/`、`commands/` 也会改掉以后每个 agent 的行为 | `Edit(~/.claude/**)`，整个禁写（第 4 节第 5 条） |
| Claude Code 的自动记忆 | `~/.claude/projects/<项目>/memory/`。文档说“同一个仓库的所有 worktree 共用一个自动记忆目录”（[memory][cc-memory] 的 Storage location 一节），所以 Worker 写进去，项目经理下次就会读到 | 给 Worker 设环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`，设置文件里再写 `autoMemoryEnabled: false`（[memory][cc-memory] 的 Enable or disable auto memory 一节）。上面的 `Edit(~/.claude/**)` 也兜着。代价是 Worker 读不到自动记忆（第 4 节第 4 条） |

- `Edit` 规则也管 Write 工具、Bash 里认得出的 `sed`、`tee` 和重定向（[permissions][cc-perms] 的 What Read and Edit rules cover 一节）。Worker 自己写 Python、Node 脚本去改文件，就拦不住了。
- **兜底**：合并前守护进程用 `git diff --name-only <基准>...<分支>` 查一遍。改动里有上面那些项目约定文件，就不合并，会话里写明“Worker 改了 AGENTS.md，记忆文件要项目经理来改”。这一道是守护进程自己查的，不依赖 Claude 认不认得命令。
- **要实测的**（冒烟 S12）：自动记忆关掉以后真的不写；`Edit(~/.claude/**)` 挡得住 Write；`auto` 档下拒绝规则照样生效。

**Worker 的任务本身就要改 `AGENTS.md` 怎么办**：项目经理来改。Worker 的提示词写明：“记忆文件（`AGENTS.md`、`CLAUDE.md`、`.claude/` 下的东西）你不能改。觉得需要改，就在汇报的‘问题’里写清楚要改成什么。”项目经理验收时在主文件夹里自己改，它有写权限。

### 2.3 合并：用户在网页上点按钮

- 推荐**网页上的“合并”按钮**，放在 Worker 那一行上。Worker 的分支比基准多出提交、会话不在跑的时候才显示。接口是 `POST /api/workers/:id/merge`，只认界面用户令牌，会话令牌调不了。所以 agent 批准不了自己（设计 11.4）。
- 点了以后守护进程同步做完，不走动作队列（合并不重试，设计 12.2）。依次是：查主文件夹干净 → 查改动里没有记忆文件 → `git merge --no-ff` → 冲突就 `git merge --abort`。成功后在会话里发“已合并 Worker · 标题（<提交号>）”，同时把这句话交给项目经理。失败也发一行，写明原因，同样交给项目经理。
- 只在本地合并，不推送。合进主文件夹当前所在的分支。
- 没选“用户在会话里说一句，项目经理调 `hub worker merge`”：这等于 agent 替用户点头，和设计 11.4 冲突；而且 `auto` 档下项目经理也能自己敲 `git merge`，所以两边都加了拒绝规则。

### 2.4 派活命令、模型、并发、卡住

- **命令**（`hub worker …`，只给项目经理）：
  - `start --title <标题> [--model <模型>] [--readonly] [--allow-push] --stdin`：任务说明从标准输入读，要写清目标和验收标准；
  - `send <编号> --stdin`：打回或者回答它的问题，同一个 Worker 会话接着做；
  - `end <编号>`：不合并，收工；
  - `list`：我派出去的 Worker 和各自的状态。
- **模型**：项目经理用 `--model` 定。不写就用项目经理自己的模型。提示词里建议：简单的活用便宜的模型。
- **同时跑几个**：每个项目经理同时最多 3 个没收工的 Worker（`limits.ts` 的 `MAX_OPEN_WORKERS_PER_PM`），超了 `start` 返回 `conflict`“已经有 3 个 Worker 没收工，先收掉一个”。设计 7.6 原来是不设上限，这里加了一个，是为了额度（第 2.7 节）。
- **卡住、失败**：M3 不做看门狗。Worker 的对话和项目经理的一样有“正在运行 `xxx`”和停止按钮，用户看得见、点得停。这一轮出错、崩溃、被停止，项目经理都会收到一行，写明原因，由它决定 `send` 让 Worker 接着做，还是 `end` 收工。建 worktree 失败，`start` 直接报错，不留工单。守护进程重启后照 M2 的做法用 `--resume` 恢复。

### 2.5 汇报格式和“做完了”

- 照设计 8.4，删掉了“证据”一项。Worker 每一轮最后一条回复以这段结尾：

  ```
  === 汇报 ===
  状态: 做完了 | 有问题 | 放弃了
  摘要: 一两句
  提交: <提交号>（没有写“无”）
  测试: <跑了什么，结果>
  问题: <要项目经理回答什么，或建议改哪个记忆文件>
  === 汇报结束 ===
  ```

- **守护进程怎么认出“做完了”**：不靠格式。Worker 只在收到任务或者项目经理的话时才跑一轮，所以每一轮的 `result` 都算一份汇报。账本在这一轮最后一段文字里找这段格式：找到就取“状态”和“摘要”放进那一行；找不到就写“没按格式”，原文照样交给项目经理。格式说明和解析函数放在同一个文件 `src/shared/worker.ts`。
- **打回以后接着用同一个会话**：`hub worker send` 往 Worker 的对话里登记一条 `session.send`，发给同一个会话（第一次以后都是 `--resume`，M1 现成的）。聊过的、改过的都在。

### 2.6 项目文件夹不是 git 仓库

`hub worker start` 先跑 `git -C <主文件夹> rev-parse --verify HEAD`。不是仓库，或者还没有任何提交，就返回 `invalid`“主文件夹不是 git 仓库（或者还没有提交），派不了 Worker。可以请用户先 `git init` 并提交一次，或者你自己做”。主文件夹有没提交的改动时照样能派，但返回的话里提醒：Worker 是从最后一次提交开始的，看不到这些改动。

### 2.7 额度

- 会话顶栏显示“5 小时额度已用 N% · 7 天 N%”。数据是现成的，每个会话每一轮都有 `rate_limit_event`，取最近一次的。
- 顶栏同时显示“N 个 Worker 在跑”。
- 每个项目经理最多 3 个没收工的 Worker（第 2.4 节）。
- 项目经理的提示词里写：能自己几句话做完的不派；简单的活派便宜的模型。
- 不做按工单统计花了多少：`total_cost_usd` 是本地估算，订阅账号不按钱算，意义不大。

## 3. 拆分

6 块，每块一个 Worker、一个 PR。W0 和 W1 同时开工；W0 合并后 W2、W3、W4 同时开工；W5 等所有块合并后做。

```
W0 接口、迁移、policy ──┬── W2 账本：工单、hub 命令、汇报 ──┐
                        ├── W3 启动文件和提示词 ────────────┼── W5 组装 + 端到端 + 冒烟
                        └── W4 网页 + 界面服务 ──────────────┤
W1 git 操作（不依赖别的） ─────────────────────────────────────┘
```

**Worker 相关的东西各放在哪**（用户要求重要的部分放在一起）：

| 东西 | 放在哪 |
|---|---|
| 权限：默认档、拒绝规则、记忆规则、开关、生成设置文件的函数 | `src/shared/policy.ts`（新） |
| 汇报格式说明和解析 | `src/shared/worker.ts`（新） |
| 可调的数：并发上限、任务说明多长、worktree 目录名 | `src/shared/limits.ts`、`src/shared/paths.ts` |
| `hub worker` 命令和按角色放行的表 | `src/shared/hub.ts`、`src/hub/cli.ts`；给 agent 看的用法在 `prompt.ts` |
| git：建、删 worktree，合并，查改动 | `src/daemon/git/`（新） |
| Worker 的提示词 | `src/daemon/prompt.ts` 的 `buildWorkerPrompt` |
| 启动文件（两种角色一个函数） | `src/daemon/launch.ts` |
| 驱动层 | 不改，`claude` 的启动参数还在 `driver/protocol.ts` |

| 块 | 只改这些 | 依赖 |
|---|---|---|
| W0 接口和迁移 | `src/shared/`（`policy.ts`、`worker.ts`，以及 `domain.ts`、`hub.ts`、`api.ts`、`actions.ts`、`limits.ts`、`paths.ts` 里新增的部分）、`migrations/0004_workers.sql`、`test/migration.test.ts`；只为编译通过的占位 | 无 |
| W1 git 操作 | `src/daemon/git/`：`isRepoWithCommit`、`addWorktree`（重复执行算成功）、`removeWorktree`（有未提交改动就不删）、`changedFiles`、`isClean`、`merge`（冲突自动 abort） | 无 |
| W2 账本 | `src/daemon/ledger/`（新 `workers.ts`）、`hub-commands.ts`、`src/daemon/agent-api/`（按角色放行） | W0 |
| W3 启动文件和提示词 | `src/daemon/launch.ts`、`src/daemon/prompt.ts`、`test/fake-claude/`（按会话分剧本） | W0 |
| W4 网页 + 界面服务 | `src/web/`、`src/daemon/ui-server/` | W0 |
| W5 组装 | `src/daemon/daemon.ts`、`handlers.ts`（`worktree.create` 处理函数、合并接到 W1）、`main.ts`、`test/e2e/`、`test/smoke/`、`HANDOVER.md`、本文档 | W1～W4 |

**接口约定**（W0 写进 `src/shared/`，之后要改得在 PR 里说明）：

- 数据（`0004`）：
  - 新表 `tickets`：`id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, switches(JSON), branch, worktree_path, base_commit, status(open|merged|ended), created_at, updated_at`；
  - `conversations.kind` 加 `worker`（要重建表，迁移器 M2 就支持）；
  - `agent_sessions.ticket_id`、`messages.ticket_id` 已经有了；
  - 消息 `kind` 加 `worker`：项目经理会话里的那一行，`meta` 里带 `ticketId`、`event`（`started`、`report`、`turn_failed`、`merged`、`merge_failed`、`ended`）、`status`、`summary`。
- 动作：加 `worktree.create`（去重键是工单号，3 次重试），做完再登记 Worker 的 `session.start` 和第一条 `session.send`。`hub worker start` 先同步检查是不是 git 仓库，真正建 worktree 放到动作里做。
- 账本给驱动层事件的钩子：Worker 会话的这一轮结束（`result`、出错、停止）时，在同一个事务里发那一行、给项目经理登记 `session.send`。
- `LaunchContext` 加 `role`、`ticket`（标题、任务、开关、worktree、分支）。项目经理的 `addDirs` 加 `<数据目录>/worktrees/<项目编号>/`。

### 测试表（TDD，先写测试）

**W0**

| 测什么 | 期望 |
|---|---|
| 迁移 | M2 的库升到 4，`conversations` 能插 `kind='worker'`，老数据都在，升级前留了备份 |
| `buildSessionSettings` 项目经理 | `defaultMode: auto`；有 `BASE_DENY_RULES`；没有记忆规则；没有 `autoMemoryEnabled` |
| `buildSessionSettings` Worker | 和项目经理的一样，再加记忆规则、`autoMemoryEnabled: false` |
| 开关 | `--readonly` → `dontAsk`；`--allow-push` 去掉推送那条；两个开关都开，记忆规则一条不少 |
| 汇报解析 | 标准格式、前面有别的文字、写了两段（取最后一段）、没有格式、状态写错 → 各自的状态和摘要，或者“没按格式” |

**W1**（真 git，临时目录）

| 测什么 | 期望 |
|---|---|
| 建 worktree | 分支和目录都对；再建一次算成功；不是仓库、没有提交时报清楚的错 |
| 删 | 干净的删掉，分支留着；有未提交改动的不删，报出来 |
| 合并 | 正常 `--no-ff` 合进去；主文件夹有改动不合；冲突时 abort，主文件夹恢复原样 |
| `changedFiles` | 列出基准之后改过的文件，包括子目录里的 `AGENTS.md` |

**W2**

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 派活 | 项目经理调 `worker.start` | 一张工单、Worker 的对话和会话、会话里一行“已派出”、登记 `worktree.create`、`hub_calls` 一行 |
| 边界 | 没有项目、主文件夹不是仓库、任务说明是空的或太长、已经有 3 个没收工的 | `invalid` / `invalid` / `invalid` / `conflict`，什么都没写 |
| 按角色放行 | Worker 调 `persona.edit`、`project.create`、`worker.start` | `forbidden`；`status` 能用，返回自己的工单 |
| 汇报回来 | Worker 这一轮 `result` | 项目经理会话里一行（状态、摘要）；给项目经理的 `session.send`，开头是“【Worker #N”；重放同一个 `result` 不会出两行 |
| 出错、停止 | Worker 这一轮失败、被停 | 一行写明原因，同样交给项目经理 |
| 打回 | `worker.send 3` | 发给同一个 Worker 会话；别的项目经理的工单 → `forbidden` |
| 收工 | `worker.end 3` | 登记 `session.end`；工单 `ended` |
| 合并 | `mergeWorker(id)`，用假的 git | 成功：工单 `merged`、一行、交给项目经理、登记删 worktree 和 `session.end`；改动里有 `AGENTS.md`、主文件夹不干净、冲突 → 不合并，一行写原因 |

**W3**

| 测什么 | 期望 |
|---|---|
| Worker 的启动文件 | cwd 是 worktree；设置文件就是 `buildSessionSettings(worker)` 的结果；`env` 里有 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 和自己的 `HUB_TOKEN` |
| 和项目经理的差别 | 同一个项目的项目经理和 Worker，两份设置文件只差记忆那几条 |
| Worker 提示词 | 有任务、汇报格式、“不能改记忆文件，要改就写进汇报”、只有 `hub status` 的用法；没有性格设定 |
| 项目经理提示词 | “只管理”模式写成派 Worker、验收、请用户点合并；`hub worker` 用法；worktree 目录在附加文件夹里 |
| 假 claude | 按会话（cwd 或 role）选剧本 |

**W4**

| 测什么 | 期望 |
|---|---|
| 那一行 | 推一条 `kind: worker` 的消息 → 显示成“Worker · 标题 · 状态：摘要”，不显示成普通的气泡 |
| 点开 | 右边打开 Worker 的对话，有消息和折叠的操作；停止按钮停的是 Worker |
| 合并按钮 | 能合的时候才显示；点了发 `POST /api/workers/:id/merge`；409 时显示原因 |
| 顶栏 | 显示额度百分比、在跑的 Worker 数 |
| 界面服务 | 合并接口没登录是 401；带会话令牌也是 401 |

**W5 端到端**（真守护进程 + 假 `claude` + 临时 git 仓库）

| 测什么 | 期望 |
|---|---|
| 整条路：项目经理的剧本跑 `hub worker start`；Worker 的剧本在 worktree 里写文件、`git commit`，最后回一段汇报 | 项目经理会话里先“已派出”后“做完了”；项目经理收到“【Worker #1 …”；Worker 的 cwd 是 worktree |
| 打回：剧本跑 `hub worker send 1` | Worker 用 `--resume` 起同一个会话，会话里多一行汇报 |
| 合并：调合并接口 | 主文件夹多出一个合并提交；worktree 删了，分支还在；Worker 会话 `ended`、令牌作废 |
| 合并被拒：Worker 改了 `AGENTS.md` | 不合并，一行写明原因 |
| 不是仓库：主文件夹不是 git 仓库 | `hub` 退出码 1，什么都没建 |
| Worker 越权：剧本跑 `hub persona edit` | 退出码 1，`forbidden` |
| 重启：Worker 跑到一半 SIGTERM，再启动 | Worker 用 `--resume` 接着做，worktree 还在 |

**真 `claude` 冒烟**（`pnpm smoke`，用 haiku，在一次性的小 git 仓库里跑，三次调用就够；M1、M2 的照跑）：

- **S11 权限默认档**：项目经理（`auto`）写一个文件，跑 `hub status`。期望：写成了，`hub` 也没被拦，证明 `--settings` 里的 `defaultMode` 管用。
- **S12 Worker 的权限和记忆**：一个 Worker 依次做：写文件并 `git commit`；`git push` 到一个临时的裸仓库；写 `AGENTS.md`；写 `~/.claude/agent-hub-smoke-probe.md`（不存在的文件，跑完删掉，不碰用户真的 `CLAUDE.md`）；“记住暗号 X”。期望：第一件成功；推送、`AGENTS.md`、探针文件都在 `permission_denials` 里，裸仓库没变，探针文件不存在；这个仓库的自动记忆目录跑前跑后一样。
- **S13 整条路**：项目经理一句话派一个 haiku Worker，改一行、提交；Worker 的汇报回到项目经理会话；点合并，主文件夹里有这次改动。

## 4. 要用户拍板的问题

**1. 默认档：项目经理和 Worker 都用 `auto` 加拒绝规则（请最后确认）。**
- 推荐：用。你 11-03 已经按推荐定了，这里再确认一次影响：**项目经理以前改不了文件，改成 `auto` 以后能改了**。实测 M2 的项目经理 Write、`git commit` 都被拒，“自己也干活”的项目经理其实干不了活，`auto` 正好也修了这个。“只管理”的项目经理也会有写权限，但模式只是提示词，设计 2.2 本来就是“程序不硬拦”。
- 没选：`acceptEdits` 加允许规则（测试命令要一条条列，换个项目就卡住）；只给 Worker 加一档（项目经理还是干不了活，验收也跑不了测试）；都不动，等 M4 的权限钩子（M3 的 Worker 干不了活）。

**2. 合并：网页上的“合并”按钮。**
- 推荐：按钮（第 2.3 节）。agent 拿不到界面令牌，替不了你点头。
- 没选：你在会话里说一句，项目经理调 `hub worker merge`。少一个按钮，但等于 agent 自己批准自己。

**3. `--allow-push` 开关现在做不做？** 推送是红线（设计 11.1：对外的动作要用户点头）。
- 推荐：做，但有三个限制：提示词写明“只有用户明确说了才开”；“已派出”那一行醒目地写“允许推送”；推送用的凭证还是你自己的 git 配置，守护进程不给。
- 没选：M3 先不做，等 M4 有了审批，推送前弹卡片问你。更稳，但 M3 里推送只能你自己来。

**4. Worker 关掉自动记忆，代价是它也读不到。**
- 推荐：关（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`）。自动记忆是整个仓库的 worktree 共用的，Worker 写进去，项目经理下次就会读到。Worker 要知道的项目约定在 `AGENTS.md` 和任务说明里。
- 没选：开着自动记忆，只用拒绝规则挡住往记忆目录里写，Worker 还能读。但自动记忆是不是都经过 Edit、Write 工具写，文档没说，要实测才知道挡不挡得住。

**5. Worker 整个 `~/.claude/` 都禁写，还是只禁 `CLAUDE.md`、`rules/` 和记忆？**
- 推荐：整个禁写。那下面的 `settings.json`、技能、子 agent、命令，改了也会影响以后每个 agent，跟记忆是一回事；Worker 也没有理由去写那里。`claude` 自己存会话记录不经过工具，不受影响。
- 没选：只禁三样（Worker 能装技能、改全局设置，范围太大）。

## 5. 验收

M3 所有 PR 合并后，用户在本机：

1. `pnpm install && pnpm build && pnpm check`：全部通过。`pnpm start`，M2 的项目经理、项目、聊天记录都在。
2. 准备一个小 git 仓库 `<仓库 A>`，至少提交过一次。新建一个“只管理”的项目经理，主文件夹填 `<仓库 A>`。
3. 说“派个 Worker 在 README 末尾加一行‘hello’，用 haiku”：会话里出现“Worker · … · 已派出”，顶栏显示“1 个 Worker 在跑”和额度百分比。
4. 点那一行：右边能看到 Worker 收到的任务、它的回复和操作，包括 `git commit`。
5. 过一会儿出现“Worker · … · 做完了：……”，项目经理接着说它验收的结论。
6. 说“让它把 hello 改成 hi”：项目经理打回，同一个 Worker 接着改（右边的记录是接着的），再来一行汇报。
7. 点“合并”：会话里一条“已合并”。在终端里看 `<仓库 A>`：`git log` 有合并提交，README 末尾是 hi，`git worktree list` 里没有它了，`hub/…` 分支还在。没有推送。
8. 再派一个，任务说明里让它“顺便在 AGENTS.md 里记一下约定”：它的汇报里说改不了 AGENTS.md，在“问题”里写了建议；项目经理在主文件夹里自己改。
9. 再派一个，在它干活的时候点停止：项目经理收到“被停止了”；让项目经理收工，worktree 删了。
10. 把一个不是 git 仓库的文件夹建成另一个项目经理的项目，让它派 Worker：它转告“主文件夹不是 git 仓库……”。
11. 派一个慢的 Worker，Ctrl+C 再 `pnpm start`：Worker 接着做完，汇报照样回来。
12. `pnpm smoke`：S1～S6、S8～S13 全部通过。

[cc-headless]: https://code.claude.com/docs/en/headless
[cc-modes]: https://code.claude.com/docs/en/permission-modes
[cc-perms]: https://code.claude.com/docs/en/permissions
[cc-memory]: https://code.claude.com/docs/en/memory
