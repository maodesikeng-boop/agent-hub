# 总助（Router）v1 方案

状态：方案，等用户拍板（第 10 节）。只写方案，不改代码。
行号以 `main@1d4715d` 为准。旧设计见 `docs/prototype-design.md` 第 2.1、3.2、3.3、5.2 节（11-02 写的，和现在的代码有出入，第 11 节列出）。

---

## 0. 一页结论

- **v1 只做三件事**：转给项目经理、自己答（进度、汇总这类）、拿不准就问你。**直接派 Worker、每日汇总推到 v2**（理由见第 1 节）。
- **不留长会话**：每条消息现拼上下文、调一次模型、按固定格式回答，用完就丢，和旧设计一致。能用规则判断的（`@项目经理名`、点了提问卡片上的选项、一个项目经理都没有）不调模型。
- **入口**：左栏最上面固定一行“总助”（在所有设备组上面），手机列表页同样在最上面。点进去是普通聊天页，没有右栏、没有 `/` 和 `@文件`。
- **转走的消息**：在项目经理那边就是**你说的一句话**，气泡上方一行小字 `Via Router`；总助这边回一张小卡“Sent to 小林 · agent-hub”，带跳转和 `Change` 按钮，**点一下选对的项目经理就改过去**。
- **跑在哪**：总助只有一个，放在**中心（东京）**；没连中心的电脑自己当总助。它的模型调用就在那台电脑上跑，用那台装好、登录好的厂商。
- **跨设备**：总助所在的守护进程用现有的设备令牌直接调目标设备的两个新接口（取“项目名片 + 进行中”、投递一条转来的消息），**不经过浏览器**，手机关了也照样送到。
- **不打架**：总助自己不记任何项目状态，只记“这条消息去了哪”。计划、优先级一律转给项目经理；总助答进度时现读各项目经理的账本。所以两边不会有两份计划。
- **花费**：规则命中 0 token、不到 0.1 秒；调模型一次约 4～8K 输入 token、150 输出 token，延迟约 3～8 秒（CLI 冷启动占一半）。所有列表都有上限，最坏约 12K 输入 token。启动时什么都不做，首屏只多一个对话。
- **统一**：分拣格式、提示词、上限各在一处；每家厂商只实现“一次性调用、按格式回答”一个方法，**优先用厂商自带的结构化输出**（claude `--json-schema`、codex `--output-schema`、agy `--json-schema`），没有的退到“只回 JSON + 我们自己校验”。厂商、模型名单都从现有名单读，不写死。
- **拆 4 个 PR**（第 9 节），和 #316、#328、#330、#332、厂商迁移 P3/P4 有交集，排在它们后面或单独约定。

---

## 1. v1 最小做什么

### 1.1 现状：代码里的“总助”做到哪一步（已核实）

| 位置 | 现在是什么 | 结论 |
|---|---|---|
| `migrations/0001_init.sql:19,31`、`0004_workers.sql:17` | 对话 kind、会话 role 的 CHECK 里有 `assistant` | 表结构允许，**一行数据都没建过** |
| `src/shared/domain.ts:35,96` | `CONVERSATION_KINDS`、`AGENT_ROLES` 有 `assistant` | 只有类型 |
| `src/daemon/launch.ts:55-56` | 不是 pm/worker 的会话直接抛错 | 总助**不能起进程**（正好，本方案也不需要它有长会话） |
| `src/daemon/ledger/hub-commands.ts:237-249` | 不是 pm/worker 的会话用 `hub` 一律 forbidden | 总助**不能用 hub**（本方案也不需要） |
| `src/daemon/ledger/messages.ts:329-330` | 发消息要求对话有会话，没有就抛错 | 往总助对话**发不了消息**，要改（第 9 节 PR1） |
| `src/web/selectors.ts:100-110`、`src/web/App.test.tsx:1170-1179` | 左栏列出非 Worker 的对话，没有项目经理的用对话标题 | 网页**已经能显示**一个叫“总助”的对话行，但没有固定在最上面 |
| `src/daemon/ledger/ledger.ts:175` 起 | 快照带所有非项目群的对话和最近 100 条 | 总助对话建出来就自动进快照 |
| `migrations/0008_schedules.sql` | 定时任务 `pm_id NOT NULL` | 定时任务**只能属于项目经理**，总助要用得改表 |

一句话：**只留了名字，没有任何行为**。

### 1.2 推荐的 v1 范围

| 做 | 理由 |
|---|---|
| 转给项目经理 | 总助存在的意义；跨设备也要能转 |
| 自己答（进度、等你的、在进行的、谁在忙什么） | 数据现成（项目、Worker、提问都在账本里），一次调用就能答 |
| 问你（拿不准、对不上任何项目） | 用现有的提问卡片（`hub ask` 那种带选项的卡），不新做控件 |
| 分错了一键改 | 没有它，自动转就不敢用 |
| 设置里选总助的厂商、模型、思考程度 | 不写死厂商 |

| 推到以后 | 为什么不放 v1 | 以后怎么做（备选） |
|---|---|---|
| 直接派 Worker | 绕过项目经理派活要在项目经理所在设备上新开一条建 Worker 的路，还要处理“项目经理正在派同一块”的冲突；v1 先看总助分得准不准 | v2 先做“转给项目经理并附一句‘这是个目标明确的小活，建议直接派’”，派活仍由项目经理用 `hub worker start`，零新路径；真要绕过项目经理再做 v3 |
| 每日汇总 | 定时任务表只认项目经理（`pm_id NOT NULL`），要改表；而项目经理现在已经能建日报（`hub schedule add`） | v2：定时任务加“属于哪个对话”，总助的汇总就是“到点在总助对话里自己答一次‘昨天完成 / 等你的 / 在进行 / 风险’”，复用同一条分拣调用，不另起会话 |
| 新建项目（对不上时卡片里的“新建项目”） | 新建项目经理弹窗已有，v1 卡片里放一个打开它的选项就够，不做“建好后自动转过去” | v2 再接“建好后把原话转进去” |
| 一次合并多条决定、主动找活、看门狗 | 个人用、消息量小 | 见第 8 节 DeepSeek 的做法 |

---

## 2. 入口和界面（只写结构，照 `docs/ui-standard.md`）

### 2.1 电脑

```
┌ 左栏 300px ─────────────────┐
│ [搜索]                       │
│ ★ 总助          Sorting…     │  ← 固定第一行（不进设备组，不参与按时间排序）
│ Needs You（跨设备，已有）      │
│ ▸ 这台 Mac                    │
│    小林  …                   │
│ ▸ 东京                        │
│    阿周  …                   │
└─────────────────────────────┘
```

- **行**：和项目经理的行同一个组件、同样高（第 16 条“左栏的行”）。头像用一个固定的图标头像（不占水果色，`Avatar neutral`）；名字是对话标题（存在库里，默认“总助”，和项目经理名字一样算内容，可改）；第二行是最后一条消息预览；右边标注沿用“等你确定”圆点（总助问你时）。分拣中显示状态词 `Sorting…`（新词，补进第 3 条措辞表）。
- **位置**：搜索框下面、“Needs You”上面，**不进设备分组**：总助管所有设备。窄屏 72px 头像栏里同样排第一个。
- **只有一台设备、还没用过总助**：照样显示这一行（空对话，点进去第一次发消息才建库里那一行），让人知道有这个入口。
- **总助所在设备离线**：行变灰（`opacity-60`），聊天页沿用第 16 条“别的设备离线”的提示和禁用输入框，不另做。

### 2.2 聊天页

- 和项目经理的聊天页同一个 `Conversation` 组件，差别：
  - **没有右栏**（总助没有 Piece）；
  - 顶栏：名字 + 设置按钮（打开设置里“总助”那一组）；
  - **输入框**：不出 `/` 命令和 `@文件`（总助没有工作目录），也不出 `/hub:worker`；打 `@` 弹出**项目经理列表**（跨设备，每行名字后面写设备名，样式同第 18 条弹出列表），选了就是“直接转给他”，不调模型。
- **总助的回复**有三种样子：
  1. **转走了**：一行小卡（`rounded-2xl bg-sidebar px-4 py-3`，同归档状态条的写法）：左边 “Sent to 小林 · agent-hub”（设备不止一台时后面加设备名），右边两个 ghost `sm` 按钮 `Open`（跳到那个项目经理的对话，定位到那条消息）、`Change`。下面一行 13.5px 灰字是理由（模型给的 `reason`，规则命中写“你点名了小林”）。
  2. **自己答**：普通 agent 消息（Markdown）。
  3. **问你**：复用 `hub ask` 的选项卡片（`AskCard`，`Messages.tsx:113`）：选项是最可能的 2～3 个项目经理 + `None of these`。点选项 = 发一条用户消息，规则直接认出来，不再调模型。卡片同时出现在 Needs You 里（选择器已经把非 Worker 对话的提问算进去）。
- **分拣中**：消息下面的状态行显示 `Sorting…`（同 `AgentStatus` 的位置），旁边 `Stop`（取消这次调用，消息标“已停止”）。

### 2.3 分错了怎么一步改

- 点卡片上的 `Change` → 浮层（`Popover`，第 11 条）列出所有项目经理（跨设备，最近说过话的在前，顶上一个搜索框）→ 点一个 → 完成。没有确认弹窗。
- 后台做两件事：
  1. 给新的项目经理投递同一句话（`Via Router`，见 2.4）；
  2. 原来那条：**还在排队、项目经理没看到**的，直接标“已取消”（现有的 `cancelled` 状态）；**已经送到**的，不撤回，给原项目经理补一条系统消息“用户说上一条不是给你的，已改给 阿周，不用处理”。
- 卡片原地变成 “Sent to 阿周 · …（changed from 小林）”。改派记一条纠正记录（第 3.6 节），以后可以看哪类消息老分错。
- 用户也可以不点 `Change`，直接回一句“不对，给阿周”——这是普通消息，`@阿周` 走规则、或者模型照样读得懂，效果一样。

### 2.4 转走的消息在项目经理那边

- 就是一条**用户消息**（`sender: user`），原文不改，状态、重试、停止都和你直接发的一样。
- meta 多一个 `routedFrom: { deviceId, conversationId, messageId }`；网页在气泡上方加一行 12px 灰字 `Via Router`（可点，跳回总助那条），补进第 17 条消息流。
- 写给项目经理 agent 时前面加一个标签（像 Worker 那边的 `USER_TO_WORKER_TAG`，见 `shared/worker.ts`）：“【经总助转来】”，让它知道这句话是从总助那里过来的、上下文可能不在本对话里。标签文字和别的提示词放在一起（`src/daemon/prompt.ts`）。
- 项目经理的提示词加一句：“经总助转来的消息就是用户本人的话，照常处理；觉得不归你管，直接说，不用转。”

### 2.5 手机外壳

- 列表页就是 `Sidebar layout="page"`（第 20 条），总助那一行跟着出现在最上面，不用另写。
- 聊天页同电脑，顶栏只有返回、头像名字；没有 Pieces 开关。
- `Change` 的浮层在手机上用底部抽屉（`ui/drawer.tsx`，和 Pieces 一样），点一项先关抽屉再改。
- 推送：总助问你（提问卡）照现有规则推（和项目经理的 `hub ask` 一样）；转走、自己答**不推**（你刚发的消息，人就在屏幕前）。

### 2.6 设置

- 设置 → General 里加一组 “Router”（第 9 条分组列表）：`Provider`、`Model`、`Effort` 三行，和新建项目经理弹窗里同一套下拉（同一个模型名单接口，按总助所在设备取）；一行 `Rules`（可展开的多行文本，你给总助加的规矩，比如“提到 NAS 的都给阿周”），存库里。
- 新词补进 `docs/ui-standard.md` 第 3 条措辞表：总助 → 内容（标题）；`Sorting…`、`Sent to X`、`Via Router`、`Change`、`None of these`、`Router`（设置组名）。

---

## 3. 分拣怎么做

### 3.1 整体流程

```
用户在总助对话发消息
  → 账本存消息（状态 queued），在同一个事务里登记动作 router.triage（现有动作队列，失败按退避重试、重启后接着做）
  → 规则（不调模型，见 3.2）命中？ ──是──▶ 直接得出决定
                                   └否─▶ 拼上下文（3.4）→ 一次性调用模型（3.3）→ 校验格式（3.5）
  → 账本按决定：写回复 / 写提问卡 / 登记 router.forward（同设备直接写，跨设备走第 4 节）
  → 写一条分拣记录（3.6），用户消息标 replied
```

- 分拣**一次只跑一条**。分拣进行中又来的消息排队；下一次把排队的几条**合成一条一起分**（和现在给 agent 的“【用户连发了 N 条】”同一个意思），一次调用、一个决定。不做一次多个决定（简单）。
- 每条消息最多调一次模型；格式不对**不重试**，直接退成“问你”（3.5）。

### 3.2 规则：不调模型

按顺序，先中先用：

| 规则 | 决定 |
|---|---|
| 一个项目经理都没有（所有设备） | 回固定的一句“还没有项目经理”，带 `New project manager` 选项 |
| 开头是 `@名字`（输入框弹出列表选的，或手打），名字唯一对上一个项目经理或项目 | 转给他；`@` 后面的正文原样转 |
| `@名字` 对上好几个（不同设备同名） | 问你，选项是这几个（带设备名） |
| 这条是在回答总助最近一张没回答的提问卡，正文正好等于某个选项 | 按选项办（转给他；`None of these` → 回“那这件事放哪？可以 `@` 一个项目经理，或者新建一个”） |
| 以 `/` 开头 | 回“总助不收命令，命令请发到项目经理那边”（总助没有厂商会话，命令没处发） |

规则都在一个文件里（`src/daemon/router/rules.ts`），加规则只加一行。旧设计里的“`#项目名`”“项目群里说话”“群里 @Worker”都不要了：没有项目群了，`@` 已经覆盖了“指定项目”。

### 3.3 调模型：哪家、哪个模型

- **用哪家**：设置里选的 Provider；没选过时用“总助所在设备上第一个装好、登录好的厂商”（顺序就是厂商名单的顺序，`VENDOR_SPECS` / 以后的 `VENDOR_LIST`），**不写死 claude**。名单、登录状态都从现有的模型名单接口（`/api/models`，`docs/vendor-availability-design.md`）读。
- **哪个模型、思考程度**：设置里选的；没选时是 Default（不传参数，用厂商默认）。界面上提示“分拣用快的小模型就够”，但不替用户选。
- **怎么调**：每家实现一个“一次性调用”方法（第 7 节），统一的入参：系统提示词、用户内容、输出格式（JSON Schema）、模型、思考程度、超时。约束：
  - **不给任何工具**（claude `--tools ""`，codex `-s read-only` + `--ephemeral`，agy 用它的计划模式 / 沙箱）；
  - 工作目录是数据目录下一个空目录（`<数据目录>/router/`），**碰不到任何项目文件**；
  - 环境变量去掉 `HUB_TOKEN`、`HUB_SOCK`（复用 `handover/forker.ts` 的 `withoutHubEnv`）；
  - 不落盘会话（claude `--no-session-persistence`、codex `--ephemeral`）；
  - 超时 `ROUTER_CALL_TIMEOUT_MS`（60 秒）后杀进程组（复用 `driver/process.ts` 的进程组清理），消息标失败，可点重试。

### 3.4 上下文拼什么、上限多大

顺序按“不常变的在前”排，claude 这类有提示缓存的厂商连续几条消息能吃到缓存：

| 段 | 内容 | 上限（写进 `limits.ts`） |
|---|---|---|
| 1. 规矩 | 固定提示词（`src/daemon/router/prompt.ts`）：你是谁、三种决定什么时候用、“改计划/定优先级/要动手的 → 转给项目经理”“拿不准就问”“只能从候选里选”，输出格式说明 | 约 1K token，固定 |
| 2. 你加的规矩 | 设置里的 `Rules` | `ROUTER_RULES_MAX_CHARS` = 2,000 字 |
| 3. 项目名片 | 每个项目经理一行：候选编号（`P1`、`P2`…，本次调用内有效）、名字、项目名、一句话说明（项目已有，≤200 字）、设备、在线与否、最后说话时间、有几个在干活的 Worker | 全名片最多 `ROUTER_MAX_PROJECT_CARDS` = 40 个（按最后说话时间取最近的），其余只列“编号 + 名字 + 设备”，最多 `ROUTER_MAX_PROJECT_NAMES` = 200 个；已归档的不列 |
| 4. 进行中 | 没收工的 Worker（标题 ≤80 字、属于谁、多久了、最近一次汇报的状态）；24 小时内收工的；没回答的提问（每条摘要） | 在干活 `ROUTER_MAX_OPEN_WORKERS` = 30；最近收工 `ROUTER_RECENT_ENDED_WORKERS` = 10；提问 `ROUTER_MAX_OPEN_ASKS` = 10；每条摘要 `ROUTER_ITEM_TEXT_CHARS` = 120 字 |
| 5. 最近几条 | 总助对话最近几条（含上一次转给了谁） | `ROUTER_RECENT_MESSAGES` = 6 条，每条 `ROUTER_RECENT_MESSAGE_CHARS` = 500 字 |
| 6. 新消息 | 用户这条（或合并的几条）；附件只给文件名 | `ROUTER_INPUT_MAX_CHARS` = 4,000 字（只截给分拣看，转出去的是全文） |
| 总上限 | 超了按 5 → 4 → 3 的顺序再砍 | `ROUTER_CONTEXT_MAX_CHARS` = 24,000 字（约 8～12K token） |

- 第 3、4 段的数据来自各设备的“名片”接口（第 4.2 节），由各自的账本现算，复用现有查询：项目和项目经理（快照里那几条 SQL）、Worker 列表（`ledger/worker-view.ts`，`hub worker list` 用的同一份）、没回答的提问（`answerAsks` 用的那条条件）。
- 不做缓存：每次分拣现取（一次几毫秒的 SQL + 每台设备一次 HTTP），省掉“数据变了缓存没跟上”的问题（`AGENTS.md` 第 1 件事）。

### 3.5 输出格式和校验

格式定义只有一份：`src/shared/router.ts` 里的 zod schema，用 zod 4 自带的 `z.toJSONSchema` 生成 JSON Schema 交给厂商（不手写两份）。

```ts
// 草稿
const routerDecision = z.object({
  action: z.enum(["forward", "answer", "ask"]),
  target: z.string().optional(),        // forward：候选编号，如 "P3"
  text: z.string().max(4000).optional(), // answer：回答；ask：问题
  options: z.array(z.string()).max(3).optional(), // ask：候选编号
  reason: z.string().max(200),
  confidence: z.enum(["high", "medium", "low"]),
});
```

代码再校验一遍（厂商的结构化输出也可能不完全守约）：

1. 解析不了 / 不合 schema → **不重试**，按“问你”处理：选项是最近说过话的 3 个项目经理，问题写“这件事归谁？”，分拣记录里记 `invalid_output` 和原文前 500 字（排查）。
2. `target`、`options` 不在本次候选编号里 → 同上。
3. `forward` 但 `confidence` 是 `low` → 改成“问你”，选项是 `target` 加名片里最近的两个。（这条是“拿不准就问”的代码兜底，不是新限制：模型自己说了拿不准。）
4. `answer` 但没有 `text` → 同第 1 条。

### 3.6 记录

新表 `router_routes`（迁移 `0019_router.sql`），一条消息一行：消息编号、走的规则名或 `model`、厂商和模型、决定、目标（设备、项目经理、对话、转过去的消息编号）、理由、把握、用时、token、被改到哪（改派时更新，不另开行）。分拣记录只在总助所在设备上；项目经理那边只有 `routedFrom`。

---

## 4. 多设备

### 4.1 总助跑在哪

| 情况 | 总助在哪 |
|---|---|
| 只有一台 | 本机 |
| 有中心（`docs/hub-tunnel-design.md`：东京当中心，Mac 用 ssh 连进来） | **中心**。连进来的电脑不建自己的总助，网页显示中心那个 |
| Tailscale 连法、没有中心 | 设置里选一台（默认最早配对的那台），存进设备清单同步 |

- 理由：中心一直开着，手机的入口也是它；中心能直接找到每台连进来的设备（第三台设备经中心中转的“块 F”还没做，Mac 找不到第三台，但中心找得到）；总助的聊天记录只在一处，不会分成两半。
- 总助的模型调用跑在中心上：中心要装好、登录好至少一家厂商（中心上本来就跑着项目经理，通常已满足）。设置里的厂商下拉按中心的名单列。
- 中心离线时：总助不可用（网页显示离线），**不自动换到别的设备**（换了聊天记录就分两处）。这时直接找项目经理照常能用。备选：以后做“中心离线时本机临时当总助，记录回头合并”，复杂，v1 不做。

### 4.2 转发怎么走

每台守护进程加两个接口（设备令牌可访问，不放进 `ENTRY_ONLY_API_PREFIXES`，`src/shared/api.ts:483`）：

| 接口 | 干什么 |
|---|---|
| `GET /api/router/brief` | 这台的项目名片 + 进行中（3.4 的第 3、4 段），已经按上限截好；响应最多 `ROUTER_BRIEF_MAX_BYTES` = 64KB，走现有的压缩 |
| `POST /api/router/forward` | 往某个项目经理的对话投递一条“经总助转来”的用户消息：`{ conversationId, text, clientId, routedFrom, attachmentIds? }`。走账本现有的发消息路径（去重、排队、投递全照旧），只是 meta 由服务端加 `routedFrom` |
| `POST /api/router/retract` | 改派时处理原来那条（2.3：排队中就取消，已送到就补系统消息） |

- 总助所在的守护进程用现有的设备间连接（`daemon/peers/transport.ts`：ssh 隧道 / tailnet、设备令牌、连接池）直接调，**不经浏览器**：手机发完锁屏，也照样送到。
- **不会重复送**：`clientId` 用 `router:<总助设备>:<总助消息编号>:<第几次改派>`，目标设备按现有的去重键（`userMessageDedupeKey`）认，重试多少次都只有一条。
- **目标设备离线**：`router.forward` 动作按现有退避重试（`ACTION_RETRY`）；总助的卡片显示 “Waiting for 东京 to come online…”，连上后自动送达、卡片更新。用户也可以 `Change` 改给别人。
- **名片取不到的设备**：上下文里写“这台离线，项目只有名字”（名字来自上次成功取到的设备清单），模型照样能选它，转发进重试。名片接口每台 `ROUTER_BRIEF_TIMEOUT_MS` = 3 秒，并发取，慢的不拖其他。
- **附件**：总助对话里的附件在中心上；转到别的设备时，先用现有上传接口（`/api/uploads`，20MB 流式）传到目标设备，拿到编号再投递。传不过去就只转文字，后面附一句“附件留在总助那边”。
- 本机的项目经理：不走 HTTP，直接调本机账本（同一个函数，传输层换一下）。

---

## 5. 和项目经理不打架

- **记录只有一处**：项目的一切（计划、Worker、提问、定时任务）都只在项目经理所在设备的账本里。总助**不存项目状态**，只存“哪条消息去了哪”（3.6）。所以不管你从总助还是直接找项目经理，最后落到的都是项目经理对话里同一串消息。
- **总助没有写权限**：它能做的只有三件事——回你话、问你、往项目经理对话里投一条你的原话。它不能派 Worker、不能改计划、不能建删定时任务、不能用 `hub`（现有限制，`hub-commands.ts:241`，不用改）。
- **计划冲突怎么办**：
  - 你让总助“把 A 项目的 X 往后放”→ 这是改计划，规矩要求转给 A 的项目经理，总助不自己答应。
  - 总助答进度时说的都是现读的账本（“小林那边 Worker 3 在做 X，已 20 分钟”），不是它自己的判断；以项目经理为准。总助的回答末尾带上数据时间（“截至 10:32”）。
  - 你和项目经理已经在聊同一件事、又在总助那边说了一句：转过去就是那个对话里的下一句，项目经理有完整上下文，自然接上。
- **项目经理觉得转错了**：它直接在对话里说“这不归我”，你点总助卡片上的 `Change` 改走。v1 不让项目经理自己把消息“转回”总助或转给别人（要给项目经理开新命令，先看有没有必要）。

---

## 6. 性能（必写）

### 6.1 每条消息花多少

| 情况 | token | 延迟（估计，PR1 实测后写进 PR） |
|---|---|---|
| 规则命中，同设备 | 0 | < 50ms（一个事务） |
| 规则命中，跨设备 | 0 | 50～300ms（隧道里一次 HTTP） |
| 调模型，典型（10 个项目、5 个在干活的 Worker） | 输入约 3.5K（规矩 1.2K + 名片 1K + 进行中 0.4K + 最近几条 0.8K + 新消息 0.2K）+ 厂商 CLI 自带的部分；输出约 150 | CLI 冷启动 1～3s + 小模型推理 1～4s ≈ **3～8s** |
| 调模型，最坏（触到所有上限） | 输入约 12K + CLI 自带部分；输出 ≤ 600 | 同上，多 1～2s |
| 名片接口（每台） | — | 几毫秒 SQL；响应 < 64KB |

- 厂商 CLI 自带的部分：claude 用 `--system-prompt` 换掉默认的大提示词、不给工具，开销小；codex `exec`、agy `-p` 各有自己的基础提示词，PR1 量出来写进 PR。
- 对照：DeepSeek 的 Router 单次请求约 2.5 秒（第 8 节），我们多一个 CLI 冷启动。若实测冷启动太慢，备选是“总助保留一个闲置自动关的进程”（现有 `IDLE_CLOSE_MS` 那套），但那就是半个长会话，v1 不做。

### 6.2 数据多了怎么封顶（按跑一个月：几十个项目、300 个已收工 Worker、3 万条消息）

| 会变多的东西 | 封顶 |
|---|---|
| 项目名片 | 全名片 40 个 + 只有名字 200 个；按最后说话时间取，查询带 `LIMIT` |
| 已收工 Worker | 只取 24 小时内收工的 10 个（`ORDER BY updated_at DESC LIMIT`），300 个历史的不进上下文；`workers` 表几百行全表扫描也在 1ms 内，不加索引 |
| 消息 | 只取总助对话最近 6 条（走现有 `messages_conversation` 索引）；3 万条消息不影响 |
| 没回答的提问 | 10 条；查询按对话 + `json_extract`，和 `answerAsks` 一样有 `LIMIT` |
| 名片接口响应 | 64KB 硬上限，超了按 3.4 的顺序截 |
| 分拣记录 `router_routes` | 一条消息一行，一个月几百行；跟总助对话的消息一起按 30 天清理（和 #332 的规则对齐，见第 9 节） |
| 内存 | 不建任何 Map 缓存；分拣队列最多 `ROUTER_QUEUE_MAX` = 20 条（超了的直接合并进下一次，不丢） |
| 一次性调用的输出 | 读 stdout 最多 `ROUTER_OUTPUT_MAX_BYTES` = 256KB，超了杀进程按格式错误处理 |

要加进 `src/shared/limits.ts` 的常量（一处）：`ROUTER_CALL_TIMEOUT_MS`、`ROUTER_RULES_MAX_CHARS`、`ROUTER_MAX_PROJECT_CARDS`、`ROUTER_MAX_PROJECT_NAMES`、`ROUTER_MAX_OPEN_WORKERS`、`ROUTER_RECENT_ENDED_WORKERS`、`ROUTER_MAX_OPEN_ASKS`、`ROUTER_ITEM_TEXT_CHARS`、`ROUTER_RECENT_MESSAGES`、`ROUTER_RECENT_MESSAGE_CHARS`、`ROUTER_INPUT_MAX_CHARS`、`ROUTER_CONTEXT_MAX_CHARS`、`ROUTER_BRIEF_MAX_BYTES`、`ROUTER_BRIEF_TIMEOUT_MS`、`ROUTER_QUEUE_MAX`、`ROUTER_OUTPUT_MAX_BYTES`。

### 6.3 会不会拖慢启动和首屏

- **启动**：什么都不做。不预热、不探测模型（名单沿用现有的按需查询和缓存），没有定时器（v1 没有每日汇总）。重启后没分完的消息由动作队列接着做（现有机制）。
- **首屏**：快照多一个对话（总助那一个，带最近一页消息，按 #316 瘦身后的规则走，和项目经理对话同等对待）。名片、设置都是按需拉（设置用 react-query，打开设置才拉）。左栏多一行。
- **网页引用稳定**：总助行从现有的左栏选择器里挑出来固定到最上面，沿用那里按输入对象缓存的写法（`selectors-cache.test.ts` 加一条：总助行输入没变返回同一个引用）。
- **验证**：PR1 用 pstack 的 `benchmark-checklist` 量三家各 20 次分拣的 p50/p95 延迟和 token；PR2 用 `perf-issue` 对比首屏快照大小、左栏渲染次数，数字写进 PR。

---

## 7. 统一（必写）

- **一处定义**：
  - 决定的格式：`src/shared/router.ts`（zod，网页和守护进程都引）；
  - 提示词：`src/daemon/router/prompt.ts`（规矩、标签“【经总助转来】”、项目经理那句补充都在这）；
  - 规则：`src/daemon/router/rules.ts`；
  - 上限：`src/shared/limits.ts`；
  - 流程（取名片 → 规则 → 调用 → 校验 → 执行）：`src/daemon/router/triage.ts`，不知道任何厂商名。
- **每家只实现一个方法**：“一次性调用、按格式回答”。接口草稿：

  ```ts
  interface VendorOneShot {
    run(input: {
      system: string; user: string; schema: object; // JSON Schema（z.toJSONSchema 生成）
      model: string | null; effort: string | null;
      cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
    }): Promise<{ raw: string; json: unknown | null; usage: TokenUsage }>;
  }
  ```

  - 厂商迁移（`docs/vendor-plugin-design.md`）之后，它就是 `VendorDaemon` 里的一个**可选能力** `oneShot`，放在 `src/vendors/<厂商>/daemon.ts`；迁移之前，按 `handover/forkers.ts` 的写法放一张按家登记表（键是厂商名单，加厂商漏填编译不过），P3 搬家时一起挪。
- **优先用厂商自带的，自己造的只当兜底**：

  | 厂商 | 自带的结构化输出（优先） | 出处 |
  |---|---|---|
  | claude | `claude -p --output-format json --json-schema <schema> --tools "" --no-session-persistence` | 本机 `claude --help`；t3code `apps/server/src/textGeneration/ClaudeTextGeneration.ts:217-240` 同样这么调 |
  | codex | `codex exec --ephemeral -s read-only --output-schema <文件> --output-last-message <文件> -` | t3code `CodexTextGeneration.ts:300-320`；本机没装 codex，PR1 在东京上实测 |
  | agy | `agy -p --output-format json --json-schema <schema>` | 本机 `agy --help`（`--json-schema`：“enforce structured output”） |

  兜底两层：① 厂商没有结构化输出参数 → 提示词里要求“只输出一个 JSON 对象”，我们取第一个 JSON 对象再用 zod 校验；② 厂商连一次性命令都没有 → 用它必有的会话驱动（`createDriver`）起一个临时只读会话、跑一轮、收文字、结束（只读用现有 `readonly-policy.ts` / OS 沙箱）。两层兜底都走同一个 3.5 的校验。
- **名单不写死**：总助设置里的 Provider 下拉按厂商名单循环、按设备上的登录状态灰掉；Model 下拉读现有模型名单接口。**新加一家厂商**：实现了 `oneShot` 就用自带的；没实现就自动走兜底 ②，下拉里照样出现。新模型进了名单就能选，不用改总助的代码。
- 守卫：`src/shared/vendor-guard.test.ts` 的范围加上 `src/daemon/router/`，保证这里不出现厂商名。

---

## 8. 对标

| 做法 | 它怎么做 | 我们学什么 | 不学什么、为什么 |
|---|---|---|---|
| **DeepSeek Super-agent**（文章：<https://x.com/DeepSeekHarness/article/2116857257245987236>，2026-11-01；原型：<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md>） | 常驻 Router（main Session）收所有消息，自己不干活、可以用轻量模型；先程序规则（Fast Path）再模型判断；决定是“新建工单 / 挂到已有工单 / 停 / 忽略”；Worker 订阅自己的线程，后续消息直通、不再过 Router（去掉直通，Router 决定数 +30%、缓存读 token +37%）；消息堵时把积压的合成一次调用（单次 2.5s→3.9s，单个决定分摊 6.4s→1.6s）；推断出来的活默认只观察（observe），不自动接 | ① 规则在前、模型在后；② 轻量模型就够；③ **直通**：转走后卡片上给 `Open`，后续直接去项目经理那边聊，不必每句都过总助；④ 分拣中来的消息合成一次 | 不要常驻主会话：个人用、跨项目消息少，常驻会话越聊越长反而影响分拣（旧设计 2.1 的理由仍成立），且每条都多付缓存读；不做“主动找活 / 看门狗”；不默认 observe：个人工具，自动转 + 一键改更省事（见拍板 2） |
| **OpenAI Agents SDK 的 handoff**（<https://openai.github.io/openai-agents-python/handoffs/>、<https://developers.openai.com/api/docs/guides/agents/orchestration>） | triage agent 把对话**交出去**，接手的专家成为后面的主角；交接时可带结构化数据（`input_type`，如 reason、priority），可以过滤历史（`input_filter`）；文档区分“交出去”和“manager 留着控制权、把专家当工具” | 我们就是“交出去”：转走后项目经理是主角，总助不留着控制权；交接带结构化的 `routedFrom` 和理由；只交原话、不把总助的历史塞给项目经理（同它的 `input_filter`） | 不用它的“专家当工具、manager 汇总回答”：那要总助等项目经理干完再转述，等于又一个长会话 |
| **t3code 的 TextGeneration**（`/tmp/t3code-provider`，`main@9e12eca`：`apps/server/src/textGeneration/*.ts`、`packages/shared/src/serverSettings.ts:95-115`） | 每家 provider 一个“一次性生成”实现，统一接口；claude 用 `-p --json-schema --tools ""`，codex 用 `exec --ephemeral -s read-only --output-schema`；用户可在设置里选生成用的 provider 和模型，没选时按 provider 给默认；provider 有 `supportsTextGeneration` 能力位 | 一次性调用做成**按家可选能力**，公共代码只认接口；各家的具体参数几乎可以照搬；设置里单独选“总助用哪家哪个模型” | 不学它“没选时按家写死一个默认小模型”（`DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`）：我们不写死模型，没选就用厂商默认，让用户自己挑；不学它没有能力就不让选：我们有驱动兜底 ② |
| **Grok Bot 的 primary Bot**（<https://docs.x.ai/grok-bot/bots>） | 一个置顶的主 Bot 是主要入口，“问它有什么新进展，它替所有 Bot 回答”，还能主动来找你、协调别的 Bot | 置顶一个入口；“问进度它替所有项目回答”就是我们的“自己答” | 不学它自己也干活、主动来找你（v1 只分拣和答简单问题，主动推送放每日汇总里再说） |

---

## 9. 拆 PR

每个 PR 先写测试（`AGENTS.md` 流程）。本机跑 `pnpm typecheck` + 改到的测试文件；CI Ubuntu 4 路。

| PR | 内容 | 改哪些文件 | 怎么验收 |
|---|---|---|---|
| **PR1 单设备后端** | 迁移 `0019_router.sql`（`router_routes`；总助设置：厂商、模型、思考程度、规矩；第一次发消息时建 `assistant` 对话）；往总助对话发消息走分拣而不是 `session.send`；动作 `router.triage`、`router.forward`（本机）；规则、上下文、提示词、校验；三家 `oneShot` + 兜底 ①；`limits.ts` 加常量 | 新增 `migrations/0019_router.sql`、`src/shared/router.ts`、`src/daemon/router/{triage,rules,context,prompt,oneshot-*}.ts`、`src/daemon/ledger/router.ts`；改 `src/shared/{limits,actions,domain,api}.ts`、`src/daemon/ledger/{messages,ledger}.ts`（发消息按对话 kind 分流、`routedFrom` meta）、`src/daemon/prompt.ts`（标签、项目经理那句）、`src/daemon/daemon.ts`（装配）、`src/daemon/ui-server/server.ts`（设置读写接口） | 假厂商测试：规则 5 条、三种决定、格式错误退成问你、低把握退成问你、合并连发、重启后接着分、去重；真厂商冒烟（三家各一次，东京跑 codex）；延迟和 token 数写进 PR |
| **PR2 界面** | 左栏固定总助行；聊天页（无右栏、`@` 选项目经理、没有 `/`）；转走卡片 + `Open`；提问卡复用；项目经理那边 `Via Router`；设置里 Router 一组；手机外壳跟着走；`ui-standard.md` 补词和条目 | `src/web/components/{Sidebar,Conversation,Messages,SettingsDialog,Composer}.tsx`、`src/web/{selectors,shell-model,composer-trigger,composer-suggest}.ts`、`src/web/mobile/MobileShell.tsx`（大概率不用改）、`docs/ui-standard.md`、对应测试 | 截图（电脑、窄屏、手机 390×844）；`selectors-cache.test.ts` 加引用稳定；首屏快照大小、渲染次数对比 |
| **PR3 多设备** | `GET /api/router/brief`、`POST /api/router/forward`、`POST /api/router/retract`；总助放哪（中心 / 本机 / 设置选）；跨设备取名片、转发、附件转传、离线重试 | 新增 `src/daemon/router/{brief,remote}.ts`；改 `src/daemon/ui-server/server.ts`（路由）、`src/shared/api.ts`（接口形状、路径）、`src/daemon/peers/`（只调用现有传输，不改协议）、`test/e2e/`（两台守护进程的用例，用现有 `loopback-daemon.ts`） | e2e：Mac 发 → 东京总助 → 转给 Mac 的项目经理；目标离线时排队、上线后送达且只一条；名片超时不拖慢 |
| **PR4 改派** | `Change` 浮层 / 抽屉；改派的两件事（新的投递、原来的取消或补系统消息）；纠正记录 | `src/web/components/Messages.tsx`、`src/web/ui/`（Popover 已有）、`src/daemon/router/triage.ts`、`src/daemon/ledger/router.ts` | 排队中改派 → 原消息“已取消”；已送达改派 → 原项目经理收到系统消息；卡片原地更新 |

v2 以后（不在本轮）：每日汇总（定时任务加“属于哪个对话”，要改 `schedules` 表）、“建议直接派”的转发、真正的直接派 Worker、分拣结果统计页。

### 9.1 和正在进行的工作冲突的地方

| 在跑的工作 | 冲突点 | 怎么排 |
|---|---|---|
| **首屏瘦身（Worker #316，改初始快照）** | 总助对话要进快照；#316 若改了快照里对话怎么带消息，总助对话要按项目经理对话同等对待。PR2 的左栏选择器也是 #316 改的地方（`web/selectors.ts`） | PR1 不碰快照代码（总助对话靠现有 `kind != 'project_group'` 自然进来）；**PR2 排在 #316 合并之后**，并请 #316 在快照里把 `assistant` 当 `pm` 处理 |
| **`/hub:worker` 第三部分（#328，输入框和消息）** | PR2 要改输入框（总助里不出 `/`、`/hub:worker`，`@` 改成选项目经理）和 `Messages.tsx`（转走卡片、`Via Router`）；PR1 改 `ledger/messages.ts` 的发消息（#328 可能也动 workerPick 那段，`messages.ts:326-339`） | **PR2 排在 #328 之后**；PR1 的 `messages.ts` 改动只在开头按 kind 分流，不碰 workerPick 那几行，冲突小 |
| **后台自动拉起（#329）** | 无直接冲突；总助不加启动时的事 | 不用排 |
| **残留进程清理（#330）** | 总助的一次性 CLI 进程要能被认出、关机时杀干净、不被当成残留误杀或漏杀 | PR1 起进程时沿用 #330 定的识别办法（进程组、环境变量标记），**PR1 排在 #330 之后**，或者 PR1 先合、#330 把 router 进程算进去 |
| **worktree 清理（#331）** | 总助没有 worktree | 不冲突 |
| **对话 30 天清理（#332）** | 总助对话的老消息和 `router_routes` 要跟着 30 天清；**总助对话本身不能被当“不活跃对话”删掉**；`routedFrom` 指向的总助消息被清后，`Via Router` 点了要能处理“找不到” | 请 #332 把 `assistant` 对话当 `pm` 对待（只清消息、不删对话）；PR1 的 `router_routes` 清理挂到 #332 的同一个定时清理上 |
| **厂商迁移（`docs/vendor-plugin-design.md` P2～P5）** | `oneShot` 是 `VendorDaemon` 的新可选能力；P3 搬各家代码进 `src/vendors/<厂商>/`；P4 动 `limits.ts`、`shared/api.ts`、`ui-server/server.ts` | 若 P3 已近合并：**PR1 排在 P3 之后**，直接写进各家 `daemon.ts`；否则 PR1 按 `FORKERS` 的写法放登记表，P3 一起搬。`limits.ts`、`api.ts`、`server.ts` 和 P4 冲突，谁后合谁解，改动都是加几行 |

---

## 10. 要用户拍板的问题

1. **v1 先只做“转给项目经理 + 自己答 + 问你”，直接派 Worker 和每日汇总以后再做？**
   推荐：是。先看总助分得准不准；派活现在由项目经理做得好好的，绕过它要多一条路还要防“两边同时派”。每日汇总现在可以让项目经理用定时任务做（已有）。
2. **分完了直接转，还是每次先给你看一眼再转？**
   推荐：把握高的直接转，卡片上一个 `Change` 一步改；拿不准的才问你。只有你一个人用，每次确认就失去了“丢一句就走”的意义。（DeepSeek 默认只观察不自动做，是因为它面对的是团队群聊和陌生人。）
3. **总助用哪家、哪个模型？**
   推荐：默认用总助那台电脑上第一个能用的厂商、厂商默认模型，**建议你在设置里换成快的小模型**（分拣只要读懂一句话、选个项目，大模型多花钱多等几秒）。不替你写死。
4. **总助放在哪台电脑？**
   推荐：放东京（中心，一直开着，手机也是连它）；Mac 只在没连东京时自己当总助。东京离线时总助用不了，但直接找项目经理不受影响。
5. **转过去的那句话，在项目经理眼里算“你说的”还是“系统转来的”？**
   推荐：算你说的（和你直接发的一样会被处理、可以重试），只在上面加一行小字“经总助转来”。这样项目经理不会把它当成可以忽略的通知。
6. **分错了改派时，原来那位已经开始处理了怎么办？**
   推荐：不硬撤回，只给它补一句“这条转错了，不用处理”；还没看到的就直接取消。硬撤回要打断它正在跑的那一轮，可能把它手上别的事一起打断。

---

## 11. 旧文档和代码不一致的地方（只列出，不改旧文档）

| 文档 | 写的 | 实际 |
|---|---|---|
| `prototype-design.md` 2.1 | 规则有“`#项目名`”“项目群里说话”“群里 @Worker” | 项目群 11-03 拿掉了；本方案用 `@项目经理名` 代替 `#项目名` |
| `prototype-design.md` 2.1、5.2 | 工单、工单卡片、总助建工单 | 没有工单，Worker 一次派活一条记录（`domain.ts` 的 `WorkerRecord` 注释），工单卡片没做 |
| `prototype-design.md` 2.1、5.2 | 调一次 `claude` | 现在三家厂商；本方案按厂商名单选 |
| `prototype-design.md` 3.3 | 输入框“在总助那里打 `#` 弹出项目列表” | 输入框的 `@` 现在是文件；本方案在总助里把 `@` 改成选项目经理（总助没有文件） |
| `prototype-design.md` 4.1 | 界面只听 127.0.0.1，一台 Mac | 多设备、中心、公网入口（`multi-device-design.md`、`hub-tunnel-design.md`） |
| `prototype-design.md` 10 | “总助的每日汇总放到 M7” | 定时任务表 `pm_id NOT NULL`，要改表才能给总助用（本方案推到 v2） |
| `src/shared/domain.ts:822,868` 注释 | “总助、Worker 的会话是 null”（暗示总助有会话） | 本方案总助**没有会话**（不建 `agent_sessions` 行）；PR1 顺手改注释 |
| `multi-device-design.md` 0 | “不做跨设备派活” | 本方案跨设备的是“投递一句话”，不是派活，不冲突；派活仍在项目经理本机 |
