# 接入飞书：扫码建应用、自动建水果头像项目群、可设访客权限、卡片流式回复

## 给用户看

### 要验收的文件

- 本文：守护进程这一侧怎么接飞书（扫码接入、总助单聊、自动建项目群、唤醒规则、访客权限三档、流式回复与急停、拍板卡、文件、断线补发）。网页上的飞书设置页（二维码、每个群的档位开关）等界面重设计时另起一步，本文只留好接口。
- 代码骨架：`src/shared/feishu.ts`、`src/daemon/feishu/`、`src/feishu/cli.ts`、`migrations/0034_feishu.sql`，函数体留给实现步骤。

### 已经定下的

- 只装一个飞书自建应用。手机飞书扫一下二维码就建好应用，扫码的人自动成为主人，不用复制 App ID 和 App Secret；手动填 App ID、App Secret 留作兜底。
- 不用话题、不用回复串。所有回复、拍板卡、截图、文件都直接发在聊天主界面里；回复用飞书卡片边写边出字（打字机效果），旁边有“停止”按钮。
- 总助就是你和机器人的单聊。每个项目经理自动建一个私有群：群名是项目经理名字，群头像是它在网页上的那只水果史莱姆小动物，你是群主。项目经理新建、改名时群跟着变，你不用手动拉群。
- 唤醒规则（11-18 拍板）：群里只有你时每句话直达项目经理；拉进别人后自动改成 @机器人 才触发，没 @ 的讨论记下来，下次 @ 时一起交给项目经理。每个群也可以手动设成“一直要 @机器人”。
- 访客权限按群设，三档，默认“仅对话”：
  - 仅对话：访客 @机器人 能和项目经理说话；拍板、停止、发附件只认你。
  - 协作者：再放开拍板、停止、发附件。
  - 只读：访客说话不唤醒项目经理，只记下来，你下次 @机器人 时一起交给项目经理。
  
  不管哪一档，访客的话触发的那一轮里，项目经理新建项目、挂载或移除电脑上的文件夹、改准备命令、改性格设定都会被账本拒绝。总助单聊和全局设置只认你。第一个访客进群时，群里会发一张“访客权限”卡，你点一下就能换档。
- 设置卡（项目群设置卡与总助单聊设置卡）：
  - 项目群设置卡拆成三个模块（用分割线隔开）：① 模型与思考程度（JSON 2.0 `select_static` 下拉选厂商、模型、思考程度，走 `editPersona` 零交接切厂商或改模型，模型固定档位时不画无效下拉并写明原因）；② 唤醒方式（自动或仅 `@` 唤醒，独立按钮组高亮当前项）；③ 群成员权限（协作者、仅对话、只读三档说明与独立按钮组高亮当前项）。
  - 总助单聊设置卡：支持 `Auto` 或指定 `厂商 + 模型 + 思考程度`，走 `updateRouterSettings`，与网页 `RouterModelPicker` 双向同步。
  - 免爬楼呼出（不碰自然语言）：只认整句斜杠命令 `/群设置`、`/设置`、`/policy`、`/model`、`/settings`；不带斜杠的“设置”“模型”原样进账本。第一个访客进群时发第一张群设置卡；访客因档位被拒（发文件、点拍板或停止）时按 `FEISHU_POLICY_CARD_COOLDOWN_MS`（5 分钟）冷却在群底附一张新卡；每次发新设置卡尝试置顶（`pin.create`）并取消上一张设置卡的置顶（`pin.delete`），缺权限只记日志。所有设置卡回调只认 `ownerOpenId`。
- Mac 和东京服务器都要接时，每台各扫一次码、各建一个应用（应用名带设备名，比如“Fusa · 东京”）。飞书的长连接是“同一个应用多台连上时随机分给一台”，两台共用一个应用会互相抢消息，所以必须一台一个。

- 你 11-18 打回时选了三个 B：
  - 项目经理归档时解散它的群（飞书里清爽，群聊天记录跟着没了，账本里还有）。取消归档时自动新建一个群，之前设的唤醒方式和访客档位照旧。项目经理删掉时也解散群。
  - 总助单聊里的拍板项也带选项按钮，和项目群里那张卡是同一张：在哪边点都行，点了两边同时变成已定案，后点的那边会提示“已经定过了”。
  - “只读”档访客说的话记下来，你下次 @机器人 时一起交给项目经理。

### 要你拍板的事

无。

## 用户目标

> 2026-11-17 14:49 用户：「如果把fusa做到手机的一个原有的app里面而不是我们自建的，自建一个app太麻烦了，我们这个是网页，还是比较卡的
> 可以做到一个聊天app里面吗」
>
> 2026-11-17 15:03 用户：「各自用各自的工作区。 他去下载我们打好的 Mac 或 Windows 安装包，装在他自己电脑上，连他自己的机器人，五分钟就能跑起来，两边彻底隔离，这是我的首选判断。
> 这是ok的
>
> 但是也支持我把他拉到我的私人工作区对话」
>
> 2026-11-17 18:40 用户：「一个串是什么？就是那一个一个reply吗，要点进去才能看到？像这个图一样？一个thread这样的话我不喜欢，我觉得它就在左边发言就行，不要这个reply，我们也不能在thread里面回复他
> 并且这个它是什么，它是slack里面的agent，那我们有多少项目经理就得有多少的agent的吧，再加上一个总助，就像一个一个的应用？还是吧这些人都放到一个channel里面？
> 我希望这些玩意，比如我的pm就直接在手机上，像一个联系人，我可以dm他，那这样我们是不是要新建好多应用，这能支持吗？」
>
> 2026-11-18 用户：「我觉得先做飞书吧，飞书也有类似slack的个人企业，很简单直接就新建一个账号，我们这个可以做成一个应用吗？
> 大致和slack的感觉也差不多，然后访客权限的话是可以设置的
> 不是说就一直限制？
> 那是不是每个项目还得拉一个群聊啊
> 还是要@机器人才会工作比较好」
>
> 2026-11-18 用户拍板定案：「先做飞书：单人群直聊，拉人进群后自动切 @机器人 才触发」

用户在手机上用原生飞书代替 Fusa 网页做日常高频的事：和总助、各项目经理说话（边写边出字的回复）、随时停、点拍板卡、看交付的截图和文件。接入要像扫码登录一样简单，项目群自动建好、长得像联系人列表（每个项目经理一个带水果头像的群）。用户能把别人拉进某个项目群一起聊，别人能做什么按群可调。每个人各装各的 Fusa、各建各的应用，默认彻底隔离。守护进程在本机或远端服务器上都行，主动连出去，不要公网地址，国内手机网络直连。

## 现状

### 代码

- 实测（读代码）：网页发消息走 `Ledger.postUserMessage`，同一个对话里同一个 `clientId` 只存一条，存完登记 `session.send` 动作。`src/daemon/ledger/messages.ts:452`、`src/shared/ledger.ts:114`。飞书消息用 `feishu:<message_id>` 当 `clientId`，飞书重推天然幂等（飞书文档也要求按 `message_id` 去重）。
- 实测（读代码）：停止走 `Ledger.requestStop(conversationId)`。`src/daemon/ledger/messages.ts:561`。
- 实测（读代码）：回答拍板卡按 `clientId` 幂等，同一个 `clientId` 再来返回已有结果，不同的回 `conflict`（“这张拍板卡已经被处理过了”）。`src/daemon/ledger/router.ts:556`。飞书点击重推、网页和飞书同时点，账本都给出唯一结果。
- 实测（读代码）：流式预览不落库，放在 `session.status` 的 `SessionState.streamingText` 里，最长 16,000 字，超长时只保留前缀；一段写完才落成一条 `message.created`。`src/shared/domain.ts:1009`、`src/shared/limits.ts:54`。保留前缀正好符合飞书“新文本以旧文本为前缀才走打字机”的要求。
- 实测（读代码）：账本所有变化经 `Ledger.onChange` 推出，推送提醒服务就是这样订阅账本的旁路。`src/shared/ledger.ts:404`、`src/daemon/daemon.ts:763`。飞书通道照同一个模式接，账本、驱动、任务图不用改流程。
- 实测（读代码）：总助是指令：`RouterDispatcher.submitCommand` 收一句话，回 `RouterCommandRecord`。`src/daemon/router/dispatcher.ts:97`。
- 实测（读代码）：发给 agent 的正文由 `deliveryParts` 拼前缀。`src/shared/worker.ts:313`。飞书的署名和背景从这里加，账本不另拼字符串。
- 实测（读代码）：hub 命令按角色放行只有一张表 `HUB_COMMAND_ROLES`，`hubCall` 在 `src/daemon/ledger/hub-commands.ts:352` 查它。访客轮次的拦截挂在同一处。
- 实测（读代码）：只读 Worker 禁读的是 `READONLY_SECRET_STATE_FILES`。`src/shared/readonly-policy.ts:52`。所以 App Secret 放单独的 `state/feishu-secrets.json` 并加进这张表。
- 实测（读代码）：用户上传走 `saveUpload`，单个最多 50 MB。`src/daemon/uploads.ts:71`、`src/shared/limits.ts:204`。飞书收进来的文件照用。
- 实测（读代码）：项目经理的水果原来是 `paletteOf(pmId)` 按编号对颜色表长度取余，图片在 `src/web/assets/avatars/<水果>.webp`。安装包里的守护进程目录不带 `src/web`，网页构建产物的文件名带哈希，所以实现时把水果顺序提到 `src/shared/fruits.ts`（`PM_FRUITS`、`pmFruitOf`，取余只按 `PM_FRUITS.length`），头像图挪到仓库根目录的 `assets/avatars/`，网页和守护进程都读这一处，`scripts/stage-runtime-common.ts` 打包时整个目录带走。后来水果扩到 20 种、头像换成 `scripts/render-avatars.ts` 画的史莱姆小动物：网页用透明底的 `<水果>.svg`，飞书群头像接口只收位图，用同一份像素稿导出的 `<水果>.png`（衬满铺浅底色，每格放大整数倍到约 1024×1024，飞书裁圆后四周留边）。
- 实测（读代码）：后端按单用户设计，没有多账号。`docs/multi-device-design.md:9`。“访客”只是飞书这一层的身份，不进 Fusa 的账号体系。
- 实测（跑测试）：`pnpm exec vitest run src/shared/feishu.test.ts src/daemon/feishu src/feishu test/migration.test.ts`：94 过、171 条 todo；`migrate` 从 0 跑到 0034 通过。
- 实测（查 PR）：开着的 PR 都没占 `0034`；被搁置的 Slack 方案 PR #348 已关闭，没有合进 `main`。

### 飞书官方接口（2026-11-18 核实）

核实方式：拉官方文档的 `.md` 版本（`open.feishu.cn/document/....md`），并下载 `@larksuiteoapi/node-sdk@1.76.0` 读它的类型定义和源码。

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| 扫码建应用 | `registerApp({ onQRCodeReady, addons, appPreset, createOnly })`，基于 RFC 8628 设备授权。返回 `client_id`、`client_secret`，以及扫码人的 `user_info.open_id` 和 `tenant_brand`。链接 10 分钟有效、只能一个人扫。错误码 `access_denied`、`expired_token`、`abort`。 | SDK README「一键创建应用」、`types/index.d.ts` 的 `RegisterAppOptions` / `RegisterAppResult` |
| 默认模板 | 扫码建出的应用默认带：机器人、单聊和 @机器人 消息、建群改群读群、上传资源、卡片读写、发消息改消息；事件 `im.message.receive_v1`、机器人进出群；回调 `card.action.trigger`。**事件与回调默认走长连接**，建完即可用。 | 开放平台「一键创建飞书智能体应用」附录（open.larksuite.com/document/mcp_open_tools/integrating-agents-with-feishu/overview） |
| 加权限 | `addons` 只能在模板上加，不能删；只能加权限、事件、回调，订阅方式等敏感配置要走“更新应用开发配置”接口（只支持开发者后台建的应用）。类型注释写着 addons 要平台灰度开着才生效，否则整个参数被忽略。 | SDK README、`AppAddons` 注释；`application-v7/application-config/patch.md` |
| 长连接 | 3 秒内处理完，否则重推（15 秒、5 分钟、1 小时、6 小时，最多 4 次）；每个应用最多 50 条连接；**集群模式，同一应用多个客户端只有随机一个收到**。卡片回调 `card.action.trigger` 也走长连接（旧版 `card.action.trigger_v1` 不行）。 | `event-subscription-guide/long-connection-mode.md`、事件概述 |
| 收群消息 | 收群里所有消息要 `im:message.group_msg`（敏感权限，管理员审批；个人版企业里管理员就是你）；默认模板只有 `im:message.group_at_msg:readonly`（只收 @机器人）。 | `reference/im-v1/message/events/receive.md` |
| 成员进出 | 事件 `im.chat.member.user.added_v1` / `deleted_v1`，要 `im:chat.members:read` 等任一。 | `reference/im-v1/chat-member-user/events/added.md` |
| 建群 | `POST /open-apis/im/v1/chats`：`avatar`（image_key）、`name`（建议 ≤ 60 字）、`owner_id`、`user_id_list`、`chat_type: private`、`group_message_type: chat`、`set_bot_manager`、`edit_permission`；`uuid` 让同一 `uuid + owner_id` **10 小时内**只建一个群。1000 次/分钟。 | `reference/im-v1/chat/create.md` |
| 改群 | `PUT /open-apis/im/v1/chats/:chat_id`：群主、管理员，或建群且有 `im:chat:operate_as_owner` 的机器人能改。 | `reference/im-v1/chat/update.md` |
| 群头像 | `POST /open-apis/im/v1/images`，`image_type: avatar`，≤ 10 MB、≤ 4096×4096，支持 WEBP。 | `reference/im-v1/image/create.md` |
| 发消息 | 同一个群里机器人共享 **5 QPS**，同一个人 5 QPS；`uuid` 1 小时内去重；卡片消息 ≤ 30 KB（错误码 230025）。 | `reference/im-v1/message/create.md` |
| 流式卡片 | 卡片 JSON 2.0，`config.streaming_mode: true`；先 `POST cardkit/v1/cards` 建实体，再按 `card_id` 发消息；“流式更新文本” `PUT cardkit/v1/cards/:card_id/elements/:element_id/content` 传全文，前缀相同才打字机，`sequence` 必须严格递增，1000 次/分钟、50 次/秒；**每张卡 10 次/秒**；流式模式开了 **10 分钟自动关**；流式模式下卡片回调不能靠响应改卡片，要先关流式；卡片实体 **14 天**后不能再操作；要求客户端 ≥ 7.20。 | `feishu-cards/streaming-updates-openapi-overview.md`、`cardkit-v1/card-element/content.md`、`cardkit-v1/card/create.md` |
| 卡片回调 | 3 秒内响应，可回 `toast`；`token` 30 分钟内最多改两次卡。 | `feishu-cards/card-callback-communication.md` |
| 文件 | 上传文件 ≤ 30 MB；下载消息里的资源 `GET im/v1/messages/:message_id/resources/:file_key` ≤ 100 MB。发消息的 `msg_type` 要和上传时的 `file_type` 配对：`mp4` 发 `media`（视频，封面 `image_key` 可不填），`opus` 发 `audio`，`pdf`、`doc`、`xls`、`ppt`、`stream` 发 `file`；不配对回 230055。 | `reference/im-v1/file/create.md`、`im-v1/message/create_json.md`、`reference/im-v1/message/create.md`（错误码 230055）、`reference/im-v1/message-resource/get.md` |
| 卡片里的图片 | 卡片 JSON 2.0 的图片组件 `{"tag": "img", "img_key", "alt", "scale_type": "fit_horizontal", "preview": true}`，`img_key` 用 `POST im/v1/images`（`image_type: message`）拿到的图片编号；`fit_horizontal` 完整展示不裁剪，`preview` 点开看大图。官方建议卡片里的图在 1500×3000 px 以内、≤ 10 MB。富文本组件 `text_size: notation` 是 12px 辅助文字。 | `feishu-cards/card-json-v2-components/content-components/image`、`.../rich-text`（2026-11-18 核实） |
| 撤回消息 | `DELETE im/v1/messages/:message_id`，机器人撤回自己发的消息，`im:message:send_as_bot` 即可（模板已带）；受管理员设的撤回时限约束（默认 24 小时），超时回 230009。 | `reference/im-v1/message/delete.md`（2026-11-18 核实） |
| 拉历史消息 | `GET im/v1/messages`（`container_id_type: chat`），`start_time` 与 `end_time` 为秒级时间戳字符串（传 `start_time` 时须一并给 `end_time`），回包 `create_time` 为毫秒字符串，`page_size` 范围 1～50；`mentions[].id` 为裸字符串（用户为 `open_id`，机器人可能标为 `app_id`），适配本机器人 `app_id` 后走官方 `normalize`。单聊需 `im:message:readonly`（模板已带），群聊还需 `im:message.group_msg`；缺权限（230027）时单群静默降级。 | `reference/im-v1/message/list.md`（2026-11-19 核实） |
| 置顶消息 | `POST / DELETE im/v1/pins`，通过可选权限 `im:message.pins:write_only` 随 `addons` 预填；未授予或群只许群主 Pin（230046）时记日志静默降级。 | `reference/im-v1/pin/create.md` |
| 查权限 | `GET /open-apis/application/v6/scopes` 返回各权限授予状态，不要额外权限。 | `application-v6/scope/list` |
| SDK 的 Channel | SDK 有高层的 `createLarkChannel`（长连接、去重、markdown 流式卡片、媒体），但只派发消息、卡片点击、表情、机器人进群、文档评论，**不派发成员进出**；卡片点击处理函数的返回值被丢掉（回不了 toast）；流式卡片只有一个 markdown 组件，放不了停止按钮。 | SDK `lib/index.js` 的 `registerDispatcherHandlers`、`docs/channel.zh.md` |

需要真机核对的三处（推断）：

- addons 加的 `im:message.group_msg` 和成员事件是否出现在确认页上（灰度）。不出现时：权限检查发现缺 `im:message.group_msg`，所有群降级成“一直要 @机器人”，状态里提示去开发者后台补开；缺成员事件时靠“发言人不是主人就算多人”加定期对账兜住。
- 扫码建的应用是否不用发布就能收到 addons 加的事件。
- 打开群的链接 `https://applink.feishu.cn/client/chat/open?openChatId=<群编号>` 在手机飞书里能直接跳进群。

## 做法比较

### 接哪一层

| 做法 | 改动面 | 和网页一致 | 结论 |
| --- | --- | --- | --- |
| A. 守护进程里加一层飞书通道：订阅 `Ledger.onChange` 往外投影，飞书事件进来调账本原有接口（和推送提醒同一个模式） | 新目录 `src/daemon/feishu/`；账本只加可选字段 `origin`、查询 `messagesAfter`、hub 拦截一处 | 账本是唯一真相 | 推荐 |
| B. 独立进程当网页客户端连 `/api/ws` | 不碰守护进程 | 一致 | 多一个进程要守护；访客轮次的拦截还是要进账本，绕路 |
| C. 让项目经理自己用飞书 CLI / MCP 发消息 | 不写代码 | 账本里没有 | 不用：违反“账本唯一真相”，也守不住主客边界 |

### 用 SDK 的哪一层

| 做法 | 说明 | 结论 |
| --- | --- | --- |
| A. `Client` + `WSClient` + `EventDispatcher` + `registerApp`，消息正文用 SDK 导出的 `normalize` | 都是官方包里的组件。自己注册要的事件（含成员进出），卡片点击的返回值就是回调响应（能回 toast）；流式卡片自己拼（要放停止按钮） | 推荐 |
| B. `createLarkChannel` | 官方高层封装，省掉去重和流式节流 | 不派发成员进出事件，单人和多人没法实时切；卡片点击回不了 toast；流式卡片放不了停止按钮。同一个应用不能再开第二条长连接补事件（集群模式会被随机分走） |
| C. 自己写 `ws` + `fetch` | 已有 `ws` | 不用：长连接协议是 protobuf 分帧，鉴权、重连、限流都要手搓 |

外部包只在 `src/daemon/feishu/sdk.ts` 里引，其余代码只认 `transport.ts` 的接口，测试用假的传输层（`daemon/feishu/test-helpers.ts`）。装的是 `@larksuiteoapi/node-sdk` 1.76.0，`AGENTS.md`「我们用的组件」已加。

### 项目经理在飞书里是什么

| 做法 | 结论 |
| --- | --- |
| A. 一个应用；总助 = 主人和机器人的单聊；每个项目经理一个私有对话群 | 推荐（用户已认可）。一个应用只扫一次码；群可以拉人，单聊不行 |
| B. 每个项目经理一个应用，像联系人一样单聊 | 不做：每建一个项目经理就要扫一次码；单聊不能拉人进来 |
| C. 所有项目经理放一个群 | 不做：混在一起，分不清在跟谁说 |

### 认主人

| 做法 | 结论 |
| --- | --- |
| A. 扫码建应用时直接用 `registerApp` 返回的扫码人 `open_id`；手动接入才用绑定码 | 推荐：扫完就能用，少一步 |
| B. 一律私聊机器人发绑定码 | 多一步，扫码路径用不上 |

### 唤醒判断放哪

| 做法 | 结论 |
| --- | --- |
| A. 开 `im:message.group_msg` 收全部群消息，Fusa 按“单人 / 多人 + 有没有 @”自己判断（`feishuWakes` 一处） | 推荐：只有这样才能做到单人群不用 @ |
| B. 只收 @机器人 的消息 | 做不到“单人群直聊”；作为没开权限时的降级 |

### 关键流程

**扫码接入。** ① 网页设置页或终端 `node src/feishu/main.ts connect` 发起 `startRegistration`，出二维码；② 手机飞书扫码，确认页已预填应用名（带设备名）和增量权限；③ 守护进程拿到凭证，验过存进 `state/feishu-secrets.json`，扫码人记为主人；④ 连长连接，查一遍权限授予状态；⑤ 给每个项目经理建群，给主人单聊发一句“已接上”。

**项目群。** `desiredFeishuChats` 由账本现状算出应有的群，`planFeishuChatSync` 和 `feishu_chats` 比出操作。建群带 `owner_id`（主人）、`user_id_list`（主人）、`set_bot_manager: true`（转给主人后机器人仍是管理员，能改名换头像）、`edit_permission: only_owner`（访客改不了群名）、`group_message_type: chat`（对话群，不是话题群）。幂等靠三层：`feishu_chats` 记录；建群 `uuid`（10 小时）；群说明里的 `feishuChatMarker`，重启时在机器人所在的群里认回。项目经理归档时解散群（`DELETE /open-apis/im/v1/chats/:chat_id`），记录留着并记下归档时间；取消归档时重建，建群 `uuid` 带上这个归档时间作 generation，免得被飞书当成 10 小时内的重复请求；新群换进同一行，唤醒方式和访客档位沿用。项目经理删掉时解散群、删记录。群被别人解散或机器人被移出时，记录记下解散时间（和归档一样），下一次对齐按取消归档重建：唤醒方式和访客档位沿用，建群 uuid 换新的 generation，不会被飞书当成 10 小时内的重复请求。水果头像每种只传一次，`image_key` 记在 `feishu_avatars`。 **群头像按图片内容认。** `feishu_avatars` 记每个水果上传得到的 `image_key` 和那张图的 SHA-256，`feishu_chats.avatar_fruit` 记每个群现在挂的是哪个水果。每次对齐现读 `assets/avatars/<水果>.png` 算哈希：`feishu_avatars` 里记的不是这张图（升级带来新图，或还没传过），就把头像是这个水果的群的 `avatar_fruit` 清空；项目经理该用的水果变了（水果扩到 20 种后，编号 8 以后的项目经理换了水果）则记录的水果和应有的本来就不同。两种情况 `planFeishuChatSync` 都出 `set_avatar`：图没传过就重传一次拿新 `image_key`，再 `chat.update` 只带 `avatar` 原地换群头像。不解散重建，不带 `name`，用户在飞书里改过的群名不动；换完记回水果，下一次对齐不再换，中途断了没换完的群下一次接着换。 **一个群出错不拖累别的群。** 对齐逐个群做：改群名、换头像时飞书回群没了（232011、232006、232010），按收到解散事件处理，记成已解散、下一次对齐重建；飞书拒收（比如群主不让机器人改群信息）记日志、当作改过了，不再反复试；网络、限流这类暂时性错误跳过这一个群，其余群照常对齐，这一轮的断线补发照常放行，隔 `FEISHU_CONTROL_RETRY_MS` 再整体对齐一次。

**唤醒。** `feishuWakes`：auto 档单人直达、多人要 @；mention_only 一律要 @；没开 `im:message.group_msg` 时强制 mention_only。没唤醒的话（含只读档访客的话）记进内存近窗（`FeishuContextWindows`），下一次唤醒时随 `origin.context` 交给项目经理，送达后清空。飞书的图片、文件、视频、语音气泡里带不了 @，多人群里常见的发法是先发文件、下一个气泡再 @机器人，所以没唤醒的气泡带的文件也记进近窗（只记消息编号和资源编号，不下载），下一次唤醒时按 `feishuGuestMay` 现查：主人和本档能发附件的访客发的，下载成附件随这次唤醒交给项目经理，排在这条自己带的文件前面；只 @机器人 没写字的气泡，前面有文件也照样交。待收文件按消息编号加资源编号去重（飞书重推同一条事件不会记两份）；处置过的当场从近窗摘掉：下载过的（成功或失败都算，失败的只回一次“没收下”）、本档不收而已回过提示的访客文件，不等送达，所以纯 @ 后提前返回也不会让下一次 @ 重下坏文件或重复报错。单人还是多人由 `FeishuDirectory` 定：成员事件实时改，发言人不是主人就立刻算多人，定期对账兜底，查不到按多人（宁可多要一次 @，也不把访客当主人）。

**设置卡与访客权限。** `feishuGuestMay(tier, action)` 是访客能做什么的唯一定义，入口（`routing.ts`）按它拦拍板、停止、附件；账本 `hubCall` 按 `origin.guestTier` 查 `FEISHU_GUEST_BLOCKED_HUB_COMMANDS` 拦越界命令。所有设置卡的下拉和按钮只认 `ownerOpenId`。主人在项目群或总助单聊发 `/群设置`、`/设置`、`/policy`、`/model`、`/settings`（整句匹配，不带斜杠的自然语言照常进账本）时，会话底部按内存缓存目录立即发出新设置卡并置顶、取消上一张的置顶（缺 `im:message.pins:write_only` 权限记日志降级），同时在后台异步重问一次不可用厂商的目录并按需原地更新卡片；`pm.updated`、`router.settings.updated` 刷卡与访客因档位被拦按 5 分钟冷却自动附卡都只读缓存目录，不阻塞会话进出队列。保留期清理时保留最新设置卡的置顶消息编号并将过期 `card_id` 置空，14 天后重发仍可取消旧置顶。

**流式与急停。** 状态机见 `stream.ts`：用户发话触发的那一轮，项目经理一开轮（`session.status` 的 activity 变成 working，调工具、思考时）就建流式卡片实体（markdown 组件 + 停止按钮）发到群主聊天流，还没正文时卡上是一行状态，文案同网页的 `describeStep`（如“Running command…”），工具阶段点停止就能停；正文来了在同一张卡上换成正文，之后每 `FEISHU_STREAM_FLUSH_MS` 推一次全文，飞书客户端打字机上屏。一轮只开一张状态卡：定稿过一段之后工具阶段不再开新卡（下一段文字照常开卡）；整轮没写正文就结束（只调了工具、被停下）时撤回这张状态卡，撤不回（超过撤回时限）就收成一行“这一轮没有文字回复”。“用户发话触发”看这个对话最近一条用户消息：是用户在网页或飞书里打的字（不是账本代发的唤醒，唤醒消息的 meta 标 `wakeup`，见 `isLedgerWakeup`）且还没回完（queued、delivered、processing）。任务图推进、拍板定案、检查点、取消任务图这些唤醒同理不镜像成“网页上说”。Worker 汇报、系统唤醒这类后台轮次工具阶段不开状态卡，等真有正文或挂卡时才发，所以后台静默处理完不会撤回任何消息，群里不留一排“撤回了一条消息”。只投影项目经理会话（`pmId` 不为空）；子任务的事件账本本来就不改主会话的状态和流式预览。开了 9 分钟续开一次流式模式；落库时换成账本正文、关流式、删停止按钮。超过 `FEISHU_CARD_MAX_CHARS` 时前一张定稿、续到新卡。点停止：回调里先回 toast（流式模式下不能靠响应改卡片），调 `requestStop`，这一轮结束时卡片收尾。整个应用的卡片接口共用一份每秒预算，每个群发消息每秒不超过 4 条。定稿或收尾时正文被飞书拒收（内容不合规、超限），卡片换成一行“飞书显示不了，去网页看”再改一次，照样关流式、删停止按钮。停机（含 `hub self-reload`）先退订账本、最多等 `FEISHU_CLOSE_DRAIN_MS` 把排着的出站发完、把还在流式的卡收尾，再断开；定稿做到一半就停机留下的 `feishu_posts` `streaming` 记录，下次连上补发时照账本正文换下一个 sequence 再定稿，水位推过了也收。

**拍板卡。** 提问卡、检查点卡、提醒卡画成卡片 JSON 2.0：一个表单里放“补充说明”输入框和选项按钮（推荐项排第一），点哪个选项都连同输入框回传，不需要弹窗。除了建 `router_items` 的独立 `hub ask`，任务图检查点与门禁拍板卡（带 `gateRef`，含步骤交付物图片与文件附件）及 `user_blocker` 自动提醒卡（带 `blockerRef`）同样经 `feishu_router_events(ask_message_id)` 同步发到总助单聊（`feishu_posts` 记 `router_ask` 与 `router_file`，同一份交付物跨会话复用已上传编号不重传）。两处卡片带同一个 `FeishuCardRef`，在总助单聊点、在项目群点、或在网页拍板、跳过、取消、重查解开，账本在同一事务里推 `message.updated`（`settleAskIn`），项目群与总助单聊两张卡一起改成已定案或已关闭；后点旧卡按钮回 toast“已经定过了”，不重复触发下游；提醒卡重查未过更新正文时两处待处理卡同步刷新。补发时先改这些待定案的卡，再按水位重放消息，重放哪一件出错都不挡卡片去掉按钮。

**文件。** 一条消息带的文件（项目经理发的文件、提问卡的交付物、网页上用户发的附件）和这条消息的卡同发同达：图片嵌进同一张卡（卡片图片组件，挂在正文下面、按钮上面），别的文件（pdf、md、mp4、zip、docx……）紧跟这张卡连着发成文件消息。做法：账本一落库就在出站队列外并发预传（`p-limit` 限 `FEISHU_UPLOAD_CONCURRENCY` 个同时传），排到发卡时最多再等到最后开始传的那个起算 `FEISHU_ATTACH_WAIT_MS`；传完的图嵌进卡、文件紧跟卡发，没传完的卡先发出去、卡底写一行 `Uploading <名字>…`，不挡后面的新消息；传完后文件补发成文件消息，再原地改这张卡（图嵌回去，文件那行改成“已送达”）。在途的附件记成 `feishu_posts` 的 `uploading` 行（挂着卡的消息编号和卡片编号），停机不等它，重连、重启后补发时接着传，传完照样补发、改卡。传完先把图片编号、文件编号记在这一行上，卡改成了才记 `final`：改卡遇到网络错误、停机重启时，补发按这一行重新改卡，不重传、不重发文件。紧跟卡发的文件被飞书拒收时，也回头把卡改成写着“没发出去”。上传暂时失败退避重试 `FEISHU_MEDIA_RETRY_MAX` 次，飞书拒收或重试用尽时卡上写“没发出去，去网页看”。超过 `FEISHU_IMAGE_MAX_EDGE` 边长或 `FEISHU_IMAGE_SHRINK_BYTES` 的截图（png、jpeg、webp、avif），上传前用 `sharp` 在临时目录缩一份最长边 2400 的副本再传，传完删掉，磁盘上的原图不动（之前一张 4920×6990、8.7 MB 的截图在慢网上传了 8 分钟）；飞书图片接口不收 avif，再小也转一份 jpeg；超过 10 MB 的动图取第一帧；要转却转不成的不白传，卡上写“没发出去”；其他文件 ≤ 30 MB 按扩展名上传并配对消息类型（mp4 发视频、opus 发语音、其余发文件，见上面「飞书官方接口」的文件一行），更大的卡上写一行“去网页看”；同一个文件只传一次。每次 HTTP 请求有超时：普通接口 `FEISHU_HTTP_TIMEOUT_MS`，上传下载 `FEISHU_TRANSFER_TIMEOUT_MS`（官方 HTTP 实例默认不设超时，`sdk.ts` 包一层补上）。卡片 Markdown 的图片地址只认上传后的图片编号（`img_` 开头），别的地址回 200570，所以正文进卡片前过一遍 `feishuCardMarkdown`：本机图片写成“图片「名字」”，网页图片改成链接，指向本机的链接只留文字；文件本身照上面同发。主人（协作者档访客）在飞书里发的图片、文件、视频、语音（富文本里夹的多张图和视频也算）都下载存成附件随消息交给项目经理，正文里这些资源的占位去掉，只丢表情包。超过 `MAX_UPLOAD_BYTES`、下载失败的文件回一句“没收下”；本档不能发文件的访客发的文件不收（他这条带的和前面气泡里他发的都算），回他一句，告诉他请主人在「访客权限」卡上切到“协作者”；文件都没收下、又没写字的消息不交给项目经理和总助。下载失败记一行日志，带消息编号和出错原因（飞书权限不够、资源过期都能从日志看出来）。

**网页和飞书一致。** 网页上发的用户消息镜像到群里（标“网页”），网页发的总助指令和结果也镜像到单聊；飞书发的消息本来就在账本里。

**断线与补发（出站补发 + 入站补拉）。** 官方 `WSClient` 默认不查心跳、握手不限时，半开的假活连接（网络切换、梯子、NAT 回收）要等 TCP 报错才发现，期间飞书推来的事件送不到。`sdk.ts` 开官方的心跳看门狗 `wsConfig.pingTimeout`（`FEISHU_WS_PING_TIMEOUT_S`）和握手超时 `handshakeTimeoutMs`（`FEISHU_WS_HANDSHAKE_TIMEOUT_MS`），断开、重连各记一行日志。启动连接与每次断线重连后双向追平：
- **入站主动补拉**：按 `feishu_inbound_cursors` 记录的各活跃会话（总助单聊 + 未归档项目群）最近入站锚点与最大回溯窗口 `FEISHU_INBOUND_CATCHUP_WINDOW_MS`（进程内重连往前多留 `FEISHU_INBOUND_CATCHUP_OVERLAP_MS` 覆盖半开盲区；`0041` 迁移与空游标会话按当前时刻建锚点，不回放升级前的非幂等消息），用 `p-limit` 控制 `FEISHU_INBOUND_CATCHUP_CONCURRENCY` 路并发调用 `GET im/v1/messages`（单群最多翻 `FEISHU_INBOUND_CATCHUP_MAX_PAGES` 页、`FEISHU_INBOUND_CATCHUP_MAX_MESSAGES` 条），过滤机器人自身消息、撤回消息和合并转发子消息，按时间升序前插到该会话重连后暂存的实时事件之前投递，保留多人群 `@` 与跨气泡带文件语义；游标仅在单条消息真正处理完毕后推进，断线、停机或入站队列满溢出丢弃时不跨过缺口推进游标（溢出时按时间先收最早消息并记结构化日志）；内存 `seenInboundMessages`（LRU 上限 `FEISHU_SEEN_MESSAGES_MAX`）与账本 `client:<conv>:feishu:<message_id>`、`router_commands.client_id` 双重去重，飞书服务端稍后经长连接迟到重推同一 `message_id` 直接跳过；未授予 `im:message.group_msg` 或单群接口报错时按单群记结构化日志静默降级，不阻塞总助单聊与其他群；并发多次闪断重连合并为同一时间只跑一轮，入站闸门按重连代次收放，旧轮收尾不放开新轮闸门。
- **出站补发**：成员缓存标过期；先把离线期间已经定案的卡（含总助单聊 `router_item` 与 `router_ask`）改掉，再按 `feishu_chats` 的水位补发离线期间的消息（每群最多 `FEISHU_CATCHUP_MAX_MESSAGES` 条，更早的发一行“还有 N 条，去网页看”），并恢复未传完的附件。飞书挂了、凭证失效都不影响网页和 agent，只在状态里报。

## 性能

1. **失效。** 群成员缓存靠成员进出事件实时改；连上和重连时整份标过期；每 `FEISHU_MEMBERS_TTL_MS` 对一遍；查失败只记 `FEISHU_MEMBERS_RETRY_MS`，期间按多人处理。背景近窗（连同没唤醒的气泡里待交的文件编号）按 `FEISHU_CONTEXT_TTL_MS` 过期，送达即清，群解散、机器人被移出、断开时清掉；守护进程重启后为空。绑定码 `FEISHU_BIND_CODE_TTL_MS` 后失效，用一次作废。权限检查结果在连上、重连、`resync` 时重查，不长期缓存。水果 `image_key` 不过期（头像图片是仓库里的固定文件）。
2. **上限。** 内存：成员缓存用已有的 `lru-cache`，最多 `FEISHU_CHAT_CACHE_MAX` 个群，每群最多 `FEISHU_CHAT_MEMBERS_MAX` 人；背景近窗每群 `FEISHU_CONTEXT_MAX_LINES` 行、`FEISHU_CONTEXT_MAX_CHARS` 字、`FEISHU_CONTEXT_MAX_FILES` 个待交文件编号，群数跟着成员缓存一起淘汰；流式状态每个项目经理对话最多一份，结束即删；进出队列各有上限；在途附件的上传记录用 `lru-cache` 存最多 `FEISHU_MEDIA_QUEUE_MAX` 个，传完、补发完即删，断线打断的也删（重连按 `uploading` 行重传）。`sharp` 和飞书 SDK 一样只在真要发图片时才加载。群数等于项目经理数，不随 Worker 和消息变多。数据库：`feishu_posts` 每条发出去的东西一行，按一个月 3 万条消息算最多约 3 万行（Worker 对话不投影，实际少得多）；卡片实体 14 天后飞书就不让改了，所以已定稿的行 `FEISHU_POST_RETENTION_DAYS` 天后由现有的保留清理删掉，等拍板的卡和 `uploading` 的附件不删。接口响应 `FeishuStatusView` 只列群，几十行，不需要压缩。
3. **前端引用稳定。** 这一步没有前端。状态接口在没有变化时返回内容相同的对象，以后设置页按它的 `chats` 数组做 `WeakMap` 缓存。
4. **验证。** 实现步骤用 pstack 的 `benchmark-checklist` 量：项目经理写出第一段到手机上出字的延迟；一段 5,000 字回复期间“流式更新文本”调用次数；三个项目经理同时回复 5 分钟时有没有限流错误（230020、99991400）；开飞书前后守护进程 RSS；`blast-radius` 列出 `PostUserMessageInput`、`UserMessageMeta`、`deliveryParts`、`hubCall` 的调用方。数字写进 PR。

`src/shared/limits.ts` 里的飞书常量（另有实现时补的 `FEISHU_CHAT_NAME_MAX_CHARS`、`FEISHU_CHAT_UUID_MAX_CHARS`、`FEISHU_PAGE_SIZE`、`FEISHU_CLI_POLL_MS`、`FEISHU_POST_RETENTION_MS`）：

| 常量 | 值 | 怎么算的 |
| --- | --- | --- |
| `FEISHU_CARD_MAX_CHARS` | 8,000 | 卡片 ≤ 30 KB，中文 UTF-8 每字 3 字节约 10,000 字，留出按钮和 JSON 的余量 |
| `FEISHU_STREAM_FLUSH_MS` | 300 | 每张卡每秒约 3 次，低于飞书每张卡 10 次/秒；手机上打字机动画连续 |
| `FEISHU_STREAM_PRINT_FREQUENCY_MS` / `FEISHU_STREAM_PRINT_STEP` | 70 / 1 | 飞书默认值，写死免得各端默认不同 |
| `FEISHU_CARDKIT_BUDGET_PER_SECOND` | 40 | “流式更新文本”接口 50 次/秒，留余量；300 ms 一推时够 12 个对话同时流式 |
| `FEISHU_STREAM_RENEW_MS` | 9 分钟 | 流式模式 10 分钟自动关 |
| `FEISHU_CHAT_SENDS_PER_SECOND` | 4 | 同一个群里机器人共享 5 QPS |
| `FEISHU_CARD_ACTION_DEADLINE_MS` | 2,500 | 卡片回调 3 秒内必须响应 |
| `FEISHU_CHAT_CACHE_MAX` | 200 | 群数 = 项目经理数 + 1，本机现在不到 20 个，留十倍 |
| `FEISHU_CHAT_MEMBERS_MAX` | 1,000 | 私人项目群不会超过几十人 |
| `FEISHU_MEMBERS_TTL_MS` / `FEISHU_MEMBERS_RETRY_MS` | 10 分钟 / 30 秒 | 事件实时改为主，定期对账兜住漏掉的事件 |
| `FEISHU_DISPLAY_NAME_MAX_CHARS` | 40 | 署名一行放得下 |
| `FEISHU_CONTEXT_MAX_LINES` / `FEISHU_CONTEXT_MAX_CHARS` / `FEISHU_CONTEXT_TTL_MS` | 30 / 4,000 / 2 小时 | 两人讨论半小时的量；太久以前的讨论当背景反而误导 |
| `FEISHU_CONTEXT_MAX_FILES` | 20 | 没唤醒的气泡里待交的文件每群最多记几个：手机上多选的图片逐张发成单独的消息，一次最多 9 张，留一倍余量 |
| `FEISHU_POLICY_CARD_COOLDOWN_MS` | 5 分钟 | 访客因档位被拒时同一个群自动附群设置卡的冷却间隔；主人发斜杠命令不受限 |
| `FEISHU_SELECT_OPTIONS_MAX` | 100 | 单个 `select_static` 下拉最多保留多少个模型选项（当前选中项必留），防止聚合厂商几百个模型撑爆 30 KB 卡片上限 |
| `FEISHU_POST_RETENTION_DAYS` | 14 | 卡片实体 14 天后不能再操作 |
| `FEISHU_CATCHUP_MAX_MESSAGES` | 20 | 离线一夜回来不刷屏 |
| `FEISHU_MESSAGE_LIST_PAGE_SIZE` | 50 | `GET im/v1/messages` 单页条数上限（飞书校验 1～50） |
| `FEISHU_INBOUND_CATCHUP_WINDOW_MS` / `FEISHU_INBOUND_CATCHUP_OVERLAP_MS` | 15 分钟 / 30 秒 | 入站主动补拉最大回溯窗口（不翻陈旧历史）与进程内重连半开盲区重叠缓冲 |
| `FEISHU_INBOUND_CATCHUP_MAX_PAGES` / `FEISHU_INBOUND_CATCHUP_MAX_MESSAGES` | 4 / 200 | 单群单次重连最多翻页数与保留最新条数上限 |
| `FEISHU_INBOUND_CATCHUP_CONCURRENCY` | 6 | 单轮入站补拉并发拉取的会话数上限，消除百群串行阻塞实时消息并压在飞书频控以内 |
| `FEISHU_SEEN_MESSAGES_MAX` | 2,000 | 内存 LRU 记住最近已处理的飞书入站消息编号上限，拦截重叠窗口与长连接迟到重推 |
| `FEISHU_BIND_CODE_TTL_MS` | 10 分钟 | 够人切到飞书里发 |
| `FEISHU_IMAGE_MAX_BYTES` / `FEISHU_FILE_MAX_BYTES` | 10 MB / 30 MB | 飞书上传图片、上传文件的上限 |
| `FEISHU_INBOUND_QUEUE_MAX` / `FEISHU_OUTBOUND_QUEUE_MAX` | 500 / 500 | 容纳多群并发补拉与突发事件；进的满了先丢成员和改名事件（重连对账会补回），消息溢出记日志并锁住补拉锚点，出的满了先合并流式推送 |
| `FEISHU_MEDIA_QUEUE_MAX` / `FEISHU_MEDIA_RETRY_MAX` / `FEISHU_UPLOAD_CONCURRENCY` | 200 / 3 / 3 | 在途附件最多几个（满了先在卡上写 Uploading，重连补发时再传）；重试隔 1、2、4 秒；同时传 3 个，慢网上不互相抢带宽 |
| `FEISHU_ATTACH_WAIT_MS` | 2.5 秒 | 发卡前等附件的窗口：常见截图、文档在这之内传完，和文字一起到；超大视频不拖住聊天 |
| `FEISHU_IMAGE_MAX_EDGE` / `FEISHU_IMAGE_SHRINK_BYTES` | 2400 px / 2 MB | 手机视网膜屏看截图足够清楚；超过的先缩再传 |
| `FEISHU_HTTP_TIMEOUT_MS` / `FEISHU_TRANSFER_TIMEOUT_MS` | 30 秒 / 180 秒 | 普通接口回包都在秒级；30 MB 在约 170 KB/s 的慢网上能传完 |
| `FEISHU_SECRETS_FILE_MODE` | 0o600 | 和 `state/ui-token` 一样 |

## 统一

- **厂商。** 飞书通道在账本之上，只看消息、会话状态和卡片，不看是哪家 agent；`src/shared/vendors.ts` 里的所有厂商都一样走。以后加一家新厂商，飞书这一层不用改任何文件。
- **三个平台。** 只有出站 HTTPS 和 WSS，macOS、Windows、Linux 一样，`src/daemon/platform/index.ts` 不用改。凭证文件的保护沿用 `READONLY_SECRET_STATE_FILES`（各平台的只读策略按这张表禁读，Windows 走 ACL）。
- **一处定义。** 权限和事件只在 `src/daemon/feishu/scopes.ts`；唤醒规则只在 `feishuWakes`；访客能做什么只在 `feishuGuestMay`，访客禁用的 hub 命令只在 `FEISHU_GUEST_BLOCKED_HUB_COMMANDS`（都在 `src/shared/feishu.ts`）；可调的数只在 `src/shared/limits.ts`；外部包只在 `src/daemon/feishu/sdk.ts`；项目经理的水果顺序只在 `src/shared/fruits.ts`，网页和群头像共用。
- **两个入口一份逻辑。** 界面服务的飞书接口和终端命令 `src/feishu/cli.ts`（经 `run/admin.sock`）都只调 `FeishuSetupService`。
- **以后接别的聊天软件。** 唤醒、访客档位、署名这些规则现在写在飞书的类型上。真要再接一家时，先把 `feishuWakes`、`feishuGuestMay`、`FeishuMessageOrigin` 抽成与平台无关的一份，再接新平台；现在只有一家，不提前抽。

## 删掉什么

无。飞书是新加的通道，网页、推送提醒照旧。被搁置的 Slack 方案（PR #348）没有合进 `main`，`main` 上没有它的代码和文档要删。

## 骨架文件

- `migrations/0034_feishu.sql`：`feishu_app`（应用、机器人、主人）、`feishu_chats`（总助单聊和项目群、唤醒方式、访客档位、补发水位）、`feishu_posts`（账本里的东西发到了哪条消息、哪张卡片实体、卡片操作序号）、`feishu_avatars`（头像的 image_key）。`migrations/0037_feishu_avatar_hash.sql` 重建 `feishu_avatars` 加 `content_sha256`。`migrations/0039_feishu_avatar_look.sql` 把 `feishu_avatars` 改按形象键 `look` 缓存。`migrations/0040_feishu_router_settings_post.sql` 重建 `feishu_posts`，`ref_kind` 加 `router_settings` 记总助单聊最新那张设置卡。`migrations/0041_feishu_router_asks_and_inbound_cursor.sql` 给 `feishu_posts` 加 `router_ask` 与 `router_file`、给 `feishu_router_events` 加 `ask_message_id` 与触发器，并建 `feishu_inbound_cursors` 记各会话入站补拉锚点。
- `src/shared/feishu.ts`：品牌化编号和解析函数、主客身份、单人多人、唤醒方式、访客档位和 `feishuGuestMay`、消息来源 `FeishuMessageOrigin`、署名与背景 `feishuDeliveryPrefixes`、访客禁用的 hub 命令和 `feishuGuestTurnBlockReason`、设置接口的形状。
- `src/daemon/feishu/transport.ts`：外部边界：用到的开放接口、长连接事件、卡片回调与 toast、`FeishuTransport`、`FeishuAuthError`。
- `src/daemon/feishu/sdk.ts`：用官方包实现传输层，包一层 `registerApp`。
- `src/daemon/feishu/scopes.ts`：模板之外要加的权限和事件、必需与可选权限、权限检查、确认页预填。
- `src/daemon/feishu/inbound.ts`：原始事件和卡片点击解析成领域事件。
- `src/daemon/feishu/routing.ts`：消息和点击的分流、唤醒判断 `feishuWakes`、主客判断。
- `src/daemon/feishu/directory.ts`：群成员和显示名缓存、单人多人、背景近窗。
- `src/daemon/feishu/chats.ts`：项目群应有的样子、群说明标记、建群 uuid、对齐计划。
- `src/daemon/feishu/avatars.ts`：项目经理对应的水果、头像图片、图片内容哈希（`feishuAvatarHash`）、按哈希认的 image_key 缓存。
- `src/daemon/feishu/outbound.ts`：账本变化投影成出站意图、补发、长文拆段。
- `src/daemon/feishu/stream.ts`：流式卡片状态机和卡片接口预算。
- `src/daemon/feishu/model-picker.ts`：项目经理与总助的模型、思考程度下拉选项及切换联动纯函数。
- `src/daemon/feishu/cards.ts`：按钮与下拉值编解码、拍板卡、总助卡、流式回复卡、群设置卡、总助设置卡。
- `src/daemon/feishu/files.ts`：文件上传和下载。
- `src/daemon/feishu/store.ts`：四张表的读写。
- `src/daemon/feishu/secrets.ts`：凭证文件。
- `src/daemon/feishu/setup.ts`：设置服务（状态、扫码、手动接入、绑定码、群策略、对齐、断开）。
- `src/daemon/feishu/service.ts`：通道本身：接账本和传输层，`FeishuLedgerPort` 写明用到的账本接口（含要新加的 `messagesAfter`）。
- `src/feishu/cli.ts`：终端命令。
- 测试骨架：上面每个文件旁边的 `*.test.ts`，以及 `src/daemon/feishu/ledger-wiring.test.ts`（账本一侧的接线，实现步骤可以挪到 `src/daemon/ledger/`）。

主仓接线（实现步骤已接上）：

- `package.json`、`pnpm-lock.yaml`：`pnpm add @larksuiteoapi/node-sdk`；`AGENTS.md`「我们用的组件」加一条。
- `src/daemon/daemon.ts`：在推送服务旁边（`daemon.ts:763`）建 `createFeishuService`，关机时 `close`。
- `src/shared/api.ts` + 界面服务：`GET /api/feishu`、`POST /api/feishu/registration`、`DELETE /api/feishu/registration`、`PUT /api/feishu/credentials`、`POST /api/feishu/bind-code`、`PUT /api/feishu/chats/:pmId/policy`、`POST /api/feishu/resync`、`POST /api/feishu/disconnect`（zod 校验，经设备令牌访问回 `forbidden_peer`）。
- `run/admin.sock` 加 `/feishu/*` 路由，新增 `src/feishu/main.ts`。
- `src/shared/ledger.ts:114` 的 `PostUserMessageInput` 和 `src/shared/attachments.ts:24` 的 `UserMessageMeta` 加 `origin?: FeishuMessageOrigin`；`postUserMessage` 写进 meta。
- `src/shared/worker.ts:313` 的 `deliveryParts` 调 `feishuDeliveryPrefixes`。
- `src/daemon/ledger/hub-commands.ts:352` 的 `hubCall` 查正在处理的那条消息的 `origin`，调 `feishuGuestTurnBlockReason`。
- `Ledger` 加 `messagesAfter`。
- `src/shared/readonly-policy.ts:52` 加 `feishu-secrets.json`；`src/shared/paths.ts` 的 `HubPaths` 加 `feishuSecretsFile`。
- `src/daemon/db-retention.ts` 调 `prunePosts`。
- `src/shared/limits.ts` 加上表的常量；`src/shared/index.ts` 导出 `feishu.ts`。
- 水果：水果顺序在 `src/shared/fruits.ts`（`palette.ts` 和 `daemon/feishu/avatars.ts` 都按它取）；头像图在仓库根目录 `assets/avatars/`（`scripts/render-avatars.ts` 生成），`scripts/stage-runtime-common.ts` 整个目录打包。

## 实现时对骨架的调整

- `FeishuStreamState` 去掉 `finalizing`：定稿是一次性的效果，发出去就回 `idle`；`opening` 多了 `sentText`（建卡时的正文）和 `pending`（建卡期间落库或这一轮结束，等 `opened` 之后再定稿或收尾）。流式卡片上只推前 `FEISHU_CARD_MAX_CHARS` 字，`live` 时总约着下一次 tick（没东西推时约在该续开流式的时候）。
- `desiredFeishuChats(pms, device)`：群说明末尾要带 `feishuChatMarker(deviceId, pmId)`，所以第二个参数从设备名换成 `{ id, name }`。
- 群被别人解散（`chat_gone`）不删记录，见上面「项目群」一段。总助单聊被解散才删记录，主人下次私聊时认回。
- `pmFruitOf`、`PmFruit` 挪到 `src/shared/fruits.ts`，`avatars.ts` 转出；默认头像目录 `FEISHU_AVATARS_DIR` 在 `avatars.ts`。
- `FeishuDirectory` 多一个 `peekMembers`（状态接口用，不发请求）；只从事件知道、还不知道名字的人，查名字时重拉一次成员。
- `FeishuService` 多一个 `idle()`（测试和关机前等队列排空）；`start()` 不等长连接连上。
- `FeishuCliIo` 多一个 `sleep`（等扫码时轮询状态的间隔，测试换成立刻返回）。
- `cards.ts` 多一个 `renderTextCard`（总助指令结果、网页消息的镜像），以及 `feishuCardRefOf`、`feishuAskOptions`、`feishuCardStateOf`、`feishuChatAppLink` 几个由账本现状算卡片的小函数。
- 水位 0 表示“这个群从头开始投影、还没发过东西”，和 `null`（还没开始记）不同：新建的空群也能补发离线期间的消息。
- 审查后的调整（PR #350 审查 FAIL 的六项）：
  - 卡片点击只认本群发出的卡：按 `action.messageId` 查 `feishu_posts`，必须是这个群的、卡上的引用和本地记录一致、目标消息归这个群的项目经理；群归档、项目经理删掉或项目不再进行时一律回“已过期”。总助拍板项只有主人能点，停止按钮只认这一轮正在流式的那张卡。
  - 分块和流式前缀按字数和转成 JSON 后的字节数一起算（`FEISHU_CARD_MARKDOWN_JSON_BYTES`），补的围栏只照抄有上限的记号和语言名，保证每段至少前进一个字；发送前再按 `FEISHU_CARD_MAX_BYTES` 核一遍。
  - 流式状态机多一个 `open_failed`：建卡失败回 `idle`，已经落库的那段直接发普通定稿卡。回 `idle` 即清计时器、删状态；群解散、换群时清掉旧群的流式状态，定稿前核对群没换。
  - 总助单聊的补发不再用两个编号水位，改成 `feishu_router_events`：账本写总助卡片、指令完成时由触发器在同一事务里按完成顺序记一行，发出去后删掉并推进 `last_router_event_id`。离线期间定案的总助卡按 `getRouterItem` 查现状改掉（快照只含待拍板的）。
  - 定案人署名存进 `feishu_decisions`，在账本定案的同一事务里写（`answerAsk`、`resolveRouterItem`、`decideTaskNode` 多一个可选的写入回调），先成功的点击为准；同一次点击重投按 `clientId`（卡片回调的 token 摘要）幂等。
  - 进出队列都按条数封顶；建群对齐和断线补发不进队列，只记标记，满载时不丢，失败隔 `FEISHU_CONTROL_RETRY_MS` 重试；出站排不进时改从账本按水位整段补发。认回已有的群时水位初始化成当前最新消息。
- 复验后的调整（PR #350 第二轮复验 FAIL 的四项）：
  - 给人看的错误（设置页 `lastError`、接口 400 的原因）不带飞书、网络的原文，原文只进日志；`FeishuSetupError` 和别的业务错误一样由界面服务统一的错误处理转成 `invalid`。
  - 提问卡、总助拍板项、简报的正文先扣掉按钮、定案说明和“打开项目群”，放不下的截到放得下，末尾写“完整内容去网页看”，整张卡不超过 `FEISHU_CARD_MAX_BYTES`。
  - 出错分两种：飞书明确拒收（业务错误码，含卡片过期、撤回、群没了、超过 30 KB 的 230025）再发也一样，放弃这一件、水位推过去，待拍板卡记成已结算；网络、限流用尽、飞书 5xx 是暂时性的，只把出错的那个群记下，隔 `FEISHU_CONTROL_RETRY_MS` 从水位整段补发。补发按群隔离，一个群出错不挡别的群。
  - 只有在补的、等着补的群不排新任务；建群对齐时出站任务排着等对齐做完再发，不丢、不触发补发。流式预览排不进直接丢（下一块文字带着全文），不触发补发。补发最后只收尾断线期间已经结束的那几轮留下的流式卡，还在写的不动。
  - 总助单聊刚连上时也最多补 `FEISHU_CATCHUP_MAX_MESSAGES` 条，更早的发一行“还有 N 条，去网页看”。
  - 提醒卡点“已处理”：回调先回“正在重查”，排队后和网页一样先 `models.list({ vendor, refresh: true })` 再 `recheckUserBlocker`；解开了账本推变化、卡跟着改，还不能用在群里说一句。
- 管理 socket 的客户端从 `src/tunnel/main.ts` 抽到 `src/tunnel/admin-client.ts`，隧道和飞书命令共用；`/feishu/*` 路由挂在 `daemon/tunnel/admin.ts`，请求体校验和界面服务共用 `daemon/feishu/setup.ts` 里的 zod schema。

## 验收方法

- **单元测试。** 每个 `it.todo` 改成真断言后全绿，重点：`feishuWakes` 的四种组合、`routeFeishuMessage` 的单人多人切换和三档访客、`stepFeishuStream` 的“定稿正文等于账本这段文字、不另发”和 sequence 递增、`planFeishuChatSync` 的幂等与认回、`feishuGuestTurnBlockReason` 覆盖每档每个禁用命令。`service.test.ts` 用假传输层和真账本跑通整条链，并断言没有任何发送带 `reply_in_thread` 或回复某条消息。
- **真机：个人版飞书企业，手机飞书客户端。** 证据是手机录屏（mp4）、截图（`docs/screenshots/feishu/`）和守护进程日志片段，贴进 PR：
  1. 从点“接入飞书”到手机上出现所有项目群，计时，五分钟以内（录屏）。
  2. 项目群列表：每个群的头像是对应水果、群名是项目经理名字、你是群主（截图）。
  3. 单人群：不 @ 说一句，项目经理的回复在主聊天流里逐字出现，点“停止”能停；网页上同一个对话同时出现这两条；全程没有话题和回复串（录屏）。
  4. 拉一个测试账号进群：群里出现访客权限卡；之后你和访客不 @ 的话项目经理不回；@机器人 后项目经理的回复里提到刚才的讨论；驱动日志里写给 agent 的正文带“【飞书 · 名字（访客）】”和“群里之前的讨论”。
  5. 档位：仅对话档访客点拍板卡只看到“只有主人能拍板”的提示；切到协作者后能点；只读档访客 @机器人 项目经理也不回；任何档访客让项目经理挂载 `~/Documents`，`hub project attach` 返回 forbidden（日志）。
  6. 拍板卡：飞书点选项后网页卡片同时变已回答；网页回答另一张，飞书里那张变“已定案”、按钮消失。
  7. 交付：项目经理发一张截图、一份 Markdown 和一个 mp4，飞书里截图嵌在回复卡里，Markdown 和视频紧跟这张卡；发一张 4920×6990 的截图，几秒内出现在卡里；网页上发带图和 pdf 的话，群里的镜像卡同样图文同发（录屏）。
  8. 断线：`kill -STOP` 守护进程 2 分钟期间在网页发消息、答卡，恢复后飞书补上这些消息、卡片改成已定案；重复恢复不重复发。
  9. 项目经理改名，群名跟着改；归档后群被解散；取消归档后出现一个新群，唤醒方式和访客档位沿用；重复触发不多建群（`feishu_chats` 行数不变）。
  10. 总助单聊里点一张拍板项的选项，项目群里同一张卡同时变已定案；再去群里点，提示“已经定过了”。
  11. 只读档访客说几句后，你 @机器人，驱动日志里写给 agent 的正文带上访客刚才的话。
- **凭证安全。** 状态接口和 `status` 命令的输出里搜不到 App Secret；只读 Worker 里 `cat state/feishu-secrets.json` 被拒（命令和输出贴进 PR）。
- **限流。** 三个项目经理同时长回复 5 分钟，日志里没有限流错误后丢字（卡片接口调用次数和限流次数写进 PR）。
