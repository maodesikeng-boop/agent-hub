# 切换厂商直接切对话、不写交接（方案）

> 状态：已拍板落地（定案：保底字数上限翻倍调高至 `240,000` 字，其余按方案执行）
> 范围：项目经理（PM）跨厂商切换上下文重建、与 240K 自动换代协同、聊天流与资料页状态展示，以及总助（Router）跨厂商切换核查；覆盖全部 6 家已接入厂商（`claude, agy, codex, pi, deepseek, cursor`）。

## 0. 一页结论

- **切换厂商不是“换代”，不写交接、不借旧交接凑数**：用户在项目经理资料页把厂商从 A 切到 B（如 `Claude Code → Codex`）时，后台在同一事务内 0 秒切到新会话，直接把**旧会话当前这一代脑子里装的内容**按原时间顺序搬给新厂商。
- **只搬“当前这一代”，绝不翻上辈子旧账，也绝不腰斩本代汇报**：
  - 从未发生过换代的 PM：从第 1 条消息起，把本对话全部用户原话（含上传附件本机路径）、PM 回复（含提问卡片选项）、系统事件通知、以及**每一份 Worker 汇报完整原文**原样喂给新厂商；
  - 发生过真实换代（满 `240K` 自动换代或用户手动点 `New session`）的 PM：只带**那次换代留下的摘要底座 + 换代切点之后的全部本代消息与 Worker 汇报全文**，彻底砍掉“跑去老切点之前重复挖 3 万字陈年旧话”的旧逻辑；
  - 末尾实时附上当前名下**未完结任务图最新状态**（弥补跨厂丢失的工具输出）与本代可读旧会话原始记录路径。
- **连续来回切厂商（A → B → C → A）100% 幂等无套娃**：每次切换都从 SQLite 账本的“本代起点”干净重建同一份本代上下文，不把上一次切换的开场包再套一层，聊天流里也不再冒出假的/陈旧的 `Handed off to a new session ›` 折叠卡。
- **窗口保底与缓存稳定**：新增 `VENDOR_SWITCH_CONTEXT_MAX_CHARS = 240_000` 保底上限（按用户拍板定案调高至 24 万字，覆盖满 `240K` 自动换代前的完整一代纯对话与汇报零截断，同时守住首轮上限防极端异常爆窗）；首轮注入后永久固化在原厂会话第 1 轮历史中，第 2 轮起 `sessionPreamble` `O(1)` 返回 `null`，前缀缓存命中率稳定在 90%～99%。

---

## 1. 从用户视角看完整体验（新 PM 切厂商 / 自动换代后切厂商 / 连续来回切三次 / 刚收到 Worker 汇报立刻切厂商）

### 1.1 一句话看懂改前 vs 改后

拿一天里聊了 **100 句**话打比方（中午第 50 句时因为上下文满 24 万 token 自动换过一次会话、写过一份《中午摘要》；下午又聊了第 51～100 句，期间收到了 Worker 的完整汇报）：

```text
第 1 句 ──────── 第 50 句（中午自动换代，已有《中午摘要》）──────── 第 100 句（下午你点切换厂商）
   └─ 早上旧账（已浓缩进《中午摘要》）─┘      └────── 下午本代新对话 + Worker 完整汇报 ──────┘
```

- **改前（拧巴的“假交接”做法）**：
  1. 塞入《中午摘要》；
  2. **多此一举跑回第 50 句前面，把早上第 20～50 句（3 万字）早就被总结过的陈年旧话又挖出来重塞一遍**，白占上下文还拿过期进度干扰新模型；
  3. **把下午第 51～100 句期间收到的所有 Worker 汇报正文全删掉，裁成一行干瘪目录**，导致你刚看到 Worker 交活就切厂商时，新厂商对汇报细节一问三不知；
  4. **聊天流里凭空冒出一条 `Handed off to a new session ›` 分隔线**，点开一看居然还是中午甚至几天前早就过期的旧摘要。
- **改后（直接切对话、原样继承本代）**：
  1. 只带**《中午摘要》+ 下午第 51～100 句的全部原话与每一份 Worker 汇报完整原文 + 当前任务图实时状态**；
  2. 早上第 50 句之前的旧账一个字不再重复翻；下午的汇报一个字不删减；
  3. 0 秒切完，聊天流里只留一行干净的 `你改了 <PM> 的设置（厂商：Claude Code → Codex）`，不再冒出任何假交接卡片，接着说话就像没换过人一样。

### 1.2 切换前后体验全景对比

| 用户感知的维度 | 改前（复用 `direct` 交接） | 改后（原样继承本代上下文） |
| --- | --- | --- |
| **切换速度** | 0 秒（空闲时） | **0 秒**（空闲同事务当场切；在忙则等当前这一轮回完无缝切） |
| **上辈子的旧话** | 往上次交接切点前硬挖 **3 万字**已总结过的过期旧话 | **0 字**，绝不翻上辈子旧账 |
| **本代收到的 Worker 汇报** | 正文被砍光，只剩一行目录（模型不主动查就失忆） | **每一份汇报八栏完整原文按时间原序原样保留** |
| **本代系统通知（交付单、定时任务、超时提醒）** | 漏掉（只取了 `user` / `agent` 纯文本） | **按时间原序完整保留**（含任务图待交付汇总单） |
| **你发过的截图与附件** | 保留本机路径 | **原样保留本机完整绝对路径**，新厂商需要时直接按路径看图/读文件 |
| **手头未完结的任务图** | 附在末尾 | **实时附上名下活跃任务图最新节点状态、PR 与定案** |
| **网页聊天流外观** | 每次切厂商都多出一条 `Handed off to a new session ›`，点开是陈旧旧摘要 | **干净无假折叠卡**，只有一行设置修改提示（支持 `Undo`） |
| **资料页等待提示（旧会话在忙时）** | 下方 `New session` 按钮误转圈显示 `Handing off…` | 上方 `Provider` 行如实显示 `Switching to Codex…`，下方按钮不误报交接 |

### 1.3 四种典型场景：新厂商脑子里到底装了什么？

#### 场景一：新 PM 切厂商（从建好起还没满过 240K 自动换代）
- **你的操作**：新建项目经理聊了 30 轮，Claude 额度快满了，你在资料页把 `Provider` 改成 `Codex` 点 `Save`，回到聊天框直接发第 31 句。
- **网页上看到什么**：保存瞬间生效，聊天流里多一行极淡的 `你改了项目经理的设置（厂商：Claude Code → Codex）`，没有交接分隔线。
- **Codex 脑子里装了什么**：
  1. 系统提示词 + 最新性格设定（`MEMORY.md`）+ 仓库 `AGENTS.md` 与技能；
  2. **第 1～30 轮按时间原序排列的全部对话原话、附件本机路径、系统通知与所有 Worker 汇报全文**（没有任何交接摘要，因为本来就是第一代）；
  3. 当前名下未完结任务图实时状态 + Claude 旧会话 `.jsonl` 原始记录路径（万一需要查某次工具输出可去翻）；
  4. 你刚发的第 31 句。

#### 场景二：自动换代后切厂商（早上自动换过代，下午切厂商）
- **你的操作**：早上聊满 240K 自动换过一次会话（生成过一份《早间换代摘要》，当时在聊天流里留下了一条真实的换代分隔线）；下午又聊了 40 轮，把厂商从 `Codex` 切到 `Antigravity`。
- **网页上看到什么**：早上的那条真实换代分隔线照常留在早上位置；下午切厂商处**不会**再冒出第二条复读早上旧摘要的假分隔线。
- **Antigravity 脑子里装了什么**：
  1. 系统提示词 + 最新性格设定；
  2. **本代开场底座**：早上那份《早间换代摘要》（管早上的历史结论，**绝不再去翻早上切点前的 3 万字原话**）；
  3. **下午这 40 轮的全部本代原话、系统事件通知与每一份 Worker 汇报完整原文**；
  4. 当前未完结任务图实时状态 + Codex 本代会话 `.jsonl` 路径 + 你接下来发的新消息。

#### 场景三：连续来回切三次（Claude → Codex → Antigravity → Claude）
- **你的操作**：先从 `Claude` 切到 `Codex` 聊了两句，觉得不顺手切到 `Antigravity` 没说话，紧接着又切回 `Claude` 接着聊。
- **网页上看到什么**：只有设置修改记录行，聊天流干净清爽，没有一串叠罗汉的交接卡片。
- **最后那个 Claude 新会话脑子里装了什么**：
  - 直接从 SQLite 账本的“本代起点”一次性干净拉出本代全部真实对话（包含刚才在 Codex 聊的那两句），**零套娃、零重复头部、不膨胀半个字**；
  - 即使中间路过的 `Antigravity` 一句话都没聊，本代之前真正跑过轮次的 `Claude` 与 `Codex` `.jsonl` 原始记录路径依然保留在提示里，线索不断链。

#### 场景四：刚收到 Worker 汇报立刻切厂商
- **你的操作**：Worker #540 刚交回一份详细的审查汇报（含修好的问题清单、PR 链接、测试结果与截图路径，或是 `confirm` 检查点挂出的待确认汇报），你看完想换一家模型帮你拿主意，立刻切厂商并问：“#540 汇报里提到的第 2 个问题你怎么看？”
- **新厂商脑子里装了什么**：
  - **情况 A（汇报已送达或静默存档在聊天流）**：`【Worker #540（…）的汇报】` 连同下面整段正文与八栏汇报**一字不漏**就在它眼前的上下文最后面，不用跑命令去捞就能直接对答如流；
  - **情况 B（汇报刚好在切换那一毫秒入库排队、旧会话还没来得及读）**：切换事务自动把这条排队中的完整汇报改绑给新厂商，作为新会话收到的消息原封不动投递进去，同样一字不漏。

### 1.4 跨厂商唯一带不过去的一块，以及系统怎么自动兜底

由于各家原厂 CLI（Claude、Codex、Antigravity 等）的底层会话文件带有模型专属加密思考签名（signature），不允许把别家跑过的工具调用轮次伪造成自家原生历史，因此跨厂商时**旧会话内部的工具调用过程输出与曾加载进内存的图片像素**会清空。系统通过 4 件事让用户几乎无感：

1. **活跃任务图实时附在末尾**：不用重新跑 `hub graph show`，一睁眼就知道每张图到哪一步、哪个 PR 开着、哪个门禁在等；
2. **上传附件与截图路径全保留**：用户发过的截图和 Worker 汇报里的截图绝对路径都在原话里，你提到某张图时新模型直接按路径重新看一眼即可；
3. **账本随时 0.2 秒可查**：所有历史 Worker 任务与汇报都在 SQLite 里（`hub worker show / search / log`），`HUB_TOKEN` 绑定在 PM 角色上，切厂商后名下所有任务图与在跑 Worker 归属关系纹丝不动；
4. **本代可读旧会话 `.jsonl` 路径附在开头**：真要核对旧会话里某条终端命令输出，新模型可直接按路径查阅。

### 1.5 顺带核查：总助（Router）切厂商有没有同类问题？

**已核查源码（`src/daemon/ledger/router.ts`、`src/daemon/router/dispatcher.ts`、`src/daemon/router/prompt.ts`）：总助不存在这个问题，无需改动。**
- 总助本来就不维护长对话会话、不写交接、也不进 `handovers` 表；
- 每次你在总助工作台发自然语言指令（轨道 B），后台都按 `router_settings` 当前选定的厂商新建一个一次性只读会话，实时注入跨设备 PM 名片（上限 `24 KB`）+ 最近 5 条跨厂商通用的指令回执（上限 `600 B`），跑完单轮当场销毁；
- 因此在总助里改厂商天然就是 0 秒即切、每次看到的都是完全一致的实时账本上下文。

---

## 2. 现状根因拆解（为什么现有代码会出问题）

当前跨厂商切换复用了 `src/daemon/ledger/handover.ts` 的 `method = 'direct'` 路径，存在 5 处根源耦合：

1. **机械复用 `pickRecent` 挖切点前 3 万字（`handover.ts:452`、`handover-recent.ts:25`）**：
   `latestHandoverOf()` 找到很久以前上一次换代的 `cut_message_id` 后，`pickRecent(recentRows, cut, HANDOVER_RECENT_CHARS)` 不仅取了 `id > cut` 的本代消息，还继续往 `id <= cut` 倒着抓取 `30,000` 字早已被浓缩进上次交接摘要的上一代原话。
2. **把本代 Worker 汇报全文砍成目录（`handover.ts:423` `reportsAfter`）**：
   原本后台写交接时，切点之前的汇报已由模型读过并总结进交接单，切点到换代只有短短几十秒，所以只列目录；但跨厂商切换时“老切点”可能是半天前甚至从未有过（`cut = 0`），导致整整一代的 Worker 汇报正文全部被抹成一行目录。
3. **本代消息筛选过窄，漏掉关键系统输入事件（`handover.ts:395` `recentRows`）**：
   `recentRows` 硬编码 `m.kind = 'text' AND (sender = 'agent' OR sender = 'user')`，漏掉了本代送入 PM 会话的 `schedule.run`（定时任务触发）、`worker.max_time_exceeded`（超时唤醒）、`task_graph.ready_to_finish`（任务图待交付汇总单）、`kind = 'worker'` 的 `user_message`（用户在 Worker 页直聊抄送）与 `turn_failed / worktree_failed`，也未还原 `AskMeta`（`hub ask` 挂出的选项列表与已选定案）。
4. **往聊天流插入虚假的 `session.renewed` 分隔线（`handover.ts:474`、`Messages.tsx:630`）**：
   切换厂商调用 `switchIn` 时无条件执行 `insertSystemMessage(..., { event: "session.renewed" }, handover)`，把 `latestHandoverOf` 翻出来的陈旧交接文本塞进 `message.text`；前端 `Messages.tsx` 把所有 `session.renewed` 渲染成 `Handed off to a new session ›` 折叠卡，同时后端 `sessionPreamble` 又依赖这条 `session.renewed` 消息的 `meta.seen` 来标记是否已读。
5. **资料页待切换状态误触发 `Handing off…`（`PmProfile.tsx:524, 623`）**：
   `PmProfile.tsx` 把 `persona.switchingToVendor != null` 直接混入 `RenewSessionGroup` 的 `renewing` 属性，导致旧会话忙碌等待切厂商时，底下的 `New session` 按钮转圈显示 `"Handing off…"`，与“不写交接”的实际行为相悖。

---

## 3. 核心架构设计：将「跨厂商直切」与「换代交接」彻底解耦

### 3.1 两个层级的清晰边界

在领域模型上严格区分两件事：

| 概念 | 触发条件 | 语义与数据表现 |
| --- | --- | --- |
| **换代交接（Session Renewal）** | ① PM 上下文达 `HANDOVER_TOKEN_THRESHOLD`（`240,000`）自动触发（`auto = 1`）；<br>② 用户在资料页主动点 `New session`（`auto = 0`） | 开启**新的记忆代**。由 fork 副本（或兜底 `in_session`）写出全新交接摘要 `text`，记录真实切点 `cut_message_id`；聊天流插入 `session.renewed` 分隔线（展开看本次新摘要）。 |
| **跨厂商切换（Vendor Switch）** | 用户在资料页修改 `Provider` 保存（`PUT /api/pms/:id/persona`） | **留在当前记忆代内更换厂商进程**。`handovers` 行记 `method = 'vendor_switch'`（兼容旧库 `'direct'`），`text = NULL`、`cut_message_id = NULL`、`preamble = NULL`；**不调模型写摘要、不插 `session.renewed` 消息**；新会话首轮实时从账本本代起点重建完整本代上下文。 |

> 为什么仍共用 `handovers` 表的活跃队列槽位（`handovers_active` 部分唯一索引）？
> 因为每个对话同一时刻最多只能有一次待执行的会话切换（无论是自动换代还是旧会话忙碌中等待当轮结束切厂商）。共用同一个原子状态槽位天然保证了：`switchingToVendor` 状态查询、忙碌期 `waitsForHandover` 压消息、当轮结束 `trySwitch` 原子接力、中途 `Undo` 撤销与 `archivePm` 取消全部在同一把 SQLite 事务锁下互斥闭环，零双轨竞态。

### 3.2 本代起点（Generation Anchor）的精确判定

对任意对话 `conversationId`，定义其**本代起点 `GenerationAnchor`** 为最近一次已完成切换的**真实换代交接**（排除所有跨厂商切换）：

```ts
interface GenerationAnchor {
  /** 最近一次真实换代写下的交接摘要；从未发生过真实换代则为 null。 */
  readonly summaryText: string | null;
  /** 本代消息起始边界：只取 messages.id > cutMessageId 的消息；从未换代则为 0。 */
  readonly cutMessageId: MessageId;
  /** 最近一次真实换代产生的新会话编号（用于筛选本代经历过的旧会话原始记录）；从未换代则为 0。 */
  readonly startSessionId: SessionId;
}
```

查询规则（配合新增索引 `handovers_conversation (conversation_id, id DESC)`，毫秒内命中）：
1. 查 `handovers` 表：
   ```sql
   SELECT text, cut_message_id, to_session_id
     FROM handovers
    WHERE conversation_id = ?
      AND status = 'switched'
      AND (method IS NULL OR method NOT IN ('direct', 'vendor_switch'))
      AND text IS NOT NULL
      AND trim(text) != ''
    ORDER BY id DESC
    LIMIT 1
   ```
   命中则返回 `{ summaryText: row.text, cutMessageId: row.cut_message_id ?? 0, startSessionId: row.to_session_id ?? 0 }`。
2. 兼容 `0013` 迁移前的远古换代记录：若上面未命中，查最近一条不关联 `direct / vendor_switch` 且 `trim(text) != ''` 的 `session.renewed` 系统消息；若仍无，返回 `{ summaryText: null, cutMessageId: 0, startSessionId: 0 }`。

**幂等性推论**：由于跨厂商切换写入的是 `method = 'vendor_switch', text = NULL`，无论用户在厂商间连续切换多少次（A → B → C → A），`GenerationAnchor` 的返回值恒定不变。

### 3.3 本代消息全集筛选与格式化真值表

在 `m.conversation_id = ? AND m.id > anchor.cutMessageId` 范围内，对照 `messages` 表全部可能的消息种类，按“旧会话脑子里本来有什么 + 用户在聊天流看到了什么”制定唯一真值表：

| 消息类别 | 库字段特征 | 是否纳入本代上下文 | 排除条件与格式化方式 |
| --- | --- | --- | --- |
| **用户消息 / 门禁拍板唤醒 / 总助转发** | `sender = 'user'`, `kind = 'text'` | **纳入** | **排除**：① `meta.rewound === true`（二次 Esc 已撤回）；② `status === 'cancelled'`（排队未读即取消）；③ `m.session_id === targetSessionId && status IN ('queued', 'delivered', 'processing')`（正要作为新会话自身输入轮次发送的消息，防首轮重复）。<br>**保留**：`replied`、`failed`（如撞上旧厂额度报错的那句）、`stopped`。<br>**格式**：`用户：${agentTextOf(msg)}`（自动附带上传附件完整本机绝对路径）。 |
| **PM 文本回复与 `hub ask` 卡片** | `sender = 'agent'`, `kind = 'text'` | **纳入** | **排除**：`meta?.handover === true`（`in_session` 写交接草稿）。<br>**格式**：`你：${formatPmAgentText(msg)}`——普通回复原样输出；若为 `AskMeta`（`needsUser: true`）且含 `options`，在正文后附上选项清单与当前状态（如 `[选项：1. … / 2. …；状态：已选「…」 \| 待用户确认]`）。 |
| **PM 工具调用折叠行** | `sender = 'agent'`, `kind = 'tool'` | **不纳入** | 仅含单行工具名而无返回输出，属噪音；状态由末尾实时任务图快照 + 旧会话 `.jsonl` 路径 + `hub` 命令替代。 |
| **Worker 汇报、报错与用户直聊抄送** | `sender = 'system'`, `kind = 'worker'` | **纳入全文** | **纳入事件**：`event IN ('report', 'turn_failed', 'worktree_failed', 'user_message')`（涵盖唤醒 PM 的汇报与任务图静默存档/检查点汇报）。<br>**排除**：① `event IN ('started', 'ended')`（纯 UI 状态短行）；② `status === 'queued'`（正压着待转交给新会话直接发送的在途汇报，防重复）。<br>**格式**：原样保留 `row.text`（即完整的 `【Worker #N（标题）的汇报】\n\n<全文与八栏汇报>`）。 |
| **系统业务事件与交付单** | `sender = 'system'`, `kind = 'text'` | **按事件纳入** | **纳入事件**：`schedule.run`、`worker.max_time_exceeded`、`task_graph.ready_to_finish`（排除 `status === 'queued'` 在途项），以及 `project.created`、`folder.attached`、`folder.detached`、`schedule.failed`。<br>**严格排除**：`persona.changed`（性格与模式已在最新系统提示词中；排除后可确保连切 N 次厂商不累积“你改了厂商”废话，实现**字节级幂等**）、`handover.requested`、`session.renewed`、`handover.failed`、`context.compacted`、`driver.warning`。<br>**格式**：`【系统通知】${stripSystemPrefix(row.text)}`（本身已带 `【…】` 标题的直接原样输出）。 |

### 3.4 新厂商首轮继承包（`buildVendorSwitchPreamble`）结构

跨厂商切换不再使用 `sessionPreambleText` 的“交接”措辞，改为专用的本代上下文原样继承结构：

```markdown
【系统】你还是同一个项目经理，用户刚把你的运行厂商从 Claude Code（claude）切换到了 Codex（codex）。
下面按时间顺序完整附上了当前这一代会话迄今的全部上下文（用户那边仍是同一个连续对话，不要向用户提及切换了会话或回复“已接手”，读完直接回应本段末尾的最新消息；历史中提到的他厂专属工具名按你当前可用的工具理解）。
做过的历史任务细节可用 `hub worker search`、`hub worker show --task / --report` 查账本；本代前序会话的原始记录：<可读路径列表或不可跨厂直读说明>。

## 本代起点摘要（上次会话换代时保存的背景）
（仅当 anchor.summaryText 非空时出现本节；若从未发生过换代则整节不出现，绝不写“上一个会话没有写交接”之类的废话）
下面的摘要覆盖本代起点之前的历史背景；如与下方的本代对话进展冲突，一律以本代最新对话和实时状态为准。

<anchor.summaryText>

## 本代完整对话与 Worker 汇报记录
（若因超长触发窗口保底截断，首行注明：本代更早的消息因窗口上限已省略，以下为离当前最近的内容）

用户：……

你：……

【Worker #540（……）的汇报】
……（完整正文与 === 汇报 === 八栏原文）

## 未完结的任务图（账本实时状态）
（仅当名下有 active 任务图时由 liveActiveGraphsSection 实时拼入，含任务图技能手册路径）
```

### 3.5 状态机与并发边界闭环

1. **空闲当场秒切（95% 场景）**：
   用户在资料页改厂商点 `Save` → `editPersonaIn` 调用 `switchVendorIn` → 旧会话满足 `activity === "idle" && (backgroundTasks ?? 0) === 0 && !inFlightTo(old)` → **同一 SQLite 事务内立即完成**：
   - 新建 `generation + 1` 的新厂商 `agent_sessions` 行；
   - 更新 `pms` 表的 `vendor, default_model, effort` 并推 `pm.updated`；
   - 入队 `session.end(old.id)` 回收旧进程、入队 `session.start(next.id)` 预热新进程；
   - 将旧会话名下 `status = 'queued'` 的排队消息改绑到 `next.id` 并重入队 `session.send`；
   - `handovers` 行直接落定为 `method = 'vendor_switch', status = 'switched', to_session_id = next.id`，`switchingToVendor` 当场为 `null`。
2. **旧会话忙碌时排队等当轮结束切（5% 场景）**：
   - 旧会话正在 `working`、有 `backgroundTasks > 0` 或有 `delivered / processing` 在途消息时，`handovers` 登记 `method = 'vendor_switch', status = 'ready', to_vendor = ...`；
   - 资料页显示 `Switching to <Vendor>…`；期间新发消息由 `waitsForHandover` 暂压；
   - 期间若用户继续改新厂商下的 `model / effort` 则原地更新该行；若改回原厂商或点 `Undo`（`revertPersonaChange`）则将该行标 `abandoned (user_message)` 取消切换；若归档 PM 则 `cancelHandoverIn` 标 `abandoned (archived)`；
   - 旧会话当轮一结束（`turn.ended` / `session.exited` / `background.changed(0)`，含当轮报错结束），`afterDriverEvent` 立即调 `trySwitch` 切到新厂商，刚跑完的这一轮消息自动纳入本代上下文，`runAutoRenew` 不会因 `HANDOVER_READY_MAX_MS` 把 `vendor_switch` 标过期。
3. **与在途换代任务碰撞（统一收口）**：
   - 若切换厂商时恰好有一条未完成的自动/手动换代（`queued / forking / writing / ready`）：
     - 若为 `in_session` 正在写交接请求 H，立即停止 H（排队标 `stopped`，在途推 `p.stops` 并 `endWriting`）；
     - 若后台 `runner.ts` 正在 `forking / writing`，将状态原地改为 `method = 'vendor_switch', status = 'ready', text = NULL, cut_message_id = NULL`——后台跑腿进程随后回调 `handoverForked / handoverWritten / handoverFailed` 时因状态已非 `forking / writing` 会自动丢弃结果并立即 `remove` 清理临时 fork 副本，零残留；
     - 随后立即尝试 `trySwitch` 秒切。
4. **与 `240K` 自动换代（`HANDOVER_TOKEN_THRESHOLD`）无缝衔接**：
   - 切到新厂商后，新会话第 1 轮读入本代完整上下文，驱动层如实上报新厂商的 `session.usage.context`；
   - 后续在新厂商上继续对话直到 `usage.context >= 240,000` 时，`afterDriverEvent` 照常触发后台 `auto` 自动换代；
   - 由于新厂商第 1 轮消息里本就完整装着切厂商前的本代前半段对话与汇报，fork 出的写手能看到**整整这一代从头到尾的完整上下文**，写出的新一代摘要自然覆盖整代，记录新的 `cut_message_id` 开启下一代；
   - `attemptsOf(fromSessionId)` 按单行 `session.id` 独立统计，切厂商不会继承旧厂商的自动换代失败次数或退避锁。

### 3.6 数据库幂等迁移 `migrations/0027_vendor_switch.sql`

为彻底解除“已读标记 `seen`”对聊天流 `session.renewed` 消息的寄生依赖，并保证所有查询走索引：

1. **为什么新建独立小表而不是 `ALTER TABLE agent_sessions ADD COLUMN`**：
   与 `migrations/0012_session_persona_revision.sql` 同理——仓库迁移测试（`test/migration.test.ts`）要求回退 `PRAGMA user_version = 8` 后重跑全部后续迁移 100% 幂等，`CREATE TABLE IF NOT EXISTS` 与 `CREATE INDEX IF NOT EXISTS` 天然可重入且无需重建 `agent_sessions` 主表。
2. **迁移 SQL 全文**：
   ```sql
   -- 0027_vendor_switch：记录会话是否已读取过首轮开场上下文（解除对 session.renewed 消息 meta.seen 的耦合），并补齐 handovers 查询索引。
   CREATE TABLE IF NOT EXISTS session_preamble_seen (
     session_id INTEGER PRIMARY KEY REFERENCES agent_sessions (id) ON DELETE CASCADE,
     seen_at    INTEGER NOT NULL
   ) STRICT;

   -- 回填升级前已完成过轮次或已在 session.renewed 标过 seen 的老会话，防止升级后重复注入开场说明
   INSERT OR IGNORE INTO session_preamble_seen (session_id, seen_at)
   SELECT id, updated_at FROM agent_sessions WHERE generation > 1 AND has_completed_turn = 1;

   INSERT OR IGNORE INTO session_preamble_seen (session_id, seen_at)
   SELECT CAST(json_extract(meta, '$.sessionId') AS INTEGER), updated_at
     FROM messages
    WHERE sender = 'system' AND kind = 'text'
      AND CASE WHEN json_valid(meta)
            THEN json_extract(meta, '$.event') = 'session.renewed' AND json_extract(meta, '$.seen') = 1
            ELSE 0 END
      AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = CAST(json_extract(meta, '$.sessionId') AS INTEGER));

   CREATE INDEX IF NOT EXISTS handovers_to_session
     ON handovers (to_session_id)
     WHERE to_session_id IS NOT NULL;

   CREATE INDEX IF NOT EXISTS handovers_conversation
     ON handovers (conversation_id, id DESC);
   ```
3. **归档清理同步**：在 `src/daemon/ledger/persona.ts` 的 `purgeExpiredArchivedPms` 中（紧挨 `DELETE FROM session_persona_seen` 处）同步执行 `DELETE FROM session_preamble_seen WHERE session_id IN (...)`。

### 3.7 前端界面与交互清理（遵循 `frontend-rules` 与 `docs/ui-standard.md`）

1. **聊天流（零前端改动即自动生效）**：
   - 跨厂商切换时后端不再插入 `session.renewed` 系统消息，聊天流里不再渲染 `SessionRenewed`（`Handed off to a new session ›`）折叠卡，仅显示 `persona.ts` 原有的 `persona.changed` 系统通知行（`你改了 <PM> 的设置（厂商：A → B）` + `Undo` 按钮）；
   - 真实的 240K 自动换代与手动点击 `New session` 照常插入 `session.renewed` 分隔线，点开永远是当次新鲜写出的真实交接摘要。
2. **资料页 `PmProfile.tsx`（修平 1 处状态误报，不增删任何装饰字或新样式）**：
   - `RenewSessionGroup` 拆分为 `renewing: boolean`（确实在跑 `New session` 写交接）与 `disabled?: boolean`（如 `switchingToVendor != null` 正在等当轮结束切厂商）；
   - 当 `switchingToVendor != null` 且 `!renewing` 时：上方 `Provider` 行照常显示 `Switching to <Vendor>…` 并禁用厂商下拉；下方 `New session` 按钮仅置 `disabled`，文案保持 `"Start…"` 而不再转圈谎报 `"Handing off…"`。

---

## 4. 统一（覆盖全部 6 家已接入厂商 `claude, agy, codex, pi, deepseek, cursor`）

全部 6 家厂商均继承自统一的 `BaseSessionDriver`（`src/daemon/driver/base-driver.ts`），跨厂商切换在任意两家之间（`6 × 5 = 30` 种有向组合）走完全同一套协议与声明表，**零厂商名硬编码分支**：

| 厂商 ID | 显示名 | 系统提示词通道（`spec.capabilities.systemPrompt`） | 首轮本代上下文注入点 | 第 2 轮起续接方式 | 原始记录跨厂可读（`transcriptPortable`） | 自动换代（240K）方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code | `resident`（`--append-system-prompt-file`） | `BaseSessionDriver.takeNotesPrefixes` → 首条 stdin 用户消息最前 | 常驻流 / `--resume <uuid>` | **可读**（`~/.claude/projects/.../<id>.jsonl`） | 后台 `CLAUDE_FORKERS`（`--fork-session`） |
| `agy` | Antigravity | `resident`（`--add-dir` 下 `.agents/rules/fusa-*.md`） | `BaseSessionDriver.takeNotesPrefixes` → 首条用户消息最前 | `--conversation <uuid>` | **不可直读**（SQLite `conversations/<id>.db`） | 后台 `AGY_FORKERS`（SQLite 备份拷库） |
| `codex` | Codex | `resident`（app-server `developerInstructions`） | `BaseSessionDriver.takeNotesPrefixes` → `turn/start` 首轮输入最前 | 常驻 app-server / `thread/resume` | **可读**（`~/.codex/sessions/.../*.jsonl`） | 后台 `CODEX_FORKERS`（`thread/fork`） |
| `pi` | Pi | `resident`（`--append-system-prompt`） | `BaseSessionDriver.takeNotesPrefixes` → 首条 RPC 用户消息最前 | 常驻 RPC / `--session` | **可读**（`~/.pi/agent/sessions/.../*.jsonl`） | 后台 `PI_FORKERS`（会话文件复制） |
| `deepseek` | DeepSeek | `resident`（`--patch` `system-prompt.personaSuffix`） | `createAcpDriver` → `takeNotesPrefixes` → `session/prompt` 首轮 `userBlocks` 最前 | 常驻 ACP / `session/load` | **不可直读**（Zstd 压缩帧 `.v4.jsonl.zstd`） | 自动退回 `in_session` 本会话写交接 |
| `cursor` | Cursor | `first_message`（ACP 无常驻入口，首轮前置 `<system_instructions>`） | `createAcpDriver` → `buildAcpPromptBlocks`：`systemBlock` 在最前，紧跟 `sessionPreamble` 本代上下文与用户新消息 | 常驻 ACP / `session/load`（吞重放） | **不可直读**（私有存储格式） | 自动退回 `in_session` 本会话写交接 |

### 跨厂商统一处理要点

1. **模型与思考程度自动归位校验（`persona.ts` `nextAgent`）**：
   从任意厂商 A 切到厂商 B 时，若未显式指定新厂商的 `model / effort`，统一重置为 `null`（使用厂商 B 的默认模型与默认思考程度；如 `codex` 声明了 `explicitDefaultModel: true` 由驱动按目录解析，如 `cursor` 自动显式下发 `Auto`），绝不会把 `claude` 的 `opus / max` 误传给 `deepseek` 或 `agy` 导致启动报错。
2. **本代多跳可读原始记录提取（按 `vendorSpec(v).handover?.transcriptPortable` 声明驱动）**：
   查询当前记忆代内（`id >= anchor.startSessionId && id < currentSession.id`）实际完成过轮次（`has_completed_turn = 1`）的最近最多 `VENDOR_SWITCH_TRANSCRIPTS_MAX`（5）个旧会话：
   - `transcriptPortable !== false` 且磁盘文件存在的（`claude, codex, pi`）：按顺序列出本机路径（如 `Claude Code: /path/to/xxx.jsonl`）；
   - 若紧邻上一个会话 `transcriptPortable === false`（`agy, deepseek, cursor`）：保留本代更早可读 `.jsonl` 路径的同时，注明紧邻上一会话格式不可跨厂直读，不输出二进制/压缩文件路径防止新模型误调 `Read` 读入乱码。
3. **`cursor` 的 `first_message` 顺序一致性**：
   在 `src/vendors/_common/acp/driver.ts` 的 `writeBatch` 中，`buildAcpPromptBlocks(batch.userBlocks, systemBlock)` 天然将 `<system_instructions>` 放在第 0 块、`batch.userBlocks`（首元素即 `sessionPreamble`）放在第 1 块、用户当轮消息紧随其后；若后续收到 `compaction_update`，只重补 `prompt.md` 系统提示词而不重补 `sessionPreamble`（因 `session_preamble_seen` 已置 1）。
4. **任务图手册 `fusa-task-graph` 6 家无缝衔接**：
   切厂商新建会话时，新会话拥有独立 `<launchDir>/<newSessionId>/`；`claude, agy, codex, pi, deepseek` 5 家走 `skills: "native"` 自动挂载，而 `cursor`（`skills: "read_file"`）与所有带活跃任务图的会话一样，由 `liveActiveGraphsSection` 在末尾自动附上新会话专属的 `SKILL.md` 路径。

---

## 5. 性能（SQL 查询有界、窗口保底上限、第 2 轮起前缀缓存命中稳定性）

### 5.1 窗口保底上限核算与 `src/shared/limits.ts` 新增常量

6 家厂商中最小主力上下文窗口为 **`128K`（`131,072` tokens，如 `deepseek` 的 `deepseek-v4-pro / deepseek-flash` 及 `agy` 的 `gpt-oss-120b`）**。按首轮最严苛水位反推：

- 厂商内置系统指令 + 工具定义 + Skills 清单 + `AGENTS.md`：约 `20K～25K` tokens；
- Fusa PM 系统提示词 + `MEMORY.md`（上限 `25 KB`）：约 `10K～12K` tokens；
- 活跃任务图快照（`HANDOVER_GRAPHS_MAX_CHARS = 8,000` 字 ≈ `5K` tokens）+ 当轮用户新消息 + 首轮推理与工具输出余量（预留 `20K` tokens）：约 `25K` tokens；
- **留给本代上下文继承包的安全净预算**：约 `65K～75K` tokens（中英代码混排按 `1 字 ≈ 0.6 token` 折算约 **`110,000～125,000` 字**）。

而日常使用中，PM 在满 `240K` 自动换代前，其上下文大头是历史工具返回结果，`messages` 表里沉淀的本代纯对话 + Worker 汇报全文通常仅 **`20,000～80,000` 字**。因此在 `src/shared/limits.ts` 集中定义以下常量：

| 常量名 | 值 | 用途说明 |
| --- | --- | --- |
| `VENDOR_SWITCH_CONTEXT_MAX_CHARS` | `240_000` | 跨厂商切换时，本代消息与 Worker 汇报回放区的最大字符预算（`String.length`）。日常整代全量无损带入；极端超长本代保留离当前最近的 24 万字（本代起点摘要另计不裁，自身仅约 2,000 字），防止极端单代爆窗报错。 |
| `VENDOR_SWITCH_MESSAGE_SCAN_LIMIT` | `4_000` | 单次重建本代上下文最多倒序扫描的非工具 `messages` 行数硬护栏（防极端异常高频短消息无界扫描）。 |
| `VENDOR_SWITCH_TRANSCRIPTS_MAX` | `5` | 跨厂商切换提示中最多附带的本代前序可读旧会话 `.jsonl` 路径个数。 |

**UTF-16 代理对安全截断**：当单条超长消息跨过 `240,000` 字边界需截取后半截时，若切点恰好落在 UTF-16 低位代理项（`0xDC00..0xDFFF`）上，切点向后移动 1 个码元对齐完整 Unicode 码点，杜绝产生孤立代理项（lone surrogate）导致 JSON 序列化或模型 API 400 报错。

### 5.2 SQL 查询有界性（按跑满一个月：300 个已收工 Worker、3 万条消息基准核算）

1. **平时每轮发消息（99.9% 调用）**：
   `sessionPreamble(sessionId)` 先检查 `session.generation <= 1`（内存/单行主键已读），若 `> 1` 执行主键点查：
   `SELECT 1 AS x FROM session_preamble_seen WHERE session_id = ?`
   **耗时 `< 0.005 ms`**，不扫 `messages` 表、不跑 `json_extract`。
2. **跨厂商切换后首轮发消息（仅每个新会话第 1 轮执行 1 次）**：
   - **查本代起点 `GenerationAnchor`**：走 `handovers_conversation (conversation_id, id DESC)` 索引，`LIMIT 1`，耗时 **`< 0.01 ms`**；
   - **倒序流式取本代消息**：复用现有复合索引 `messages_conversation (conversation_id, id)`，按 `WHERE conversation_id = ? AND id > ? AND id < ? ORDER BY id DESC LIMIT 100` 分页倒序迭代：
     - 正常一代（约 50～200 条消息）：1～2 页索引范围扫描即遇到 `anchor.cutMessageId` 自然终止，完全不触碰库里其余 29,800 条历史消息，**耗时 `< 0.5 ms`**；
     - 极端超长一代：累计入选文本达到 `VENDOR_SWITCH_CONTEXT_MAX_CHARS`（`240,000` 字）或扫描行数达 `VENDOR_SWITCH_MESSAGE_SCAN_LIMIT`（`4,000` 行）立即 `break` 停止拉页，单次内存峰值严格有界（`< 3 MB`）。

### 5.3 第 2 轮起前缀缓存（Prompt Cache）命中稳定性

跨厂商切换后的缓存生命周期分两步走，第 2 轮起 100% 静态追加、零前缀抖动：

```text
第 1 轮请求: [系统提示词 + MEMORY.md] + [User Turn 1: 本代继承包 P (含一次性任务图快照) + 用户新消息 U1]  ──► 写入原厂会话 & 建立缓存前缀
                                                      │
                                  收到 message.processing { preamble: true }
                                  写入 session_preamble_seen (持久化落盘)
                                                      ▼
第 2 轮请求: [系统提示词 + MEMORY.md] + [User Turn 1: P + U1] + [Assistant A1] + [User Turn 2: U2]
            └──────────────────── 100% 字节级一致，直接命中原厂前缀缓存 ────────────────────┘
```

- **为什么实时任务图快照不会破坏第 2 轮缓存？**
  因为 `liveActiveGraphsSection` 只在 `sessionPreamble` 返回非 `null`（即**仅第 1 轮**）时拼在 `P` 末尾一次，随 `User Turn 1` 一起固化进原厂自己的会话历史文件；第 2 轮起 `sessionPreamble` 恒返回 `null`，原厂重放的 `User Turn 1` 依然是第 1 轮固化进去的那串字节，不会随之后任务图状态变化而改写第 1 轮历史。
- **闲置关进程再唤醒也不丢缓存**：
  会话空闲满 `IDLE_CLOSE_MS`（10 分钟）关闭子进程后，下次发消息通过 `--resume` / `thread/resume` / `session/load` 恢复原厂会话，同时 `session_preamble_seen` 在 SQLite 中持久保留，驱动层不会二次重塞 `P`，6 家厂商第 2 轮起的缓存命中率均保持在 **90%～99%**。

### 5.4 `AGENTS.md` 缓存与状态四项必查核对

| 必查项 | 本方案落实情况 |
| --- | --- |
| **1. 失效** | 跨厂商切换不缓存静态 `preamble` 副本，首轮发送前实时从 SQLite 读取最新本代消息与实时活跃任务图；PM 归档到期清理时同步删除 `session_preamble_seen` 记录。 |
| **2. 上限** | 文本预算 `VENDOR_SWITCH_CONTEXT_MAX_CHARS = 240_000`、扫描护栏 `VENDOR_SWITCH_MESSAGE_SCAN_LIMIT = 4_000`、路径条数 `VENDOR_SWITCH_TRANSCRIPTS_MAX = 5`、任务图预算 `HANDOVER_GRAPHS_MAX_CHARS = 8,000` 全部集中定义在 `src/shared/limits.ts`。 |
| **3. 前端引用稳定** | 不新增前端状态字段或列表；`selectors.ts` 的 `placeHandovers` 因跨厂商切换不再产生 `session.renewed` 行，减少无意义的数组重排复制，已有 `WeakMap` 缓存保持原样稳定。 |
| **4. 验证指标** | 在实现步单测中构造 30,000 条历史消息 + 300 个已收工 Worker 数据集，实测并断言切换与首轮 `sessionPreamble` 耗时及返回字符上限。 |

---

## 6. 落地边界与验收测试矩阵（供 `impl` + `review` 步执行）

### 6.1 预计改动文件清单

1. `migrations/0027_vendor_switch.sql`：新增 `session_preamble_seen` 表（含存量幂等回填）及 `handovers_to_session`、`handovers_conversation` 索引。
2. `src/shared/limits.ts`：新增 `VENDOR_SWITCH_CONTEXT_MAX_CHARS`、`VENDOR_SWITCH_MESSAGE_SCAN_LIMIT`、`VENDOR_SWITCH_TRANSCRIPTS_MAX`。
3. `src/daemon/ledger/vendor-switch-context.ts`（新拆纯逻辑模块，保持 `handover.ts` 职责清晰）：实现本代消息过滤格式化、UTF-16 安全尾部保底截断与 `buildVendorSwitchPreamble`。
4. `src/daemon/ledger/handover.ts`：
   - `switchVendorIn` 改为写入 `method = 'vendor_switch'`（`text = NULL, cut_message_id = NULL`），碰撞在途换代时统一安全收口；
   - `switchIn` 在 `method === 'vendor_switch'` 时不写 `session.renewed` 系统消息、不预写冗余 `preamble`；
   - `GenerationAnchor` 查询严格跳过 `method IN ('direct', 'vendor_switch')`；
   - `sessionPreamble` 与 `afterDriverEvent(message.processing)` 改走 `session_preamble_seen` 表。
5. `src/daemon/ledger/persona.ts`：`purgeExpiredArchivedPms` 增加清理 `session_preamble_seen`。
6. `src/web/components/PmProfile.tsx`：`RenewSessionGroup` 拆分 `renewing` 与 `disabled`，待切换厂商时按钮保持 `"Start…"` 禁用态，不误显 `"Handing off…"`。
7. 测试文件：`test/migration.test.ts`、`src/daemon/ledger/handover.test.ts`、`src/daemon/ledger/ledger-projects-persona.test.ts`、`src/web/m2.test.tsx`。

### 6.2 必测回归场景清单

1. **新 PM 初次切厂商**：无任何历史换代，聊多轮（含用户上传附件、PM `hub ask` 选项卡片、系统事件）后切厂商，新会话首轮拿到从第 1 条起的完整本代记录与附件绝对路径，无“交接”段落，聊天流无 `session.renewed` 消息。
2. **240K 自动换代后切厂商**：第 1 代聊满阈值完成自动换代，第 2 代再聊若干轮后切厂商——首轮包含上次自动换代摘要 + 切点后全部本代消息，**严格不包含切点前第 1 代的 3 万字旧原话**。
3. **A → B → C → A 连续来回切三次（含中途说话与不说话）**：每次 `sessionPreamble` 产出的本代对话主体无套娃、无重复头部、不混入 `persona.changed` 噪音；中途未说话跳过中间厂商时，仍保留本代前序可读厂商 `.jsonl` 路径。
4. **Worker 汇报全文保留**：覆盖已唤醒 PM 的汇报、任务图 `confirm` 检查点静默汇报、以及切换瞬间处于 `queued` 待发的汇报，新厂商拿到的均为八栏完整汇报原文而非一行目录。
5. **6 家厂商全矩阵可移植性**：从 `claude / codex / pi` 切出时附 `.jsonl` 路径；从 `agy / deepseek / cursor` 切出时不塞不可读文件路径。
6. **超长本代窗口保底截断**：本代消息总长超过 `VENDOR_SWITCH_CONTEXT_MAX_CHARS`（含边界处带 emoji 代理对），保留本代起点摘要 + 最新 24 万字完整尾部，首部带省略提示且无孤立代理项。
7. **240K 自动换代切点不被污染**：切厂商后继续聊到 `240K` 触发自动换代，自动换代正常 fork 当前会话写出新摘要并推进 `GenerationAnchor`；切厂商不影响 `attemptsOf` 重试计数。
8. **忙碌期切厂商、中途改参、撤销与碰撞**：旧会话 `working` / `backgroundTasks > 0` / 在途后台写交接时切厂商，`switchingToVendor` 状态、中途 `Undo` 取消、当轮结束（含报错结束）自动切换均准确闭环。
9. **第 2 轮起 `sessionPreamble` 恒返 `null` 与迁移幂等**：首轮 `message.processing { preamble: true }` 后 `session_preamble_seen` 落库，重启后也不重塞；`0027` 从 `0026` 升级及回退 `user_version = 8` 重跑均幂等通过。
10. **前端界面验证**：资料页 `switchingToVendor != null` 时 `Provider` 显示 `Switching to …` 而 `New session` 按钮显示禁用态 `Start…`（不显示 `Handing off…`），聊天流不渲染 `session.renewed` 折叠卡。
