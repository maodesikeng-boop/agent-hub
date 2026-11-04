# M4 计划：等你处理和通知

> 状态：草稿，待用户审阅。第 4 节有 4 个问题要用户定。
> 依据：[prototype-design.md](prototype-design.md)（下文简称“设计”）第 3.5、3.7、5.3、7.5 节，第 11 章和里程碑表；[m0-report.md](m0-report.md) 实验 4、8；[m3-plan.md](m3-plan.md)；main 上 `ad65a3e` 的 M3 实现；Claude Code 官方文档（链接在文末）；2026-11-04 用 `claude` 2.1.314 + haiku 实测了两次（第 2.1 节）。
> 用户 11-04 定的原则：**系统只提供编排的能力，不写死工作流程**。原话：“它只需要编排工作就可以了，至于怎么编排，agent 自己思考，每个用户情况都不一样，我有我的 agents.md”。所以 M4 只给 agent 一个“找得到用户”的能力，不规定 agent 什么时候必须来问。“合并前问”“推送前问”这类规定，另一个 PR 会从提示词里删掉，M4 也不加。
> 写于 2026-11-04。

## 1. 范围

**M4 要解决的**：agent 需要用户的时候，能找到用户；用户点一下，它就能接着做。

**做完用户能看到什么**：

1. Worker 或项目经理的某一步被 `auto` 档的分类器拦下了。项目经理的会话里出现一张卡片：“Worker #3 · 修 X 被拦下：`git push --force origin main`（[原因]）”，带两个按钮：“允许”“不用了”。
2. 点“允许”，它就会收到一条消息：“用户允许你做刚才被拦下的这一步：`…`”，然后接着做。
3. 项目经理在回复里问了用户一句（问什么、什么时候问，由它自己定），然后它和它的 Worker 都停了下来。左栏它那一行出现“等你”，浏览器标签页的标题变成“(1) agent-hub”。
4. 上面两种情况，如果用户没在看这个会话，就弹一个系统通知。点通知，回到网页里对应的会话。

**最小的那条路**

| 步骤 | 怎么做 |
|---|---|
| 发现被拦 | 驱动层本来就在读 `claude` 的 stream-json 输出，里面有 `system/permission_denied` 事件（[headless][cc-headless]、[SDK 类型][cc-sdk-ts]）。只把 `decision_reason_type` 是 `classifier` 的拦截做成卡片（第 2.2 节）。不用钩子，也不用新开端口 |
| 卡片 | 在项目经理的会话里加一条消息，`kind: blocked`。Worker 被拦的也放在这里，标明是哪个 Worker。状态是 `pending`、`allowed`、`dismissed`、`expired` 之一，原地更新（用现成的 `message.updated`） |
| 点“允许” | 账本往被拦的那个会话登记一条 `session.send`（sender `user`），正文照模板写，点名那一步的具体内容。分类器认用户在对话里点名的同意（[permission-modes][cc-modes] 的 Approvals you state in conversation 一节）。这一轮已经结束的，就作为新的一轮；还没结束的，就排在后面（M1 现成的队列） |
| “等你” | 网页自己算：一个项目经理的会话和它所有 Worker 的会话都停着，没有排队或处理中的消息，并且这种状态持续了 3 秒，就算“等你”。不需要 agent 配合，也不解析回复的内容 |
| 通知 | 用浏览器的通知接口。网页要开着，标签页在后台也行。点通知时，网页把自己切到前台，并打开对应的会话 |

**M4 不做**（各写一句为什么）

- **挂起等批准的 `PermissionRequest` 钩子**（设计 5.3、7.5 节）：在 `auto` 档、`-p` 模式下，几乎没有操作会走到它，做了基本用不上（第 2.1 节）。以后用户在 `permissions.ask` 里加了规则，想要硬关卡时再加，M0 已经验证过它能挂 300 秒。
- **单独的收件箱页、四档分组**：卡片放在会话里，左栏有“等你”，就够找到了。M3 也没有工单状态需要分组。
- **审批流程、红线设置页、`policy.json`**：用户的原则是少加硬限制。现在唯一的硬限制，Worker 不能写记忆，已经在 `policy.ts` 里了。
- **“总是允许”按钮、一次性许可的指纹**：点了“允许”，就是在对话里说一句同意，由分类器去认。不在系统里存规则。
- **`hub ask` 命令、“需要你回复”的标记**：“等你”靠的是会话都停下来了，agent 不用学新命令，也不用照固定格式写。
- **规定 agent 什么时候必须问用户**：照 11-04 的原则，这由 agent 按 `AGENTS.md` 自己判断。
- **网页关着时用 `osascript` 兜底弹通知**：M0 实测这种通知点了只会打开“脚本编辑器”，跳不过去（第 4 节问题 2）。
- **勿扰时段、通知开关、“待验收”攒着发**：先用着看看吵不吵，再说。
- **未读数**：“等你”只在整个项目经理都停下来时才出现，比未读数更少打扰。

## 2. 关键决定

### 2.1 现状：`auto` 档下，“要批准”几乎都变成了“直接拦下”

原来的设想是：分类器拦下的操作，交给 `PermissionRequest` 钩子挂起，等用户点。查了官方文档，这条路走不通：

- **分类器拦下，不触发 `PermissionRequest`**。拦下以后，Claude 收到原因，接着往下干（[permission-modes][cc-modes] 的 How the classifier evaluates actions 一节第 4 步）。这时触发的是 `PermissionDenied` 钩子，它只能回 `retry: true`，告诉模型“可以再试”，并不会撤销这次拦截。再试一次，还是要过分类器（[hooks][cc-hooks] 的 PermissionDenied 一节）。所以挂起等用户没有意义。
- **`-p` 模式下，连续拦 3 次或累计 20 次之后，也不会改成弹窗问人**：“the action doesn't run and Claude keeps working”（同一页的 Repeated-block thresholds 一节）。
- **其他会弹窗问人的情况，在 `auto` 档、`-p` 模式下也都不会弹**：
  - 删关键路径：`auto` 档直接拒绝，没有“由钩子放行”这一说（Critical-path removals in each permission mode 一节的表）；
  - 第一次读工作目录以外的文件：`-p` 模式下不问，直接读（The first read outside the working directories 一节）；
  - `ask` 规则：我们一条都没有。
- **被拦下的事件现成就有**：用 stream-json 输出时，“denials appear as `permission_denied` system messages”（[headless][cc-headless] 的 Turn off permission prompts in unattended runs 一节）。字段有 `tool_name`、`tool_use_id`、`decision_reason_type`（`rule`、`mode`、`classifier` 等）、`decision_reason` 和 `message`（[SDK 类型][cc-sdk-ts] 的 SDKPermissionDeniedMessage 一节）。这个事件是“尽力而为”的，`result.permission_denials` 才是全的。卡片晚一点出来没关系，所以只用这个事件，漏掉的也不去补。
- **用户在对话里同意，分类器会认**：“If you tell Claude that a blocked action is allowed, the classifier reads that as your approval and can clear the block”。同意的话要点名具体的动作和内容，而且只管这一次（[permission-modes][cc-modes] 的 Approvals you state in conversation 一节）。

**实测**（2026-11-04，`claude` 2.1.314 + haiku，`--permission-mode auto`，在一个一次性仓库里，远端是本地的裸仓库）：

1. 用户直接说“运行 `git push --force origin HEAD:main`”：没被拦，推送成功。分类器认用户的原话。
2. 让它“照 TODO.md 里写的做”，文件里写着强推：它自己停下来，在回复里问用户要不要做，也没被拦。

结论：被拦下的情况本来就少，更常见的是 agent 自己停下来问。所以 M4 把重点放在“停下来问”时能通知到用户（第 2.4 节）。卡片是给少数真被拦下的情况准备的快捷方式。

### 2.2 被拦下：卡片不挂起，这一轮照常结束

- **只给分类器的拦截做卡片**（`decision_reason_type === "classifier"`）。规则拦的不做卡片：比如 Worker 写记忆，拒绝规则先于一切，用户同意了也没用。只读 Worker 的 `dontAsk` 档拦的（`mode`），也不做。哪些类型做卡片，放在 `src/shared/blocked.ts` 的 `CARD_REASON_TYPES` 里统一定。
- **卡片上写什么**：
  - 哪个会话：项目经理自己，或者“Worker #3 · 标题”；
  - 工具和内容：Bash 显示命令原文，其他工具显示账本 `tool-summary.ts` 的那一行摘要；
  - 原因：`decision_reason`。
  - 工具的参数从同一轮的 `agent.tool` 里按 `toolUseId` 找到。去重键也是 `toolUseId`。
- **不挂起**：agent 收到拒绝原因后怎么做，由它自己定：换个办法、跳过，或者停下来问。这一轮照常结束。用户很久不回也没关系，卡片一直留着，没有超时。
- **“允许”**：往被拦的那个会话发模板消息，模板放在 `blocked.ts`：
  > 用户允许你做刚才被拦下的这一步：`<命令或摘要>`。还需要的话，可以重新执行。
  - 卡片改成“已允许”。
  - Worker 已经收工，或者会话已经结束的，按钮变灰，显示“已失效”。
- **“不用了”**：只改卡片的状态，不给 agent 发消息。它本来就已经知道被拒了。
- **拦不住的情况**：有些拦截，用户同意了也清不掉（[permission-modes][cc-modes] 的 Some blocks stay in place 一条）。这时 agent 会再被拦一次，再出一张卡片。卡片上能看到命令原文，用户可以自己去终端里跑。

### 2.3 “等你处理”放在哪：会话里的卡片，加上左栏的“等你”

- 卡片就放在项目经理的会话里。用户本来就在这里看 Worker 的汇报，不单独做收件箱页。
- 左栏每个项目经理那一行：有没处理的卡片，就显示一个数字；没有卡片、但这个项目经理在“等你”，就显示“等你”两个字。
- 标签页的标题前面加上总数：“(N) agent-hub”。N 是所有没处理的卡片，加上在“等你”的项目经理个数。
- **“等你”怎么算**：在网页里算。一个项目经理，同时满足下面几条，就算在“等你”：
  - 它的会话和它所有 Worker 的会话，`activity` 都是 `idle`；
  - 它的会话里没有 `queued`、`delivered`、`processing` 状态的消息；
  - 最后一条消息不是用户发的；
  - 用户上次看这个会话之后，又有了新消息。

  “上次看”指的是网页在前台、正开着这个会话。时间存在浏览器的 `localStorage` 里。“停着”要持续 `WAITING_SETTLE_MS`（3 秒）才算，避免 Worker 刚汇报、项目经理还没开始处理的那一瞬间被当成停了。
- 以后要在网页关着时也提醒（`osascript`），再把“等你”挪到守护进程里算。

### 2.4 agent 想问用户：普通回复就够了

- agent 想问什么、什么时候问，都由它自己定。它在回复里写出来，这一轮结束，所有会话都停下来，就进入“等你”，会弹通知。不用学新命令，也没有固定的格式。
- 提示词里只加一段**介绍能力**的话，不加规矩，放在 `prompt.ts` 的 `REACH_USER_NOTE`，项目经理和 Worker 都有：
  > 你的某一步被权限系统拦下时，用户会在界面上看到这一步，可以点“允许”，点了你会收到一条消息。你在回复里问用户的话，等你这边停下来以后，用户会收到提醒。

  Worker 的版本把第二句换成：“你的汇报会交给项目经理。”Worker 没有直接问用户的通道，这是 M3 的分工，不算流程上的规定。
- 不写“合并前必须问”“推送前必须问”这类话。

### 2.5 Worker 被拦下：直接给用户看

- 卡片直接出现在项目经理的会话里，标明是哪个 Worker。用户点“允许”，消息直接发给 Worker 的会话。不经过项目经理：经过它要多绕一轮，还要多一个命令。
- 项目经理照样能用 `hub worker send` 给 Worker 回话。它说的话在 Worker 的对话里也是一条“用户”消息，分类器可能也会认。这是 M3 就有的能力，M4 不限制，也不另加规定。
- Worker 自己停下来、在汇报里提问的，照 M3 交给项目经理。项目经理要不要再问用户，由它自己定。它问了，就会进入第 2.3 节说的“等你”。

### 2.6 通知

- **用什么弹**：浏览器的通知接口（`new Notification`）。M0 实验 8：`127.0.0.1` 算安全来源，可以申请通知权限。界面的端口固定是 4317（`DEFAULT_UI_PORT`），所以授权一次以后一直有效。
- **什么时候弹**：
  - 出现一张新卡片；
  - 一个项目经理从“在忙”变成“等你”。
  - 用户正看着这个会话的时候不弹：网页在前台，而且选中的就是这个会话。
  - 同一个项目经理只留最新的一条：`tag` 用项目经理的编号，新的一条会替换旧的。
- **点了以后**：`window.focus()`，选中那个项目经理的会话，滚到卡片。M0 没能自动验证点通知会不会跳回来，放进验收第 6 步，让用户手动看。
- **申请权限**：通知权限还是“没问过”时，左栏底部显示一个“开启通知”按钮，点了才申请（浏览器要求由用户的操作来触发）。用户拒绝过，就不再显示。
- 通知相关的代码都放在 `src/web/notify.ts`；可调的数，比如 `WAITING_SETTLE_MS`，放在它的开头。

## 3. 拆分

4 块，每块一个 Worker、一个 PR。W0 先做；W0 合并后，W1 和 W2 同时开工；W3 等两块都合并后再做。

```
W0 接口 ──┬── W1 守护进程：驱动层事件 + 账本卡片 + 界面接口 ──┬── W3 组装 + 提示词 + 端到端 + 冒烟
          └── W2 网页：卡片、等你、通知 ──────────────────────┘
```

**M4 新加的东西各放在哪**：

| 东西 | 放在哪 |
|---|---|
| 卡片的类型、哪些拦截做卡片（`CARD_REASON_TYPES`）、“允许”的消息模板、卡片上的那一行字 | `src/shared/blocked.ts`（新） |
| `permission_denied` 事件的解析 | `src/daemon/driver/protocol.ts`，事件类型在 `src/shared/driver.ts` |
| 建卡片、点允许、点不用了、标已失效 | `src/daemon/ledger/blocked.ts`（新） |
| 界面接口 `POST /api/blocked/:messageId` | `src/daemon/ui-server/server.ts`，路径在 `src/shared/api.ts` |
| 介绍能力的那段提示词 | `src/daemon/prompt.ts` 的 `REACH_USER_NOTE` |
| “等你”的计算、通知、`localStorage` 里的“上次看过” | `src/web/notify.ts`（新）；选择器在 `src/web/selectors.ts` |
| 设置文件、权限 | 不改，`policy.ts` 照旧 |

| 块 | 只改这些 | 依赖 |
|---|---|---|
| W0 接口 | `src/shared/`：`blocked.ts`；`domain.ts` 里 `MESSAGE_KINDS` 加 `blocked`；`driver.ts` 加 `PermissionDeniedEvent`；`api.ts` 加路径和请求体。`messages.kind` 没有 CHECK（`0001` 写明了），不用迁移 | 无 |
| W1 守护进程 | `driver/protocol.ts` 和 `claude-driver.ts`（转发事件）、`ledger/blocked.ts`（新）、`ledger/` 里接事件的地方、`ui-server/server.ts` | W0 |
| W2 网页 | `src/web/`：卡片组件、`Sidebar.tsx`、`notify.ts`、`selectors.ts`、`App.tsx` | W0 |
| W3 组装 | `daemon.ts`（接线）、`prompt.ts`、`test/fake-claude/`（加一个“被拦下”的剧本）、`test/e2e/m4.test.ts`、`test/smoke/m4.ts`、本文档 | W1、W2 |

### 测试表（TDD，先写测试）

**W0**

| 测什么 | 期望 |
|---|---|
| `blocked.ts` 的卡片判断 | `classifier` → 做卡片；`rule`、`mode`、没有类型 → 不做 |
| 模板 | Bash 用命令原文；其他工具用摘要；带反引号、很长的命令会转义、截断，但不会丢掉 |

**W1**

| 测什么 | 怎么触发 | 期望 |
|---|---|---|
| 解析 | 喂一行 `system/permission_denied` | 出一个 `permission.denied` 事件，字段都对；缺字段的不出错，也不出事件 |
| 建卡片 | 项目经理被 `classifier` 拦下 | 项目经理会话里一条 `kind: blocked`、`pending`，参数从同一轮的 `agent.tool` 里取 |
| Worker 被拦 | Worker 被拦下 | 卡片在项目经理的会话里，带 `workerId` 和标题 |
| 不做卡片 | `rule` 或 `mode` 类型 | 什么都不写 |
| 去重 | 同一个 `toolUseId` 来两次 | 只有一张卡片 |
| 允许 | `POST …/blocked/:id {action: allow}` | 给被拦的会话登记 `session.send`（sender `user`，正文是模板）；卡片变成 `allowed`；推送 `message.updated` |
| 不用了 | `{action: dismiss}` | 卡片变成 `dismissed`；不登记 `session.send` |
| 失效 | Worker 已经收工，再点允许 | 返回 `invalid`；卡片变成 `expired` |
| 重复点 | 已经处理过的卡片再点 | 返回 `invalid`，什么都不变 |
| 鉴权 | 不带界面令牌、带会话令牌 | 都拒绝（agent 不能替自己点允许） |

**W2**（用 jsdom，把 `Notification` 换成假的）

| 测什么 | 期望 |
|---|---|
| 卡片 | `pending` 的显示两个按钮，点了调接口；其他状态显示结果，没有按钮；Worker 的标明是哪个 Worker |
| 等你 | 项目经理和它的 Worker 都停下来 3 秒以后才算等你；只停 1 秒又开始忙的不算；有 Worker 在跑的不算；最后一条是用户发的不算；看过以后就不算了 |
| 左栏和标题 | 有卡片的显示数字；在“等你”的显示“等你”；标题前面是总数 |
| 通知 | 新卡片和变成“等你”时各弹一次；正看着这个会话时不弹；刚打开网页时本来就在“等你”的不弹；点通知会切到那个会话 |
| 申请权限 | 没问过时显示“开启通知”按钮，点了调 `requestPermission`；拒绝过就不显示 |

**W3 端到端**（真守护进程 + 假 `claude`）

| 测什么 | 期望 |
|---|---|
| Worker 被拦下：假 `claude` 的剧本先出一个 `agent.tool`，再出一个 `classifier` 类型的 `permission_denied`，然后结束这一轮 | 项目经理会话里有一张卡片；Worker 的汇报照常回到项目经理那里 |
| 点允许 | Worker 的会话收到模板消息，作为新的一轮（`--resume`）；剧本这一轮“做成了”；卡片变成 `allowed` |
| 关机重启 | 卡片的状态还在；没处理的卡片照样能点 |

**真 `claude` 冒烟**（`pnpm smoke`，用 haiku，在一次性的小仓库里，就一次调用）：

- **S15 事件的样子**：让一个 Worker 写 `AGENTS.md`，这一步会被记忆规则拦下（规则，不是分类器）。期望：
  - 驱动层收到 `permission_denied`，`decision_reason_type` 是 `rule`，字段名和第 2.1 节写的一样；
  - 没有出卡片。

  这样能确认我们读的事件在 `-p` 模式下真的有、字段名也对。分类器的拦截没法稳定地故意触发（第 2.1 节试过两次都没被拦），这一条由端到端测试里的假 `claude` 来覆盖。
- 不测“项目经理会不会来问”：什么时候问，由 agent 自己定，不是系统的行为。

## 4. 要用户拍板的问题

1. **Worker 被拦下时，问谁**：直接给用户看（卡片放在项目经理的会话里，点了直接发给 Worker），还是先交给项目经理，由它决定要不要再来问用户？**推荐**：直接给用户看（第 2.5 节）。分类器认的是用户的同意，绕一道项目经理，要多跑一轮，也多一个命令。
2. **网页关着的时候**：要不要用 `osascript` 兜底弹一下？弹出来点了也跳不到网页，只能写“去 agent-hub 看”。**推荐**：M4 先不做，网页开着就能收到通知；用一阵子再说。
3. **“等你”的判定**：项目经理和它的 Worker 都停下来，就算等你。好处是不用 agent 配合；坏处是项目经理只是做完了、没有问问题，也会提醒一次。**推荐**：就这样做，嫌吵再改（比如加一个 `hub ask`，让 agent 自己标）。
4. **“允许”的效果**：现在是发一句“用户允许你做……”，由分类器去认，系统里不存规则。也就是说同样的事下次可能还会被拦，还要再点一次。**推荐**：先这样。如果某一类操作老被拦，再考虑在设置文件的 `autoMode.allow` 里加规则（[auto-mode-config][cc-auto-config]），那时要用户点名加哪些。

## 5. 验收

M4 所有 PR 合并后，用户在本机：

1. `pnpm install && pnpm build && pnpm check`：全部通过。`pnpm start`，打开界面，M3 的项目经理、Worker 和聊天记录都在。
2. 左栏底部点“开启通知”，在浏览器弹出的窗口里点允许。按钮消失。
3. 跟一个项目经理说一件要派 Worker 的小事，然后切到别的应用。等它和 Worker 都做完：弹出“<项目经理名> 等你”的通知；左栏它那一行显示“等你”；标签页标题是“(1) agent-hub”。
4. 点通知：浏览器回到前台，打开的是这个项目经理的会话。“等你”消失，标题里的数字也没了。
5. 再说一句，然后一直看着这个会话，等它做完：不弹通知。
6. **被拦下的卡片**：真的分类器拦截没法稳定地故意触发，所以用假 `claude` 演示一次：
   - 跑 `AGENT_HUB_HOME=$(mktemp -d) AGENT_HUB_CLAUDE=<仓库>/test/fake-claude/… pnpm start`，具体命令由 W3 写进本节；
   - 新建一个项目经理，发“演示拦下”；
   - 期望：会话里出现一张卡片，弹出通知；点“允许”以后，会话里出现“做成了”，卡片变成“已允许”；再来一次，点“不用了”，卡片变成“已忽略”，agent 不会收到消息。
7. 平时真用的时候，如果遇到真的被拦下，卡片的样子和第 6 步一样。遇到了记下来，作为以后调整的依据。
8. `pnpm smoke`：S1～S6、S8～S15 全部通过。

[cc-headless]: https://code.claude.com/docs/en/headless
[cc-modes]: https://code.claude.com/docs/en/permission-modes
[cc-hooks]: https://code.claude.com/docs/en/hooks
[cc-sdk-ts]: https://code.claude.com/docs/en/agent-sdk/typescript
[cc-auto-config]: https://code.claude.com/docs/en/auto-mode-config
