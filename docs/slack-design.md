# 接入 Slack：私密频道、单人直聊与拉人共聊

## 给用户看

### 要验收的文件

- 本文：守护进程这一侧怎么接 Slack（五分钟接入、频道对应、单人和多人自动切换、主客权限、流式、拍板卡、文件、断线补发）。网页上的 Slack 设置页等界面打磨 R01 达 9 分后另起一步，本文只留好接口。
- 代码骨架：`src/shared/slack.ts`、`src/daemon/slack/`、`src/slack/cli.ts`、`migrations/0034_slack.sql`，函数体留给实现步骤。

### 要你拍板的事

1. **回复放在哪、怎么流式。** Slack 规定原生流式（打字机效果）只能发在消息串里，顶层消息只能发出后反复改。
   - A（推荐）：回复跟着提问走。你在频道里直接说，项目经理就在频道里直接回，边写边刷新（约 1.5 秒一刷）；你在某条消息的串里说，就在那个串里回，用原生流式。手机上一对一聊天不用每次点进串里看。
   - B：所有回复都进串，全用原生流式，打字最顺，但每条回复都要点进串才看得到全文。
   - C：不流式，写完一段发一段。最省事，但长回复要干等。
2. **被拉进来的人说话，项目经理能做多少。**
   - A（推荐）：访客 @机器人 或在机器人的串里接话就直达项目经理，消息带上他的名字和“访客”标记。新建项目、挂载或移除文件夹、准备命令、改性格设定、拍板步骤、加定时任务这几件，访客唤醒的那一轮里账本直接拒绝。拍板卡按钮、停止按钮、总助频道、附件、斜杠命令只认你。要提醒的是：项目经理那一轮仍然能在项目目录里读写文件、跑命令，所以共享的项目最好放在东京服务器上，并在项目经理能力开关里关掉邮件、云盘这类私人连接器。
   - B：访客的话先在频道里给你一个“转给项目经理”按钮，你点了才送达。最安全，但聊起来不顺。
3. **Mac 和东京服务器两台都要接时。**
   - A（推荐）：每台各建一个 Slack 应用（机器人名带设备名，比如 “Fusa · 东京”），可以装在同一个工作区里，频道名也带设备名，互不串台。哪台断了只影响那台。
   - B：只在一台上接，经已配对设备转发管另一台的项目经理。少一个机器人，但这台一断两台都没法在 Slack 里用，这次不做。
4. **总助频道里的拍板卡。**
   - A（推荐）：按钮只放在项目经理频道那张卡上，总助频道发一行摘要和“去拍板”的跳转链接，同一张卡只有一处可点。
   - B：两个频道都放按钮，点了一处另一处同时变成已定案。

## 用户目标

> 2026-11-17 14:49 用户：「如果把fusa做到手机的一个原有的app里面而不是我们自建的，自建一个app太麻烦了，我们这个是网页，还是比较卡的
> 可以做到一个聊天app里面吗」
>
> 2026-11-17 14:59 用户：「我见一个私人工作区，别人想用我直接把他拉进来就可以了吗」
>
> 2026-11-17 15:03 用户：「各自用各自的工作区。 他去下载我们打好的 Mac 或 Windows 安装包，装在他自己电脑上，连他自己的机器人，五分钟就能跑起来，两边彻底隔离，这是我的首选判断。
> 这是ok的
>
> 但是也支持我把他拉到我的私人工作区对话」
>
> 2026-11-17 18:00 用户：「先去写接入slack的方案和骨架」

用户在手机上用原生 Slack 代替 Fusa 网页做日常高频的事：和总助、各项目经理说话（流式回复）、随时停、点拍板卡、看交付的截图和文件。每个人各装各的 Fusa、各连各的工作区和机器人，默认彻底隔离；同时用户能把别人拉进自己工作区里某个项目的私密频道，一起和那个项目经理对话。守护进程在本机或远端服务器上都行，主动连出去，不要公网地址，手机不用开 Tailscale。

## 现状

### 代码

- 实测（读代码）：网页发消息走 `Ledger.postUserMessage`，同一个对话里同一个 `clientId` 只存一条（`dedupe_key`），存完登记 `session.send` 动作。`src/daemon/ledger/messages.ts:452`、`src/shared/ledger.ts:114`。Slack 消息用 `slack:<频道>:<ts>` 当 `clientId`，重投天然幂等。
- 实测（读代码）：停止走 `Ledger.requestStop(conversationId)`，只停最新一代会话。`src/daemon/ledger/messages.ts:561`。
- 实测（读代码）：提问卡（`hub ask`）是项目经理的消息，meta 是 `AskMeta`（选项、推荐项、`gateRef` 检查点、`blockerRef` 提醒卡、已回答标记）。`src/shared/domain.ts:497`。网页回答普通卡走 `POST /api/asks/:id/answer`（账本的 `answerAsk`），检查点卡走任务图的 `decide`，提醒卡走 `recheckUserBlocker`。`src/web/components/Messages.tsx:185`、`src/daemon/ui-server/server.ts`（`/api/asks/:id/answer`、`/api/user-blockers/:id/recheck`）。
- 实测（读代码）：回答拍板卡按 `clientId` 幂等：同一个 `clientId` 再来返回已有结果，不同的 `clientId` 回 `conflict`（“这张拍板卡已经被处理过了”）。`src/daemon/ledger/router.ts:525`。Slack 点击重投、网页和 Slack 同时点，账本都能给出唯一结果。
- 实测（读代码）：流式预览不落库，放在 `session.status` 变化的 `SessionState.streamingText` 里，网页节流 70 ms，最长 16,000 字；一段写完才落成一条 `message.created`。`src/shared/domain.ts:1009`、`src/shared/limits.ts:52`、`src/shared/limits.ts:54`。Slack 一条消息的 markdown 块合计 12,000 字，所以长段要拆。
- 实测（读代码）：账本所有变化经 `Ledger.onChange` 按事务提交后推出，推送提醒服务就是这样订阅账本的旁路。`src/shared/ledger.ts:407`、`src/daemon/daemon.ts:763`、`src/daemon/push/index.ts`。Slack 通道照同一个模式接，账本、驱动、任务图不用改流程。
- 实测（读代码）：总助不是一个对话，是指令：`RouterDispatcher.submitCommand` 收一句话，回 `RouterCommandRecord`（回答或分派结果），账本推 `router.command.updated`；简报和拍板项是 `router_items`，推 `router.item.*`。`src/daemon/router/dispatcher.ts:97`、`src/shared/router.ts`。
- 实测（读代码）：项目经理发给用户的文件是 sent-files 副本（编号、名字、mime），卡片带的交付物也是副本；用户上传走 `saveUpload` 存进上传目录。`src/shared/deliverables.ts:23`、`src/daemon/uploads.ts:71`。
- 实测（读代码）：发给 agent 的正文由 `deliveryParts` 拼前缀（比如 Worker 对话里的“【用户直接对你说】”）。`src/shared/worker.ts:313`。Slack 发言人署名从这里加，账本不另拼字符串。
- 实测（读代码）：hub 命令按角色放行只有一张表 `HUB_COMMAND_ROLES`，账本 `hubCall` 查它。`src/shared/hub.ts`。访客轮次的拦截挂在同一处。
- 实测（读代码）：只读 Worker 能读 `state/hub.sqlite`，禁读的是 `READONLY_SECRET_STATE_FILES` 里的文件。`src/shared/readonly-policy.ts:52`。所以 Slack 令牌不能进数据库，要放单独的 `state/slack-secrets.json` 并加进这张表。
- 实测（读代码）：后端按单用户设计，没有多账号。`docs/multi-device-design.md:9`。所以“访客”只是 Slack 这一层的身份，不进 Fusa 的账号体系。
- 实测（跑测试）：`pnpm exec vitest run src/daemon/store/store.test.ts test/migration.test.ts` 加上 0034 后迁移相关用例全过；`store.test.ts` 里“进程号被别的进程复用了”一条在本 worktree 的沙箱里失败，原因是沙箱禁止 `ps`（`operation not permitted: ps`），和本次改动无关。

### Slack 官方接口（2026-11-17 核实）

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| Socket Mode | 守护进程用应用级令牌（`xapp-`，`connections:write`）开 WebSocket，主动连出去，不要公网地址。每个信封带 `envelope_id`，必须回 ack；连接每隔几小时会收到 `disconnect`（`warning` 提前约 10 秒、`refresh_requested`），要重连。 | docs.slack.dev/apis/events-api/using-socket-mode |
| 应用级令牌轮换 | 2026-10 起可选开启，开了每 12 小时过期且关不掉。我们不开，清单里写 `token_rotation_enabled: false`。 | slack.dev/app-level-token-rotation-in-slack（2026-10-08） |
| 原生流式 | `chat.startStream`（Tier 2）/`appendStream`（Tier 4）/`stopStream`（Tier 2），只要 `chat:write`。在普通频道和单聊里必须是串里的回复（顶层只在 Slack Code 这类频道可以，否则 `invalid_thread_ts`），在频道里还必须给 `recipient_user_id` 和 `recipient_team_id`。一条最长 10 分钟，markdown 合计 12,000 字；第三方 2026-10 实测普通机器人不开 Agents 功能也能用，空闲 301 秒还在、311 秒失效。 | docs.slack.dev/reference/methods/chat.startStream、chat.appendStream、chat.stopStream；slack.green/en/blog/slack-chat-startstream（2026-10-03） |
| 改消息 | `chat.update` 是 Tier 3（每个工作区每分钟 50+ 次）。发消息每个频道约每秒一条。 | docs.slack.dev/reference/methods/chat.update；docs.slack.dev/apis/web-api/rate-limits |
| 富文本 | `markdown` 块直接吃标准 Markdown（项目经理的回复不用转格式），一个块 12,000 字，一条消息合计约 13,000 字。 | docs.slack.dev/reference/block-kit/blocks/markdown-block |
| 文件 | `files.upload` 已于 2025-11-12 下线，改用 `files.getUploadURLExternal` + 上传 + `files.completeUploadExternal`（都是 Tier 4，`files:write`），可以挂在串里（`thread_ts`）。官方 SDK 的 `uploadV2` 包好了这三步。 | docs.slack.dev/reference/methods/files.getUploadURLExternal、files.completeUploadExternal |
| 读历史的限流 | 2025-05 起对商店外分发的应用把 `conversations.history/replies` 降到每分钟 1 次；用户自己工作区里自建的应用（我们这种）不受影响。我们也不靠读历史，事件进来就处理。 | docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps |
| 私密频道 | `conversations.create` 带 `is_private: true`（`groups:write`）。频道名只能小写字母、数字、`-`、`_`，最长 80 字；第三方实测中文等其他文字也收。归档的频道仍占着名字。 | docs.slack.dev/reference/methods/conversations.create；slack.green/en/blog/slack-channel-name-rules（2026-10-07） |
| 官方 Node 包 | `@slack/web-api` 8.x（改用原生 fetch，自带 429 退避和 `chatStream` 流式助手）、`@slack/socket-mode` 3.x（3.2.0），Bolt for JS 5.0（Node 20+）。 | slack.dev/changelog-july-sept-2026；npmjs.com/package/@slack/socket-mode |
| 免费版 | 免费版只能看最近 90 天的消息，账本里的完整记录不受影响。 | 推断（Slack 计划说明，未逐字核对） |

## 做法比较

### 接哪一层

| 做法 | 改动面 | 和网页一致 | 结论 |
| --- | --- | --- | --- |
| A. 守护进程里加一层 Slack 通道：订阅 `Ledger.onChange` 往外投影，Slack 事件进来调账本原有接口（和推送提醒同一个模式） | 新目录 `src/daemon/slack/`；账本只加一个可选字段 `origin`、一个查询 `messagesAfter`、hub 拦截一处 | 账本是唯一真相，两边各自按变化刷新 | 推荐 |
| B. 起一个独立进程，当成网页客户端连 `/api/ws` 和 HTTP 接口 | 不碰守护进程 | 一致 | 多一个进程要守护；拿不到会话的流式预览以外的内部状态（比如访客轮次拦截要进账本），绕路 |
| C. 让项目经理自己用 Slack MCP 发消息 | 不写代码 | 不一致，账本里没有 | 不用：违反“账本唯一真相”，也守不住主客边界 |

### 用哪个官方包

| 做法 | 说明 | 结论 |
| --- | --- | --- |
| A. `@slack/web-api` 8.x + `@slack/socket-mode` 3.x | 官方 SDK 的两块：Web API 客户端（429 退避、`uploadV2`、`chatStream`）和 Socket Mode 客户端（ack、断线重连）。路由由我们自己按领域做 | 推荐 |
| B. `@slack/bolt` 5.x | 官方框架，内部就是 A 的两个包，再加一层监听器路由和中间件 | 我们的分流规则（主客、单人多人、绑定码）不按事件类型路由，Bolt 那层用不上，反而多一层要绕开的约定 |
| C. 自己写 `ws` + `fetch` | 已有 `ws` | 不用：ack、重连、429、三步上传都要手搓 |

外部包只在 `src/daemon/slack/sdk.ts` 里引，其余代码只认 `transport.ts` 的接口，测试用假的传输层。本步不装包；实现步骤 `pnpm add @slack/web-api @slack/socket-mode`，并在同一个 PR 更新 `AGENTS.md`「我们用的组件」。

### 谁能参与

| 做法 | 结论 |
| --- | --- |
| A. 直接用 Slack 私密频道的成员关系：拉进频道就能参与，移出就收回 | 推荐（用户已认可） |
| B. Fusa 里另做一份白名单 | 不做：重复造一套成员管理 |

### 关键流程

**五分钟接入。** ① 打开清单链接（`GET /api/slack/manifest` 或终端 `node src/slack/main.ts manifest`），Slack 的“从清单创建应用”页面已填好权限、事件、Socket Mode；② 装到工作区，复制机器人令牌（`xoxb-`）和应用级令牌（`xapp-`）；③ 交给守护进程（`PUT /api/slack/credentials`，或终端 `connect` 从标准输入读），验过权限才存；④ 拿绑定码（`bind`），在 Slack 里私聊机器人发它，发的人就是主人；⑤ 守护进程建好总助频道和每个项目经理的私密频道，把主人拉进去。

**频道对应。** 总助一个、每个项目经理一个私密频道，名字带设备名。对齐只看账本现状和 `slack_channels`，项目经理新建、改名、归档、取消归档时重算一遍（`planSlackChannelSync`），重复执行不多建。Worker 不建频道，按静默规矩只由项目经理转述。

**单人直聊和多人共聊。** 频道里除机器人外只有主人时是 solo，每句话直达；有别人时是 shared，只有 @机器人 或在机器人消息的串里接话才唤醒，其余聊天按频道记在内存里（最多 20 条、4,000 字、2 小时内），下一次唤醒时作为“频道里刚才的讨论”一起带给项目经理。模式由成员事件实时切换。

**发言人署名与主客边界。** 从 Slack 进来的用户消息在 meta 里记 `origin`（显示名、主人或访客、当时的模式、背景聊天），发给 agent 时由 `deliveryParts` 加署名（solo 下主人的话不加，和网页一样）。硬边界分三处：入口（`routing.ts`）挡住访客的总助频道发言、按钮、停止、附件、斜杠命令；账本 `hubCall` 在访客唤醒的轮次里拒绝 `SLACK_GUEST_BLOCKED_HUB_COMMANDS`；配合已上线的项目经理能力开关把私人连接器关掉。

**流式与急停。** 每个项目经理对话同一时间最多一条在流式的 Slack 消息，状态机见 `stream.ts`：顶层用 `chat.postMessage` + 节流 `chat.update`（每条 1.5 秒一刷，整个工作区每分钟最多 45 次，超了只合并）；串里用原生流式，失败一次就退回改消息。流式中的消息带“停止”按钮（调 `requestStop`），定稿时去掉。一段落库后流式那条改成最终正文，不另发。

**拍板卡。** 提问卡、检查点卡、提醒卡画成 Block Kit：选项按钮（推荐项第一、带星）、“补充说明”和“打回”打开弹窗写原因、提醒卡是 Done。点了走账本原有接口，账本推变化后 Slack 原消息改成“已定案”（谁、选了什么）。网页上答的卡也一样改。

**文件。** 项目经理发的文件和卡片的交付物用三步上传传成频道里的原生附件（截图直接看图），同一个文件只传一次；主人在 Slack 贴的文件下载存成附件随消息交给项目经理。

**网页和 Slack 一致。** 网页上发的用户消息镜像到频道（标明来自网页），网页发的总助指令和结果也镜像到总助频道；Slack 发的消息本来就在账本里，网页自然看得到。

**断线与补发。** 重连后：对一遍频道成员；按 `slack_channels` 的水位补发离线期间的消息，每个频道最多 20 条，更早的发一行“还有 N 条，去网页看”；把离线期间已经定案的卡改掉。Slack 挂了、令牌失效都不影响网页和 agent，只在状态里报。

## 性能

1. **失效。** 频道成员缓存靠 `member_joined_channel` / `member_left_channel` 实时改，连上和重连时整份标过期，另外每 `SLACK_MEMBERS_TTL_MS` 对一遍；查失败只记 `SLACK_MEMBERS_RETRY_MS`，期间按 shared 处理（宁可少唤醒）。显示名缓存 `SLACK_USER_CACHE_TTL_MS`，失败只记 `SLACK_USER_CACHE_RETRY_MS`。频道归档、断开、换工作区时对应缓存和背景聊天清掉。绑定码 `SLACK_BIND_CODE_TTL_MS` 后失效，用一次作废。
2. **上限。** 内存里按频道记的东西（背景聊天、成员）都用已有的 `lru-cache` 管，最多 `SLACK_CHANNEL_CACHE_MAX` 个频道；频道数等于项目经理数加一，不随 Worker 和消息变多。`slack_posts` 每条发出去的东西一行，按一个月 3 万条消息算最多约 3 万行（Worker 对话不投影，实际少得多），已定稿的 `SLACK_POST_RETENTION_DAYS` 天后由现有的保留清理删掉，等拍板的卡不删。进出队列各有上限。接口响应 `SlackStatusView` 只列频道，几十行，不压缩也很小。
3. **前端引用稳定。** 这一步没有前端。`GET /api/slack` 在没有变化时返回内容相同的对象，以后设置页按它的 `channels` 数组做 `WeakMap` 缓存。
4. **验证。** 实现步骤用 pstack 的 `benchmark-checklist` 量：单条回复从项目经理写出第一段到 Slack 出现文字的延迟、一段 5,000 字回复期间 `chat.update` 次数、三个项目经理同时回复时是否撞 429、开 Slack 前后守护进程 RSS；`blast-radius` 列出 `PostUserMessageInput`、`UserMessageMeta`、`deliveryParts`、`hubCall` 的调用方。数字写进 PR。

| 常量（`src/shared/limits.ts`） | 值 | 怎么算的 |
| --- | --- | --- |
| `SLACK_MESSAGE_MAX_CHARS` | 11,000 | markdown 块一条消息合计 12,000 字，留按钮和署名的余量 |
| `SLACK_STREAM_UPDATE_INTERVAL_MS` | 1,500 | 一条消息每分钟约 40 次刷新，单个项目经理回复不超 Tier 3 |
| `SLACK_UPDATE_BUDGET_PER_MINUTE` | 45 | `chat.update` Tier 3 每个工作区每分钟 50+ 次，留余量 |
| `SLACK_NATIVE_STREAM_APPEND_INTERVAL_MS` | 500 | `appendStream` Tier 4 每分钟 100+ 次 |
| `SLACK_NATIVE_STREAM_MAX_MS` | 480,000 | 10 分钟强制结束前收尾 |
| `SLACK_NATIVE_STREAM_IDLE_MAX_MS` | 240,000 | 实测空闲约 5 分钟失效 |
| `SLACK_CONTEXT_WINDOW_MESSAGES` / `_CHARS` / `_MAX_AGE_MS` | 20 / 4,000 / 2 小时 | 一次唤醒带的背景不超过一屏，也不把几小时前的闲聊塞给 agent |
| `SLACK_CHANNEL_CACHE_MAX` | 200 | 频道数 = 项目经理数 + 1，本机现在不到 20 个项目经理，留十倍 |
| `SLACK_MEMBERS_TTL_MS` / `_RETRY_MS` | 10 分钟 / 30 秒 | 事件实时更新为主，定期对账兜住漏掉的事件 |
| `SLACK_CHANNEL_MEMBERS_MAX` | 1,000 | 私人工作区的项目频道不会超过几十人 |
| `SLACK_USER_CACHE_MAX` / `_TTL_MS` / `_RETRY_MS` | 500 / 1 小时 / 30 秒 | 私人工作区的人数 |
| `SLACK_DISPLAY_NAME_MAX_CHARS` | 40 | 署名一行放得下 |
| `SLACK_POST_RETENTION_DAYS` | 30 | 和 Worker 保留期同量级；一个月后不会再有人去改那条 Slack 消息 |
| `SLACK_CATCHUP_MAX_MESSAGES` | 20 | 离线一夜回来不刷屏 |
| `SLACK_BIND_CODE_TTL_MS` | 10 分钟 | 够人切到 Slack 里发 |
| `SLACK_INBOUND_QUEUE_MAX` / `SLACK_OUTBOUND_QUEUE_MAX` | 200 / 500 | 一个工作区的正常事件量远低于此，满了先丢背景聊天、合并流式刷新 |
| `SLACK_SECRETS_FILE_MODE` | 0o600 | 和 `state/ui-token` 一样 |

## 统一

- **厂商。** Slack 通道在账本之上，只看消息、会话状态和卡片，不看是哪家 agent；`src/shared/vendors.ts` 里的所有厂商都一样走。以后加一家新厂商，Slack 这一层不用改任何文件。
- **三个平台。** 只有出站 HTTPS 和 WSS，macOS、Windows、Linux 一样，`src/daemon/platform/index.ts` 不用改。令牌文件的保护沿用 `READONLY_SECRET_STATE_FILES`（各平台的只读策略已按这张表禁读，Windows 走 ACL），实现步骤把 `slack-secrets.json` 加进去即可。
- **一处定义。** 权限和事件只在 `src/daemon/slack/manifest.ts`；访客禁用的 hub 命令只在 `SLACK_GUEST_BLOCKED_HUB_COMMANDS`（`src/shared/slack.ts`）；可调的数只在 `src/shared/limits.ts`；外部包只在 `src/daemon/slack/sdk.ts`。
- **两个入口一份逻辑。** 界面服务的 `/api/slack/*` 和终端命令 `src/slack/cli.ts`（经 `run/admin.sock`）都只调 `SlackSetupService`。

## 删掉什么

无。Slack 是新加的通道，网页、推送提醒照旧，没有被取代的旧代码和说法。等用户在手机上改用 Slack 一段时间后，再决定要不要收掉手机 PWA 的推送提醒，那是另一件事。

## 骨架文件

- `migrations/0034_slack.sql`：`slack_workspace`（工作区、机器人、主人）、`slack_channels`（频道对应、补发水位）、`slack_posts`（账本里的东西发到了哪条 Slack 消息）。
- `src/shared/slack.ts`：品牌化的 Slack 编号和解析函数、主客身份、频道模式、频道对应、消息来源 `SlackMessageOrigin`、署名 `slackDeliveryPrefixes`、访客禁用的 hub 命令和 `slackGuestTurnBlockReason`、设置接口的形状。
- `src/shared/attachments.ts`：`UserMessageMeta.origin`。
- `src/shared/ledger.ts`：`PostUserMessageInput.origin`。
- `src/shared/api.ts`：`API_PATHS.slack*` 六个接口。
- `src/shared/limits.ts`：上表的常量。
- `src/shared/paths.ts`：`HubPaths.slackSecretsFile`。
- `src/shared/index.ts`：导出 `slack.ts`。
- `src/daemon/slack/transport.ts`：外部边界：用到的 Web API 方法、原始信封、`SlackTransport` 接口、`SlackAuthError`。
- `src/daemon/slack/sdk.ts`：用官方包实现 `SlackTransport`。
- `src/daemon/slack/manifest.ts`：权限、事件、清单和一键创建网址。
- `src/daemon/slack/inbound.ts`：原始信封解析成领域事件，丢掉机器人、编辑、别的工作区。
- `src/daemon/slack/routing.ts`：消息和点击的分流、主客判断、背景聊天窗口。
- `src/daemon/slack/directory.ts`：频道成员和显示名缓存、单人多人模式。
- `src/daemon/slack/channels.ts`：频道应有的样子、频道名规整、对齐计划。
- `src/daemon/slack/outbound.ts`：账本变化投影成出站意图、补发、长文拆段。
- `src/daemon/slack/stream.ts`：流式状态机和 `chat.update` 预算。
- `src/daemon/slack/cards.ts`：卡片编号、按钮值编解码、卡片和停止按钮的块。
- `src/daemon/slack/files.ts`：文件上传和下载。
- `src/daemon/slack/store.ts`：三张表的读写。
- `src/daemon/slack/secrets.ts`：令牌文件。
- `src/daemon/slack/setup.ts`：设置服务（状态、清单、令牌、绑定码、对齐、断开）。
- `src/daemon/slack/service.ts`：通道本身：接账本和传输层，`SlackLedgerPort` 写明用到的账本接口（含要新加的 `messagesAfter`）。
- `src/slack/cli.ts`：终端命令。
- 测试骨架：上面每个文件旁边的 `*.test.ts`，以及 `src/daemon/ledger/slack-origin.test.ts`（账本这一侧的接线）。

接线留给实现步骤：`daemon.ts` 在推送服务旁边建 `createSlackService` 并在关机时 `close`；界面服务加 `/api/slack/*` 六个路由（zod 校验，经设备令牌访问回 `forbidden_peer`）；`run/admin.sock` 加 `/slack/*` 路由并新增 `src/slack/main.ts`；`postUserMessage` 写 `meta.origin`；`deliveryParts` 调 `slackDeliveryPrefixes`；`hubCall` 查正在处理的那条消息的 `origin` 调 `slackGuestTurnBlockReason`；`Ledger` 加 `messagesAfter`；`READONLY_SECRET_STATE_FILES` 加 `slack-secrets.json`；`db-retention.ts` 调 `prunePosts`。

## 验收方法

- **单元测试。** 上面每个 `it.todo` 改成真断言后全绿，重点：`routeSlackMessage` 的单人多人切换和主客拦截、`stepSlackStream` 的“定稿正文等于账本这段文字、不另发”、`planSlackChannelSync` 的幂等、`slackGuestTurnBlockReason` 覆盖每个禁用命令。`service.test.ts` 用假传输层和真账本跑通整条链。
- **真机，私人工作区，手机 Slack 客户端。** 证据是手机截图（放 `docs/screenshots/slack/`）和守护进程日志片段，贴进 PR：
  1. 从清单链接建应用到频道出现，计时，五分钟以内（录屏 mp4）。
  2. solo：在项目经理频道说一句，回复边写边出现，点“停止”能停；网页上同一个对话同时出现这两条。
  3. shared：拉一个测试账号进频道，它不 @ 说的话项目经理不回；@机器人 后项目经理的回复里引用了刚才的讨论；驱动日志里写给 agent 的正文带“【Slack · 名字（访客）】”。
  4. 访客点拍板按钮只看到“只有主人能拍板”；访客让项目经理挂载 `~/Documents`，`hub project attach` 返回 forbidden（日志）；访客在总助频道说话被拒。
  5. 拍板卡：Slack 点选项后网页卡片同时变已回答；网页回答另一张，Slack 原消息变“已定案”、按钮消失。
  6. 交付：项目经理发一张截图和一份 Markdown，Slack 里是原生图片和文件附件。
  7. 断线：`kill -STOP` 守护进程 2 分钟期间在网页发消息、答卡，恢复后 Slack 补上这些消息、卡片改成已定案；重复恢复不重复发。
  8. 项目经理改名、归档、取消归档，频道跟着改；重复触发不多建频道（`slack_channels` 行数不变）。
- **令牌安全。** `GET /api/slack` 和 `status` 的输出里搜不到 `xoxb-` / `xapp-`；只读 Worker 里 `cat state/slack-secrets.json` 被拒（命令和输出贴进 PR）。
- **限流。** 三个项目经理同时长回复 5 分钟，日志里没有 429 之后丢字（`chat.update` 次数和 429 次数写进 PR）。
