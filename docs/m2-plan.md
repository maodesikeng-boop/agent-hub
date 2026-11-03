# M2 计划：项目群

> 状态：第 6 节的 5 个问题用户已在 2026-11-03 全部按推荐拍板。接口约定以 W0 写进 `src/shared/` 的为准，W0 对本计划的补全见第 3 节末尾。依据是 [prototype-design.md](prototype-design.md)（下文简称“设计”）第 2、3、5、6、8、9、14 章，[m0-report.md](m0-report.md) 实验 5，以及 main 上 `bd3aa53` 的 M1 实现。
> 写于 2026-11-03。网页按“Tailwind v4 + shadcn/ui 樱粉风格 + Markdown 渲染”改版后的样子来计划（另一个 Worker 正在做，只改 `src/web/`）。

## 1. 范围

**做完用户能看到什么**：左下角点“＋项目经理”，填名字、选模式，左栏多一个项目经理；在它的私聊里说“在 `~/code/foo` 建一个叫 foo 的项目”，左栏出现 foo 群，群里有一条“项目已建好”；在 foo 群和 bar 群里同时问它问题，两个群同时在回、各说各的项目；说“把 foo 交给阿周”，foo 群里出现“项目经理由小林换成阿周，交接在这里”，之后阿周接着聊、知道之前聊过什么；说“以后回复都用列表”，聊天里出现“项目经理改了自己的做事习惯”，点“撤销”能改回去。

**M2 做**

| 部分 | 做到什么程度 | 设计章节 |
|---|---|---|
| 数据 | 迁移 `0002`：`projects`、`project_folders`、`persona_changes`、`handoffs`、`hub_calls`（`hub` 调用记录，设计里没有，见第 7 节第 9 条）；`pms.mode` 改成两种模式；`agent_sessions` 加 `pm_id` | 6.2 |
| 项目经理 | 界面新建（名字、模式、模型、性格设定模板）；资料页看和改性格设定，修改记录，撤销最近一次；同一个人管好几个项目，每个群一个会话，可以同时跑 | 2.2、3.6 |
| 两种模式 | “只管理”（推荐）和“自己也干活”，只是提示词里的默认做法；项目经理能用 `hub persona edit` 改自己的习惯和模式。M2 还没有 Worker，“只管理”的提示词写成：只讨论、拆步骤，要动手先问用户，用户让它做就自己做 | 2.2 |
| 项目和项目群 | 建项目（界面表单或一句话）；挂、移除文件夹；换项目经理（只用一句话，见第 6 节第 2 条），一定先写交接再开新会话；每一步在账本里留记录，在相关对话里发一条系统消息 | 9 |
| agent 接口 + `hub` | 最小一套：Unix socket `run/hub.sock` + 每个会话一个令牌 + `hub` 命令，只有第 3 节第 4 条那几个子命令；设置文件里带 `Bash(hub:*)` 和 `allowUnixSockets` | 4.2、8.1、8.2 |
| 提示词 | 私聊：角色、性格、模式、管着的项目名片、`hub` 用法。群：再加项目信息、文件夹、最近一份交接、按情况“先读 `AGENTS.md`” | 7.2 |
| 驱动层 | 每次启动用各自的环境变量（令牌）；启动参数或提示词变了，在两轮之间自动重启（`--resume`）；`end` 一个会话（交接后关掉旧会话） | 7.2、7.4 |
| 网页 | 左栏：项目经理、项目群（按最后一条消息排序）、左下角“＋项目经理”“＋项目”；群页顶栏显示项目经理和文件夹；系统消息居中；资料页；失败消息的“重试”（第 6 节第 5 条） | 3.1～3.3、3.6 |

**M2 不做**（括号里是哪个里程碑做）

- 工单、Worker、worktree、`hub ticket`（M3）。所以 M2 的“只管理”还派不了活。
- 审批、收件箱、权限钩子、通知（M4）。归档、删除项目都要审批，放到 M4；建项目时文件夹不存在的处理见第 6 节第 1 条。
- 总助、`#项目名`（M5）；定时任务、`hub schedule`（M6）；看门狗（M7）。
- 换主文件夹、群设置里的“开新会话”、按项目设 `CLAUDE_CONFIG_DIR`、头像上传（默认用名字首字）、未读数、`@` 成员、拖文件。
- 界面上的“换项目经理”按钮（第 6 节第 2 条）。

## 2. 技术选型

只写 M2 新增的。每项第一个是推荐。

| 项 | 选项 | 推荐和理由 | 出处 |
|---|---|---|---|
| agent 接口 | **第二个 Fastify 实例，`listen({ path })` 在 Unix socket 上** / `node:net` 自己解析 / 和界面服务共用一个实例 | Fastify：和界面服务一样的写法和 JSON Schema 校验，测试用 `inject()` 不开真 socket。分开实例：会话令牌天然调不了界面接口（设计 4.2）。 | [Fastify listen][fastify-listen] |
| `hub` 程序 | **Node 脚本 `src/hub/main.ts`**，守护进程生成一个 `run/bin/hub` 小外壳（`exec <process.execPath> <仓库>/src/hub/main.ts "$@"`），把 `run/bin` 加到子进程 `PATH` 最前面 / 照 M0 用 `sh` + `curl` / 打包成单个可执行文件 | Node 脚本：直接引 `src/shared/hub.ts` 的类型，`http.request({ socketPath })` 不依赖 `curl`；外壳写死 Node 的绝对路径，不怕 agent 的 `PATH` 里没有 `node`；不用编译。启动约几十毫秒，够用。 | [node:http socketPath][node-http] |
| 命令行解析 | **`node:util` 的 `parseArgs`** / commander | 内置，不加依赖；子命令就几个。 | [parseArgs][node-util] |
| 会话令牌 | **内存里，每个会话一个（32 字节随机）：同一个会话反复 `prepareLaunch` 拿到的是同一个，会话结束（`revoke`）或守护进程重启才作废；`revoke` 过的会话不再发新令牌** / 存数据库 | 内存：盘上不落令牌；守护进程重启时旧 `claude` 本来就会被结束（设计 5.4），令牌跟着失效。同一个会话不换令牌：驱动层每次写消息前都会调 `prepareLaunch`，换了正在跑的进程就用不了 `hub`。 | 设计 8.1 |
| 长文本（交接、性格设定）怎么交给 `hub` | **显式写 `--stdin` 才从标准输入读（提示词里教 `hub … --stdin <<'EOF'`）**，同时支持 `--text "…"` / 只用参数 / 先写文件再传路径 | 标准输入不受参数长度和引号影响；写文件要写到项目目录外，`-p` 下会被权限拦。不做“没带正文就去读标准输入”：agent 的 shell 里标准输入可能一直开着，会卡住。带引号的 heredoc 不展开变量，应该能过 `Bash(hub:*)`，但没实测过，冒烟 S7 验证，不行就改教 `--text`。 | m0-report 实验 5 |
| 文件夹路径 | **网页里输入框 + 服务端校验**（展开 `~`、`realpath`、必须是已有目录） / 系统文件夹选择器 | 浏览器拿不到本机真实路径；校验放服务端，界面和 `hub` 共用一套。 | — |
| 新组件 | **沿用改版带进来的 shadcn/ui**（Dialog、Select、RadioGroup、Textarea），不另加组件库 | 和改版保持一致。 | — |

**新增目录**：`src/daemon/agent-api/`（agent 接口和令牌）、`src/hub/`（`hub` 命令）、`migrations/0002_projects.sql`。

## 3. 拆分

7 块，每块一个 Worker、一个 PR。W0 先做；W1～W5 在 W0 合并后**同时开工**（W5 还要等网页改版合并）；W6 等 W1～W5 都合并后做。

```
W0 接口和迁移 ──┬── W1 账本：项目经理、项目、交接、性格设定 ──┐
               ├── W2 agent 接口 + hub 命令 ───────────────┤
               ├── W3 驱动层 + 提示词 + 假 claude 跑命令 ───┼── W6 组装 + 端到端 + 冒烟
               ├── W4 界面服务新接口 ──────────────────────┤
 网页改版合并 ──┴── W5 网页 ──────────────────────────────┘
```

| 块 | 边界：只改这些 | 依赖 |
|---|---|---|
| W0 接口和迁移 | `src/shared/`、`migrations/0002_projects.sql`、`test/migration.test.ts`；另外改了迁移器 `src/daemon/store/migrate.ts`，`prompt.ts` 改成引用共用的性格模板，以及只为编译通过的占位（见下面“W0 对上面约定的补全”） | 无 |
| W1 账本 | `src/daemon/ledger/`、`src/daemon/store/`（行转换、`SessionStore` 读 `pm_id`） | W0 |
| W2 agent 接口 + `hub` | `src/daemon/agent-api/`、`src/hub/` | W0 |
| W3 驱动层 + 提示词 | `src/daemon/driver/`、`src/daemon/prompt.ts`、`test/fake-claude/` | W0 |
| W4 界面服务 | `src/daemon/ui-server/` | W0 |
| W5 网页 | `src/web/`（含 `isWaitingForQuota` 改用 `isQuotaExhausted`、当前会话取最大的 `generation`、`applyChange` 里 W0 留的空 case） | W0、网页改版 |
| W6 组装 | `src/daemon/daemon.ts`、`handlers.ts`（含 `session_ended` 的处理：不计入 health，`session.start` 按 done，`session.send` 按 later；本地的 `RATE_LIMIT_REJECTED` 改用 `isQuotaExhausted`）、`main.ts`、`test/e2e/`、`test/smoke/`；接线时的小改动可以碰其他目录，PR 里写明 | W1～W5 |

**接口约定**（W0 写成 `src/shared/` 里的类型和常量，之后改要在 PR 里说明，并通知用到它的块）：

1. **数据（`domain.ts` + `0002`）**
   - `PM_MODES = ["manage_only", "hands_on"]`；迁移把已有的 `'default'` 改成 `'manage_only'`，加 CHECK。
   - `Project { id, name, description, status, pmId, conversationId, createdAt, updatedAt }`，`PROJECT_STATUSES = ["active", "archived", "deleted"]`（M2 只用 `active`）；进行中的项目名字唯一，项目经理名字唯一。
   - `ProjectFolder { id, projectId, path(真实路径), isMain, addedAt, removedAt }`；同一个真实路径只能当一个进行中项目的主文件夹。
   - `PersonaChange { id, pmId, actor: "user" | "pm" | "file", sessionId, textBefore, textAfter, modeBefore, modeAfter, reason, revertOf, createdAt }`（列名 `text_before`、`text_after`：`before`、`after` 是 SQL 关键字）。
   - `Handoff { id, projectId, fromSessionId, toSessionId, fromPmId, toPmId, file, reason: "reassign", createdAt }`，正文写在 `state/handoffs/<项目编号>/<交接编号>-<时间>.md`。
   - `AgentSessionRow` 加 `pmId`（项目经理的会话一定有）。群会话：`conversation_id` = 群，换项目经理时开下一代；账本发消息一直找最新一代（M1 已经这样）。群对话按 `project_id` 唯一。
   - `SessionState` 加 `generation`：网页和账本凡是要“这个对话的当前会话”（状态行、停止按钮、等额度、发消息、`requestStop`）都取 `generation` 最大的那一个；`requestStop` 只停最新一代。`SessionState` 还带 `pmId`（W6b）：网页按消息的 `sessionId` 找会话、用它的 `pmId` 给消息署名，换项目经理后旧项目经理的话仍署旧名字（找不到会话就署对话现在的项目经理）。
   - 系统消息：`sender: "system"`、`kind: "text"`，`meta.event` 取 `project.created`、`folder.attached`、`folder.detached`、`project.reassigned`、`persona.changed`，`meta` 里带相关编号（撤销按钮用 `personaChangeId`），去重键用 `systemMessageDedupeKey`。要让 agent 也看到的系统消息走 `session.send`（`source: "system"`，文字开头带 `【系统】`），网页上不显示投递状态。项目经理自己调 `hub` 改的设置，不再单独给它发 `【系统】` 消息（白白多跑一轮），驱动层自动重启后在下一条消息前面拼 `RELAUNCH_NOTE`。
   - `isQuotaExhausted(info)`：`status === "rejected"`，处理函数和网页共用（第 7 节第 2 条）。网页的 `isWaitingForQuota`（`src/web/selectors.ts`）由 W5 改成用它，`handlers.ts` 里的本地常量 `RATE_LIMIT_REJECTED` 由 W6 删掉改用它。
2. **账本（`ledger.ts`）**：所有改动都在一个事务里写业务表、发系统消息、登记动作，然后推变化。
   - 界面用：`createPm({ name, mode, defaultModel?, persona })`（`pmHomeRoot` 是账本的构造参数 `LedgerOptions.pmHomeRoot`，必填）、`createProject({ name, folder, pmId, description? }, actor)`、`getPersona(pmId)` → `{ pmId, text, mode, changes, revertableChangeId }`、`editPersona(pmId, { text?, mode?, reason? }, actor)`、`revertPersonaChange(changeId)`（只能撤销最近一次）、`retryMessage(messageId)`（只接受 `failed` 的用户消息：同一个事务里状态改回 `queued`、清空失败原因、重新登记 `session.send`、推 `message.updated`）。
   - `hub` 用：`hubCall(sessionId, command, args)`，账本按会话认人（这个会话属于哪个项目经理、哪个对话），只能动自己管的项目；记一行 `hub_calls`；返回 `{ text, data }`。
   - 错误：`LedgerRequestError(code, message)`，`code` 是 `invalid` / `not_found` / `forbidden` / `conflict`，两个服务都映射成 400 / 404 / 403 / 409，`message` 给人看（agent 也看得懂）。
   - 文件夹校验用注入的 `resolveFolder(path)`（展开 `~`、`realpathSync.native`、是目录、不在 `~/.agent-hub` 里），测试换假的。`project.detach` 遇到已经删掉的目录：`realpath` 失败就用 `path.resolve` 后的字面路径去和库里比。
   - 性格设定以数据库为准：先提交事务，再写 `personas/pm-<编号>.md`（临时文件 + 改名），写成功才更新 `pms.persona_file_hash`（上次成功写入文件的内容哈希）。启动时文件哈希等于它 = 没人动过（内容和数据库不一样就是上次没写成，按数据库重写）；不等于才算用户手改过，记一条 `actor: "file"` 的修改。详见 `syncPersonaFiles` 的注释。
   - 给 W3 的 `getLaunchContext(sessionId)` → `{ sessionId, role, conversation, pm: { id, name, mode, persona }, managedProjects: 名片[], project: 名片 | null, handoff: { id, fromPmName, text, createdAt } | null }`。`persona` 是 NULL 时兜底成模板。群的提示词不放 `managedProjects`。
3. **网页 ↔ 界面服务（`api.ts`）**
   - `StateSnapshot` 加 `projects`、`folders`（只给未移除的）。
   - `POST /api/pms`、`POST /api/projects`、`GET /api/pms/:id/persona`、`PUT /api/pms/:id/persona`、`POST /api/persona-changes/:id/revert`、`POST /api/messages/:id/retry`（202）。
   - `CHANGE_TYPES` 加 `pm.created`、`pm.updated`、`project.created`、`project.updated`、`folders.updated`、`conversation.created`、`session.created`。
4. **agent 接口（新文件 `hub.ts`）**
   - 环境变量 `HUB_TOKEN`、`HUB_SOCK`；请求 `POST /v1/<命令>`，头 `Authorization: Bearer <令牌>`，体是参数 JSON；回 `{ ok: true, text, data }` 或 `{ ok: false, code, message }`。请求体超过上限也是 `invalid`（400），不用 413。`hub.sock` 的真实路径超过 macOS 上限 103 字节时，启动就报清楚的错（`assertSocketPathFits`）。
   - `hub` 退出码：0 成功；1 系统拒绝（打印 `message`）；2 用法不对；3 连不上守护进程。
   - M2 的命令：`hub status`（我是谁、管哪些项目）、`hub pm list`、`hub project create --name --folder [--description]`、`hub project attach <项目> <文件夹>`、`hub project detach <项目> <文件夹>`、`hub project assign <项目> --to <项目经理名字>`（交接正文用 `--stdin` 从标准输入读或 `--text`，必填）、`hub persona show`、`hub persona edit [--mode] [--reason]`（新全文用 `--stdin` 或 `--text`，可以只改模式）。没写 `--stdin` 就不读标准输入。
   - `SessionTokens { issue(sessionId): string; resolve(token): SessionId | null; revoke(sessionId): void }`，W2 实现。同一个会话 `issue` 返回同一个令牌；`revoke` 过的再 `issue` 抛错。
5. **驱动层（`driver.ts`）**
   - `LaunchFiles` 加 `env`（这一次启动额外的环境变量：`HUB_TOKEN`、`HUB_SOCK`、`PATH`）和 `fingerprint`（提示词、设置文件、MCP 配置内容的摘要，用 `src/shared/launch.ts` 的 `launchFingerprint` 算；不含时间、随机数、令牌）。
   - 每次往空闲进程写下一条前，驱动层重新调 `prepareLaunch`；`fingerprint` 变了，或会话那一行的 `cwd`、`addDirs`、`model` 和这个进程启动时不一样，就关标准输入、等它退出、`--resume` 重启再写，这条前面拼 `RELAUNCH_NOTE`（挂文件夹、改性格设定都靠这个生效，第 6 节第 3 条）。`env` 不参与比较。
   - 新增 `end(sessionId)`：一调用就拒绝新的 `send`（抛 `DriverError("session_ended")`，不可重试）；正在跑就等这一轮 `result`，然后关标准输入，状态 `ended`。
   - `ACTION_TYPES` 加 `session.end`（去重键 `会话:代`）。
6. **组装（W6）**：`prepareLaunch` 里 `tokens.issue` 并生成设置文件（`Bash(hub:*)` + `allowUnixSockets: [hub.sock 的真实路径]`）；会话 `ended` 时 `tokens.revoke`；`session.end` 处理函数；处理函数接 `session_ended`：不计入 driver 的 health，`session.start` 按 `done`，`session.send` 按 `later`（详见 `Driver.end` 的注释）；`handlers.ts` 的本地常量改用 `isQuotaExhausted`；启动顺序里在执行器之前开 agent 接口（建 `run/` 0700、删残留 socket、socket 0600），关机时最后关它；`paths.ts` 加 `runDir`、`hubSock`、`hubBinDir`、`personasDir`、`handoffsDir`。

**W0 对上面约定的补全**（详见 `src/shared/` 各文件的注释，W0 的 PR 正文逐条写了理由）：

- 迁移器：跑每个迁移时关外键检查、提交前 `PRAGMA foreign_key_check`（SQLite 的标准做法），否则 `0002` 没法重建被引用的 `pms` 来加 `mode` 的 CHECK；检查失败时报错里列出是哪些行。在外层事务里调直接报错。已有数据的库升级前先备份成 `hub.sqlite.bak-<旧版本>-<时间>`。`0002` 把 M1 里重名的项目经理改成“名字-编号”。改了 `src/daemon/store/migrate.ts`。
- 性格设定正文存在 `pms.persona`（“以数据库为准”要有地方存）；`PersonaChange` 的正文前后叫 `textBefore`、`textAfter`（`before`、`after` 是 SQL 关键字）。新增 `syncPersonaFiles()` 给 W6 在启动时调。
- 项目经理名字唯一（`UNIQUE`）；`createPm` 的 `pmHomeRoot` 挪到账本的构造参数，`CreatePmInput` 是 `{ name, mode, defaultModel?, persona }`。
- 令牌：`SessionTokens.issue` 对同一个会话返回同一个令牌，只在会话结束时作废；`revoke` 过的会话再 `issue` 抛错。因为驱动层每次写消息前都会调 `prepareLaunch`，每次换令牌会让正在跑的进程失效。
- 重启判断：`fingerprint` 只管提示词和设置文件内容；`cwd`、`addDirs`、`model` 由驱动层自己和启动时比；`env` 不参与。`model` 那一列只表示配置的模型（账本和界面写，驱动层只读不写）；`claude` 实际报回来的模型只在 `session.started` 事件里。
- `end`：一调用就拒绝新的 `send`；待发队列里没写的消息丢掉；交接时账本把群里还在排队的消息改指新一代会话，撞上 `session_ended` 的那次处理函数返回 `later`（不算失败、不记 health），下次用新参数。
- 系统消息：哪条发在哪、要不要也发给 agent、`【系统】` 前缀和 `status` 的规矩，写在 `SystemMessageMeta` 的注释里。
- `paths.ts` 的 `runDir`、`hubSock`、`hubBinDir`、`personasDir`、`handoffsDir` 在 W0 就加了（W1、W2 都要用），性格设定文件的路径一律用 `personaFilePath`；`PM_PERSONA_TEMPLATE` 只在 `src/shared` 有一份，`prompt.ts` 引用它。
- 消息状态：转换表加 `failed → queued`（用户点重试），`failed → delivered` 保留（重启后重发）。
- `hub_calls` 的 `args`、`result` 只存摘要，长字段超过 2 KB 截断（`HUB_CALL_FIELD_MAX_BYTES`）。
- `HEALTH_MODULES` 加 `agent-api`；`normalizeName` 还拒绝 U+2028、U+2029 和 C1 控制字符。
- 为了让 `pnpm check` 保持全绿，W0 在 daemon、web 里放了只为编译通过的占位（新方法抛“没实现”、新字段给空值），都标了 `M2 W0 占位`，由对应的块替换。

**W6a 对上面约定的补全**（组装时碰到的，PR 正文逐条写了理由）：

- 账本接口加 `refreshSessionState(sessionId)`：驱动层 `end` 直接把会话那一行写成 `ended`、没有事件，`session.end` 处理函数作废令牌后调它，网页才看得到 `ended`。
- 会话换代只有一个入口：账本里的 `nextGeneration`（开下一代、登记上一代的 `session.end`、排队的消息改指下一代），交接用它，以后自动换代也用它；守护进程这边结束会话只走 `session.end` 处理函数（等这一轮回完 → 作废令牌 → 推状态）。
- 作废过令牌的会话再 `prepareLaunch`：`tokens.issue` 抛 `SessionTokenRevokedError`，包成 `DriverError("session_ended")`，驱动层原样抛（不包成可重试的 `spawn_failed`），处理函数按 `session_ended` 接；`issue` 抛的别的错不包，照常抛出。
- agent 接口：`AgentApiOptions` 加 `log`，500 和记健康状态失败写进守护进程的日志；Node 在 `headersTimeout`（默认 60 秒）大于 `requestTimeout` 时会把两个对调，所以 `headersTimeout` 也设成 15 秒、检查间隔从 30 秒调到 1 秒，半截请求才是 15 秒左右断开。`createAgentApi` 有可选的 `requestTimeoutMs`、`timeoutCheckMs`（默认取 `limits.ts`），测试里用 2 秒和 100 毫秒，几秒内测出连接真的被断开。
- 可调的超时、间隔集中到 `src/shared/limits.ts`（原来散在 daemon、handlers、agent-api、driver、hub 里）；动作的重试次数仍在 `actions.ts` 的 `ACTION_RETRY`。执行器的轮询间隔和并发数、SQLite 忙等时间、额度恢复后多等的 1 秒、标准错误取多少字符也都在 `limits.ts`。
- `session.send` 撞上 `session_ended`、消息还指着这个已结束的会话：重启恢复时会发生（交接那一轮被 SIGKILL 打断，重启后 `session.end` 先结束旧会话，恢复登记的 `session.send` 随后撞上）。按“这一轮被重启打断”处理，账本 `stopMessage` 把消息标 `stopped`（和关机打断一轮一样），不标 `failed`，免得用户点重试把同一句话再发给新项目经理；排队中（`queued`，不该出现）的标 `failed`，原因“这条消息发给的项目经理已经换人，请重发”。
- 关机有总上限 `SHUTDOWN_TOTAL_MS`（`main.ts` 用 `shutdown.ts` 的 `stopWithinLimit` 包住 `daemon.stop()`），超了记一条日志、退出码 1。
- M1 的 `createLaunchPreparer`、`buildPmPrompt`、`writeDefaultPersona` 删掉，默认性格设定文件由 `createPm` 和启动时的 `syncPersonaFiles` 写。

**交接怎么走**（一句话“把 foo 交给阿周”）：原项目经理在 foo 群或私聊里先写好交接，调 `hub project assign foo --to 阿周 --stdin`。账本在一个事务里：存交接文件和 `handoffs`；`projects.pm_id` 改成阿周；给 foo 群建下一代会话（属于阿周，提示词带这份交接）；登记旧会话的 `session.end`；在 foo 群发“项目经理由小林换成阿周，交接在这里”，在阿周的私聊发一条系统消息（agent 也收到）“小林把 foo 交给了你”。`handoffs.from_session_id` 是群里被结束的那一代，`hub_calls.session_id` 是调用者的会话（可能在私聊里）。旧会话这一轮回完用户后就关掉；之后群里的消息都发给新一代。“你也管一下 bar”只能对 bar 现在的项目经理说（第 7 节第 8 条）。

## 4. 测试方案

**假 `claude` 加一种剧本动作**（W3）：`{ "bash": "<命令>" }`，用自己拿到的环境变量 `sh -c` 跑，照真 `claude` 的格式输出一次 `tool_use` 和 `tool_result`（带命令输出）。这样端到端能测“agent 敲 `hub` → 系统做事”整条路，不用真模型。

**必须用真 `claude` 测的**（W6 加进 `pnpm smoke`，验收时和每次升级 `claude` 后跑；M1 的 S1～S4 照跑）：S5 私聊里一句话建项目，`hub project create` 没被权限拦、命令里没有变量；S6 挂文件夹后下一条消息前自动重启，能读新文件夹里的文件；S7 换项目经理，交接从 heredoc 传进来没被拦，新项目经理能答出交接里的事；S8 说“以后回复都用列表”，`hub persona edit` 成功，下一条回复是列表；S9 同一个项目经理在两个群同时被问长问题，两个进程同时跑，各自只说自己的项目。

### W0 接口和迁移

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 迁移能执行 | 在 M1 的库（一个 `mode='default'`、带头像和默认模型的项目经理，一个 `mode='hands_on'` 的）上跑 `0002` | 新表都建出来；`user_version` 是 2；第一个变成 `manage_only`，第二个保持 `hands_on`，头像、默认模型都在；项目经理的会话都有 `pm_id`；升级前留了一份备份 |
| 空库 | 空库连跑 `0001`、`0002` | 没有报错 |
| 约束 | 插第二个同名的进行中项目、同一个项目第二个群、`mode='foo'`、`is_main=2`、`mode_after='default'`、各个外键指向不存在的行 | 都报约束错误；换下来、标了移除的旧主文件夹不占路径 |
| 迁移器 | M1 里有重名的项目经理；迁移留下悬空引用；在事务里调 | 后建的改名成“名字-编号”；回滚并列出哪些行；直接报错 |
| 共用函数 | `isQuotaExhausted` 喂 `allowed`、`allowed_warning`、`rejected` | 只有 `rejected` 是 true |

### W1 账本

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 建项目经理 | `createPm` | 一个项目经理、一个私聊、一个会话（带 `pm_id`）、性格设定文件；推 `pm.created`、`conversation.created` |
| 同名项目经理 | 再建一个同名的 | `conflict`，什么都没写 |
| 一句话建项目 | 私聊会话调 `hubCall(project.create)` | 项目、主文件夹、群、群会话（cwd 是主文件夹真实路径）；群里“项目已建好”；`hub_calls` 一行；返回文字里有群名 |
| 文件夹不对 | 路径不存在、是文件、在 `~/.agent-hub` 里、已是别的项目的主文件夹 | `invalid` 或 `conflict`，带原因；什么都没写 |
| 挂文件夹 | `project.attach` | `project_folders` 多一行；群会话的 `add_dirs` 有它；群里一条系统消息，同时登记一条给 agent 的 `session.send` |
| 移除文件夹 | `project.detach` 一个挂着的、主文件夹、没挂过的 | 第一个标移除时间；第二个 `invalid`（主文件夹不能移除）；第三个 `not_found` |
| 管不着 | 阿周的会话 `attach` 小林的项目 | `forbidden` |
| 交接 | 小林的会话 `project.assign foo --to 阿周`，带正文 | 交接文件和记录；项目经理换了；群的新一代会话属于阿周；旧会话的 `session.end`；群里和阿周私聊各一条系统消息 |
| 交接边界 | 没有正文；交给自己；交给不存在的人；正文超过 64 KB | `invalid` / `invalid` / `not_found` / `invalid` |
| 换人后发消息 | 用户在群里发一条 | `session.send` 指向新一代会话 |
| 改习惯 | 会话调 `persona.edit`（新正文、`--mode hands_on`） | 文件和模式变了；`persona_changes` 一行（`actor: pm`）；发起的对话里一条“改了自己的做事习惯”；推 `pm.updated` |
| 撤销 | `revertPersonaChange(最近一次)`；再撤销更早的一次 | 第一次恢复原样并多一条记录（`revertOf`）；第二次 `conflict` |
| 手改文件 | 改 `personas/pm-1.md`，重新打开账本 | 多一条 `actor: file` 的记录 |
| 写文件失败 | 让写性格文件抛错 | 数据库已提交，`persona_file_hash` 没变；下次启动按记录重写文件，不多出 `actor: file` 的记录 |
| 重试失败消息 | `retryMessage` 一条 `failed`、一条 `replied`、一条不存在的 | 第一条状态回到 `queued`、失败原因清空、推 `message.updated`、重新登记（同一行重置）；第二条 `conflict`；第三条 `not_found` |
| 移除已删掉的文件夹 | 挂上一个文件夹，在磁盘上删掉它，再 `project.detach` | 按字面路径找到那一行，标移除 |
| 停止只停最新一代 | 换人后旧一代还在跑，用户点停止 | 只通知最新一代 |
| 启动上下文 | `getLaunchContext(群会话)` | 有项目信息、其他文件夹、最近一份交接；私聊会话有管着的项目名片，没有项目信息 |

### W2 agent 接口 + `hub`

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| socket 权限 | 启动接口 | `run/` 0700，`hub.sock` 0600；返回的路径是真实路径 |
| 残留 socket | 先放一个旧的 `hub.sock` 再启动 | 删掉重建，能连 |
| 令牌 | 不带、带错、带已作废的令牌 | 401；账本没被调用 |
| 认人 | 带 A 会话的令牌调 `status` | 账本收到的会话是 A，不看请求体里自称的身份 |
| 错误映射 | 假账本抛四种 `LedgerRequestError` | 400 / 404 / 403 / 409，体是 `{ ok: false, code, message }` |
| 请求体 | 未知命令、缺参数、超大正文、整个请求体超过上限 | 400（`invalid`），不调账本 |
| `hub` 成功 | 对着测试服务跑 `hub project create --name foo --folder /x` | 打印 `text`，退出码 0；请求体参数对 |
| `hub` 长文本 | `--stdin`，标准输入给 3 KB 带 `$`、反引号、引号的交接 | 原样到服务端 |
| 不写 `--stdin` 不读 | 标准输入一直开着、不写 `--stdin` 也不写 `--text` 调 `project assign` | 马上退出码 2，不卡住 |
| 令牌作废后 | `revoke` 之后再 `issue` 同一个会话 | 抛错 |
| `hub` 失败 | 服务拒绝；参数不对；`HUB_SOCK` 指向不存在的文件；没设 `HUB_TOKEN` | 退出码 1 / 2 / 3 / 2，各打印一句能看懂的原因 |
| `~` 展开 | `--folder ~/code/foo` | 发出去的是展开后的绝对路径 |

### W3 驱动层 + 提示词 + 假 claude

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 每次启动的环境变量 | `prepareLaunch` 返回 `env` | 假 `claude` 记下的环境里有 `HUB_TOKEN`、`HUB_SOCK`，`PATH` 最前面是给的目录；同一个会话两次 `prepareLaunch` 令牌相同、`fingerprint` 相同 |
| 设置文件 | 返回 `settingsFile` | 参数里有 `--settings <文件>` |
| 两轮之间重启 | 一轮结束后 `fingerprint` 变了，再发一条 | 先关标准输入、进程退出，再 `--resume` 启动，然后才写这条（前面拼 `RELAUNCH_NOTE`）；消息不丢、不重复 |
| 没变不重启 | `fingerprint` 不变连发两轮 | 同一个进程 |
| 忙时变了 | 一轮中 `fingerprint` 变了 | 这一轮不打断，结束后再重启 |
| 结束会话 | 一轮中调 `end`，在它 resolve 之前再 `send` | 这次 `send` 马上抛 `session_ended`，不排队；等 `result` 后关标准输入，状态 `ended` |
| 结束没在跑的 | 空闲会话调 `end` | 直接 `ended`，不启动进程 |
| 同时跑 | 三个会话同时发 | 三个进程，事件各归各的会话 |
| 提示词：群 | 群会话、`manage_only` | 有角色、性格、“只管理”的默认做法、项目名和文件夹、交接正文、`hub` 用法（写明不要在命令里写变量）；按 M1 规则加 `AGENTS.md` 那句 |
| 提示词：私聊 | 私聊会话、`hands_on`，管两个项目 | 有两个项目的名片和“自己也干活”的做法，没有某个项目的文件夹 |
| 提示词：群不随别的项目变 | 同一个项目经理在私聊里又建了一个项目 | 群会话的 `fingerprint` 不变（群提示词里没有 `managedProjects`） |
| 假 claude 跑命令 | 剧本 `{ "bash": "echo hi" }` | 输出 `tool_use` 和带 `hi` 的 `tool_result`；驱动层出一个 `agent.tool` |

### W4 界面服务

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 建项目经理 | `POST /api/pms`，四个字段都对 | 调 `ledger.createPm`，回编号 |
| 请求体不对 | 名字空、`mode` 不是两种之一、性格设定超过 32 KB | 400，不调账本 |
| 建项目 | `POST /api/projects` | 调 `ledger.createProject`（`actor: user`）；账本抛 `invalid` 时 400，带原因 |
| 性格设定 | `GET`、`PUT` persona，`POST` revert | 原样转给账本；`conflict` → 409 |
| 重试 | `POST /api/messages/:id/retry` | 202；`not_found` → 404；`conflict` → 409 |
| 新变化 | 账本推 `project.created` | WebSocket 收到，断线补齐里也有 |
| 没登录 | 不带 cookie 调新接口 | 401 |
| 会话令牌进不来 | 用 `Authorization: Bearer <会话令牌>` 调界面接口 | 401 |

### W5 网页（jsdom + Testing Library，接口用假的）

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 左栏 | 快照里两个项目经理、两个项目 | 项目经理和群分两组；群头像是项目名首字；按最后一条消息时间排 |
| 新项目 | 推 `project.created` | 左栏马上多一个群，不用刷新 |
| 新建项目经理 | 点“＋项目经理”，填名字，模式默认选中“只管理（推荐用于复杂项目）”，提交 | 发 `POST /api/pms`；成功后跳到它的私聊 |
| 新建项目 | 点“＋项目”，填名字、路径，选项目经理 | 发 `POST /api/projects`；400 时在表单里显示原因，不关表单 |
| 群页 | 打开一个群 | 顶栏有项目名、项目经理、文件夹列表 |
| 系统消息 | 推一条 `sender: system` 的消息 | 居中显示，没有投递状态 |
| 撤销 | “改了做事习惯”的系统消息点“撤销” | 发 revert；409 时提示“只能撤销最近一次” |
| 资料页 | 点项目经理头像，改性格设定保存 | 发 `PUT`；修改记录列表多一条 |
| 重试 | 一条 `failed` 的消息点“重试” | 发 retry，按钮变“重试中”；推回 `queued` 后按钮消失；接口失败时恢复按钮 |
| 当前会话 | 一个群有两代会话，旧一代在跑、新一代空闲 | 状态行、停止按钮按新一代（`generation` 大的）显示 |
| 等额度 | 会话 `rateLimit.status` 是 `allowed_warning` | 不显示“等额度” |
| Markdown | agent 消息里有列表、代码块 | 按改版后的样子渲染（沿用，回归测试） |

### W6 组装 + 端到端（真守护进程 + 假 `claude`，临时数据目录）

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 一句话建项目 | 私聊发消息，剧本跑 `hub project create --name foo --folder <临时目录>` | WebSocket 收到 `project.created`；群里“项目已建好”；`hub_calls` 一行 |
| 群里聊 | 在 foo 群发一条 | 新的假 `claude` 工作目录是 `<临时目录>` 的真实路径；提示词里有 foo |
| 同时跑 | 同一个项目经理的两个群同时发，剧本都慢慢回 | 两个进程同时在跑，回复各进各的群 |
| 挂文件夹 | 剧本跑 `hub project attach`，再发一条 | 第二条前进程重启，参数多一个 `--add-dir`；agent 收到“【系统】…文件夹…”那条 |
| 交接 | 剧本跑 `hub project assign … --to 阿周` | 旧进程这一轮结束后退出；群里再发一条，起的是新一代会话，提示词里有交接正文 |
| 令牌作废 | 交接后用旧会话的令牌跑 `hub status` | 退出码 1，401 |
| 重启不丢 | 建好项目后 `SIGTERM` 再启动 | 项目、群、文件夹、交接都在；群会话用 `--resume`；旧 `hub.sock` 被替换 |
| 守护进程没开 | 关掉守护进程后直接跑 `hub status`（同样的环境变量） | 退出码 3，提示“连不上 agent-hub” |
| 重试 | 让 `claude` 找不到导致消息失败，再修好路径，点重试 | 消息回到“排队中”→“已送达”→“已回复” |
| 交接时排队的消息改指新一代 | 交接时群里还有一条排队的消息（用例先断言它确实排在旧一代上） | 发给新一代；driver 的 health 没有记 `session_ended`（`session_ended` 两个分支由 `handlers.test.ts` 覆盖） |
| 重启恰好打断交接那一轮 | 旧项目经理一轮里跑 `hub project assign`，这一轮没结束就 SIGKILL 守护进程，再启动 | 那条用户消息 `stopped`、没有失败原因；动作都 `done`；health 没有 `session_ended` |

## 5. 验收

M2 所有 PR 合并后，用户在本机：

1. `pnpm install && pnpm build && pnpm check`：全部通过。`pnpm start`，用打印的链接打开网页：M1 的“项目经理”还在，资料页显示模式“只管理”。
2. 左下角“＋项目经理”：名字“阿周”，选“自己也干活”，提交：左栏多一个阿周，点开是空的私聊。
3. 在“项目经理”的私聊里说“在 `<一个已有的文件夹>` 建一个叫 foo 的项目”：它回复建好了；左栏出现 foo 群，群里居中一条“项目已建好”。再建一个 bar（换一个文件夹）。说一个不存在的文件夹：它回复文件夹不存在，没有建。
4. 在 foo 群问“这个文件夹里有什么”，马上在 bar 群问同样的话：两个群同时显示“正在运行”，各自回答自己文件夹里的东西。
5. 在 foo 群说“把 `<另一个文件夹>` 也挂上，然后看看里面有什么”：群里一条“已挂上文件夹”；它能说出新文件夹里的文件。
6. 在 foo 群说“记住：发布日期定在周五。然后把 foo 交给阿周”：群里出现“项目经理由‘项目经理’换成阿周，交接在这里”，阿周的私聊里也有一条。在 foo 群问“发布日期是哪天”：阿周回答周五。
7. 在 bar 群说“以后回复都用列表”：群里出现“项目经理改了自己的做事习惯”；下一条回复是列表；点“撤销”，资料页里的性格设定改回去，修改记录有两条。
8. 把 `AGENT_HUB_CLAUDE` 设成不存在的路径重启守护进程，发一条消息，等它标“失败”（重试 3 次，约 15 秒）；去掉这个变量再重启，点那条消息的“重试”：先变回“排队中”，再变成“已回复”，没有多出一条消息。
9. Ctrl+C 再 `pnpm start`：项目、群、聊天记录、交接都在，接着聊。
10. `pnpm smoke`：S1～S9 全部通过。

## 6. 已拍板的问题

用户 2026-11-03 全部按推荐定了。每条先写结论，再留着当时没选的方案和理由。

**1. 建项目时文件夹不存在怎么办？** 设计第 9 章说要用户批准再建，但审批是 M4 的。
- **结论：M2 直接拒绝**，`hub` 返回“文件夹不存在，请先建好：<路径>”（`invalid`），项目经理转告用户；界面表单同样提示。M4 有了审批再改成弹审批卡片。
- 没选：守护进程直接建文件夹（不经批准就写用户的磁盘，和设计第 11 章冲突）；M2 提前做一个简化的审批（把 M4 的一块拉进来，范围变大）。

**2. 换项目经理只用一句话，界面上先不给按钮。** 设计第 3.6 节的项目设置页能“换人”，但用户定的是“换项目用自然语言说”，而且交接要原项目经理写。
- **结论：M2 只支持在聊天里一句话说**，由当前项目经理先写交接再调 `hub project assign`。界面上不加按钮，以后再加（那时要让守护进程先叫原项目经理写交接）。
- 没选：M2 就做按钮，交接由守护进程从最近 30 条消息自动拼（交接质量差，且多一条路径要测）。

**3. 性格设定、模式、文件夹改了，什么时候生效？** 提示词和 `--add-dir` 只在启动 `claude` 时读。
- **结论：下一条消息前自动重启**（`--resume`，同一个会话），多等几秒，改动马上生效；正在跑的这一轮不打断。判断规则写在 `src/shared/driver.ts` 的“两轮之间自动重启”。
- 没选：等进程空闲 10 分钟自己退出后才生效（不用改驱动层，但用户说完“以后用列表”，接下来十分钟里它可能还不照做）。

**4. 强制结束 `claude` 时，按进程组把它起的子进程一起杀掉。** 现在 `spawn` 没有放进单独的进程组，强制结束（关机超时、启动超时、清理上次残留）只杀 `claude` 本身，它跑着的 `pnpm test`、开发服务器之类可能留下来。
- **结论：要。** `spawn` 加 `detached: true`；正常停止仍只给 `claude` 发 `SIGINT`（M0 实测过的行为不变）；强制结束改成给整个进程组发 `SIGKILL`；重启清理时核对过命令行后也按进程组杀。顺带的好处：终端里按 Ctrl+C 不会直接打到每个 `claude`，统一由守护进程按顺序关。放在 W3 做，加两条测试（剧本起一个睡眠子进程，强制结束后它也不在了）。
- 没选：保持现状（M3 有了 Worker 跑测试和服务后，残留进程会越来越多）。

**5. 服务端标了“失败”的消息，可以重试。** 现在只有“网页没发出去”能重试；服务端起不来 `claude` 等原因标失败的，用户只能重新打一遍。
- **结论：要。** `POST /api/messages/:id/retry`（202），账本只接受“失败”的用户消息，同一个事务里把状态改回“排队中”（转换表里的 `failed → queued`）、清空失败原因、推一条 `message.updated`，按原来的去重键重新登记发送（M1 的动作表已经支持把失败的那一行重置；发给这个对话现在最新一代的会话），之后照“排队中 → 已送达 → …”走，不新增消息。
- 没选：不做，让用户复制重发（会多出一条重复消息，原来那条一直挂着“失败”）。

## 7. 设计文档和 M1 实现不一致的地方

只记录，不改设计文档。

1. **进程组**：设计第 12.3 节说 `claude` 放在单独的进程组里、重启后按进程组找到并结束；实现里 `spawn` 没有 `detached`，清理是按记录的进程号 + `ps` 核对命令行，只结束 `claude` 本身。见第 6 节第 4 条。
2. **“等额度”的判断两边不一样**：设计第 7.3 节写“`status` 不是 `allowed` 时状态等额度”。实现里发消息的处理函数只把 `rejected` 当用完（`allowed_warning` 照常发），网页却按“不是 `allowed`”显示“等额度”。结果是额度快到了（`allowed_warning`）时界面显示“等额度”，agent 其实在照常干活。M2 W0 加一个共用的 `isQuotaExhausted`，两边都按 `rejected` 判断。
3. **`pms.mode`**：设计是两种模式；实现的列默认值是 `'default'`，没有约束。`0002` 迁移改掉。
4. **会话不记属于哪个项目经理**：设计第 6.2 节 `agent_sessions` 只关联对话或工单；换项目经理后同一个群的旧一代会话属于原项目经理，提示词和令牌都要知道是谁，所以加 `pm_id`。
5. **失败消息的重发没有入口**：设计第 7.3 节说“只有失败能在重发时回到已送达”，但没写谁触发重发；M1 只有重启恢复会重发。见第 6 节第 5 条。
6. **每个会话的环境变量**：设计第 7.2 节每个会话有自己的 `HUB_TOKEN`；M1 的 `DriverOptions.env` 是所有会话共用一份，`prepareLaunch` 只返回文件。M2 给 `LaunchFiles` 加 `env`。
7. **性格设定能手改**：M1 写默认性格文件的注释说“以后改这个文件就行”，设计第 2.2 节只说项目经理通过系统命令改、留记录。M2 以数据库为准，启动时发现文件被手改就补一条 `actor: file` 的记录。
8. **“你也管一下 bar”**：设计第 9 章表里允许对一个项目经理说“你也管一下 bar”，同一章又说“项目经理只能操作自己管的项目”。M2 按后者：只有 bar 现在的项目经理能把 bar 交出去，或者等以后界面上的按钮。
9. **`hub` 调用记录**：设计第 9 章要求“每个操作都在账本里留记录”，第 6.2 节没有对应的表。M2 加 `hub_calls`（哪个会话、什么命令、参数、结果、时间）。
10. **“只管理”模式要派 Worker**：设计第 2.2 节的默认做法是派 Worker，M2 还没有 Worker（M3）。M2 的提示词先写成“要动手先问用户”，M3 再改成派工单。

[fastify-listen]: https://fastify.dev/docs/latest/Reference/Server/#listen
[node-http]: https://nodejs.org/api/http.html#httprequestoptions-callback
[node-util]: https://nodejs.org/api/util.html#utilparseargsconfig
