# 后台写交接 + 原话带 3 万字（方案）

> 2026-11-07，Worker #111。只是方案，没改产品代码。基于 main `13be06d`（PR #113）。
> 实测依据：Worker #108 的脚本（`worktrees/1/108/experiments/fork/`）+ 本文第 6 节自己补测的几项。

## 0. 一页结论

- **复制一份去写，原会话照常聊。** 项目经理对话到 20 万 token 后，在它两轮之间的第一个空当（不等 20 秒）从它的会话复制一份，
  复制那份在后台写交接；项目经理照常回用户。交接写好后，**项目经理当前这一轮一结束就换**（同一个事务里换代，之前压着的消息直接交给新会话）。
- **原话带约 3 万字**：只带用户和项目经理之间网页上看得到的话，从账本（`messages` 表，三家统一）从新往旧取，可以跨好几代。
  切点（开始复制那一刻）之后的原话**全部**带上，保证写交接期间聊的不丢。
- **只看队列**：每轮结束时到 20 万的对话进队列；5 秒一次的检查只看队列里的几个，队列空就什么都不查。
- **换完马上起新会话的进程**（预热），第一条回复不用等进程启动。
- **一处定流程**：账本里一个状态机（`ledger/handover.ts`）+ 守护进程里一个跑腿的（`daemon/handover/runner.ts`）；各厂商只实现
  `fork / write / remove` 三个方法。厂商自带的复制优先，拷库这种自己造的放后面当兜底，最后统一兜底是“本会话写交接 + 用户一发消息就打断”。
- 补测（第 6 节）：claude 的 `--fork-session` 可以加 `--no-session-persistence`，复制那份**根本不落盘**，不用删；也可以加 `--session-id` 事先定好编号。

## 1. 现状（PR #113）和问题

- 守护进程每 5 秒对**每个**项目经理跑 `runAutoRenew`：用量 ≥ 20 万、最后一轮正常回完、没有在路上的消息、空闲 20 秒 → 给**这个会话**发交接请求（H），
  它单独一轮写交接；写完同一个事务里换代（新会话 + 分隔线 R），开场说明 + 交接 + 最近 10 条原话拼在下一条消息前面（`sessionPreamble`）。
- 问题：写交接那一轮（30 秒到几分钟）占着项目经理，这期间用户发的消息被 `waitsForHandover` 压着，**用户要等**。
- 次要问题：每 5 秒对每个项目经理跑一遍 `SELECT max(updated_at) FROM messages WHERE conversation_id = ?`，这条要把这个对话的消息全扫一遍
  （索引是 `(conversation_id, id)`，没有 `updated_at`），消息越多越慢（第 6 节有实测）。

## 2. 全流程

### 2.1 状态

一次交接是 `handovers` 表的一行（第 8 节），状态：

```
queued ──(旧会话空闲)──► forking ──► writing ──► ready ──(旧会话这一轮结束)──► switched ──► (清理完记 cleaned_at)
   │                        │            │          │
   └────────────────────────┴──失败/超时──┴──过期────┴──► failed / abandoned（按退避再来一次，或这一代不再自动试）
```

- **queued**：到门槛了，等旧会话两轮之间的空当。
- **forking**：正在复制（厂商的 `fork`）。
- **writing**：复制那份在写交接（厂商的 `write`）。
- **ready**：交接写好了（存在这一行的 `text`），等旧会话这一轮结束。
- **switched**：已换代。之后异步清理复制那份（`remove`），清完记 `cleaned_at`。

每个对话同一时间最多一行不在终态（部分唯一索引保证）。

### 2.2 何时触发：到门槛后第一个空当，不等 20 秒

- 账本在 `turn.ended`（`afterDriverEvent`）时看这个项目经理会话的 `usage.context`，≥ `AUTO_RENEW_CONTEXT_TOKENS`（20 万）就把对话**放进队列**（第 4 节），
  同一个事务里登记一行 `queued`，提交后叫醒跑腿的（`onHandoverClaimable`）。跑腿的有空位就 `claimHandover()`：账本在这个事务里判断能不能开始——
  旧会话空闲（`activity === "idle"`）、没有发给它还在路上的消息（delivered / processing）、过了退避 → 改成 `forking`、记切点，把活交给跑腿的。
  不满足就留在 `queued`，下一次 `turn.ended` 叫醒或跑腿的每 5 秒自己领一次时再看。（PR 0 定的：判断只在 `claimHandover` 一处。）
- **为什么不等 20 秒了**：以前要等，是因为写交接占着项目经理，怕和用户撞上；现在写交接在复制那份里，用户怎么聊都不受影响，越早开始交接越新、上下文也少涨一点。
- **为什么还要等“两轮之间”而不是一轮中途就复制**：
  1. 一轮中途复制，复制那份里是半截的一轮（工具调了没结果），写出来的交接缺这一轮的结论；
  2. codex 在另一个进程一轮中途 `thread/fork`、agy 拷正在写的库，#108 都没测过一轮中途的情况；两轮之间是测过的；
  3. 用量本来就只在一轮结束时更新，到门槛的时刻天然就是一轮结束，通常马上就有空当。
- 复制那一刻记 **切点** `cut_message_id = max(messages.id)`：交接覆盖到切点为止，切点之后的靠原话补（2.8）。
- 每一代自动试的次数、退避沿用 `AUTO_RENEW_MAX_ATTEMPTS`（3）、`AUTO_RENEW_RETRY_BACKOFF_MS`（10 分钟起翻倍）。

### 2.3 复制

跑腿的按这个厂商的**办法清单**（第 7 节）从前往后试：

| 厂商 | 办法 | 做法 | 缓存 |
|---|---|---|---|
| claude | 自带（native） | `write` 时直接 `claude -p --resume <原编号> --fork-session --no-session-persistence`，model / `--append-system-prompt-file` 照项目经理的传，`--settings` 是项目经理的叠上禁写三层（见下）；`fork` 本身什么都不做 | 约 97% |
| codex | 自带（native） | 单独起一个 `codex app-server`（不带 HUB_*），`thread/fork {threadId, cwd, model, developerInstructions, sandbox, approvalPolicy, config}`，参数和项目经理的 `thread/start` 同一个构造函数出 | 只中约 1.2 万 |
| agy | 自造拷库（copy） | sqlite 备份接口拷 `conversations/<id>.db`，库里 `cascade_id`、`trajectory_id` 换成同长新 UUID，`brain/<id>/` 一起拷；之后 `--conversation <新编号>` | 0 |

- 启动参数**复用驱动层现成的构造**（`protocol.ts` 的 `buildClaudeArgs`、`codex-protocol.ts` 的 `readCodexLaunchConfig` / `buildThreadStartRequest`、`agy-protocol.ts`），
  `prepareLaunch(session)` 拿到的文件和环境变量照用，**只去掉 `HUB_TOKEN`、`HUB_SOCK`**（codex 还要去掉 `shell_environment_policy.set` 里的这两个）。
  #108 实测：三家去掉后复制那份都拿不到凭证，工具清单不变（缓存不受影响）。
- 复制那份不能派活（没凭证），也要技术上写不了文件（不能只靠提示词）：
  - codex、agy 本来就不走缓存，复制那份直接收紧：codex `sandbox: "read-only"`、`approvalPolicy: "never"`、反向审批一律拒绝；
    agy `--mode plan`（2026-11-07 实测：让它“批准了、执行”，`write_file` 照样报 permission check failed，无头模式不能问就自动拒）。
  - claude 要保缓存，工具清单、模型、系统提示词不能改。`--settings` 换成项目经理的设置叠上三层（`shared/policy.ts` 的 `buildForkSettings`）：
    拦所有工具调用的 PreToolUse 钩子（退出码 2）+ 权限档 `dontAsk` + `Edit(//**)` 拒绝。只动权限和钩子，不动工具清单。
    2026-11-07 真 claude 2.1.314 实测（让复制那份 Write 建文件、Bash 写文件、Edit 改文件）：不加时三样都写成了；叠上后三样都被拦，
    用户设置里放行过的 `Bash(echo:*)`、`Write`、`Edit` 也拦得住；第一个请求缓存命中不加 97.8%、叠上 97.6%。
    反例：拒绝规则写整工具（`Bash`、`Bash(*)`）会把工具从清单里拿掉，缓存命中掉到 0。
  - 没用 OS 沙箱（`sandbox-exec`）包 claude：Worker 自己就跑在 `sandbox-exec` 里（不能嵌套），没法在 Worker 里实测它包住后 claude 还能不能正常跑；
    上面三层都在 claude 进程里管，Linux（没有 `sandbox-exec`）上一样生效。
  - 剩下的缺口（三家都一样，都是用户自己放开的）：claude 的钩子没跑（托管策略只许托管钩子）且用户/项目设置放行了会写文件的 shell 命令；
    agy 用户设置 `permissions.allow` 放行了 `write_file` / `run_command`。
- 复制失败分两种：
  - `ForkUnsupportedError`（格式不认识、厂商没这个能力、`--conversation` 找不到）→ **这一次**直接换清单里的下一个办法，不算失败、不退避；
  - 其它错误（进程起不来、网络）→ 这一次失败（2.7）。

### 2.4 写

- 复制那份收到的是改过的交接提示词（`handoverRequestText` 改一版）：开头说明“这是从项目经理会话复制出来的一份，只用来写交接；用户看不到这里，
  这里没有 hub 凭证，不要调用工具，直接把交接写成回复”；“新会话手里有”那一条改成“交接之前约 3 万字你和用户的原话”。
  第 7 节“附上最近对话里的原话”和带过去的 3 万字原话重复，改成“写清楚最后在做什么、做到哪”，不再抄原话。
- 跑腿的拿到这一轮 agent 的全部文字（claude 取 `result`，codex 取 `agentMessage`，agy 取这一轮的文字），空的算失败（`handover_empty`）。
- 复制那份的用量记在这一行的 `usage`（看花了多少），不进项目经理会话的用量。
- 超时：从 `forking` 起算 `HANDOVER_TIMEOUT_MS`（5 分钟），到了跑腿的 `abort`（杀进程组，复用 `process.ts`），记失败。

### 2.5 收下

跑腿的拿到文字后调 `ledger.handoverWritten(id, text, usage)`，一个事务里：

1. 存 `text`，状态 `ready`；
2. 旧会话这时空闲、没有在路上的消息 → **直接换代**（2.5.1）；
3. 否则等：之后这个对话里新来的消息（用户的、Worker 的汇报）由 `waitsForHandover` 压着（不再进旧会话），旧会话这一轮 `turn.ended`（不管成没成、有没有被打断）时换代。

#### 2.5.1 换代（沿用 #113 的 `renew`，改几处）

同一个事务里：

- 建 `generation + 1` 的会话（抄工作目录、模型、思考程度、额度状态）；旧会话登记 `session.end`；
- 记分隔线 R（`session.renewed`，网页照旧显示成很淡的分隔线，点开看交接全文），meta 里带 `handoverId`；
- **开场说明在这一刻定稿**：交接 + 原话（第 3 节）拼好存到这一行的 `preamble`，`sessionPreamble(sessionId)` 直接返回它（不再每次现算；之后的消息本来就发给新会话，不会漏）；
- 压着的、还在排队的消息改发给新会话（照旧）；
- **登记 `session.start` 预热新会话的进程**（第 5 节）；
- 登记清理复制那份（跑腿的异步做，第 2.6 节）；
- 这一代自动换的次数清零，对话移出队列。

“项目经理当前一轮结束时瞬切”就是这里：换代就在那一轮的 `turn.ended` 事务里，用户看到的只是下一条回复已经由新会话回了。

**后台任务**（claude 的 `run_in_background`）：旧会话有后台任务在跑时不换（任务完成会叫醒旧会话，换了结果就丢了），也**不压消息**（后台任务可能跑十几分钟，压着就让用户等了），
消息照常发给旧会话；等后台任务没了、空闲的那一刻再换。`ready` 放太久交接就旧了：超过 `HANDOVER_READY_MAX_MS`（建议 30 分钟）作废（`abandoned`，原因 `stale`），过了退避重新复制，不算失败次数。

### 2.6 清理复制那份

- 复制那份写完交接就没用了：跑腿的在 `handoverWritten` / `handoverFailed` 之后**马上**清（不等换代；`handoverForked` 返回 false 时也直接清）。
  调厂商的 `remove(handle)`，幂等（不存在算成功），清完 `handoverCleaned`；清不掉记日志，下次守护进程启动再试（`uncleanedHandovers()`），**不挡换代**。
  换代事务里就不用再登记清理了。
- 为什么要清：复制那份会出现在用户自己的 `claude --resume` 列表、codex 历史、agy 对话列表里，越积越多。
- 各家：
  - claude：用了 `--no-session-persistence` 就没有文件，`remove` 只是保险：算出 `projects/<目录>/<编号>.jsonl`，在就删。
  - codex：`thread/delete`（复制那份）。#108 实测“先删复制那份才能删原会话”——我们从来不删原会话（新会话开场说明里要指原会话的原始记录），只记下这个约束，以后要删原会话先删它的复制。
    `thread/fork` 有 `ephemeral: true`（不落盘、不进 codex 历史，#121 实测上文照带）：用它。ephemeral 的 thread 只活在那个 app-server 进程里，所以 fork 起的进程按 forkId 留着给 write / remove 用，remove 先 `thread/delete`（对 ephemeral 报 not persisted，忽略）再杀进程；重启后进程没了就是已经清掉了。
  - agy：删 `conversations/<新编号>.db*`、`brain/annotations/implicit/presence` 下这个编号的东西，`conversation_summaries.db` 里这个编号的行（`conversation_summaries`、`conversations_fts`）。照 #108 的 `cleanup.py`。

### 2.7 失败、超时、重试

| 情况 | 处理 |
|---|---|
| 复制：不支持 / 格式变了 | 换清单里下一个办法（agy 只有拷库这一个 → 退回“本会话写交接”，见下） |
| 复制、写：普通出错、进程退出、5 分钟超时、写出来是空的 | 记 `failed`，清理复制那份；自动的这一代失败次数 +1，按退避再来；满 3 次这一代不再自动试，记一条日志（同 #113） |
| ready 后放太久（后台任务一直不完） | `abandoned`（`stale`），过退避重来，不算失败次数 |
| 换代后发现 | 不会：换代在一个事务里，重启只会落在前或后 |
| 守护进程重启 | 启动时扫：`forking` / `writing` 的记 `failed`（原因 `restart`，不算次数），清理；`ready` 的照常等空当换（过期就作废）；终态没清的补清 |

**最后的兜底：本会话写交接 + 用户一发消息就打断**（办法清单的最后一项 `in_session`，所有厂商都有，因为它只用通用的驱动接口）：

- 就是 #113 现在的做法（H 发给旧会话、空闲 20 秒才发、写交接那一轮不显示），只加一条：**写交接那一轮里这个对话来了用户的消息，立刻请驱动层停掉这一轮**
  （`p.stops`），H 记 `stopped`（原因 `user_message`，**不算失败次数**），用户的消息照常发给旧会话；之后再空闲 20 秒再试。
- 用户最多等驱动层打断那一下（几秒）。代价是被打断那次白花一次 20 万的读入（claude 走缓存很便宜，agy 不走缓存）。
- 什么时候走到这一步：只有清单前面的办法都“不支持”时（现在只有 agy 拷库失败会走到）。

### 2.8 写交接期间又聊的，怎么不丢

- 切点之后用户和项目经理的原话**全部**带进开场说明，不受 3 万字限制（第 3 节）；只有切点之后的原话本身超过 `HANDOVER_POST_CUT_MAX_CHARS`（建议 6 万字）才说明交接太旧，作废重来。
- 切点之后到的 **Worker 汇报**：每条一行目录（“交接之后到的 Worker 汇报：#112 做完了，全文 `hub worker show 112 --report`”），不带全文——
  交接里不会有它们，不提一句新会话不知道要去查。（用户已拍板，见第 11 节第 1 条。）
- 切点之后项目经理派的活、PR：交接里没有，但账本有，原话里也能看到项目经理当时怎么说的。开场说明加一句“交接写于切点，之后的事看下面的原话和 Worker 汇报目录”。

### 2.9 手动“开新会话”

也走后台：资料页点了，跳过门槛直接排队（`auto = false`）。已有自动的在跑就并进去（改成手动的，失败要提示）。没写成照旧在对话里提示“交接没写成，没换会话”。

## 3. 原话带约 3 万字

- **从哪取：账本 `messages` 表**，不读厂商记录。理由：三家统一（厂商记录格式各不相同，agy 是 sqlite + protobuf）；账本里本来就是网页上看到的那些话；
  对话编号跨代不变，跨几代往前带就是同一条查询；读一张有索引的表，比解析几十 MB 的 jsonl 快几个数量级。
- **带什么**：这个项目经理对话里
  - 用户的 `kind = 'text'`（已回复的；没回复的就是新会话马上要处理的那条，不重复带）；
  - 项目经理的 `kind = 'text'`（包括 `hub ask` 那种问用户的），不带写交接那几轮的（`meta.handover`，只有兜底的本会话写交接会留下）；
  - 不带：工具调用（`kind = 'tool'`）、Worker 汇报（`kind = 'worker'`）、系统消息、分隔线。附件只带文件名（`agentTextOf` 已经是这样）。
- **怎么截**：从切点往后的全部 + 从切点往前按字数（`String.length`，中文一个字算 1）从新往旧累加到 `HANDOVER_RECENT_CHARS`（3 万）。整条整条地取；
  跨过边界的那一条只留后半截，前面标“（前面略）”。按时间正序排，每条前面标“用户：”“你：”，跨代的地方插一行“（这之前是第 N 个会话）”方便新会话对上交接。
- **实现**：一条 `ORDER BY id DESC` 的游标（`messages_conversation (conversation_id, id)` 索引倒着走），够数就停，不用窗口函数扫全表。
  常量 `HANDOVER_RECENT_MESSAGES = 10` 换成 `HANDOVER_RECENT_CHARS = 30_000`，放 `limits.ts`。
- 新会话的提示词同步改：“交接之前约 3 万字你和用户的原话”。

## 4. 只检查需要换的会话（队列）

用户原话：“把大于20万的加入队列不就行了”。

- 账本里一个**内存队列** `Set<ConversationId>`（只是缓存，真相在库里，随时能重建）：
  - 进：`turn.ended` 时用量 ≥ 门槛；手动“开新会话”；
  - 出：换代了；这一代试满次数；会话结束、坏了；
  - 守护进程启动时一条查询重建：`role = 'pm'`、没结束、`json_extract(token_usage, '$.context') >= 门槛` 的会话所在对话，加上 `handovers` 里不在终态的对话。
- 5 秒检查（`runAutoRenew` 改成只看队列）：队列空直接返回，**一条 SQL 都不跑**；队列里每个对话：看它的交接行在哪一步——
  `queued` 且到了退避且旧会话空闲 → 开始；`ready` 且旧会话空闲 → 换代（保险，正常在 `turn.ended` 已经换了）；兜底的本会话写交接看空闲 20 秒。
- 写交接的超时不靠 5 秒检查，跑腿的自己计时（`AbortSignal.timeout`）。

## 5. 换完马上起好新会话的进程

- 换代事务里登记 `session.start(新会话)`。执行器调 `driver.start`：三家现成的“只起进程不写消息”路径（`#spawn(st, resume, null)` 后 `#armIdle`）：
  claude 起进程等标准输入，codex 起 app-server 并 `thread/start`，agy 起进程。已经有压着的消息要发的，`session.send` 自己会起，`start` 遇到正在起就复用。
- 只起进程，**不预读**（不把开场说明先喂进去跑一轮）：第一条回复省掉进程启动（claude 带 MCP 的话几秒），但开场说明（约 3 万字 + 交接 2000 字，claude 1 万多 token）
  第一次要读入，多 2～5 秒。后台先预读一轮的做法不做（用户已拍板，见第 11 节第 3 条）。
- 进程闲 `IDLE_CLOSE_MS`（10 分钟）没人说话照常被关，之后和平常一样按需再起。

## 6. 性能

本机实测（`~/.agent-hub/state/hub.sqlite` 只读，1.2 万条消息；最大的项目经理对话 2131 条，其中工具 893 条、用户/项目经理的话 763 条）：

| 项目 | 现在（#113） | 方案 |
|---|---|---|
| 5 秒检查做的事 | 每个项目经理 1 次对话查询 + 3～5 次查询，其中 `max(updated_at)` 扫这个对话全部消息：2131 条约 3 ms，**随消息数线性涨**（2 万条约 30 ms，乘项目经理个数） | 队列空：0 次查询；队列里每个对话 1～2 次按主键 / 唯一键的查询（微秒级），和消息总数无关 |
| 判断进不进队列 | — | `turn.ended` 事务里读一下本来就在手上的会话行，零额外查询 |
| 原话截取 | 10 条，一次 `LIMIT 10` | 倒着走索引到 3 万字就停：最大那个对话要走约 67 条可见消息 + 中间夹的工具行，全扫这个对话也才 5 ms（用窗口函数全扫实测）；**只在换代时算一次**并定稿，之后零开销。工具行很多时再加部分索引 `(conversation_id, id) WHERE kind = 'text'` |
| claude 复制 | — | 起一个 `claude -p`（1～3 秒，带 MCP 更久）+ 读原会话 jsonl（本机最大 72 MB，`cp` 一遍 0.1 秒，解析也在秒级）；不落盘没有写入 |
| codex 复制 | — | 起 app-server + `thread/fork`（拷 rollout，本机最大 9.6 MB，毫秒级） |
| agy 拷库 | — | 本机最大两个库：8.7 MB 备份 11 ms + 换编号 26 ms（929 格）；5.6 MB 19 ms + 16 ms。`brain/` 一般很小 |
| 写交接（模型） | 占着项目经理 | 后台：读入 20 万（claude 约 97% 缓存，codex、agy 基本不走缓存）+ 写 2000 字左右，估计 0.5～2 分钟；超时 5 分钟 |
| 额外花费 | 0（同一个会话，走缓存） | claude 很少；codex、agy 每次多付约 20 万不走缓存的输入（用户已同意） |
| 同时跑几个 | — | 跑腿的并发上限 `HANDOVER_CONCURRENCY = 2`（每个复制进程几百 MB 内存），多的在 `queued` 等 |

数据多了会不会变慢：检查和触发和消息总数无关；原话截取只走最近的一段，和总数无关；复制耗时跟原会话大小走，但原会话大小被 20 万门槛封顶（换代后从头算）。

## 7. 统一：一处定流程，各厂商只实现三个方法

### 7.1 分工

- `src/daemon/ledger/handover.ts`（同步、在事务里）：**整个流程和所有判断**——进队列、能不能开始、选办法、收下、换代、失败退避、压不压消息、定稿开场说明、手动和自动。不知道厂商的任何细节。
- `src/daemon/handover/runner.ts`（异步、守护进程里）：从账本领活、按办法清单调厂商的 `fork → write`、计时和取消、报回结果、清理、重启时补清。不做判断。
- `src/daemon/handover/<厂商>.ts`：各厂商的 `SessionForker`。
- 本会话写交接（兜底）不需要厂商代码：它用的是现成的驱动接口（发消息、停止）。

### 7.2 接口（PR 0 已定，以代码为准）

- `src/shared/handover.ts`：账本和跑腿的之间的约定——`HandoverId`、`HANDOVER_STATUSES` / `ACTIVE_HANDOVER_STATUSES`、`ForkerKind`、`HandoverMethod`、
  `ForkHandle`、`ForkRef`（`fork_ref` 存的 JSON：`{ forker: SessionForker.id, handle }`）、`HandoverJob`、`HandoverFailure`、`HandoverCleanJob`、`LedgerHandoverWork`。
- `src/daemon/handover/forker.ts`：`ForkSource`、`ForkWriteResult`、`ForkUnsupportedError`、`SessionForker`、`ForkerRegistry`、`findForker`、`withoutHubEnv`、`forkSourceOf`。
- `src/daemon/handover/forkers.ts`：`FORKERS`（`Record<AgentVendor, …>`，漏一家编译不过）；每家的清单在自己的文件里（`claude.ts` 的 `CLAUDE_FORKERS` 等，PR 0 都是 `[]`），
  B、C、D 各改各的文件，不在同一处撞车。

```ts
// src/daemon/handover/forker.ts
export interface SessionForker {
  readonly id: string;              // 清单里唯一、发布后不改，存进 fork_ref，重启后凭它找回同一个办法 remove
  readonly kind: ForkerKind;        // "native" | "copy"，存进 handovers.method
  fork(src: ForkSource, signal: AbortSignal): Promise<ForkHandle>;              // 用不了抛 ForkUnsupportedError
  write(src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal): Promise<ForkWriteResult>;  // { text, usage }
  remove(fork: ForkHandle): Promise<void>;  // 幂等；只拿得到 handle，清理要的路径 fork 时放进 handle.extra
}

// src/shared/handover.ts：账本实现（Ledger extends 它），跑腿的调。都是同步的、各一个事务；对不上的报告静默忽略
export interface LedgerHandoverWork {
  claimHandover(): HandoverJob | null;            // 挑一行能开始的 queued → forking，记切点；{ handoverId, conversationId, session, auto, prompt }
  handoverForked(id: HandoverId, fork: { kind: ForkerKind; ref: ForkRef }): boolean;  // 总是存 fork_ref；还在 forking → writing 返回 true，否则 false（别写了，直接清）
  handoverWritten(id: HandoverId, result: { text: string; usage: TokenUsage }): void; // ready 或直接换代；空白记 failed(handover_empty)
  handoverFailed(id: HandoverId, failure: HandoverFailure): void;  // kind: unsupported（退回 in_session，不算次数）| error | timeout | shutdown（不算次数）
  handoverCleaned(id: HandoverId): void;          // 记 cleaned_at，幂等
  uncleanedHandovers(): HandoverCleanJob[];       // 启动时补清：有 fork_ref、没 cleaned_at、不在 forking / writing
}
```

跑腿的一次活：`claimHandover` → `forkSourceOf(job.session, await prepareLaunch(job.session))` → 按 `FORKERS[vendor]` 从前往后 `fork`（`ForkUnsupportedError` 换下一个；
清单空或都不支持 → `handoverFailed({ kind: "unsupported" })`）→ `handoverForked` → `write` → `handoverWritten`（出错 `handoverFailed`）→ `remove` → `handoverCleaned`。
账本有行可以领时调 `LedgerOptions.onHandoverClaimable`（守护进程接到跑腿的 `wake`）。

办法清单走完都“不支持”→ 账本退回 `in_session`。顺序原则：**厂商自带的放前面，自己造的放后面**；哪天 agy 出了 `-p` 下能用的 `/fork`，加一个 native 放在拷库前面就行。

### 7.3 以后接新厂商要做什么

1. `shared/vendors.ts` 的 `AGENT_VENDORS` 加上它 → `FORKERS` 编译不过，逼着你填。
2. CLI 有复制会话的能力：实现 `SessionForker`（`fork / write / remove`），参数复用这家驱动的启动参数构造、去掉 HUB_*；跑一遍 `test/smoke/background-handover.ts`。
   没有：填 `[]`，自动走本会话写交接 + 用户一发消息就打断，什么都不用写。
3. 驱动层照常要做的：每轮结束报 `usage.context`（门槛靠它）、`driver/transcript.ts` 里原始记录路径（交接提示词里写）。

## 8. 数据和常量

迁移 `0013_handovers.sql`（PR 0 已建，以文件为准）：上面这些列，另加两处——

- `to_vendor`、`to_model`、`to_effort`：新会话用哪家、什么模型和思考程度（第 12 节换厂商）。`to_vendor` 是 NULL = 三列都照抄旧会话；不是 NULL 就照这三列开
  （`to_model`、`to_effort` 是 NULL = 新厂商的默认）。复制、写交接永远用旧会话的厂商。
- 索引 `handovers_from_session (from_session_id)`：按一代会话数自动试的次数。
- 表和索引都 `IF NOT EXISTS`（有的测试把 `user_version` 退回 8 再跑一遍迁移）。

每一代自动试了几次、上次失败时间从这张表按 `from_session_id` 数，不再塞在 H 的 meta 里。H（交接请求消息）只剩兜底的本会话写交接在用。

`limits.ts` 新增 / 改（PR 0 已加，`HANDOVER_RECENT_MESSAGES` 留到 A 换掉时删）：`HANDOVER_RECENT_CHARS = 30_000`（替换 `HANDOVER_RECENT_MESSAGES`）、`HANDOVER_POST_CUT_MAX_CHARS = 60_000`、`HANDOVER_READY_MAX_MS = 30 * 60_000`、
`HANDOVER_CONCURRENCY = 2`；`AUTO_RENEW_IDLE_MS` 只剩兜底用；其余沿用。提示词（`handoverRequestText`、`sessionPreambleText`）留在 `handover.ts` 一处。

## 9. 测试计划（先写测试）

**账本状态机**（`ledger/handover.test.ts` 重写，跑腿的换成假的，直接调 `handoverWritten / handoverFailed`）：

1. `turn.ended` 用量 ≥ 门槛进队列，< 门槛不进；队列空时 `runAutoRenew` 不跑任何 SQL（给 `db` 包一层计数）；50 个项目经理里只有 1 个到门槛，只查那 1 个。
2. 到门槛时旧会话空闲 → 马上 `forking`，不等 20 秒；记了切点；旧会话不空闲 → 等，下一次空闲再开始。
3. 写交接期间用户发消息 → 照常发给旧会话（不压）、旧会话照常回。
4. 收下时旧会话空闲 → 同一个事务换代：新会话、R、旧会话 `session.end`、新会话 `session.start`、开场说明定稿。
5. 收下时旧会话在忙 → `ready`；之后的消息压着；这一轮 `turn.ended`（成功、失败、被打断三种都测）→ 换代，压着的发给新会话，第一条带开场说明。
6. 有后台任务 → 不压消息、不换；后台任务没了再换；超过 `HANDOVER_READY_MAX_MS` 作废重来、不算次数。
7. 失败、超时、空文字 → `failed`、次数 +1、退避翻倍；满 3 次不再自动试、记日志；手动照常能用、失败有提示。
8. `ForkUnsupportedError` → 换下一个办法；清单走完 → 本会话写交接；本会话写交接那一轮来了用户消息 → 停掉、不算次数、用户消息照常发。
9. 重启：`forking / writing` → `failed(restart)` 并清理；`ready` → 空闲就换；终态没清的补清；内存队列按库重建。
10. 手动开新会话碰上自动的在跑 → 并成一个；手动跳过门槛。
11. 换代后只清理一次；清理失败不挡换代、下次启动再清。

**原话截取**（纯函数 + 账本查询）：只取用户 / 项目经理的文字，不取工具、Worker 汇报、系统、写交接那几轮；从新往旧到 3 万字；边界那条留后半截加“（前面略）”；
跨两代、三代都带；切点之后的全带（哪怕超过 3 万）；超过 6 万作废；用户没回复的那条不带；切点之后的 Worker 汇报每条一行目录。

**各厂商**（`daemon/handover/<厂商>.test.ts`，用假的可执行文件，和现在驱动测试一样）：
- claude：参数里有 `--resume 原编号 --fork-session --no-session-persistence`、模型 / 提示词文件 / 设置照传、环境变量没有 HUB_*；取 `result`；退出码非 0 报错；`remove` 文件不在算成功。
- codex：`thread/fork` 参数和 `thread/start` 同一个构造出来、`config` 里没有 HUB_*、`sandbox: read-only`；收齐 `agentMessage` 到 `turn/completed`；`remove` 发 `thread/delete`。
- agy：拿一个造出来的小库（有 `trajectory_meta`、几处编号）拷：原库一个字节不变、新库编号全换、长度不变、`brain/` 拷过去；缺 `trajectory_meta` 抛 `ForkUnsupportedError`；`remove` 删干净、摘要库的行删掉。

**跑腿的**（`runner.test.ts`）：并发上限；超时杀进程组；取消；按清单顺序试；结果报回账本。

**真机冒烟**（`test/smoke/background-handover.ts`，三家都跑，门槛改小）：
切点前说一个暗号、写交接期间再说一个 → 写交接期间用户的消息几秒内就回了（不等交接）→ 换代后新会话两个暗号都答得上 → 复制那份里 `printenv HUB_TOKEN` 是空的 →
跑完 `~/.claude/projects`、codex 线程、agy 对话里没有复制那份留下的东西 → 量一下切换后第一条回复的耗时。
另补两项实测：codex 在原进程一轮中途 `thread/fork` 行不行；claude `--max-turns 1` 是不是调工具前就停。

## 10. 实现拆分

先合 **PR 0（小）**：`shared/handover.ts` 约定 + `forker.ts` 接口 + `forkers.ts` 的 `FORKERS` 占位 + 迁移 0013 + 常量 + `onHandoverClaimable` 选项（只接到账本，还没人调）。合了之后下面并行：

| 块 | 内容 | 依赖 | 建议 |
|---|---|---|---|
| A 账本 | `handover.ts` 状态机、队列、原话截取、换代改动、`waitsForHandover`、兜底的打断、提示词改写 + 第 9 节账本 / 原话测试 | PR 0 | Opus high（最难、时序多） |
| B claude | `handover/claude.ts` + 测试 | PR 0 | Sonnet |
| C codex | `handover/codex.ts` + 测试（含查 `thread/fork` 的不持久化参数） | PR 0 | Sonnet |
| D agy | `handover/agy.ts` 拷库 + 清理 + 测试 | PR 0 | Sonnet high（未公开格式） |
| E 跑腿的 | `handover/runner.ts` + `daemon.ts` 接线（启动重建、关机取消）+ 测试 | PR 0，接口对着 A 的 `handoverWritten / handoverFailed` 签名写 | Sonnet high |
| F 冒烟 | `test/smoke/background-handover.ts` 三家 | A～E 都合 | Sonnet |

A 和 E 之间只靠 PR 0 里写死的账本方法签名（`shared/handover.ts` 的 `LedgerHandoverWork`：`claimHandover / handoverForked / handoverWritten / handoverFailed / handoverCleaned / uncleanedHandovers`），可以同时做。
A 实现时让 `Ledger` extends `LedgerHandoverWork`；E 只依赖 `LedgerHandoverWork`（测试里给假的）。
A 改动大、要审查；B、C、D 各自独立、互不影响。

## 11. 已拍板（2026-11-07，都按推荐）

1. **切点之后到的 Worker 汇报**：开场说明里每条列一行目录（编号 + 状态 + 去哪查），不带全文。
2. **交接写好时项目经理正忙**：这期间新来的消息压到新会话（最多等这一轮结束），不插进旧会话。
3. **新会话预热到哪一步**：只预先起好进程，不预读一轮。

## 12. 给已有项目经理换厂商

**思路：换厂商 = 一次直接换会话（`method = 'direct'`），不调旧厂商写交接，新会话用另一家开。** 用户换厂商常常是因为旧厂商额度用完、报错或断连，这时调旧厂商复制/写交接必然失败；因此直接把账本里已有的内容（对话最近一份已有交接 + 最近约 3 万字原话 + Worker 汇报目录 + 原始记录路径）转给新厂商。性格设定、模式、项目、Worker 都在我们这边，不受影响。

- **触发与当场秒切**：资料页改厂商（`editPersona` 带 `vendor`）。同一个事务里记一条性格设定修改（厂商、模型、思考程度的“改前 / 改后”照记），并调 `switchVendorIn`：
  直接登记（或更新活跃交接行）为 `status = 'ready'`、`method = 'direct'`、`auto = 0`，`to_vendor` = 新厂商，`to_model` / `to_effort` = 用户这次一起选的（没选是 NULL = 新厂商默认），
  `text` 和 `cut_message_id` 取这个对话最近一份已有交接（如有），并**当场在同一事务调 `trySwitch`**：
  - **旧会话空闲时**（包括刚因额度用光或报错 `turn.ended` 停下）：同一事务内直接完成 `switchIn`（更新 `pms` 表的厂商/模型/思考程度、结束旧会话、建新会话、生成 `preamble`、起新会话进程），点保存瞬间秒切完成；
  - **旧会话正忙或有后台任务时**：这一行保持 `status = 'ready'`，资料页显示“正在换到 codex…”，厂商下拉禁用；等旧会话当前这一轮结束（不管成功、失败还是被打断）或后台任务归零时立即切过去。hub 里项目经理自己改不了厂商（照旧 forbidden）。
- **不调旧厂商写交接，直接带已有交接 + 原话 + Worker 汇报目录**：
  - 绝不让跑腿的按旧厂商复制/写交接，也不发本会话交接请求 H；
  - 交接段落复用对话最近一份已写好的交接（`handovers` 表最近一行 `switched` 或最近一条 `session.renewed` 消息；没有则写“（上一个会话没有写交接）”）；
  - `recentRows` 取用户（`status IN ('replied', 'failed', 'stopped')`，含刚因旧厂商额度不够或报错失败的那条用户消息）和项目经理的原话，且直接换厂商跳过 `HANDOVER_POST_CUT_MAX_CHARS` 作废检查；
  - 切点之后的 Worker 汇报目录和原始记录路径照常拼进 `sessionPreamble`。
- **换代时新会话用新厂商**：`switchIn` 建会话时 `vendor = to_vendor ?? old.vendor`；`to_vendor` 不是 NULL 时模型、思考程度用 `to_model` / `to_effort`
  （NULL = 新厂商默认，**不抄旧会话的**：旧厂商的模型名到新厂商那儿不认识）；同一个事务里把 `pms` 的厂商、模型、思考程度改成新的。
  旧会话的 `rate_limit` **不抄**给新会话（额度是按厂商的）。`prepareLaunch` 本来就按会话的厂商拼提示词、设置文件、启动参数，不用改。
- **新厂商工具清单不同的影响**：
  - hub 命令（派活、问用户、看 Worker）三家一样，主要能力不受影响；
  - 开场说明直接写明：“用户把你的厂商从 <旧厂商> 换成了 <新厂商>，直接把之前的对话原话和记录转给了你；用户那边还是同一个对话，不用跟用户提换会话的事。提到的工具名按你自己的工具理解”；
  - “上一个会话的原始记录”是旧厂商的格式：claude 的 jsonl、codex 的 rollout 是文本能翻；agy 是 sqlite + protobuf，新会话翻不了——开场说明里照实写“格式是 agy 的，读不了，只看交接和原话”；
  - 换厂商就没有缓存：新会话第一条要整个读入开场说明（约 1 万多 token），多几秒；
  - 旧厂商的后台任务（claude `run_in_background`）：和平常一样，有后台任务在跑时不换（2.5.1）。
- **Worker 汇报照常发给新会话**：Worker 汇报按对话发给 generation 最大的那个会话，和厂商无关；在跑的 Worker 自己的厂商不变、不受影响。
- **和自动换会话撞上、等待期间撤销**：
  - 如果已经有一行 `ready` 且有写好的交接文本（例如因后台任务未换），直接把 `to_vendor` 等三列写到那一行上并尝试换代；期间若改回旧厂商或点撤销，把三列清回 NULL，照常作为普通换会话走完；
  - 如果活跃交接还在 `queued` / `forking` / `writing`（或 `in_session` 正在写 H），停止 H（如有）并直接改成 `method = 'direct'`、`status = 'ready'` 尝试当场换代；在旧会话忙、等待切换期间若改回旧厂商或点撤销，`direct` 行直接标 `abandoned`（`user_message`）取消。
