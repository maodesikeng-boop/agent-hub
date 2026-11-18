# 总助转交后在总助里看到项目经理的回复

## 给用户看

要验收的文件：

- [对话示意](screenshots/router-forward-reply/mock.png)：总助时间流里三种情况的示意图（手画的，不是真截图）。第一问项目经理答完了，回复接在原问题下面；第二问那一轮被打断，只显示 `Stopped`；第三问转给配对设备上的项目经理，还在处理，显示 `Working…`。点项目经理的头像和名字进它的对话。
- 本文：方案。真界面的录屏和截图在实现步骤交。

要你拍板的事：

1. **回复放在哪。**
   - A（推荐）：接在原问题那一回合下面，和问题、去向行在一起。问哪句答哪句一眼看得出，翻历史也在原处。代价是你连着问了几句、前面那句后答完时，回复出现在上面，不在最底下。
   - B：按回复到达的时间排到时间流最底下，开头引用原问题。新回复总在眼前，但问答分开，翻历史要对着引用找，时间流的分页也要多处理一种条目。

   你平时多是一问一等，A 的代价很少碰到，所以推荐 A。

## 用户目标

> 从总助转过来的消息也要从总助看到回复

> 我的意思是这应该做成fusa的基本功能

你在总助里问的话，总助转给项目经理之后，你留在总助里就能看到项目经理这一轮的正式回复，知道是谁答的，能点进项目经理的对话。转给本机和配对设备上的项目经理都一样，自动路由和 `@` 指定目标都一样。只显示和这次转交有关的那一轮回复，项目经理别的对话、工具调用过程、Worker 的日志不进总助。这是 Fusa 默认就有的功能，不靠提示词让项目经理每次手工发汇报卡。

## 现状

- 实测（读代码）：总助转给项目经理（`pm.forward`）就是在项目经理对话里发一条普通的用户消息，拿回这条消息的编号。本机：`src/daemon/router/target-port.ts:325`；配对设备：同一个操作经 `POST /api/router/target-ops` 发到那台设备执行，回来的是那台设备上的消息编号，`src/daemon/router/target-port.ts:725`。
- 实测（读代码）：投递记录（`router_commands.dispatched_json`）里每个去向记着设备编号、项目经理、对话编号和消息编号，`src/daemon/router/dispatcher.ts:289`、`src/shared/router.ts:146`。总助指令只存在发起的那台设备上，经配对访问时是空的，`src/shared/router.ts:200`。
- 实测（读代码）：网页把去向画成一行可点的跳转，消息编号在 `buildDestinations` 里被丢掉了，`src/web/router-stream.ts:153`；轨道 A 转交成功后连模板回执都不画，`src/web/components/RouterStream.tsx:216`。所以现在总助里只看得到“转给了谁”，看不到回复。
- 实测（读代码）：一轮结束时驱动层的 `turn.ended` 带着这一轮处理的用户消息编号，账本据此把它们标成 `replied`、`stopped` 或 `failed`，`src/daemon/ledger/messages.ts:384`。agent 写的文字一段一行（`sender = 'agent'`、`kind = 'text'`），行上不记属于哪一轮，也不记是不是子代理说的，`src/daemon/ledger/messages.ts:123`、`src/daemon/ledger/messages.ts:352`。
- 实测（读代码）：Worker 汇报已经有“这一轮从开始起最后一段文字”的取法（记下这一轮开始时的最大消息编号），`src/daemon/ledger/workers.ts:1453`。
- 实测（读代码）：网页每台设备一个 `DeviceHub`，拉快照再按 seq 收推送，断线重连各补各的，`src/web/device-hub.ts:46`。快照里每个对话只带最近 `SNAPSHOT_RECENT_MESSAGES`（20）条，`src/shared/limits.ts:9`；网页对话里最多留 `MAX_LIVE_MESSAGES`（200）条，之后推来的消息比近窗最早一条还早时不插进近窗，只给 `ConversationView.outsideRev` 加一（`src/web/state.ts` 的 `applyChange`），所以消息滑出近窗后它的状态变化只能靠补取看到，见下面归属和去重的规则。入口把 `/d/<设备>/api/*` 原样转给配对设备，`src/daemon/peers/proxy.ts:1`。
- 实测（只读查本机账本 `sqlite3 "file:$HOME/.agent-hub/state/hub.sqlite?mode=ro"`）：总助第 11 条指令「飞书接入做到哪里了」转给 PM #9，对话 205，消息 #76089。这条消息的状态是 `stopped`：项目经理只说了一句“我查一下飞书任务图和 PR……”（#76090），你 31 秒后发的 #76102「我只是测试一下总助……」把那一轮打断了，之后几轮答的都是别的问题。也就是说，这次真实复现里项目经理并没有给出正式回复。按“转交之后项目经理说的最后一段话”去猜，会把 #76090 的半句话或别的问题的答案当成回复。
- 实测（`git diff main...origin/hub/708-…`）：飞书图 #35 的 PR #350 还没合，占了迁移 `0034_feishu.sql`，改了 `messages.ts`（发用户消息时记飞书来源、`messagesAfter`）、`attachments.ts`（`UserMessageMeta.origin`）、`shared/ledger.ts`、`ledger.ts`、`server.ts`、`api.ts`、`limits.ts`、`index.ts`、`fake-ledger.ts`。飞书总助单聊会镜像网页发的总助指令和结果（`docs/feishu-design.md:162`，在那个分支上）。`main` 上迁移到 `0033`。
- 推断：本机现在没有配对设备（`state/peers.json` 是空的），配对路径要用测试里的两台回环守护进程验证（`test/e2e/loopback-daemon.ts`）。

## 做法比较

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| A. 项目经理那台设备在一轮结束时把正式回复的编号记在原消息上（`meta.replyId`），总助网页按投递记录里的消息编号找原消息、再找回复，用项目经理对话里同一个组件画 | 归属由账本在同一个事务里定，不靠猜；本机和配对设备走同一条路（网页本来就连着每台设备）；不加表、不加迁移、不加设备之间的新协议；回复、文件链接和项目经理对话里一模一样 | 配对设备离线时总助里看不到那边的回复（去向行还在），上线后自动补上；老版本的配对设备不记 `replyId`，只显示去向行 |
| B. 发起设备的总助账本存一份回复副本（新表，配对设备回推或发起设备轮询） | 回复跟着指令存，翻历史不用再问目标设备；飞书单聊也能直接用 | 要新表和迁移，还要新做设备之间的回推或轮询，是一套平行的回复系统；回复存两份，改名、清理、文件链接都要同步 |
| C. 网页按时间猜：转交消息之后项目经理说的最后一段话 | 只改网页 | 真实复现里就会猜错（见上面 #76089）；批量入队、中途插话、下一轮的回复都会串进来 |
| D. 提示词让项目经理每次 `hub router report` | 不改代码 | 用户明确不要；靠模型记得做，会漏、会重复，也不知道对应哪一问 |

推荐 A。它只在已有的消息上多记一个编号，复用已有的推送、配对转发和消息组件；B 的好处（飞书单聊、离线看历史）现在用不上，等飞书要在总助单聊里显示转交回复时再按 A 的 `turnReplyOf` 去取。

**归属和去重的规则**（写在 `src/shared/turn-reply.ts` 顶部，实现照它）：

- 正式回复 = 处理这条消息的那一轮里，这条消息送达之后写下的最后一段顶层 agent 文字。工具调用、子代理的文字、写交接那一轮的文字、提问卡都不算。
- 只在这条消息变成 `replied` 的那个事务里写一次 `replyId`，之后不改。被停止、取消、失败的不写；下一条消息那一轮的回复不会挂到上一条上。
- 一轮同时处理了几条用户消息（排队后一起送达，或中途插话）：这几条的 `replyId` 是同一条回复，总助里各自的回合下面显示同一段。
- 一次转给几个项目经理：每个去向一个消息编号，各接各的回复，顺序同去向行。
- 本机和配对设备上编号相同的消息互不串：网页按“设备键 + 消息编号”找。
- 重复推送：`message.updated` 按消息编号覆盖，同一个 `turn.ended` 重放不重复写。断线重连：那台设备重拉快照，近窗里有就用近窗，没有就补取。消息滑出近窗后状态变化不会再经 `upsertMessage` 进近窗（`state.ts` 丢掉比近窗最早一条还早的 `message.updated`），所以补取到的在途结果在三种情况下作废重取：重新连上、重拉了快照（`HubState.snapshotRev` 加一，连接不断线只收到 `resync` 时也一样）、那台设备丢掉了这条消息所在对话的近窗外更新（`ConversationView.outsideRev` 加一）。目标设备的首份快照到了（`phase` 是 `ready`）才补取，加载期、拉取失败时不发请求。
- 只认投递记录里的消息编号，项目经理对话里你直接说的话、它的其他轮次都不会出现在总助里。

## 性能

1. **失效。** `replyId` 写在消息上，消息被清理时跟着没了，补取回 `reply: null`。网页以近窗为准，近窗的变化靠那台设备的推送；补取的结果按“设备键 + 消息编号”缓存在 react-query 里：已经定了（有回复、已停止、已失败）的不再取；在途的在重新连上、重拉快照（`snapshotRev`）、近窗外更新到达（`outsideRev`）时作废重取；404（老版本设备、消息已清理）只记 `ROUTER_FORWARD_REPLY_MISS_RETRY_MS`。
2. **上限。** 守护进程内存里每个在跑的项目经理会话一条（这一轮最后一段顶层文字的编号）加在途消息的送达水位，这一轮结束、会话退出就清掉，最多是在跑的会话数乘在途消息数。补取接口一次只回两条消息，大的走 `@fastify/compress`。网页的补取缓存只给时间流里画出来的转交回合建，回合数受 `ROUTER_STREAM_LIVE_MAX` 和翻页上限 `ROUTER_STREAM_MAX_PAGES` 管，卸载后按 react-query 默认的回收时间清掉。快照不加字段，每条项目经理对话里的用户消息 meta 多十几个字节。

   | 常量（`src/shared/limits.ts`） | 值 | 怎么定的 |
   | --- | --- | --- |
   | `ROUTER_FORWARD_REPLY_MISS_RETRY_MS` | 60_000 | 补取 404 或失败只短暂记：配对设备升级、重连后一分钟内能补上，又不会在一屏十几个回合上反复打请求 |

3. **前端引用稳定。** `forwardReplyOf` 按对话的 messages 数组用 `WeakMap` 缓存，`turnReplyStateOf` 按原消息和回复对象缓存；对话里来了无关的新消息，已定的状态对象不变。回复由单独的 `ForwardReply` 组件订阅那台设备的仓库，项目经理流式打字时 `TurnRow` 和指令回合的缓存（`turnEntryOfCommand`）不重算。
4. **验证。** 实现步骤用 pstack 的 `benchmark-checklist` 量：快照大小（改前改后，`snapshot-size.test.ts` 的规模），项目经理流式输出 30 秒内总助页 `TurnRow` 的重画次数（改前改后应都只有在途那一回合），`turn.ended` 事务的耗时（多一次按主键的 UPDATE）。用 `blast-radius` 列出 `applyDriverEvent` 的调用面。数字写进 PR。

## 统一

- 厂商：只用驱动层的标准事件（`message.delivered`、`message.processing`、`turn.started`、`agent.text` 带不带 `parentToolUseId`、`turn.ended`），`src/shared/vendors.ts` 里所有厂商的驱动都发这些，账本一处写。以后加一家新厂商，驱动照常发这些事件就行，这块一行不改。
- 平台：不碰进程、文件和路径，macOS、Windows、Linux 一样，`src/daemon/platform/index.ts` 不涉及。
- 本机和配对设备：同一套代码，区别只在网页拿哪台设备的仓库和接口（`DeviceHub` 和 `HubClient`）。

## 删掉什么

- `pm.forward` 的 `sourceCommandId`：本机执行时不读，发往配对设备时又剥掉，没人用（`src/daemon/router/dispatcher.ts:613`、`src/daemon/router/dispatcher.ts:1255`、`src/daemon/router/target-port.ts:101`、`src/daemon/router/target-port.ts:785`）。关联改成投递记录里的消息编号，这个字段一起删。`worker.start` 的同名字段在用（`target-port.ts:383`），不动。
- 提示词：现在没有让项目经理手工回报转交结果的提示词，不用删。上线后项目经理不再需要为转交的问题手工发汇报卡（像这次的 #96）。

## 骨架文件

- `src/shared/turn-reply.ts`：归属规则、补取接口的回包形状、读 `replyId` 和算显示状态的两个函数。
- `src/shared/turn-reply.test.ts`：上面两个函数的行为。
- `src/shared/attachments.ts`：`UserMessageMeta` 加 `replyId`。
- `src/shared/api.ts`：`API_PATHS.messageTurnReply`。
- `src/daemon/ledger/turn-replies.ts`：一轮结束时写 `replyId`，按编号取原消息和回复。
- `src/daemon/ledger/turn-replies.test.ts`：归属、去重、批量、打断、重放的行为。
- `src/web/client.ts`：`fetchTurnReply`。
- `src/web/router-stream.ts`：去向多一个 `forwardMessageId`（转交的消息编号，别的去向是 null）。
- `src/web/forward-reply.ts`：近窗选择器和补取钩子。
- `src/web/forward-reply.test.ts`：近窗、补取、重连、离线、相近问答不串。
- `src/web/components/ForwardReply.tsx`：画一条转交的回复。
- `src/web/components/ForwardReply.test.tsx`：各状态怎么画。
- `docs/ui-standard.md` 第 21 条：加“转交回复”。

骨架没碰飞书 PR #350 改的那几处（`attachments.ts` 和 `api.ts` 的改动和它不在同一段，`git merge-tree` 试合没有新冲突）。下面这些接线留给实现步骤，等 #350 合入后从最新 `main` 开分支再接，和 #350 的改动都不在同一段：

- `src/daemon/ledger/ledger.ts`：建 `createLedgerTurnReplies`，在 `applyDriverEvent` 里 `messages.applyEvent` 之后调它的 `afterDriverEvent`；导出 `turnReplyOf`。
- `src/shared/ledger.ts` 的 `Ledger` 接口、`src/daemon/ui-server/fake-ledger.ts`：加 `turnReplyOf`。
- `src/daemon/ui-server/server.ts`：在重试消息的路由旁边加 `GET /api/messages/:id/turn-reply`。
- `src/web/components/RouterStream.tsx` 的 `TurnRow`：每个 `forwardMessageId` 不是 null 的去向，在去向行和总助正文之后接一个 `ForwardReply`；`RouterWorkbench.tsx` 传按设备键找仓库的办法（`DevicesStore` 里每台的 `DeviceHub.store`）。
- `src/shared/limits.ts`：`ROUTER_FORWARD_REPLY_MISS_RETRY_MS`。
- 删掉上一节列的 `sourceCommandId`。

飞书图 #35 的边界：本方案不改飞书的文件和迁移，不用迁移编号。共用的只有账本的 `turnReplyOf`、消息上的 `replyId` 和已有的 `message.updated` 推送。飞书总助单聊要不要也显示转交回复，是 #35 以后的事；本机项目经理可以直接用 `turnReplyOf`，配对设备上的要另想办法（飞书在守护进程里，没有网页的多设备连接）。

## 验收方法

- 单元测试（实现步骤把 `it.todo` 改成真断言）：`src/daemon/ledger/turn-replies.test.ts` 用真库和假驱动事件跑归属、批量、打断、重放；`src/shared/turn-reply.test.ts`；`src/web/forward-reply.test.ts`；`src/web/components/ForwardReply.test.tsx`；`src/web/router-workbench.test.tsx` 加一条：同一个项目经理先后收到两条相近的转交（「飞书接入做到哪里了」「飞书接入的 PR 合了吗」），各自回合下只出现自己那一轮的回复。
- 配对路径：`test/e2e/multi-device.test.ts` 加一条：两台回环守护进程配对，第一台的总助用 `@` 指定第二台的项目经理发两条相近的问题，假 claude 各答一句；断言第一台网页拿到的两个 `TurnReplyView` 各是自己那一句，第二台掉线时补取失败、上线后补齐。
- 真界面：本机守护进程加网页，在总助里分别用自动路由和 `@agent-hub` 问一句，录从发问到项目经理回复出现在总助里的 mp4，另截一张两条相近问答各自对上的图；配对路径用 `test/fake-devices/main.ts --devices two` 加上转交和回复的假数据截一张。证据放进实现 PR 和汇报的“文件”栏。
- 复现回归：用 #76089 那段（转交后说一句“我查一下”就被下一条消息打断）做一条测试，总助里显示 `Stopped`，不出现 #76090 或下一轮的内容。

## 实现备注

- 一轮中途插进来的消息（`message.delivered` 带 `midTurn`）以 agent 取走它的那一刻（`message.processing`）为界：送达到取走之间 agent 还在答前面的话，那几段不算它的回复。开一轮的消息、批量一起送达的以送达为界。重复的 `delivered`、`processing` 不改已记的界。
- `turn.ended` 里状态变成 `replied` 和写 `replyId` 在同一个事务里，只推一条带 `replyId` 的 `message.updated`（把同事务里状态变化那一条换掉），网页不会先看到 `replied`、再等一条才有回复。
- 补取结果 `ok` / `missing`（404）/ `failed`（其他错误）三种都存在 react-query 里，不抛错：已定的永不过期，处理中的每次挂载重取，`missing` 和 `failed` 记 `ROUTER_FORWARD_REPLY_MISS_RETRY_MS`；那台设备连接从断开变回 open 时，没定的结果作废重取。
- `hub(key)` 找不到设备时会退回本机，所以网页里按设备键找仓库用 `shell-model.ts` 的 `storeForDevice`：键对不上就是 null，不拿本机的同号消息顶替。

