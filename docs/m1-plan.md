# M1 计划：能聊

> 状态：草稿，等用户拍板。依据是 [prototype-design.md](prototype-design.md)（下文简称“设计”）第 14 章的 M1，以及 [m0-report.md](m0-report.md)。
> 写于 2026-11-02。本机现有：Node 24.21、pnpm 10.34、npm 11.19、yarn 4.18、bun 1.4、sqlite3 3.51。只看了，没装东西。

## 1. 范围

**做完用户能看到什么**：终端里启动守护进程，浏览器打开它打印的链接，和一个项目经理聊天；点“停止”能停下它这一轮；关掉守护进程再开，聊天记录还在，它还记得之前聊的内容，能接着聊。

**M1 做**

| 部分 | 做到什么程度 | 设计章节 |
|---|---|---|
| 守护进程 | 一个 Node 进程；数据目录锁；启动和关闭顺序；关机时按设计第 12.3 节停子进程 | 4、12.3 |
| 账本 + 数据库 | M1 用到的表：`pms`、`conversations`、`messages`、`agent_sessions`、`actions`、`health`；其他表 M2 起再加 | 6.2 |
| 动作队列 + 执行器 | 只有两类动作：“启动或恢复会话”“给会话发消息”；退避重试；重启后接着做 | 12.2 |
| 驱动层（Claude） | 启动、恢复、发消息、读事件、打断、空闲关闭、崩溃后恢复；全部按 M0 改过的做法 | 7.2～7.4 |
| 界面服务 | HTTP + WebSocket，只监听 `127.0.0.1`，要界面用户令牌 | 4.3、11.3 |
| 网页 | 左栏只有一个项目经理；对话页：消息、投递状态、“执行了 N 个操作”折叠、状态行和“停止”按钮；断线重连补齐 | 3.1～3.3 |
| 重启恢复 | 设计第 5.4 节第 1～4、6 步 | 5.4 |
| 默认项目经理 | 第一次启动自动建一个，名字“项目经理”，带一份默认性格设定；工作目录 `pm-home/<编号>/` | 2.2 |

**M1 不做**（括号里是哪个里程碑做）

- 项目、项目群、文件夹、新建项目经理的页面、改性格设定（M2）。
- `hub` 命令和 agent 接口的 Unix socket（M2，第一次用到是 `hub project create`）。M1 的提示词里不写 `hub` 用法。
- 工单、Worker、worktree（M3）。
- 权限钩子、收件箱、通知（M4）。M1 里 agent 弹出的权限请求由 Claude 自己按 `-p` 的规矩拒绝。
- 总助（M5）、定时任务（M6）、看门狗的大部分检查（M7）。M1 只做驱动层自带的两项：启动 60 秒没有 `init`；进程退出了但没有 `result`。
- `CLAUDE_CONFIG_DIR` 切换账号、头像、勿扰时段。

## 2. 技术选型

每项第一个是推荐。

| 项 | 选项 | 推荐和理由 | 出处 |
|---|---|---|---|
| 运行时 | **Node 24**（本机 24.21，维护期 LTS，到 2028-04-30）/ Node 26（当前的 Active LTS，本机没装）/ Bun 1.4（本机有） | Node 24：本机已有，不用装；下面两项内置功能在 24 上都能用。以后升 26 只改 `engines`。Bun 不选：设计第 4.4 节定了 Node，Bun 的子进程和 SQLite 接口跟 Node 不一样，换了要重写。 | [Node 发布计划][node-rel] |
| 怎么跑 TypeScript | **Node 自带的类型擦除** / `tsx` / 先用 `tsc` 编译 | Node 自带：24.12 起稳定，直接 `node src/daemon/main.ts`，不用编译。限制是不能用 `enum`、构造函数参数属性这类要转换的写法，`tsconfig` 开 `erasableSyntaxOnly` 让 `tsc` 提前报错。`tsc --noEmit` 只做类型检查。 | [Node TypeScript][node-ts] |
| 包管理 | **pnpm 10**（本机有）/ npm 11 / yarn 4 | pnpm：本机已有、装得快；10 版默认不跑依赖的安装脚本，更安全。`package.json` 写 `packageManager` 锁版本。 | [pnpm v10 说明][pnpm10] |
| SQLite | **`node:sqlite`（内置）** / `better-sqlite3` / 上面再加 ORM（如 Drizzle） | `node:sqlite`：不用装、没有原生编译；同步接口，适合“一个进程、一个写者”。24.15 起是“候选发布”（Stability 1.2），还不是稳定版，所以只在 `store/db.ts` 一个文件里用它，事务自己写个十来行的 `transaction()`（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）。万一接口变了，换成 `better-sqlite3` 只改这一个文件。不用 ORM：表少，直接写 SQL 更清楚。迁移用 `PRAGMA user_version` 加编号的 `.sql` 文件。 | [node:sqlite][node-sqlite]、[better-sqlite3][bsq] |
| HTTP + WebSocket | **Fastify 5 + `@fastify/websocket` + `@fastify/static`** / Node 自带 `http` + `ws` / Hono | Fastify：测试时用 `inject()`、`injectWS()`，不用开真端口；请求体按 JSON Schema 校验；M2 的 agent 接口可以直接 `listen({ path })` 开在 Unix socket 上。`@fastify/websocket` 底下就是 `ws`。 | [Fastify][fastify]、[@fastify/websocket][fws] |
| 网页 | **React + Vite** / Preact + Vite / 不用框架（原生 DOM） | React：聊天页状态多（消息原地更新、折叠、重连补齐），M2～M5 还要加卡片和收件箱，手写 DOM 越往后越难改；React 资料最多，agent 写得最熟。Vite 只在开发和打包时用，守护进程只发打包好的 `dist/` 静态文件。M1 不引组件库。 | [Vite][vite]、[React][react] |
| 测试 | **Vitest** / Node 自带 `node:test` / Jest | Vitest：前后端一套；有假计时器（测退避、超时不用真等）；前端配 jsdom + Testing Library。要求 Node ≥ 22.12，本机满足。`node:test` 不用装，但前端组件测试不顺手。Jest 对 ESM 和 TypeScript 要额外配置。 | [Vitest][vitest] |

**目录结构**（一个包，不拆多包）：

```
agent-hub/
├── package.json             # 脚本：dev / build / start / check / smoke
├── tsconfig.json            # strict、erasableSyntaxOnly、noEmit
├── vite.config.ts           # 只管 src/web
├── vitest.config.ts
├── migrations/0001_init.sql
├── src/
│   ├── shared/              # 前后端共用：接口类型、事件、HTTP/WS 消息
│   ├── daemon/
│   │   ├── main.ts          # 组装、启动和关闭顺序
│   │   ├── store/           # 打开数据库、迁移、目录锁
│   │   ├── ledger/          # 账本命令
│   │   ├── actions/         # 动作队列和执行器
│   │   ├── driver/          # Claude 驱动层
│   │   └── ui-server/       # HTTP + WebSocket
│   └── web/                 # React 页面
└── test/
    ├── fake-claude/         # 假 claude 和剧本
    ├── e2e/                 # 端到端
    └── smoke/               # 真 claude 冒烟脚本
```

`pnpm check` = `tsc --noEmit` + `vitest run`，每个 PR 合并前必须全绿。数据目录可以用环境变量 `AGENT_HUB_HOME` 改（测试用临时目录），`claude` 的路径可以用 `AGENT_HUB_CLAUDE` 改（测试指向假 `claude`）。

## 3. 拆分

6 块，每块一个 Worker、一个 PR。W0 先做；W1～W4 在 W0 合并后**同时开工**；W5 等 W1～W4 都合并后做。

```
W0 骨架和接口 ──┬── W1 存储 + 账本 + 动作队列 ──┐
               ├── W2 驱动层 + 假 claude ──────┤
               ├── W3 界面服务 ────────────────┼── W5 组装 + 端到端
               └── W4 网页 ────────────────────┘
```

| 块 | 边界：只改这些 | 依赖 |
|---|---|---|
| W0 骨架和接口 | 根目录配置文件、`src/shared/`、`migrations/0001_init.sql`、各目录的空入口文件 | 无 |
| W1 存储 + 账本 + 动作队列 | `src/daemon/store/`、`ledger/`、`actions/` | W0 |
| W2 驱动层 + 假 claude | `src/daemon/driver/`、`test/fake-claude/` | W0 |
| W3 界面服务 | `src/daemon/ui-server/` | W0 |
| W4 网页 | `src/web/` | W0 |
| W5 组装 + 端到端 | `src/daemon/main.ts`、提示词生成、默认项目经理、`test/e2e/`、`test/smoke/`；接线时发现的小改动可以碰其他目录，PR 里写明 | W1～W4 |

**接口约定**（W0 写成 `src/shared/` 里的类型，之后改它要在 PR 里说明，并通知用到它的块）：

1. **网页 ↔ 界面服务**
   - 登录：守护进程启动时打印 `http://127.0.0.1:<端口>/auth?token=<界面用户令牌>`。打开后设一个 `HttpOnly`、`SameSite=Strict` 的 cookie，跳到 `/`。之后所有请求和 WebSocket 都靠这个 cookie。
   - `GET /api/state` → 项目经理列表、对话列表、每个对话最近 100 条消息、会话状态、当前事件序号 `seq`。
   - `GET /api/conversations/:id/messages?before=<消息编号>` → 更早的 100 条。
   - `POST /api/conversations/:id/messages`，请求体 `{ clientId, text }` → `{ messageId }`。`clientId` 由网页生成，重发用同一个。
   - `POST /api/conversations/:id/stop` → `202`。
   - WebSocket `/api/ws?since=<seq>`：服务端推 `{ seq, type, data }`，`type` 有 `message.created`、`message.updated`、`session.status`；`since` 太旧补不齐时推 `{ type: "resync" }`，网页重新拉 `/api/state`。
2. **界面服务 ↔ 账本**：`ledger.postUserMessage({ conversationId, clientId, text })`、`ledger.requestStop(conversationId)`、`ledger.snapshot()`、`ledger.changesSince(seq)`、`ledger.onChange(listener)`。
3. **执行器 ↔ 驱动层**：`driver.send(sessionId, { messageIds, source: "user" | "system", text })`、`driver.interrupt(sessionId)`、`driver.shutdown()`。驱动层自己管每个会话的待发队列（设计第 7.3 节）。
4. **驱动层 → 账本**：`driver.onEvent((sessionId, event) => …)`。事件：`session.started`、`message.delivered`、`message.processing`、`agent.text`、`agent.tool`、`turn.ended`（带 `ok`、`interrupted`）、`rate_limit`、`session.exited`（带 `hadResult`）、`driver.error`。每个事件带 Claude 原始的 `uuid`（有的话），账本按它去重。
5. **驱动层 ↔ 存储**：`SessionStore` 接口，读写 `agent_sessions` 的一行。W1 实现，只有驱动层调用；W2 测试时用内存假实现。

## 4. 测试方案

**假 `claude`**（W2 写，`test/fake-claude/fake-claude.ts`，开头一行 `#!/usr/bin/env node`）：

- 按环境变量 `FAKE_CLAUDE_SCRIPT` 指的剧本（JSON）回应；把收到的命令行参数、每一行标准输入、收到的信号记到 `FAKE_CLAUDE_LOG`，测试拿这份记录对答案。
- 默认行为照 M0 实测：每轮先发 `system/init`；收到消息先回显，再按剧本发 `assistant`、`rate_limit_event`、`result`；忙时收到的几条合并成下一轮；坏的输入行写一行错误后退出码 1；`interrupt` 控制消息回 `control_response` + `[Request interrupted by user]` + `result`；`SIGINT` 结束这一轮后退出码 0；同一个 `--session-id` 第二次用就报 “already in use”。
- 剧本可以让它：不发 `init`、中途退出、不理控制消息、慢慢输出、输出一行不是 JSON 的东西。
- 第一批剧本从 `experiments/m0/` 的真实记录改出来，事件字段名照抄。

**必须用真 `claude` 测的**（W5 写成 `pnpm smoke`，不进 `pnpm check`，验收时和每次升级 `claude` 后手动跑）：S1 连续聊两轮；S2 重启守护进程后接着聊，记得之前说的话；S3 点“停止”，控制消息管用、进程还在；S4 忙时连发两条，下一轮两条都回应到。这四条测的是 Claude 那边的行为，假 `claude` 证明不了。

### W0 骨架和接口

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 骨架能跑 | 空仓库装好依赖后跑 `pnpm check` | 类型检查和测试都通过（有一条占位测试） |
| 禁用的 TS 写法会报错 | 临时写一个 `enum` 跑 `tsc` | 报错（`erasableSyntaxOnly` 生效） |
| 迁移文件能执行 | 用 `sqlite3` 在空库上执行 `0001_init.sql` | 六张表都建出来，没有报错 |

### W1 存储 + 账本 + 动作队列

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 首次建库 | 在空的临时目录打开存储 | 建出 `state/hub.sqlite`；`journal_mode` 是 `wal`；`user_version` 是 1 |
| 重复迁移 | 同一个库打开两次 | 第二次不改任何东西 |
| 用户消息和动作同一个事务 | `postUserMessage` | 多一条消息（状态“排队中”）和一个“发消息”动作 |
| 同一条消息来两次 | 用同一个 `clientId` 调两次 | 只有一条消息、一个动作；两次返回同一个编号 |
| 事务回滚 | 让登记动作那一步抛错 | 消息和动作都没写进去 |
| agent 输出去重 | 同一个（会话，`uuid`）的事件交两次 | 只有一条消息 |
| 退避重试 | 动作处理函数一直抛错，用假计时器拨时间 | 5 秒、10 秒后各重试一次；第 3 次失败后状态“失败”，`health` 记下错误 |
| 推迟不算失败 | 处理函数返回“稍后再试” | 不加失败次数，按时间再试 |
| 重启接着做 | 留一个“执行中”的动作，重新打开存储和执行器 | 改回“待执行”并执行一次 |
| 开两个 | 已拿锁时再拿一次 | 第二次报错“已有守护进程在跑” |
| 变化推送 | 写一条消息后调 `changesSince(上一个 seq)` | 拿到这一条变化，`seq` 加一 |

### W2 驱动层 + 假 claude

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 首次启动参数 | 新会话发第一条 | 参数里有 `-p`、两个 `stream-json`、`--verbose`、`--replay-user-messages`、`--session-id <预先生成的 ID>`，没有 `--resume` |
| 之后用 `--resume` | 跑完一轮、进程退出后再发 | 参数里是 `--resume <同一个 ID>` |
| 一轮正常 | 发一条，剧本回一段文字 | 依次出 `message.delivered`、`message.processing`、`agent.text`、`turn.ended(ok)` |
| 工具调用 | 剧本里有一次工具调用和结果 | 出一个 `agent.tool` |
| 一次只写一条 | 剧本慢慢回，期间发两条用户消息 | 这一轮 `result` 前标准输入只有第一条；之后一行写入，内容以“【用户连发了 2 条】”开头 |
| 用户在系统前 | 忙时先来一条系统消息，再来一条用户消息 | 先写用户的，等它的 `result` 再写系统的，两条没拼在一起 |
| 写入前校验 | 直接让写入函数写一条 `role` 不对的 | 不写；出 `driver.error`；进程还在 |
| 打断，控制消息管用 | 一轮中调 `interrupt` | 标准输入多一行 `control_request`；`turn.ended(interrupted)`；进程还在，下一条照常 |
| 打断，控制消息没回应 | 剧本不理控制消息 | 5 秒后收到 `SIGINT`；`session.exited`；下一条用 `--resume` |
| 崩溃 | 剧本一轮中途退出码 1 | `session.exited(hadResult: false)`；下一条用 `--resume`，开头带恢复说明 |
| 启动卡住 | 剧本不发 `init` | 60 秒后结束进程，出 `driver.error(start_timeout)` |
| 参数选错 | 剧本对 `--session-id` 报 “already in use” | 自动改用 `--resume` 重试一次并成功；反过来 “No conversation found” 也一样 |
| 空闲关闭 | 一轮结束后用假计时器拨 10 分钟 | 关掉标准输入，进程正常退出，会话状态“空闲” |
| 额度信息 | 剧本发 `rate_limit_event` | 出 `rate_limit`，带 `utilization`、`resetsAt` |
| 坏的输出行 | 剧本输出一行不是 JSON 的 | 记一条错误，跳过，后面的事件照常 |
| 原始日志 | 跑完一轮 | `logs/sessions/<会话>.jsonl` 里每个事件一行，原样 |

### W3 界面服务

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 只听本机 | 启动后看监听地址 | 是 `127.0.0.1` |
| 登录 | 带对的令牌打开 `/auth` | 设 cookie，跳到 `/`；令牌不对返回 401 |
| 没登录 | 不带 cookie 请求 `/api/state` 或连 WebSocket | 401，WebSocket 连不上 |
| 防 DNS 重绑定 | `Host` 头不是 `127.0.0.1:<端口>` 或 `localhost:<端口>` | 403 |
| 发消息 | `POST` 消息 | 调用 `ledger.postUserMessage`，参数原样；返回 `messageId` |
| 请求体不对 | 空文本、超过 100 KB、少了 `clientId` | 400，不调账本 |
| 停止 | `POST /stop` | 调用 `ledger.requestStop`，返回 202 |
| 推送 | 连上后账本发一条变化 | 收到 `{ seq, type, data }` |
| 断线补齐 | 带 `since` 重连，中间有 3 条变化 | 收到这 3 条，不多不少 |
| 补不齐 | `since` 比保留的最早一条还早 | 收到 `resync` |
| 静态文件 | 请求 `/` | 返回 `index.html` |

### W4 网页（jsdom + Testing Library，接口用假的）

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 首屏 | 假 `/api/state` 返回一个项目经理和几条消息 | 左栏有它；点开看到消息，用户的靠右，agent 的靠左带名字 |
| 发送 | 输入文字按 Enter | 发出 `POST`，带新的 `clientId`；消息马上出现，标“排队中” |
| 换行 | Shift+Enter | 不发送，输入框多一行 |
| 状态原地更新 | 推 `message.updated`（排队中 → 处理中 → 已回复） | 同一条消息的标记跟着变，不多出新消息 |
| 操作折叠 | 一轮里推 3 个工具调用 | 显示“执行了 3 个操作”，点开看到 3 条 |
| 状态行和停止 | 推 `session.status` 为运行中，点“停止” | 底部有状态行；发出 `POST /stop` |
| 等额度 | 推额度状态不是 `allowed` | 状态行显示“等额度” |
| 发送失败 | 假接口返回 500 | 消息标“发送失败”，有“重试”；重试用同一个 `clientId` |
| 断线 | 假 WebSocket 断开再连上 | 显示“重连中”；重连带上最后的 `seq`；补齐后没有重复消息 |
| 补不齐 | 推 `resync` | 重新拉 `/api/state`，界面和新数据一致 |
| 没登录 | `/api/state` 返回 401 | 提示“请用守护进程在终端里打印的链接打开” |

### W5 组装 + 端到端（真守护进程 + 假 `claude`，临时数据目录）

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 首次启动 | 空目录启动守护进程 | 打印登录链接；自动建一个项目经理和它的私聊 |
| 聊一轮 | 通过 HTTP 发一条 | WebSocket 收到回复；假 `claude` 的工作目录是 `pm-home/<编号>/` |
| 提示词 | 看 `launch/<会话>/prompt.md` | 有角色说明和性格设定；没有 `hub` 用法 |
| 正常重启 | 发 `SIGTERM`，再启动，再发一条 | 历史都在；假 `claude` 用 `--resume` 同一个 ID |
| 关机 | 一轮中发 `SIGTERM` | 假 `claude` 收到 `SIGINT`；10 秒内全部退出；消息标“已停止” |
| 崩溃重启 | 一轮中 `SIGKILL` 守护进程，再启动 | 留下的假 `claude` 被结束；会话恢复，带恢复说明；界面上消息不重复、不丢 |
| 开两个 | 已有一个在跑时再启动 | 第二个报“已有守护进程在跑”并退出 |
| 找不到 `claude` | `AGENT_HUB_CLAUDE` 指向不存在的文件 | 守护进程不崩；消息标失败；`health` 记错误，界面显示“找不到 claude” |

## 5. 验收

M1 所有 PR 合并后，用户在本机：

1. `pnpm install && pnpm build && pnpm check`：全部通过。
2. `pnpm start`：终端打印一个 `http://127.0.0.1:…/auth?token=…` 的链接。
3. 浏览器打开链接：左栏有一个“项目经理”，点开是空对话。
4. 发“记住暗号：蓝鲸。然后用一句话介绍你自己”：消息靠右，标记依次变成“已送达”“处理中”“已回复”；它回一句自我介绍。
5. 发“写一篇 1500 字的文章”，开始输出后点“停止”：它停下，这条标“已停止”；再发“你好”，照常回复。
6. 再发一条要写很久的，趁它没写完连发“补充一”“补充二”：这一轮结束后，它在下一轮里同时回应了两条补充。
7. 在终端按 Ctrl+C，再 `pnpm start`，刷新页面：之前的消息都在。问“暗号是什么”：回答“蓝鲸”。
8. 守护进程开着时，在另一个终端再 `pnpm start`：提示已有守护进程在跑，退出。
9. `pnpm smoke`（用真 `claude`）：S1～S4 全部通过。

## 6. 风险和待拍板的问题

**1. agent 会继承用户全局的 `~/.claude` 设置。** M0 实测，每个 agent 都会加载用户全局的 `CLAUDE.md`、全局钩子（包括 Orca 装的各类钩子，其中有一个 `PermissionRequest` 钩子）和插件（比如 slack）。
- **推荐：沿用。** 这和用户定的“权限沿用 agent 自己的设置”一致：用户平时怎么用 Claude，agent 就怎么用，允许规则也不用重配。
- **影响**：全局 `CLAUDE.md` 里给自己定的习惯（比如开工先读某个本地文件）每个 agent 都会照做，多花一点 token，也可能和我们给的角色说明打架；Orca 的钩子对每个 agent 会话都会触发，Orca 里可能多出很多记录；slack 插件让 agent 有发消息的能力，发不发由 agent 自己的权限设置决定，我们的收件箱只管得到它弹出来的权限请求；agent 的会话记录也存在 `~/.claude/projects/` 里，和用户自己的混在一起。M4 时守护进程会检查全局设置里的 `PermissionRequest` 钩子，在设置页提示。
- **另一个选项**：给 agent 单独设 `CLAUDE_CONFIG_DIR`（指向一个干净的配置目录）。好处是 agent 的环境干净、可预期。代价：用户要在终端里用这个目录**再登录一次** `claude`（守护进程不能碰登录凭证）；用户自己的允许规则、技能、插件都不带过去，要用的得再配一份，两份设置要一起维护；agent 弹出的权限请求会变多；这也就不算“沿用 agent 自己的设置”了。设计第 7.1 节已经留了这个开关（按项目设置），以后哪个项目想要干净环境再单独开。

**2. 忙时连发的消息：拼成一条，还是一条一条排队？** M0 实测，忙时写进去的消息会被 Claude 合并，模型常常只回应其中一条。
- **推荐：我们自己拼成一条**，开头写“【用户连发了 N 条】”并编号。用户的补充下一轮就能被看到。
- 另一个选项：一条一轮，严格排队。回复和消息一一对应，但用户连发 3 条要等 3 轮。

**3. “停止”依赖没写进文档的控制消息。** `interrupt` 控制消息能停下这一轮而不杀进程，但这是 `claude` 命令行内部的标准输入协议，升级后可能变。
- **推荐：用**，5 秒没回应就退回 `SIGINT`（进程会退出，但会话保留，下次 `--resume`），功能上不会坏，只是慢一点。每次升级 `claude` 后跑 `pnpm smoke` 的 S3。
- 另一个选项：只用 `SIGINT`。最稳，但每次停止都要重启进程，下一条消息多等几秒。

**4. `node:sqlite` 还不是稳定版。** 它在 Node 24.15 起是“候选发布”。
- **推荐：用**，只在 `store/db.ts` 一个文件里碰它。接口真变了，换 `better-sqlite3` 只改这一个文件。
- 另一个选项：一开始就用 `better-sqlite3`。最成熟，但它是原生模块，pnpm 10 要手动批准它的安装脚本，Node 升级后可能要重新编译。

**5. M1 的项目经理怎么来。**
- **推荐：第一次启动自动建一个**，名字“项目经理”，用默认性格设定。新建、改名、改性格设定的页面放到 M2 和项目一起做，M1 专心把“聊天 + 重启不丢”做稳。
- 另一个选项：M1 就做“新建项目经理”页面。多一块界面和接口，W4、W5 会变大。

[node-rel]: https://github.com/nodejs/Release
[node-ts]: https://nodejs.org/api/typescript.html
[node-sqlite]: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
[bsq]: https://github.com/WiseLibs/better-sqlite3
[pnpm10]: https://github.com/pnpm/pnpm/releases/tag/v10.0.0
[fastify]: https://fastify.dev/docs/latest/Reference/Server/
[fws]: https://github.com/fastify/fastify-websocket
[vite]: https://vite.dev/guide/
[react]: https://react.dev/
[vitest]: https://vitest.dev/guide/
