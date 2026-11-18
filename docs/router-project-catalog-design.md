# 总助的项目目录：后台按对话增量维护，名片两层披露（方案）

> 2026-11-17，Worker #641。只是方案和骨架，没改运行行为。基于 main `95627917`（PR #340）。

## 给用户看

### 要验收的文件

- [`docs/router-project-catalog-example.md`](router-project-catalog-example.md)：总助改完后看到的名片（第一层）、按需展开的档案（第二层）、后台什么时候写档，各给一个例子。第二层的档案是实跑模型写出来的。
- 本文第 3.6 节：整个流程一页说完，想看细节再看。

### 要拍板的事

1. **后台怎么写档。**
   - A（推荐）：守护进程从账本取上次之后你和项目经理的对话、最新交接、结束的任务图，单独跑一轮模型写档。不碰项目经理的会话。
   - B：照写交接那样复制（fork）项目经理的会话去写。
   - 推荐 A：B 每次要读进项目经理整个会话（本机实测 7 万到 24 万 token），agy 复制没有缓存，还要等项目经理两轮之间的空当，并和写交接抢同一个会话。A 每次 1 到 3.5 万 token，随时能跑，四家厂商一样。B 唯一多看到的是工具输出（看过哪些代码），这部分已经写进交接，A 会读交接。你原话里的“fork 放在后台”，A 保留“放在后台、不打扰项目经理”，只是不复制会话。
2. **写档用哪个模型。**
   - A（推荐）：和总助同一份设置（总助台上选的那个，现在是 agy `gemini-3.8-flash` low）。
   - B：跟这个项目的项目经理同一家、同一个模型。
   - C：新加一项单独的设置。
   - 推荐 A：写档和总助分派一样是轻活，用户已经为总助选过便宜快的模型；不加新设置。B 会让写档用上 Opus 这种贵模型。
3. **总助能看多深。**
   - A（推荐）：两层。第一层每次都在名片里；第二层是完整档案，总助用 `hub dispatch project-show` 按需查。原始对话只给后台写档看，总助看不到，细节照旧转给项目经理查。
   - B：再加第三层，总助能查某个项目最近几千字原话。
   - 推荐 A：总助每轮限时 25 秒，只管分派和答全局状态。看原话会让它自己答项目细节，和“名片看不出来的不猜、转给项目经理”的规矩冲突。
4. **`hub router note` 去留。**
   - A（推荐）：删掉。档案自动维护后，它就没用了（11 个项目里只有 1 个写过，还是旧的）。
   - B：留着，作为项目经理手动补充，喂给写档。
   - 推荐 A：新旧两套不并存。项目经理想让总助知道的事，在对话里说了，下次写档就会进去。
5. **刷新多勤。**
   - A（推荐）：上次之后加权字数到 2 万（你的字乘 4，项目经理的字算 1），且离上次至少 2 小时；任务图结束、项目经理换代也刷新（同样隔 2 小时）。按本机过去 7 天回放，一周约 48 次。
   - B：更省，门槛 4 万字，一周约 34 次，最忙的项目档案会旧半天左右。
   - 推荐 A：用总助的便宜模型，一次不到 1 分钱（haiku 实测 0.75 到 0.94 美分）。

## 给 Worker 和审查看

### 1. 用户目标

用户原话（优先级最高）：

1. 「总助怎么了解每个项目是干嘛的呢」
2. 「router要足够聪明，它要有能力去看我们的所有的对话，来自己总结每个项目是干嘛的这个结构化目录，渐进式披露，每次启动的时候去看哪些项目的变化大，这个通过代码去做，然后去读变化大的项目的对话，让他去维护这个结构化目录，维护的过程通过fork放在后台？，这个方案如何，如果有新项目也要去维护。\n\n就有点像我们写交接的过程」
3. 「去做之前总助的方案吧」

理解：总助要真的知道每个项目做什么、平时怎么被称呼、最近在干什么，用户说口头叫法也能找对项目。这份认识由守护进程自动维护：启动时和运行中由代码算出哪些项目变化大，只给它们在后台写档；新项目自动建档。总助平时只看几行摘要，需要时再展开。

### 2. 现状

- **总助拿不到项目说明。** 实测：读代码。`getDigest` 把 `projects.description` 放进了名片（`src/daemon/ledger/router.ts:1001`），但轨道 B 组提示词时只取了 `id`、`name`、`mainFolder`（`src/daemon/router/dispatcher.ts:729-735`），说明丢了。本机 11 个项目有 7 个没写说明（`sqlite3 -readonly ~/.agent-hub/state/hub.sqlite "SELECT id, length(description) FROM projects"`）。
- **`summary` 是拼的，来源不对。** 实测：`dispatcher.ts:736` 把 `pmNote`、`personaSummary`、`recentBrief` 用 `|` 连起来。`personaSummary` 是项目经理性格设定的前 4 行（`router.ts:278-286`），写的是用户偏好和干活规矩。`pmNote` 来自 `hub router note`（`router.ts:549-588`），本机 `router_pm_notes` 只有 1 行，是一周前的。
- **总助每轮独立。** 当时定的限时 25 秒已取消：总助成功分派后被误报超时失败，用户也不要超时提醒；`ROUTER_AGENT_TIMEOUT_MS` 现在是 10 分钟，只防卡死的厂商进程占着并发槽，已投出去的指令不会因它改标失败。实测：每条指令新建一个 assistant 会话，在 `<stateDir>/router-home` 隔离只读空目录跑一轮（`dispatcher.ts:767-860`，`ROUTER_AGENT_TIMEOUT_MS` 在 `src/shared/limits.ts`）。启动文件由 `prepareRouterSandboxLaunch` 生成，只按角色区分，系统提示词固定是总助的（`src/daemon/router/sandbox.ts:79-160`，`src/daemon/launch.ts:95`）。
- **双向沙箱。** 实测：`createRouterSandboxGuard` 拦 assistant 调普通 hub 命令，也拦项目经理和 Worker 调 `hub dispatch`；没绑定指令的 assistant 会话调 `hub dispatch` 也被拒（`sandbox.ts:162-202`，守卫测试 `src/daemon/agent-api/server.test.ts:989`）。账本不记 assistant 会话的事件（`src/daemon/ledger/ledger.ts:341`）。
- **跨设备。** 实测：每台设备从自己的账本算名片（`LocalTargetPort.getDigest`，`src/daemon/router/target-port.ts`），远端名片经配对通道 `GET API_PATHS.routerDigest` 取，缓存 10 秒。只读查询已有先例：`hub dispatch worker-list` 走 `target-ops` 的 `worker.list`，不算分派数、不让名片缓存失效（`target-port.ts:448-453`、`817`，`dispatcher.ts:1264`）。
- **项目对话就是项目经理私聊。** 实测：`projects.conversation_id` 指向 `conversations.kind = 'pm'` 那一行（查库 11 个项目全是）。消息有 `messages_conversation (conversation_id, id)` 索引。
- **对话量差别很大。** 实测（查库，近 7 天）：最忙的项目 7 天 104 万字（其中用户 2.2 万字），一天 19 万字；其余项目 7 天 0 到 7 万字。项目经理说的字占 98%。
- **交接是现成的压缩历史。** 实测：`handovers` 已有 115 份写成的交接，单份最长 10,871 字、平均约 6,000 字（查库）。交接由复制项目经理会话写成，看过工具输出。
- **复制会话很重。** 实测：项目经理当前会话的上下文 7 万到 24 万 token（`agent_sessions.token_usage` 的 `context`）。复制缓存：claude 约 97%、codex 只中约 1.2 万、agy 0（`docs/background-handover-design.md` 第 2.3 节）。
- **独立单轮很快。** 实测：`claude -p --model haiku --no-session-persistence` 喂 38,599 字，墙钟 11 秒、接口 6.8 秒、0.75 美分；喂 9,058 字首次建档，14 秒、0.94 美分，输出就是示例文件第 2 节。模型把上限 80 字的“一句话”写成了 110 字，所以解析时要截断，不能按超长判失败。
- **算增量很便宜。** 实测（Python 只读连库，20 次取平均）：切点在最近时，11 个项目各算一次加权字数共 0.14 毫秒；切点为 0（首次）共 15.8 毫秒，最大的项目单个 8.1 毫秒。查询计划走 `messages_conversation (conversation_id=? AND id>?)`。
- **刷新次数。** 实测：按过去 7 天的真实消息回放推荐规则（2 万加权字、间隔 2 小时、任务图结束强制），共 48 次，最忙项目 38 次，其余每个 0 到 3 次；门槛 4 万时共 34 次。

### 3. 做法比较

#### 3.1 后台怎么写档

| 做法 | 每次读入 | 什么时候能跑 | 厂商 | 能看到什么 | 问题 |
|---|---|---|---|---|---|
| A 账本增量独立单轮（推荐） | 1 万到 3.5 万 token（上限 6 万字） | 随时 | 走驱动层，四家一样 | 对话原话、交接、任务图、Worker 汇报摘要、首次建档读说明文件 | 看不到工具输出，靠交接补 |
| B 复制项目经理会话 | 7 万到 24 万 token | 等项目经理两轮之间空闲，和写交接抢同一个会话 | 每家要复制办法，agy 拷库无缓存 | 整个会话含工具输出 | 贵、慢；新项目还没会话时没得复制 |
| C 项目经理自己写（`hub router note` 加提示词） | 0 | 项目经理想起来时 | 一样 | 项目经理知道的全部 | 靠自觉，现状就是没人写；还占项目经理的轮次 |
| D 总助留一个长会话，自己读所有对话 | 不断涨 | 随时 | 一样 | 全部 | 总助是每轮独立的设计，长会话要再造一套交接 |

推荐 A。它和写交接是同一个思路（后台、增量、带上最近原话），但输入取账本，不复制会话。交接里已经有复制会话看到的东西，A 直接读交接。

#### 3.2 哪台设备写

| 做法 | 说明 | 问题 |
|---|---|---|
| A 每台设备写自己的项目（推荐） | 对话、交接、说明文件都在本机，写好的第一层跟名片一起被远端取走，第二层走 `target-ops` 的 `project.show` | 远端设备离线时只能看到它上次给的名片（现状也是这样） |
| B 总助所在设备写所有设备的项目 | 要把远端对话传过来 | 要新开传对话的接口，流量和隐私面都变大；远端离线就写不了 |

推荐 A。

#### 3.3 用哪个模型

| 做法 | 说明 | 问题 |
|---|---|---|
| A 和总助同一份设置（推荐） | 每份活开始前调 `resolveRouterModel(ledger.getRouterSettings(), catalogs)`，和总助选型同一个函数；没设就用各家 `routerDefault` | 用户把总助调成贵模型时写档也贵 |
| B 跟项目经理同一家同一个模型 | 用 `pms.vendor`、`default_model` | 多是 Opus 这类贵模型；项目经理那家没登录时写不了 |
| C 单独一项设置 | 设置页加一行 | 多一个设置，用户要多选一次 |

推荐 A。每台设备用自己的 `router_settings`，远端项目由远端按它自己的设置写。

#### 3.4 总助看多深，沙箱怎么划

| 做法 | 总助看到什么 | 问题 |
|---|---|---|
| A 两层（推荐） | 第一层在名片里：一句话、别名、主线、最近一句、档案几时更新；第二层 `hub dispatch project-show --device --project` 返回完整档案 | 档案没写到的细节要转给项目经理 |
| B 三层 | 再加 `project-history` 查最近原话 | 和“名片看不出的不猜”冲突；每轮 25 秒里多读几千字 |

推荐 A。沙箱两个方向都收紧：

- 写档会话：角色 assistant，在 router-home 跑，套同一份只读策略；**不发 hub 令牌**（环境里没有 `HUB_TOKEN`、`HUB_SOCK`；守护进程自己环境里的也由 `buildChildEnv` 去掉，厂商设置里不放行 hub 命令和 hub.sock），调任何 hub 命令都失败；不绑定 sandboxGuard，`/v1/router.dispatch` 也拒；事件不进任何对话（账本跳过 assistant）。它能读到的项目文件和别的 agent 一样，但提示词要求不调用工具，材料全由守护进程喂进去。
- 总助：`project-show` 只回档案，不回原话、不读文件；只读，不算分派数；单轮最多查 `ROUTER_PROJECT_SHOW_PER_TURN_MAX`（4）个。项目经理和 Worker 调 `hub dispatch project-show` 照旧被 sandboxGuard 拒。
- 对话里可能有“忽略上面的要求”这类话：写档会话没有凭证、没有可写目录，输出按结构校验、按字数截断，进名片前去控制字符（`cleanInline`），最坏只是把档案写歪，下一次刷新会改回来。

#### 3.5 “变化大”怎么算，冷启动怎么建

| 做法 | 说明 | 问题 |
|---|---|---|
| A 切点之后的加权字数 + 事件（推荐） | 每个项目存一个切点（档案覆盖到的最大消息编号）。分数 = 切点之后 `kind = 'text'` 的用户字数 × 4 + 项目经理字数。分数到 2 万且离上次 ≥ 2 小时就刷新；建项目、任务图结束、项目经理换代记 `forced`，过了间隔就刷新 | 门槛是经验值，要按实际用量调 |
| B 只按时间（比如每天一次） | 简单 | 新项目要等一天；忙的项目一天变很多也要等 |
| C 按消息条数 | 简单 | 项目经理一条回复几十到几千字，条数不反映变化 |

推荐 A。用户的字乘 4 是因为项目经理的字占 98%，用户的话才是方向变化的信号。

冷启动：

- **存量老项目**：守护进程启动时扫一遍，没有档案的全部进队列。输入是最新一份交接（压缩了之前全部历史）+ 最近 3 万字原话 + 说明文件（`README.md`、`AGENTS.md`、`CLAUDE.md` 各前 4000 字）。不从头读全部对话：最大的项目有 151 万字，交接就是为此存在的。
- **新项目**：建项目的事务里记 `forced`，马上进队列。那时对话还是空的，就靠用户写的说明和说明文件。
- **运行中**：守护进程常驻好几天，不能只靠启动。项目经理每轮结束（`turn.ended`）时在同一个事务里算一次分数（0.01 毫秒级），到期进队列；任务图结束、换代同理。

#### 3.6 推荐做法全流程

```
启动 ──► scanAtStartup：每个活跃项目算 catalogDue，到期的进队列（内存 Set，真相在库）
运行 ──► 项目经理 turn.ended / 建项目 / graph finish / 换代 ──► 同一个事务里判到期 ──► 进队列，提交后 wake 跑腿的
跑腿的（并发 1，每 60 秒兜底看一次队列，队列空不查库）
   claimCatalog：记切点 = 该对话当前最大消息编号，拼输入（上一版档案、切点后的交接、原话、任务图、Worker 汇报）
   首次建档再读说明文件
   resolveRouterModel（总助的设置）── 选不出 ──► catalogFailed(model_unavailable)
   runTurn(purpose = catalog)：router-home、无令牌、写档提示词，限时 2 分钟
   parseCatalogReply：取最后一个 JSON，按结构校验，超长截断 ── 不合格 ──► catalogFailed(invalid_reply)
   catalogWritten：存档案，切点前移，清 forced 和失败次数（写代数 +1，名片缓存自然失效）
失败：切点不动，旧档案照旧用；退避 10 分钟起翻倍，同一切点 3 次后隔一天
总助每轮：名片带第一层 ──（拿不准）──► hub dispatch project-show ──► 本机读库 / 远端走 target-ops project.show
```

接线点（实现步骤做，骨架没碰）：

- `src/daemon/ledger/ledger.ts`：建 `createLedgerProjectCatalog`，`applyDriverEvent` 里调它的 `afterDriverEvent`，导出 `projectCatalog*` 给守护进程和名片用。
- `src/daemon/ledger/projects.ts`（建项目）、`task-graphs.ts` 的 `finishIn`、`handover.ts` 换代：同一个事务里调 `markForcedIn`。
- `src/daemon/ledger/router.ts` 的 `getDigest`：`project.catalog = cardOf(projectId)`，去掉 `personaSummary`、`pmNote`。
- `src/daemon/router/dispatcher.ts`：轨道 B 改用 `createRouterTurnRunner`（`purpose = dispatch`，`onSession` 里绑 sandboxGuard）；名片组装原样传 `description`、`catalog`、`recentBrief`；`handleAgentDispatch` 加 `project-show`。
- `src/daemon/router/sandbox.ts`、`src/daemon/launch.ts`：`prepareRouterSandboxLaunch` 按 purpose 选系统提示词，catalog 不发令牌。purpose 由单轮跑腿的在建会话后登记在一个按会话编号的 Map 里，收尾时删。
- `src/daemon/router/prompt.ts`：名片格式（示例文件第 1 节）和系统提示词里的 `project-show` 说明；`ROUTER_PM_CARD_MAX_BYTES` 从 1,024 提到 2,048 并挪进 `limits.ts`。
- `src/daemon/router/target-port.ts`：加 `project.show` 操作（本机读库，远端走配对通道，不让名片缓存失效）。
- `src/hub/cli.ts`、`src/shared/router.ts` 的 `RouterAgentDispatchInput`、`src/daemon/agent-api/server.ts` 的 op 枚举：加 `project-show`。
- `src/daemon/daemon.ts`：建跑腿的，接 `onCatalogClaimable → wake`，启动 `start`、关机 `stop`；`self-reload.ts` 判空闲时看 `busy()`。

### 4. 性能

1. **失效。**
   - 写成档案时写代数 +1，`getDigest` 的缓存按写代数失效（`router.ts:883-886`）；远端名片缓存 10 秒。
   - 用户写的说明不进档案，名片每次从 `projects` 现读，改了马上生效。
   - 删项目时 `ON DELETE CASCADE` 删档案；项目经理归档后名片不再列它，档案留着，恢复后照常增量。
   - 写档失败、空回复、结构不对都不当成功存：切点不动，退避从 10 分钟起翻倍，旧档案照旧用并标“几小时前更新”，总助能看出它旧。
   - 模型设置改了：下一份活现选模型，不缓存。
   - 说明文件只在首次建档读；之后的变化靠对话进档案，不监视文件。
2. **上限。** 按跑一个月算（3 万条消息、几十个项目）。档案一个项目一行，单行不超过 16 KB，50 个项目不到 1 MB。队列只放项目编号，条数不超过活跃项目数。常量加进 `src/shared/limits.ts`：

| 常量 | 值 | 怎么定的 |
|---|---|---|
| `PROJECT_CATALOG_ONE_LINER_MAX_CHARS` | 80 | 名片一行能读完 |
| `PROJECT_CATALOG_ALIASES_MAX` / `_ALIAS_MAX_CHARS` | 8 / 24 | 代号、产品名、口头叫法够用；模块名也用 24 |
| `PROJECT_CATALOG_FOCUS_MAX_CHARS` | 160 | 两句话 |
| `PROJECT_CATALOG_MODULES_MAX` / `_DECISIONS_MAX` / `_OPEN_ITEMS_MAX` | 8 / 8 / 5 | 实跑样例 5 个模块、6 条决定 |
| `PROJECT_CATALOG_ITEM_MAX_CHARS` | 160 | 实跑样例单条最长 76 字，留一倍 |
| `PROJECT_CATALOG_DETAIL_MAX_CHARS` | 4,000 | 各字段上限加起来约 3,700 字 |
| `PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS` | 40 | 压缩单行里的“做什么” |
| `PROJECT_CATALOG_ROW_MAX_BYTES` | 16,384 | 4,000 字 × 3 字节加 JSON 外壳 |
| `PROJECT_CATALOG_DIALOG_MAX_CHARS` | 30,000 | 和交接带的原话一样（`HANDOVER_RECENT_CHARS`） |
| `PROJECT_CATALOG_HANDOVER_MAX_CHARS` | 12,000 | 实测最长 10,871 字 |
| `PROJECT_CATALOG_FILE_MAX_CHARS` | 4,000 | 每个说明文件 |
| `PROJECT_CATALOG_GRAPHS_MAX` / `_WORKER_REPORTS_MAX` / `_INPUT_ITEM_MAX_CHARS` | 10 / 20 / 200 | 两小时内结束的图和汇报，很少超过 |
| `PROJECT_CATALOG_INPUT_MAX_CHARS` | 60,000 | 实测 3.9 万字单轮 11 秒，留余量 |
| `PROJECT_CATALOG_REFRESH_DELTA` / `_USER_CHAR_WEIGHT` | 20,000 / 4 | 回放 7 天 48 次 |
| `PROJECT_CATALOG_MIN_INTERVAL_MS` | 2 小时 | 同上 |
| `PROJECT_CATALOG_CONCURRENCY` | 1 | 后台活，不和总助抢槽位 |
| `PROJECT_CATALOG_TIMEOUT_MS` | 2 分钟 | 实测单轮 11 到 14 秒 |
| `PROJECT_CATALOG_RETRY_BACKOFF_MS` / `_MAX_ATTEMPTS` / `_GIVE_UP_MS` | 10 分钟 / 3 / 1 天 | 同写交接的退避 |
| `PROJECT_CATALOG_TICK_MS` | 60 秒 | 只看内存队列 |
| `ROUTER_PROJECT_SHOW_MAX_BYTES` / `_PER_TURN_MAX` | 16,384 / 4 | 一份档案 12 KB 以内；一轮最多展开 4 个 |
| `ROUTER_PM_CARD_MAX_BYTES`（从 `prompt.ts` 挪来） | 1,024 → 2,048 | 第一层最多多 1.2 KB；24 KB 总名片放 12 张完整卡，再多按现有逻辑压成单行 |

3. **前端引用稳定。** 这次不加界面。删掉 `RouterSlice.notes` 和 `router.note.updated` 后，`src/web/state.ts` 少一个数组，不新增 selector。
4. **验证。** 已量（第 2 节）：增量查询 0.14 毫秒 / 首次 15.8 毫秒（11 个项目）；单轮写档 11 到 14 秒、0.75 到 0.94 美分；回放刷新次数。实现步骤在 PR 里补：名片字节数改前改后（本机 11 个项目）、守护进程启动耗时改前改后（扫描不能拖慢启动，要 < 50 毫秒）、`project-show` 一次多花的总助单轮时间。

### 5. 统一

- 厂商：写档走 `createRouterTurnRunner`，它只用驱动层的 `Driver` 接口和 `prepareRouterSandboxLaunch`（按 `VENDOR_DAEMONS[vendor].launchFiles` 拼），选型用 `resolveRouterModel`（按 `VENDOR_LIST` 和各家 `routerDefault`）。以 `src/shared/vendors.ts` 为准，现有几家都覆盖。以后加一家新厂商，这里一个文件都不用改，只要它像现在一样登记进厂商注册表。
- 平台：只用 SQLite、`node:fs` 和现有的 router-home 只读沙箱（`buildReadonlyPolicy`、`workerWriteScope`，平台差异在 `src/daemon/platform/index.ts` 和 `driver/write-scope.ts` 里已抹平）。`readColdStartFiles` 用 `realpath` 判断软链是否出了主文件夹，Windows 路径一样适用。
- 跨设备：档案字段都是可选的。旧版设备的名片没有 `catalog`，新版总助显示“未建档”；新版设备给旧版总助的名片多一个字段，旧版忽略。旧版设备不认识 `project.show`，回 `invalid`，总助据此告诉用户对方版本旧。

### 6. 删掉什么

同一个 PR 里删，不留两套：

- 拼凑名片：`summarizePersona`（`src/daemon/ledger/router.ts:278-286`）、`PmDigestEntry.personaSummary` / `pmNote`（`src/shared/router.ts`）、`getDigest` 里读 `router_pm_notes` 和超限时裁这两个字段的代码（`router.ts:895-897`、`1005-1006`、`1024-1033`）、`dispatcher.ts:736` 的 `roleSummary` 拼接、`PromptPmDigestCard.roleSummary` 和 `formatFullPmCard` 里的 `summary` 行（`src/daemon/router/prompt.ts`）、常量 `ROUTER_PERSONA_SUMMARY_LINES`、`ROUTER_PERSONA_SUMMARY_MAX_CHARS`（`src/shared/limits.ts`）。
- `hub router note` 整条：`src/hub/cli.ts:267-271`、`999-1009`；`src/shared/hub.ts` 的 `router.note`（命令名、角色、参数、返回）；`src/daemon/agent-api/server.ts:305`；`src/daemon/ledger/hub-commands.ts:330-331`；`router.ts` 的 `noteIn`、`routerNoteSchema`、`RouterPmNoteDbRow`、快照里的 `notes`；`src/shared/router.ts` 的 `RouterPmNote`、`RouterSlice.notes`；`src/shared/api.ts` 的 `router.note.updated`；`src/daemon/ledger/context.ts:53`；`src/web/state.ts:329-333`、`426-437`；`src/shared/reminders.ts:444-448`；常量 `ROUTER_NOTE_MAX_CHARS`、`MAX_ROUTER_NOTE_BYTES`；表 `router_pm_notes`（在 `migrations/0032_project_catalogs.sql` 里 `DROP TABLE`）；对应测试（`router.test.ts:304-317`、`cli.test.ts:530-531`、`server.test.ts:70`、`739`、`state.test.ts:708-711`、`shared.test.ts`、`db-retention.test.ts:173`、`task-graphs.test.ts:576-580`）。
- 提示词：项目经理提示词里的 `router report|note` 和“更新一句话项目主线备忘”（`src/daemon/prompt.ts:237`，`prompt.test.ts:778`）改成只有 `router report`。
- 轨道 B 里自己管会话生命周期的那段（`dispatcher.ts:767-880` 建会话、监听事件、计时、打断、结束、删启动目录），挪进 `single-turn.ts`，dispatcher 只留绑定 sandboxGuard 和处理结果。
- 旧说法：`docs/router-design.md:371`、`635` 里 `hub router note` 的例子和常量行；`docs/orchestration-simplify-design.md:458` 的“`hub router note` 保留”。改成指向本文。

### 7. 骨架文件

- `migrations/0032_project_catalogs.sql`：`project_catalogs` 表（一个项目一行：档案 JSON、切点、写成时刻、forced、失败次数和退避）。实现步骤在同一个文件补 `DROP TABLE router_pm_notes`，所以方案 PR 不单独合入。
- `src/shared/limits.ts`：第 4 节表里的新常量。
- `src/shared/project-catalog.ts`：档案的结构（zod）、第一层名片、第二层详情、写档输入和一份活、账本给跑腿的接口；纯函数 `changeScore`、`catalogDue`、`parseCatalogReply`、`catalogCardOf`、`renderCatalogDetail`。
- `src/shared/router.ts`：`PmDigestEntry.project` 加可选的 `catalog`。
- `src/daemon/ledger/project-catalog.ts`：账本这一半：启动扫描、`turn.ended` 和事件触发、领活、报成败、读第一层第二层。
- `src/daemon/project-catalog/runner.ts`：跑腿的（领活、读说明文件、选模型、跑单轮、校验、报回）和 `readColdStartFiles`。
- `src/daemon/project-catalog/prompt.ts`：写档的系统提示词和每轮输入，提示词文字只在这里。
- `src/daemon/router/single-turn.ts`：总助单轮会话，分派和写档共用。
- 测试骨架：`src/shared/project-catalog.test.ts`、`src/daemon/ledger/project-catalog.test.ts`、`src/daemon/project-catalog/runner.test.ts`、`src/daemon/project-catalog/prompt.test.ts`、`src/daemon/router/single-turn.test.ts`，以及在 `src/daemon/router/prompt.test.ts`、`target-port.test.ts`、`dispatcher.test.ts`、`src/daemon/agent-api/server.test.ts`、`src/hub/cli.test.ts` 末尾加的 `it.todo`。

### 8. 验收方法

- **单元和集成测试**：第 7 节列的 `it.todo` 全部改成真断言并通过，重点：
  - `catalogDue` 那组（冷启动、退避、最短间隔、forced、门槛差一个字）；
  - `afterDriverEvent` 只算切点之后的用户和项目经理的话；`markForcedIn` 跟事务一起回滚；
  - `catalogWritten` 后 `getRouterDigest` 的 `project.catalog` 换新、不再有 `personaSummary`、`pmNote`；
  - `parseCatalogReply` 截断超长、拒绝结构错；
  - `server.test.ts` 新加的双向沙箱三条；`single-turn.test.ts` 里 catalog 会话环境没有 `HUB_TOKEN`、`HUB_SOCK`。
  - 跑 `pnpm typecheck`、上面的测试文件、`src/shared/write-scope.test.ts`。
- **真库实测**（把 `~/.agent-hub/state` 拷一份，用拷贝起守护进程，不碰用户正在用的库）：
  1. 启动后日志里扫描耗时 < 50 毫秒，11 个项目全部进队列；几分钟后 `sqlite3 <拷贝>/hub.sqlite "SELECT project_id, refreshed_at IS NOT NULL, length(catalog_json) FROM project_catalogs"` 11 行都有档案。输出贴进 PR。
  2. `hub dispatch project-show --device self --project 7`（用总助会话的令牌，或测试里调 `handleAgentDispatch`）的输出贴进 PR，确认不超过 16 KB。
  3. 新建一个项目，记下从建好到 `project_catalogs` 有档案的秒数。
  4. 在一个项目里发消息到加权 2 万字以上（或测试里把切点调旧），项目经理一轮结束后档案刷新、切点前移。
  5. 在总助台发“改一下 Fusa 的设置页”这类只用别名的话，截图回执显示投给了 agent-hub 的项目经理。截图放 `/tmp/router-catalog-alias.png`。
- **数字**：名片字节数、启动耗时、总助单轮时间的改前改后，写进 PR 的 Verification。
