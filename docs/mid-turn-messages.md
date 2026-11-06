# 一轮中途写入的消息：claude 能不能马上看到（实测 + 改动方案）

> 结论：**能。** claude 2.1.314 在 stream-json 输入下，一轮还在跑时写进标准输入的 user 消息，会在**当前这个工具调用跑完之后、下一次问模型之前**被读进同一轮，模型据此改计划；不用等整轮结束。M0 实验 1（`docs/m0-report.md`）说“忙时写入的消息只能等下一轮”，那是 `--tools ""` 没工具时的结果，对有工具的会话不成立。
> 只实测、写文档，没改产品代码。（agy、codex 的实测和三家对比在第 7～9 节。）脚本和剧本在 `experiments/steer/`（原始输出含本机信息，没提交，`out/` 已忽略；关键行摘在下面）。

## 1. 官方文档怎么说

出处都在 <https://code.claude.com/docs> 下：

| 页面 | 说的 |
| --- | --- |
| [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript) 的 `SDKUserMessage` | 有 `priority?: "now" \| "next" \| "later"` 字段，“controls when a message you send during a running turn reaches Claude”：**`next` 或不写**：“Claude reads the message in the same turn, as soon as the tool calls it is running finish. If the turn ends first, the message starts the next turn.”；**`later`**：“holds the message until the turn ends and sends it as a new turn”；**`now` + `origin: {kind:"human"}`**（v2.1.286+）：能放后台的活（shell 命令、子代理、MCP 工具调用，v2.1.287+ 还有 WebFetch/WebSearch）挪去后台，Claude 在同一轮读到消息；“When Claude is only writing a response, or the work it is running can't move, Claude Code interrupts the turn instead and Claude reads the message next.”；**`now` 不带 origin**：直接打断这一轮，Claude 接着读这条。 |
| 同页 `SDKControlInterruptResponse` | `interrupt` 控制请求的回执 `{still_queued, cancelled?}`：`still_queued` 是打断时还排着的消息 uuid，“Claude Code processes the listed messages after the interrupt unless you cancel them first”；直接发控制请求的客户端可带 `cancel_queued: true`（v2.1.219+，init 里 `interrupt_cancel_queued_v1`）把它们一并取消。 |
| 同页 `SDKSystemMessage` 的 capabilities | `interrupt_receipt_v1`、`interrupt_cancel_queued_v1` 等；init 事件的 `capabilities` 数组用来探测，“instead of comparing version strings”。`msg_lifecycle_v1`、`interrupt_send_now_v1`、`interrupt_requeue_taken_v1` 在 2.1.314 的 init 里也有，但本页没有写它们的含义（见下面第 2 节的补充来源）。 |
| [agent-sdk/streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) | 流式输入是推荐方式，“Queued messages: send multiple messages that process sequentially, with ability to interrupt”；单条输入模式不支持“Dynamic message queueing / Real-time interruption”。 |
| [agent-sdk/agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop) | “`UserMessage`: emitted after each tool execution with the tool result content sent back to Claude. Also emitted for any user inputs you stream mid-loop.”；流式输入下到 max-turns 还排着的消息不算进那一轮，另起一轮。 |
| [cli-reference](https://code.claude.com/docs/en/cli-reference) | `--replay-user-messages`：“Re-emit user messages from stdin back on stdout for acknowledgment”；`--max-turns`：流式输入时到上限还排着的消息会另起一轮。 |
| [headless](https://code.claude.com/docs/en/headless) | 讲 SIGINT / SIGTERM（SIGTERM 退出码 143、不记 result；SIGINT 或 SDK 的 `interrupt()` 才收尾这一轮）；没有专门讲“一轮中途写入”。 |

**官方没有单独的“Steer”控制请求。** 插话就是正常的 user 消息，靠 `priority` 选时机；另有 `interrupt` 控制请求负责停止，另有 `interrupt_send_now_v1`（对“排着的消息”按“立即发送”）。文档没有写的细节（`command_lifecycle` 事件、`msg_lifecycle_v1`）见第 2 节，来源是下面的实测和第三方整理。

## 2. 补充：`command_lifecycle` 事件（`msg_lifecycle_v1`）

2.1.314 的 `system/init` 里 `capabilities` 有 `msg_lifecycle_v1`。官方页面没写，实测：**我们在 user 行里带了 `uuid`，claude 就会为这条消息输出 `command_lifecycle` 事件**，`command_uuid` 就是我们给的 uuid，`state`：

- `queued`：写进去就出（忙不忙都出）；
- `started`：这条消息被取走、要送给模型了（和回显、`system/status requesting` 同一刻）；
- `completed`：这条消息所在那一轮 `result` 出来时；
- `cancelled`：被取消（`priority:"now"` 打断、`interrupt` 带 `cancel_queued`…）。

第三方整理（docs.rs `claude-codes` 的 `CommandLifecycleMessage`，CLI 变更日志 v2.1.219）与实测一致：不带 uuid 的消息不出生命周期事件；“终态不一定有 started”。**这个事件正好对应我们账本的“排队中 / 已送达 / 处理中 / 完成”**，见第 5 节。

## 3. 实测

**环境**：`claude` 2.1.314，`--model haiku`，在 `/tmp` 临时目录里跑；参数照 `buildClaudeArgs`：`-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --session-id <uuid> --model haiku --append-system-prompt-file <文件>`，另加 `--no-session-persistence --strict-mcp-config --allowedTools Bash`（要开着工具；没有 `--settings` 钩子文件）。每条消息都带 `uuid`。时间是从启动进程算起的秒数。任务：依次跑 3 条 `sleep 5; echo ONE/TWO/THREE`，每条之后报一句。脚本 `experiments/steer/steer.py`，剧本 `a.json` 等，`run.sh NAME` 跑一个。

### A：第一条命令跑的时候写进“停下，只跑一条”

默认（不写 `priority`）。第一次跑（`a`，不带 uuid）：

```
 3.62 assistant  tool_use:Bash sleep 5; echo ONE
 4.67 WRITE      STOP. Change of plan: only run ONE command in total ... Reply with the word ACK-A.
 8.99 user       tool_result:'ONE'                         ← 命令跑完
 9.04 user       [replay] 'STOP. Change of plan…'          ← 回显：这时才出
10.77 assistant  text:"ACK-A  The first command printed `ONE`. I've stopped there and won't run the other two."
11.38 result/success turns=2
```

**结论：下一步就看到并照做**，没有再跑第 2、3 条；命令一跑完（8.99）模型下一次请求就带上了这条消息（9.04），不用等整轮。等的时间 = 当前这个工具剩下的时间（这里 5 秒的命令）。一个 10 分钟的工具调用就要等 10 分钟，想更快要用 `priority:"now"`（见 A′）。

### A′：`priority` 的另外两种（补测）

- **`later`**（`a_later`）：3.75 写入，3 条命令全跑完，21.49 `result`，之后才另起一轮（23.06 回显、`started` 在 21.49）读到消息，模型说“All three commands had already finished before your message arrived”。**和现在“忙时排队”一样**。
- **`now` + `origin:{kind:"human"}`**（`a_now`）：5.22 写入，命令被挪到后台（7.65 `background_tasks_changed`，tool_result 文字是 “Command was moved to the background … so that a message that arriv…”），8.48 **这一轮就以 `result/success`（`result:""`，`queued_turn_count:1`）收尾**，同一刻第一条消息的 `command_lifecycle` 变 `cancelled`、新消息 `started`；10.06 回显，新的一轮回复 `ACK-A_NOW`（10.13 `result`）；之后后台命令跑完又触发了一个自己起的轮（12.3～13.75，模型读了后台命令的输出文件）。**这一条的副作用比 `next` 大**：打断的那一轮有个空 `result`，被打断的消息标 cancelled，被挪走的命令没被杀、之后还会再唤醒模型一次。

### B：连着写进两条

`b`，第一条命令跑时先后写进 “MSG-B1：再告诉我 2+2” 和 “MSG-B2：最后一句带 PINEAPPLE”：

```
 4.98 WRITE B1 / 4.99 command_lifecycle queued(B1)
 6.02 WRITE B2 / 6.03 command_lifecycle queued(B2)
 9.39 user tool_result:'ONE'
 9.48 user [replay] B1    9.48 user [replay] B2    9.48 lifecycle started(B1)、started(B2)
10.73 assistant text:"The first command printed ONE, and 2+2 is 4. Running the second command now."
23.11 assistant text:"All three commands … 2+2 is 4.\n\nPINEAPPLE"
23.14 lifecycle completed(B1)、completed(B2)   23.15 result/success turns=4（只有一个 result）
```

**结论：两条都被看到、都被回应**；同一次工具跑完后一起取走，各自一个回显、各自 `queued → started`，不需要我们拼成“用户连发了 N 条”。

补测 `g`（M0 实验 1 的场景：模型在流式输出文字、没工具，写进 “只回 SECOND” “只回 THIRD”）：两条一起被排到下一轮，回显合成一个事件（两个 text 块，`uuid` 是第二条的），`started` 事件两条各一个，模型回 `SECOND\nTHIRD`——**两条都回了**，M0 当时“只回第一条”现在不再复现（模型和 claude 版本都变了）。

### C：回显什么时候出，`result` 怎么算

- **回显（`isReplay:true`）不是写入时出，是被取走时出**：A 里写入 4.67、回显 9.04；B 里写入 4.98/6.02、回显 9.48。第一条消息的回显在 `init` 之后约 2～3 秒（模型开始响应时，如 3.60），不是 0 秒。
- **同一轮**：A、B 中途插进来的消息都在同一轮里，整轮只有一个 `result`（`turns=2`/`4` 算了它）；`result` 上没有 `user_message_uuid` 一类字段指出是哪条消息，要靠 `command_lifecycle`。
- **另起一轮的情况**：消息没赶上（模型已经在写最后的文字，D；`later`；`now`）就在这一轮的 `result` 之后另起一轮，`system/init` 又出一次（现有的 `#onInit` 把“没有在途消息时的 init”当成 claude 自己开的轮，见第 6 节风险）。
- **回显和 uuid 不是一一对应的**：多条合并时回显是一个事件（`g`），只带最后一条的 uuid；要用 `command_lifecycle.started` 对账，不要用回显。

### D：写进去时 claude 正在流式输出文字（没跑工具）

`d_next`（加了 `--include-partial-messages` 以便知道在流式输出）：2.72 流式输出了 8 个 delta 时写入（`queued`），**要等这一段回复写完**（7.49 整段 assistant text，7.56 `result/success`，`completed(第一条)`），随即 7.56 `started(第二条)`，8.37 回显，9.59 第二个 `result`，模型回 `ACK-D_NEXT`。**结论：不打断；等当前这次模型回复结束，作为下一轮处理，两个 `result`**——和现在的排队效果一样，只是排队的是 claude 而不是我们。`d_now`（`priority:"now"`+human）：2.60 写入，2.61 立刻出 `result/success`（带着已写的半截文字），第一条标 `cancelled`，新一轮从头回应——等于“打断”。

### E：消息里带我们的标签

`e1`：中途写入 `content:[{text:"【用户直接对你说】"},{text:"STOP. Only run ONE command…ACK-E1"}]`（我们的 `prefixes` 单独一块的格式），系统提示里放了 `prompt.ts` 里那两句说明。8.34 命令跑完，8.40 回显两个 text 块，10.26 模型回 `ACK-E1` 并停止，`result` 一个。`e2`：中途连写一条带标签（“只跑两条，句子里带 ACK-E2A”）和一条不带标签（“最后带 PINEAPPLE”）：11.32 一起取走，12.82 回复里带 ACK-E2A，不再跑第 3 条，最终回复以 `PINEAPPLE` 结尾。**结论：标签不影响取走和照做**；带标签、不带标签的各自分开回显，模型按系统提示区分来源。

### F：停止（`interrupt` 控制请求）碰上 claude 里排着的消息（补测）

`f1`：第一条命令跑时写一条 “MSG-F，回复 ACK-F”，1 秒后发 `{"type":"control_request","request_id":"i1","request":{"subtype":"interrupt"}}`（现有 `buildInterruptLine` 就是这个）：

```
4.69 WRITE  control_request interrupt
4.70 control_response success {"still_queued":["…0002"]}
4.70 user [Request interrupted by user for tool use] ; 4.70 result/error_during_execution
4.71 lifecycle cancelled(第一条) ; 4.71 lifecycle started(MSG-F)         ← 停止之后，排着的消息照样跑
5.97 回显 MSG-F ; 5.98 assistant text:'ACK-F' ; 6.02 result/success
```

**停止不会清掉 claude 里排着的消息，它们紧接着另起一轮跑。** 要真正“停”，控制请求要带 `cancel_queued:true`（`f2`）：回执 `{"still_queued":[],"cancelled":["…0002"]}`，该消息 `cancelled`，没有后续轮（那次进程最后退出码是 1，stderr 没有输出，大概是最后一个 result 是 error 导致，没深究）。

## 4. 能不能做：能

做成“跑完当前工具就看到新消息”的办法就是**忙的时候也直接把 user 行写进标准输入**（不写 `priority`，等同 `next`），不再放进我们自己的队列。

- 能看到的时机：当前工具调用结束、下一次问模型之前；等待时间 = 这个工具剩下的时间。
- 看不到的时机（会像现在一样排到这一轮之后）：模型正在输出最后的文字时（D）。
- 想“不等工具”要用 `priority:"now"` + `origin:{kind:"human"}`，副作用大（A′），**不建议第一版做**，可以做成之后的“立即插话”按钮。

## 5. 驱动层改动方案（只针对 `claude-driver.ts` / `protocol.ts`；agy、codex 另算）

**总的原则**：claude 自己已经有队列和 `command_lifecycle` 事件，让它管；我们的待发队列只留“现在写不了”的情况。

### 5.1 写入：忙时直接写

- `#takeBatch`/`#deliverNext`/`#afterTurn`：`send` 时，如果进程已经 `initSeen`、没在关闭、消息不是命令：**不管有没有在途的轮，立刻写**（现在是 `#busy(st)` 就排队）。进程没起、正在启动（没 init）、正在关闭、消息是命令（`composer.isCommand`，本地命令如 `/compact` 在轮中间的行为没测，也会丢前缀块，见 #76）：照旧排在 `st.pending`。
- 每一行 user 都要带 `uuid`（真 UUID，`crypto.randomUUID()`），和我们的 `Batch`（一组 messageIds）对应起来：`Map<uuid, Batch>`。`buildUserLine` 加 `uuid` 参数；可选 `origin:{kind:"human"}`（`queued_turn_count` 才会数它们，对我们没用，不加）。
- `st.inFlight`（一个 Batch）要改成“已写给 claude、还没 `completed` 的 Batch 集合”；`#busy` = 集合非空 || `selfTurn`。多条写进去不再拼接，每条各一个 Batch（保留 `mergeUserTexts`，用在上面“只能排队”那几种情况下）。
- `#armIdle`/空闲关闭：只在集合为空、`pending` 为空时才计时；写入时清掉计时器（现有的 `#writeBatch` 已经清了）。**另一个 Worker 正在改空闲关闭，这块合并时要对一下。**

### 5.2 状态对应（账本 `message.*` 事件）

| 账本状态 | 现在 | 新 |
| --- | --- | --- |
| 排队中 | `st.pending` | 只剩“写不了”的那几种；已写进去的**不再是排队中** |
| 已送达 `message.delivered` | `stdin.write` 回调成功 | 不变（写成功）；若 init 有 `msg_lifecycle_v1`，可以再等 `command_lifecycle queued` 作为确认（几毫秒内就出） |
| 处理中 `message.processing` | 收到回显且 `inFlight` 非空 | 收到该 uuid 的 `command_lifecycle started`（**不要用回显对账**，合并时回显只带最后一条 uuid，见 C） |
| 一轮结束 `turn.ended` | `result` 到，带 `inFlight.messageIds` | `result` 到：带上**这一轮之前 `started` 过、还没 `completed` 的所有** Batch；`queued` 但没 `started` 的留给下一轮（D），不能标完成 |
| 被取消 | — | `command_lifecycle cancelled`：停止（带 `cancel_queued`）、`now` 打断，标“已取消/已停止”，别标失败；`result` 是 `success` 也可能带 cancelled（`a_now`） |

### 5.3 连发合并还要不要

中途写入的多条各自分开取走、各自回显、模型各自回应（B、E2），**不再需要“【用户连发了 N 条】”**。保留的场景只剩“进程没起/在启动/在关闭/前面是命令”时排在我们自己队列里的几条。提示词 `prompt.ts` 里关于合并的那两句（项目经理、Worker 各一句）继续留着，没有害处；以后若合并几乎不触发再删。

### 5.4 停止

`interrupt()` 里的控制请求要加 `cancel_queued:true`（`buildInterruptLine`），否则停止之后 claude 里排着的消息会紧接着跑（F）。要先看 init 的 `capabilities` 有没有 `interrupt_cancel_queued_v1`，没有就退回现在的行为（并记日志）。停止后被取消的消息怎么办要定：建议标“已取消”，不自动重发（用户按停止就是不想让它再做）。SIGINT 兜底（进程退出）后，`queued`、没 `started` 的消息在 claude 进程里丢了，按 5.5 处理。

### 5.5 重启、崩溃

现在：进程退出时 `inFlight` 的消息走 `CRASH_RECOVERY_NOTE` + `#forgetWritten`。新：按生命周期分开——
- 已 `started` 没 `completed`：模型看到过，按现在的崩溃处理（带说明、由执行器重发）；
- 只有 `queued`、没 `started`：模型没看到，**放回 `st.pending` 前面重新发**（不加崩溃说明），消息不丢；
- `--resume` 之后 claude 的内部队列是空的，别指望它还记得。

### 5.6 要改的地方（清单）

1. `protocol.ts`：`buildUserLine` 加 `uuid`；新增解析 `command_lifecycle`（`command_uuid`、`state`）；`buildInterruptLine` 支持 `cancel_queued`；init 事件里的 `capabilities` 也要读出来（现在没读）。
2. `claude-driver.ts`：`inFlight` → 在途集合；`send` 忙时直写；`#onInit` 判断“自己开的轮”要改（见下面风险）；`#onResult` 结算 `started` 过的；`case "user"` 里 `isReplay` 不再用来标处理中；新增 `case "command_lifecycle"`；`#afterTurn` 只管 `pending`；退出时按 5.5；`interrupt()` 带 `cancel_queued`。
3. 测试：假 claude（`test/fake-claude/`）要能出 `command_lifecycle`、在 tool_result 之后回显插话；加用例：中途写入同轮取走、D 场景下一轮取走、停止带 `cancel_queued`、崩溃时 `queued` 的放回、旧版 claude（没有 capability）退回排队。
4. `docs/m0-report.md` 实验 1、`HANDOVER.md` 第 7.3 节：更新“忙时排队”的结论，指向本文。
5. 网页：“排队中”那个状态只在没写进 claude 时出现；写进去后（已送达）到被取走前，可以显示“已发给 agent，等它跑完当前这一步”（文案和 `docs/ui-standard.md` 对一下，不加灰色说明小字）。

## 6. 风险和没测的

- **`system/init` 每一轮开头都出**：现在没有 `inFlight` 时的 init 被当成“claude 自己开的轮”（`selfTurn`，`#onInit`）。新方案里一轮结束后紧跟的下一轮是由 claude 队列里的消息开的（D），这时在途集合必须还非空，否则会被误判成自己开的轮、并少发 `message.processing`。
- **`result` 不再等于“这条消息答完了”**：一轮的 `result` 可能同时结算好几条，也可能一条消息跨到下一轮（D）。账本只能靠 `command_lifecycle`，必须 init 里有 `msg_lifecycle_v1`（没有就退回旧做法，这在更老的 claude 上要测一次）。
- **等待 = 当前工具剩余时间**：项目经理如果跑一个很长的单个工具调用（比如 10 分钟的构建），用户的话还是要等。`now` 能缓解但有副作用（A′：命令挪到后台没被杀、打断的那一轮 `result` 是空的、之后多一次唤醒），要不要做、怎么做另议。
- **没有工具、只是流式输出文字时没有“插话”**（D）：只能等这次回复写完，和现在一样。
- **没测的**：（1）`/compact` 等本地命令在轮中间写入；（2）`selfTurn`（claude 自己开的轮，后台任务完成）期间写入；（3）模型 haiku 以外（实测只用了 haiku，行为由 claude 的队列决定，应该和模型无关，但“模型看到消息后是否照做”各模型会不同）；（4）带 `--settings` 的权限钩子、真实的项目经理提示词，工具权限等待（`requires_action`）期间写入；（5）`--resume` 后的会话；（6）多个 Worker 的负载。
- **别的版本**：`msg_lifecycle_v1`、`interrupt_cancel_queued_v1`（v2.1.219+）是靠 init 里的 `capabilities` 探测的，不要比版本号；`priority`、`origin` 字段的最低版本官方没写全（`now`+human 要 v2.1.286+）。
- **旁观到的小事**：用户自己的 `~/.claude` 里有 `SessionStart` 钩子，每次启动会出 `hook_started`/`hook_response`，对本测试没有影响。
- 另外 2 家（agy、codex）的实测见第 7、8 节，三家对比和跟厂商无关的驱动层接口见第 9 节。

## 7. agy（Antigravity）实测

**环境**：`agy` 1.5.1，`--model gemini-3.8-flash-low`，在 `/tmp` 临时目录里跑；参数照 `buildAgyArgs`：`--input-format stream-json --output-format stream-json --mode auto --dangerously-skip-permissions --model … --print ""`（本账号 `--mode auto` 不可用，agy 回一句 warning 后用默认模式，`--dangerously-skip-permissions` 照样放行工具）。每条消息是 `{"event":"user","message":{"content":[{"type":"text",…}]}}`，没有 uuid 字段。脚本 `experiments/steer/steer_agy.py`，剧本 `*_agy.json`，`run_agy.sh NAME` 跑一个。时间是从启动进程算起的秒数。任务同第 3 节（3 条 `sleep 5`）。

### 7.1 官方文档

出处 <https://antigravity.google/docs/cli/headless>（headless 模式）、<https://antigravity.google/docs/cli/settings>（`queuedMessages`）、<https://antigravity.google/docs/cli/reference>（命令行参数）、<https://antigravity.google/docs/changelog?tab=cli&version=1.4.7>：

- 流式输入：“feeding it prompts one by one on standard input … **Each prompt executes a full turn and emits its own `result` event.**”；“Drive a session programmatically”一节的提示：“**Wait until you receive the `result` event for the current prompt before writing the next one.**”——官方没说一轮中途写进去会怎样，示例是等 `result` 再写下一条；一次管道里连写多条（`printf … | agy`）示例里每条各出一个 `result`。
- 不支持的输入：`control_request`/`control_response` 事件 → `ERROR` 结果、**会话结束、退出码 2**；以 `/` 开头、CLI 自己处理的命令（`/model` 等）同样；不认识的 `event` 名只在 stderr 打 warning 跳过。所以**没有协议层的插话/打断接口**。
- 停止：`result.status` 有 `INTERRUPTED`（“for example, SIGINT”）；关 stdin 是正常结束（等当前轮完成再退出）。
- 只有交互式界面（TUI）有“忙时发消息”的设置：`queuedMessages` = `"queue"`（默认，“held until the current turn ends”）或 `"send-immediately"`（“interrupts the agent and sends it right away”），`alt+m` 临时反着来（changelog 1.4.7）。**这个只管 TUI，headless 的 stream-json 没有对应开关。**

### 7.2 实测

**A**：第一条命令跑时写入“只跑一条”。第一条命令 6.01 开始、11.28 结束；7.05 写入；**3 条命令全跑完**（13.09、19.97、26.82 各一段文字，27.05 `result` turns=1，回复里 ONE、TWO、THREE 都有）；27.08 才出这条消息的回显（`step#8 user_input/DONE`），28.70 回 `ACK-A`，29.06 第二个 `result`（turns=2）。**结论：整轮跑完才读到，和现在“忙时排队”一样。**

**B**：连写两条（7.35、8.39）。27.33 第一个 `result`；27.36 B1 的 `user_input`、29.15 第二个 `result`（回 “2+2 is 4”）；29.18 B2 的 `user_input`、30.86 第三个 `result`（回 `PINEAPPLE`）。**结论：两条都处理，但每条自己占一轮、各一个 `result`，agy 自己在标准输入后面排队，不合并。**

**C**：回显是 `step_update` 的 `step_type:"user_input"`、`state:"DONE"`，**在上一轮 `result` 之后 0.03 秒才出**（27.05→27.08、27.33→27.36、10.56→10.59），也就是“这一条开始被处理”；没有 uuid，只能按写入顺序（先进先出）对应。**一条消息一轮，中途写进去的永远是下一轮，不会和当前轮混在一起**；`result.num_turns` 是整个会话累计的。第一条消息的回显在 init 之后约 0.03 秒。

**D**：正在流式输出故事时（5.82，已出 3 个 delta）写入 “最后加一行 ACK-D”。故事 10.30 写完、10.56 `result`（故事里没有 ACK-D），10.59 回显，12.39 第二个 `result` 回 `ACK-D.`。**结论：不打断，下一轮读到，和 A 一样。**

**E**：中途写入 `content:[{text:"【用户直接对你说】"},{text:"Skip command (3)…ACK-E2A"}]`，再写一条不带标签的 “…PINEAPPLE”。同样是整轮（3 条命令）跑完后才读到，第二轮回 `ACK-E2A: Understood… skip command (3)`，第三轮回 `…PINEAPPLE`。**结论：标签不影响（进的是下一轮，两个块都被读到）。**

**停止**（`f_agy`）：第一条命令跑时（6.34 开始）写入 “MSG-F，回复 ACK-F”（7.37），再发 `SIGINT`（现有 `interrupt()` 就是这个）：8.44 stderr `error: interrupted`，`result` 的 `status:"ERROR"`、`response:""`、`num_turns:1`，**进程退出码 1**，没有后续轮。再用同一个 `--conversation <id>` 起一个进程（`f2_agy`）问“你有没有收到过 MSG-F”，回 `NOT-SEEN-F`。**结论：停止就是杀进程，agy 里排着的消息整个丢了（连历史里都没有）；没有“取消排着的消息”这回事，也没有“停止之后它们接着跑”的风险。**

### 7.3 结论（agy）

不能做“当前工具跑完就看到新消息”。协议里没有插话/打断，只有“一条一轮”的队列。**照旧排队**（我们自己的待发队列），不要把消息提前写进标准输入：提前写进去也是排到整轮之后，还多一个“进程杀掉时写进去的消息丢了、而账本以为已送达”的问题；另外 agy 不合并连发消息，我们现有的“用户连发了 N 条”合并反而省轮数。想做“立即插话”只能 SIGINT 杀进程再 `--conversation` 重启，约 4 秒启动、被打断的工具白跑，不建议。

## 8. codex（app-server）实测

**环境**：`codex-cli 0.162.0-alpha.17.2`（ChatGPT.app 里那个），`codex app-server --listen stdio://`。握手和参数照 `codex-driver`/`codex-protocol`：`initialize`（`experimentalApi:true`）→ `initialized` → `thread/start {cwd, model, developerInstructions, sandbox:"workspace-write", approvalPolicy:"on-request"}` → `turn/start {…, summary:"detailed", sandboxPolicy:{type:"workspaceWrite", networkAccess:true, writableRoots:[cwd]}}`；服务端发来的审批请求脚本自动 `accept`。脚本 `experiments/steer/steer_codex.py`，剧本 `*_codex.json`，`run_codex.sh NAME` 跑一个。**模型：任务指定的 `gpt-5.4-mini` 在本机账号（ChatGPT 免费档）上不能用**：`400 The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account`（`model_not_found`）；`model/list` 只有 `gpt-6-luna`、`gpt-5.6-terra`、`gpt-5.6-luna`，实测用 **`gpt-5.6-luna`**。（`src/shared/vendors.ts` 里 codex 打包名单是 gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex，在这个账号上都不可用，不在本任务范围，见汇报。）时间同样是从启动进程算起的秒数；注意每一轮第一条用户消息的 `userMessage` 回显比 `turn/started` 晚 5～10 秒（模型首次响应前的启动），和本任务无关。

### 8.1 官方文档

出处 <https://developers.openai.com/codex/app-server>（同内容 <https://learn.chatgpt.com/docs/app-server>），源码 <https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs>、测试 `codex-rs/app-server/tests/suite/v2/turn_steer.rs`、`turn_interrupt.rs`；本机 `codex app-server generate-json-schema --experimental` 生成的 schema 也有：

- **Thread**：“a conversation between a user and the Codex agent. Threads contain turns.” **Turn**：“a single user request and the agent work that follows”，含若干 item。生命周期：`turn/start` 开一轮；“**Steer an active turn**: Call `turn/steer` to append user input to the currently in-flight turn **without creating a new turn**”；一轮以 `turn/completed`（`status`: `completed` / `interrupted` / `failed`）结束。
- **`turn/steer`**：“Include `expectedTurnId`; it must match the active turn id.”；“The request fails if there is no active turn on the thread.”；“`turn/steer` doesn’t emit a new `turn/started` notification.”；“doesn’t accept turn-level overrides (`model`, `cwd`, `sandboxPolicy`, or `outputSchema`)”；返回 `{turnId}`。参数还有 `clientUserMessageId`（可选）、`additionalContext`（实验）。
- **`turn/interrupt`**：`{threadId, turnId}`，成功回 `{}`，“the turn finishes with status: "interrupted"”；`turnId` 不对报 `expected active turn id … but found …`。
- `turn/start` 源码注释里提到“Ignored when this request steers an already-active turn”“Ignored when this request adds input to an active turn”，**也就是 `turn/start` 在一轮进行中会被当成往这一轮加输入**；官方文档没写这一点，而且 GitHub issue #59536（2026-11）在报告“有轮在跑时 `turn/start` 应该返回带活动 turn id 的可重试错误”，行为还在变，**不要依赖它，用 `turn/steer`**。
- 还有 `thread/queue/add|list|start|update|delete|reorder`（schema 里有、文档页没写）：codex 自己的待发队列，通知 `thread/queue/changed`。

### 8.2 实测

**A**：第一条命令 10.02 开始；11.06 `turn/steer`，**马上回** `{"turnId":"…"}`；14.91 命令跑完；**14.92 就出 `item/started userMessage`（内容是“STOP…”），在同一个 turn 里**；16.49 `agentMessage` `ACK-A`，16.87 `turn/completed status=completed`。没再跑第 2、3 条。**结论：下一步就读到（当前命令跑完立刻），同一轮，只有一个 `turn/completed`。**

**B**：连着两个 `turn/steer`（11.53、12.57），各自马上回成功；命令 15.40 跑完，**15.41 同一刻出两个 `userMessage` item**（B1、B2 各一个）；回复 “The first command output was ONE, and 2+2 is 4.”，最终 “…THREE. PINEAPPLE”，一个 `turn/completed`。**结论：都读到、都回应、各一个 item，不用拼。**

**C**：回显是 `item/started`+`item/completed` 的 `userMessage` item，**在被取走的那一刻出（不是写入时）**：A 里写入 11.06、回显 14.92。同一轮：中途 steer 的消息 `turnId` 和这一轮相同，整轮一个 `turn/started`、一个 `turn/completed`。`turn/steer` 的回执只表示“收下了”，**不表示被模型读到**。**连在 `turn/started` 之前也行**：`turn/start` 的回执（0.15）一回来就 `turn/steer`（0.15，比 `turn/started` 的 0.26 还早）也被收下，第一条回复 `OK`（8.11）之后 8.12 出它的 `userMessage`，10.48 回 `ACK-L`，同一轮。

**D**：正在流式输出故事时（13.70 `agentMessage` 开始）`turn/steer`（13.71）也马上被收下；故事 24.44 写完，**24.51 出 `userMessage`，随后同一轮又出一个新的 `agentMessage`（38.52，按要求重写并带上 `ACK-D`）**，一个 `turn/completed`。**结论：没有工具时也能在同一轮读到（等当前这次模型回复写完），不像 claude 那样另起一轮。**

**E**：`turn/steer` 的 `input` 里放两个 text（`【用户直接对你说】` 单独一块 + 正文），再一个不带标签的。15.78 取走：第一条回显是一个 `userMessage`，`content` 里两个 text 块；回复 `Command 1 finished with output ONE. ACK-E2A`，不再跑第 3 条，最后回复以 `PINEAPPLE` 结尾。**结论：标签不影响。**

**`turn/start` 在忙时**（`g_codex`）：第一条命令跑时 17.27 再发 `turn/start`，**回执里的 turn id 就是正在跑的这一轮**，21.13 命令跑完后出它的 `userMessage`，同一轮回 `ACK-G`，一个 `turn/completed`（27.47）。也就是行为上等于 steer，但文档没保证（见上面 issue）。

**报错**：没有活动 turn 时 `turn/steer` → `{"code":-32600,"message":"no active turn to steer"}`（`i_codex`，turn 刚 `turn/completed` 之后）；`expectedTurnId` 不对 → `-32600 "expected active turn id `not-the-active-turn` but found `01a1…"`（`k_codex`）；`expectedTurnId` 传 null → `-32600 "Invalid request: invalid type: null, expected a string"`。

**`thread/queue/add`**（`j_codex`）：第一条命令跑时 15.74 加入队列，回 `queuedSubmission`；`thread/queue/list` 能看到；**这一轮不读它**，35.28 `turn/completed` 之后 35.31 自动 `turn/started`（新 turn）处理它，回 `ACK-J`，队列清空。**等于 claude 的 `priority:"later"` 和现在的“忙时排队”。**

**停止**（`h_codex`、`h2_codex`）：第一条命令跑时 steer “MSG-H：以后每条回复都以 KIWI 结尾”（12.01，已收下），1 秒后 `turn/interrupt`（13.04）：13.06 `turn/completed status=interrupted`；**命令没被杀，3 秒后还报 completed（15.87）**；这条被收下但没被取走的消息**没有出过 `userMessage`**；之后新开一轮问“之前有没有消息让你以某个词结尾”，回 `NOT-SEEN`。**结论：停止之后已收下、没被取走的 steer 消息静默丢了（连历史里都没有），不会接着跑；收到 `turn/completed interrupted` 时驱动层要自己把“已写但没见到回显”的消息标成取消。**

### 8.3 结论（codex）

**能做，而且比 claude 更直接**：忙的时候直接发 `turn/steer {threadId, expectedTurnId: <当前 turn id>, input:[…]}`，不用放进我们自己的队列。当前命令跑完（或当前这次模型回复写完）就读到，同一轮。要点：

- 需要当前 turn id：`turn/start` 的回执和 `turn/started` 通知里都有（驱动层已存 `st.activeTurnId`）。`turn/start` 回执之后、`turn/started` 之前就能 steer。
- 竞态：`turn/steer` 报 “no active turn to steer”（刚好 `turn/completed`）→ 退回我们自己的队列，等下一次 `turn/start`；回执成功但 `turn/completed` 来了还没见到那条的 `userMessage`，要不要重发——**没测**这个竞态（steer 被收下的同一刻这一轮恰好结束会不会丢），建议驱动层这样兜底：`turn/completed(status=completed)` 时对“已 steer、没见到回显”的消息按未处理重新排队；用 `clientUserMessageId` 对账（schema 里有，回显里是否带回**没测**，`userMessage` item 实测只有 `content`）。
- 不要用 `turn/start` 当作 steer，也不要用 `thread/queue/*` 替换我们的队列（等同排队，没有收益）。
- `turn/steer` 没有 `model`/`cwd`/`sandboxPolicy` 覆盖：我们每个 `turn/start` 都带的 `sandboxPolicy`、`effort` 等，steer 的消息沿用这一轮的。

## 9. 三家对比和跟厂商无关的驱动层接口

### 9.1 对比

| | claude（2.1.314） | codex（0.162，app-server） | agy（1.5.1） |
| --- | --- | --- | --- |
| 中途能不能被读到 | 能：当前**工具**跑完后（A、B、E） | 能：当前工具跑完，或当前**模型回复**写完后（A、B、D、E） | **不能**，整轮跑完才读（A、B、D、E） |
| 怎么送 | 照常写 user 行（可带 `uuid`，`priority` 默认 `next`） | 专门的 `turn/steer`（要 `expectedTurnId`） | 只能写 user 行，排在整轮后面 |
| 文字输出时（D） | 等这次回复写完，**另起一轮**（两个 `result`） | 等这次回复写完，**同一轮**继续（一个 `turn/completed`） | 另起一轮 |
| 连发两条（B） | 都读到，各一个回显，同一轮 | 都读到，各一个 `userMessage` item，同一轮 | 各占一轮，各一个 `result`，不合并 |
| 怎么知道被取走了（C） | `command_lifecycle started`（要带 uuid；回显会合并，不能对账） | `item/started userMessage`（按顺序；`clientUserMessageId` 能不能带回没测） | `user_input` step（在上一轮 `result` 之后），按先进先出对 |
| 一轮结束的标志 | `result`（可同时结算好几条） | `turn/completed`（`completed`/`interrupted`/`failed`） | `result`（每条消息一个） |
| 标签（E） | 无影响 | 无影响 | 无影响 |
| 立刻打断 | `interrupt` 控制请求（可带 `cancel_queued`）；`priority:"now"` | `turn/interrupt`（要 turn id）；命令不会被杀 | `SIGINT` 杀进程（退出码 1）；TUI 的 send-immediately 在 headless 没有 |
| 停止时已写入、没取走的消息 | **默认接着另起一轮跑**；带 `cancel_queued:true` 才取消 | **静默丢了**（没有 `userMessage`，历史里也没有） | **进程没了，丢了**（`--conversation` 恢复后也没有） |
| 官方文档有没有写 | 有（`priority` 字段） | 有（`turn/steer`，但 `turn/start` 忙时的行为没写） | 没有（只写了“等 `result` 再写下一条”） |

### 9.2 接口设计

原则：**界面和账本只认“能力声明 + 几个通用事件”，不认厂商**。厂商差别全收在驱动里。

**1) 能力声明**：`Driver` 加一个只读属性（放 `src/shared/driver.ts`，每家驱动写死或按 init 探测）：

```ts
interface MidTurnSupport {
  /** 一轮进行中能不能把消息交给 agent。"none" 时驱动层自己排队（现状）。 */
  mode: "none" | "direct";
  /** direct 时：agent 最早什么时候读到。"tool"=当前工具跑完；"model_step"=当前这次模型回复写完（含没有工具时）。 */
  seenAfter?: "tool" | "model_step";
  /** 没赶上这一轮（读到之前这一轮就结束）时：消息怎么办。"next_turn"=厂商自己排到下一轮；"requeue"=驱动层收回、放回自己的队列。 */
  missed?: "next_turn" | "requeue";
  /** 被取走的信号：驱动层据此发 message.processing。 */
  consumedBy?: "lifecycle_event" | "echo_item";
  /** 停止时已写入、还没被取走的消息，厂商是什么态度（驱动层要把它抹平成“已取消”）。 */
  onStopWritten?: "vendor_runs_them" | "vendor_drops_them" | "process_gone";
}
```

三家声明：claude `{mode:"direct", seenAfter:"tool", missed:"next_turn", consumedBy:"lifecycle_event", onStopWritten:"vendor_runs_them"}`（停止时带 `cancel_queued`，抹平成已取消）；codex `{mode:"direct", seenAfter:"model_step", missed:"requeue", consumedBy:"echo_item", onStopWritten:"vendor_drops_them"}`；agy `{mode:"none"}`（`onStopWritten:"process_gone"`，只对驱动自己排的队列有意义）。

**2) `send` 的返回**：`DriverSendResult` 加一种 `{ kind: "written", midTurn: true }`——“忙时写进去了，agent 之后会读到”。`written`（空闲写入）、`queued`（驱动层自己排队，等这一轮完再写，agy 一律这样）、`rejected` 不变。调用方不用知道是 steer 还是直写。

**3) 状态和事件（账本只认这些）**：

| 账本状态 | 事件 | 谁产生 |
| --- | --- | --- |
| 排队中 | `send` 返回 `queued` | 驱动层自己的队列（agy 一律；claude/codex 只在进程没起、正在关闭、命令消息、codex 报“没有活动 turn”时） |
| 已送达 | `message.delivered` | 写成功 / `turn/steer` 回执成功 |
| 处理中 | `message.processing` | **按 `consumedBy` 各家自己判断**：claude 用 `command_lifecycle started`，codex 用 `userMessage` item，agy 用 `user_input` step（现状） |
| 完成 | `turn.ended`，`messageIds` = 这一轮里已经 processing 的 | 驱动层按“已被取走”结算，没取走的留着（claude `queued` 没 `started`、codex steer 没见到回显） |
| 取消 | **新增 `message.cancelled { messageIds, reason }`**（reason: `stop` \| `session_ended`） | 见下 |

**4) 停止时（统一语义）**：用户按停止 = **这一刻所有还没被 agent 取走的消息都标已取消、不自动重发**（和第 5.4 节建议一致），不管厂商：

- 驱动层自己队列里排着的：丢掉，发 `message.cancelled`（现状 `end` 里已经丢，这里补事件）；
- 已写进厂商、没取走的：驱动层记着“已写、没 processing”的消息编号；claude 在 `interrupt` 控制请求里带 `cancel_queued:true` 并以回执为准；codex 收到 `turn/completed interrupted` 时把没见到 `userMessage` 的发 `cancelled`（厂商已丢）；agy 进程 SIGINT 退出后同理（厂商已丢）；
- 这样“厂商停止后会接着跑排着的消息”（claude 默认）的差别不会漏给界面。

**5) 忙时写入前的统一规则（驱动层内部）**：`mode==="none"` 或消息是命令、进程没起/没 init/在关闭 → 排自己的队列；否则直接写，并把消息编号登记到“已写、未取走”集合；这一轮结束时（`turn.ended`）集合里还没被取走的：`missed:"next_turn"` 的留着等下一轮的取走信号（claude），`missed:"requeue"` 的放回自己队列最前面、下一轮 `turn/start`（codex）。崩溃/重启：已 `processing` 的按现在的崩溃说明重发，“已写、没取走”的放回队列重发，不加崩溃说明（模型没看到过）。

**6) 界面**：只认“排队中 / 已送达 / 处理中 / 已取消”；“已送达”在支持中途送达的厂商上表示“agent 会在当前这一步跑完后读到”，agy 没有这个状态（直接排队中）。是否显示“agent 不会中途看到”之类提示由能力声明里的 `mode` 决定，不按厂商名判断。

**7) 没测的（agy、codex）**：codex——steer 被收下的同一刻这一轮恰好结束的竞态、`clientUserMessageId` 是否回显、审批请求（`requestApproval`）挂着时 steer、`thread/resume` 之后的 steer、`gpt-5.4-mini` 以外的模型（行为由 app-server 决定，应与模型无关）、长工具（比如 10 分钟的命令）里 steer 要等到它结束（和 claude 一样，没有 `priority:"now"` 那种挪去后台的办法）；agy——`--mode auto` 在本账号不可用，用的是默认模式 + `--dangerously-skip-permissions`，没测别的权限模式；另外 agy 一轮里工具权限请求挂着时的行为没测。

## 10. 后台任务的信号（agy、codex 有没有对应 claude 的 `system/background_tasks_changed`）

**要回答的**：驱动层靠它判断“还有后台命令在跑，别因为闲置把进程关掉”（claude 的做法见 PR #92 和 `docs/m0-report.md` 的“后台任务事件”一节：`background_tasks_changed` 带完整名单；任务结束时顺序是 `task_updated` → `task_notification` → `background_tasks_changed(tasks=[])` → 约 100 毫秒后 claude 自己开一轮）。agy、codex 有没有对应的信号。

**做法**：同第 7、8 节的环境和参数，让 agent 起一个后台跑 30 秒的命令（`sleep 30; echo BGDONE > bg_done.txt`），记下这段时间的所有事件。agy 脚本 `bg_agy.json`、`bg2_agy.json`，codex 脚本 `bg_codex.json`、`bg2_codex.json`（codex 的 `steer_codex.py` 加了 `bg_list` 步骤，调 `thread/backgroundTerminals/list`）。

### 10.1 agy

官方文档（<https://antigravity.google/docs/cli/headless>）没有后台任务的事件；`init` 里的工具有 `run_command`、`command_status`、`manage_task`、`send_command_input`，没有推送。实测（`bg_agy`，第一个进程等 50 秒）：

```
 6.89 step#2 tool/ACTIVE run_command {"CommandLine":"sleep 30; echo BGDONE > bg_done.txt"}   ← 之后一直没有这一步的 DONE
11.47 step#3 agent_response/DONE 'STARTED'   11.47 result/SUCCESS turns=1
      …… 11.47 到 62.10 之间没有任何事件（命令约 37 秒时跑完，bg_done.txt 写好了，已核对）
```

- **运行期间**：没有任何“后台任务”事件。唯一的痕迹是这个 `run_command` 的 tool step 出了 `ACTIVE` 之后到 `result` 都没出 `DONE`（对比前台命令：`ACTIVE` 之后命令一跑完就出 `DONE`，见第 7 节 A）。
- **跑完时**：没有通知，没有 `step_update`，**不会自己开新的一轮**。agent 要自己调 `command_status` 才知道结果，这要有下一轮。
- **进程关闭**（`bg2_agy`，turn 结束后 2 秒关标准输入）：agy 9.19 `result`、12.92 退出（退出码 0），**不等后台命令**；命令没被杀，孤儿进程自己跑完、写好了文件，但结果没有任何地方接。
- **结论：agy 不能可靠判断“有后台任务在跑”**。只有一个启发式：`result` 到的时候还有 `step_type:"tool"` 的 `ACTIVE` 步骤没 `DONE`——两次实测都是这样，官方没写、没测过其他情形（`command_status` 查询之后会不会补 `DONE`、权限请求挂着、别的工具），**不建议当真**。agy 保持现状（闲置关闭不看后台任务）。

### 10.2 codex

官方文档（<https://developers.openai.com/codex/app-server>）没写后台任务；本机 `generate-json-schema --experimental` 里有 `thread/backgroundTerminals/list|clean|terminate`（返回 `{data:[{itemId, processId, command, cwd, osPid, cpuPercent, rssKb}], nextCursor}`）和 `item/commandExecution/terminalInteraction` 通知。实测分两种情形：

**1) 命令是 codex 自己的“长命令”（unified exec，`source:"unifiedExecStartup"`，`bg2_codex`，让模型给 3 秒的 yield 时间）：**

```
12.14 item/started   commandExecution "sleep 30; echo BGDONE > bg_done.txt" status=inProgress processId=77837
16.44 item/completed agentMessage 'STARTED'
16.50 thread/status/changed idle ; turn/completed status=completed        ← turn.items 里只有 agentMessage，没有这个命令
16.50 thread/backgroundTerminals/list → data:[{itemId:"exec-2bee…", processId:"77837", command:"sleep 30; …", cwd, osPid:null,…}]
26.56 同上：还在名单里
42.05 item/completed commandExecution status=completed exitCode=0 durationMs=29905 aggregatedOutput=null
56.57 thread/backgroundTerminals/list → data:[]
```

- **运行期间能判断**：两个办法都行——①事件：`item/started`（`type:"commandExecution"`）之后没出对应 `item/completed`，这个命令 item **跨过 `turn/completed` 继续开着**，名单就是“开着的 commandExecution item（按 `item.id`）”；②查询：`thread/backgroundTerminals/list {threadId}`（回完整名单，`processId`、`command` 字段，`osPid` 实测是 null）。**`turn/completed` 的 `turn.items` 不含这个命令，不能靠它。**
- **跑完时有通知**：`item/completed`（`status:"completed"`、`exitCode`、`durationMs`，`aggregatedOutput` 是 null），名单随即变空。**不会自己开新的一轮**（42.05 前后没有 `turn/started`，`thread/status` 一直是 idle），模型也没被叫醒——agent 要等下一轮自己去查（或由我们发一条系统消息叫醒它，见 10.3）。
- **闲置关闭（关标准输入）会杀掉它**（`bg3_codex`，turn 结束后 2 秒关标准输入）：app-server 14.79 `turn/completed`、17.18 退出（退出码 0），**那个 unified exec 命令随之被杀**——退出后进程已不在，再等 32 秒 `bg_done.txt` 也没有写出。所以 codex 不处理后台信号的话，超过闲置时长的长命令一定会在关进程时被杀。（shell 层 `nohup &` 的命令是脱离的，应该能活下来，没单独测。）
- 一轮结束时没有专门的“后台任务变了”事件，`thread/status/changed` 的 `activeFlags` 在这期间是空的，不能用。

**2) 命令是 shell 层面放后台（`nohup … &`、`( … ) &`，`bg_codex`，模型被要求“放后台”时选的是这种）：**

```
13.47 item/started commandExecution "/bin/zsh -lc \"nohup sh -c 'sleep 30; echo BGDONE > bg_done.txt' >/dev/null 2>&1 &\"" 
13.47 item/completed commandExecution status=completed exitCode=0 durationMs=0       ← 外壳立刻退出
22.96 turn/completed ; thread/backgroundTerminals/list → data:[]（命令约 44 秒时才跑完）
```

codex 看到的是一个立刻结束的命令，**之后命令还在跑，但没有任何事件、名单也是空的**，不能判断，也没有完成通知。

- **结论：codex 能判断一部分**：codex 自己的长命令（yield 出去的 unified exec）能判断，靠 `item/started`/`item/completed` 对子 commandExecution item、或 `thread/backgroundTerminals/list` 的 `data` 是否为空；agent 自己用 `nohup &` 放到后台的命令，codex 不知道，**判断不了**。哪一种取决于模型怎么选：本次让它“放后台”，一次选了 `nohup … &`、一次选了 `( … ) &`（都是 shell 层面的），只有明确要求“用 yield 时间让命令继续跑”才走 unified exec。`src/daemon/prompt.ts` 里项目经理的“长命令放后台”那句（`run_in_background`，“命令跑完会叫醒你”）只对 claude 成立：codex、agy 没有 `run_in_background`，跑完也不会叫醒。

### 10.3 三家对比和接口

| | claude | codex | agy |
| --- | --- | --- | --- |
| 有没有“后台任务名单” | 有：`system/background_tasks_changed`，`tasks[]` 完整名单（每次整个换掉） | 部分：`thread/backgroundTerminals/list`（完整名单，主动查）；以及开着的 `commandExecution` item；只管 unified exec 的长命令，管不到 `nohup &` | **没有** |
| 运行时的信号 | 事件推送 | 事件（`item/started` 没配对 `item/completed`）+ 查询 | 无（只有一个没 `DONE` 的 tool step，不可靠） |
| 完成时的通知 | `task_notification`、`background_tasks_changed(tasks=[])` | `item/completed`（`exitCode`、`durationMs`） | 无 |
| 会不会自己开新的一轮 | **会**（约 100 毫秒后，agent 读到结果） | **不会** | **不会** |
| 一轮的 `result`/`turn/completed` 之后 | 后台任务通常还在跑 | 命令 item 仍开着 | 命令还在跑 |
| 闲置关闭（关标准输入）时 | 没有信号就会被杀（PR #92 要解决的问题） | **杀掉** unified exec 的长命令（`bg3_codex`）；`nohup &` 的没测 | 进程不等它就退出，**不杀**，命令成孤儿自己跑完，结果没人接 |

**接口**：沿用第 9.2 节的思路，能力声明加一项，界面和闲置关闭只认通用的东西：

```ts
interface BackgroundTaskSupport {
  /** "none" = 这家看不到后台任务（闲置关闭照旧）；"snapshot_event" = 事件带完整名单（claude）；"item_lifecycle" = 靠命令 item 的开始/结束对子，加可选的名单查询（codex）。 */
  signal: "none" | "snapshot_event" | "item_lifecycle";
  /** 任务结束后厂商会不会自己开一轮叫醒 agent。false 时，驱动层要靠“任务结束”事件自己发一条系统消息，不然 agent 不知道命令跑完了。 */
  wakesAgent: boolean;
}
```
驱动层对外只出一个通用事件 `background.changed { count: number }`（claude 用 `tasks.length`，不算 `ambient`；codex 用开着的 `commandExecution` item 数，turn 结束和重启时调一次 `thread/backgroundTerminals/list` 校准），闲置关闭（`idleDelayMs`）只看 `count>0`。`signal:"none"` 的驱动不发这个事件。

- claude：`{signal:"snapshot_event", wakesAgent:true}`（现状，PR #92）。
- codex：`{signal:"item_lifecycle", wakesAgent:false}`：**可以像 claude 一样“有任务就不闲置关闭”，但光保住进程不够**——命令跑完时 agent 不会被叫醒，要由驱动层在 `item/completed`（后台那个命令）到达时发一条系统消息（“后台命令 X 已结束，退出码 N”）把 agent 叫起来读结果，否则只是命令没被杀、结果没人看。
- agy：`{signal:"none", wakesAgent:false}`：判断不了，闲置关闭照旧，命令随进程退出变成没人接的孤儿；`prompt.ts` 里“长命令放后台、跑完会叫醒你”这一句对 agy（和 codex）不成立，要按厂商分开写或只给 claude（agy 让它前台跑，当前这一轮等它；这一条另开任务）。
- **没测的**：`thread/backgroundTerminals/terminate/clean` 的行为、强杀（进程组 SIGKILL）时 agy 的孤儿命令会不会被一起杀、`osPid` 为什么是 null、一个 turn 里同时多个后台命令（名单格式应与单个一致，没测）、`write_stdin`/轮询类工具的事件；agy 的 `manage_task` 工具（可能是子任务，没触发）、`command_status` 调用的事件形状；两家在 `--resume`/`thread/resume` 之后后台任务是否还在。

## 11. 实现（PR：忙时直接把消息送给 agent）

照第 5、9 节做了，和方案不一样、或方案没写到的地方：

**通用接口**（`src/shared/driver.ts`）：第 9.2 节的能力声明（`MidTurnSupport`）最后没做成接口——账本、网页都用不上它（网页不加“要等这一轮结束才看得到”之类的说明小字），只靠 `send` 的结果和事件；`send` 多两种结果 `{kind:"written", midTurn:true}` 和 `{kind:"cancelled"}`（交出去的那一刻用户点了停止，已出 `message.cancelled`）；新事件 `message.cancelled {messageIds, reason:"stop"}`（停止时写进去、没被取走的；方案里的 `session_ended` 从来不会出，去掉了）和 `message.requeued {messageIds}`（进程没了、或这一轮没读到它就结束了，账本放回排队中、重新登记 `session.send`）；`message.delivered` 多一个 `midTurn` 标记（Worker 汇报靠“开这一轮的那条送达”定这一轮从哪开始，中途送达的不算开头）。消息状态多一个 `cancelled`（已取消，迁移 `0010`），转换表多了 `delivered → cancelled`、`delivered → queued`。账本、网页只认这些，不看厂商。

**claude**（`claude-driver.ts`）：
- 中途写入要 init 里 `msg_lifecycle_v1` **和** `interrupt_cancel_queued_v1` 都有（方案只要求前者、停止时再查后者）：少了后者，停止时没法取消，干脆照旧排队，“停止 = 没取走的都取消”就不会有例外。
- 每行都带 uuid（命令行也带）；在途改成按写入先后的数组。`command_lifecycle` 的形状实测是顶层 `{"type":"command_lifecycle","command_uuid","state"}`，第一条的 `queued`、`started` 在第一个 init **之前**到、`completed` 在 result **之后**到：`started` 先记下，init 时再出处理中，事件顺序和以前一样。
- result 只结算 `started` 过的；中途写进去没赶上的留着，它们开的下一轮的 init 不算“claude 自己开的轮”。兜底：一轮里一条 `started` 都没有（claude 没出生命周期事件）时，开这一轮的那条（空闲时写的）照旧算这一轮的。
- 还有没取走的就算忙：不开始算空闲、`end` 等它们处理完、两轮之间不重启（中途写入本身也不调 `prepareLaunch`、不重启，设置的变化等这一轮完了下一条再生效）。
- 停止：控制请求带 `cancel_queued:true`，以回执的 `cancelled` 和 `command_lifecycle cancelled` 为准出 `message.cancelled`；已经 `started` 的那条照旧按“这一轮被打断”收尾（它的 `cancelled` 在 result 之后到，不管）。控制请求没回应被 SIGINT 时，没取走的同样标已取消。
- 崩溃、关机：没取走的出 `message.requeued`（方案是放回驱动层的待发队列：那样没有执行器的动作在等它，进程起不来就丢了，所以交给账本重新登记）；已取走的照旧按崩溃处理。点了停止、控制消息还没回应时进程崩了，没取走的照停止处理（用户的取消，不收回）。
- 中途写的那一行写回调还没回来进程就退出（管道写满时会这样）：退出时已经按停止或崩溃收掉的，回调回来照那时的结论（不再出已送达）；写失败、期间点过停止的，用户的标已取消（`send` 返回 `cancelled`），不退回队列——不然停止之后会写给新起的进程。

**codex**（`codex-driver.ts`）：忙时、知道当前 turn id 时发 `turn/steer`，回执成功算已送达，`userMessage` item（按文字对上是哪条，对不上按先后）算处理中；回执报错（`no active turn to steer` 等）退回驱动层自己的队列（最前面）。`turn/completed` 时 steer 了没读到的：`interrupted` 标已取消，否则出 `message.requeued`；回执还没到这一轮就结束的，回执来了退回自己的队列，这时才算闲下来（接着发、空闲计时、`end` 才返回）。等回执期间点了停止（或这一轮以 `interrupted` 结束）的，回执来了按停止处理：用户的标已取消，系统的退回队列、停止后照常发。点了停止、`turn/interrupt` 还没结果时进程崩了，没读到的照停止处理。中途送达没有加关进程的路径（关进程仍只在 end、两轮之间重启、空闲关闭、end 后刚起的进程这几处，第 10.2 节的后台命令问题不在这次范围）。

**agy**：声明 `mode:"none"`，照旧排队、连发照旧合并。停止时写进去了、还没出 `user_input` 的标已取消（停止时 agy 先出一个 interrupted 的 result 再退出，两条路都处理）。

**停止的统一规矩**（用户定的）：按了停止，agent 还没看到的**用户**消息都取消、不发——还在账本里排队的（账本 `requestStop` 当场标已取消）、在驱动层自己队列里的（`interrupt` 丢掉、出 `message.cancelled`）、一轮中途写进去还没被取走的（上面各家的做法），三家一样（`src/daemon/driver/stop-untaken.ts`）。**系统消息**（Worker 汇报、定时任务、交接）不取消：队列里的停止后照常发，写进去没被取走的收回重发——它们不是用户发的，取消了项目经理就收不到汇报，用户也没法替它们重发。网页上已取消的气泡变淡、下面一行“已取消”，没有重试，用户想再发自己复制。

**账本**：
- `message.requeued` 重新登记 `session.send` 是按去重键 UPSERT 的：同一条消息的 `session.send` 还在跑（`send` 还没返回时被收回）就只改了参数，跑完变 `done`，消息会一直排队中。处理函数在 `written` 之后再读一次消息，又回到排队中就返回 `later`（`handlers.ts`）。
- Worker 汇报：中途送达的不算这一轮的开头；没赶上上一轮、claude 为它另起一轮的，它的 `message.processing` 到时补记这一轮的开头（不然这一轮只调工具没文字时会拿上一轮最后那段文字再汇报一次）。用户直接对 Worker 说的话，中途送达的等 `message.processing` 才告诉项目经理（读到之前点停止会被取消，项目经理不该收到“用户说了 X”）。
- 交接（`handover.ts`）不认 `cancelled`：交接的两种消息是系统消息，停止时不取消。

**已知没处理**：claude 一轮刚结束、它为没赶上的消息另起的下一轮还没开始的那几毫秒里点停止，消息会正常取消，但网页上的“正在停”可能要等下一个事件才消失。

**没做的**：`priority:"now"`（立即插话）；网页上按厂商显示“agent 不会中途看到”的提示（能力声明也就没做成接口）。

**冒烟**（`test/smoke/mid-turn.ts`，`pnpm smoke S27 S28`，直接用驱动层）：claude（haiku）、codex（gpt-5.6-luna）在 `sleep 8` 时说“停下”，都是第 1 条命令跑完就读到、同一轮一个结束、不再跑后面的；写进去还没读到就停止，都标已取消、停止后 8 秒没有新的一轮。

**补测 D 场景的先后**（审查后，claude 2.1.314、haiku，`experiments/steer/d_next.json`、`d_late.json`，`d_order.py` 汇总）：没赶上这一轮的那条（B），第一个 `result` 和 `started(B)` 谁先到——两种写法各跑 5 次（`d_next` 长回复流到一半写入，`d_late` 短回复刚开始流就写入，离 `result` 只有 0.3～0.6 秒），10 次都是 `result` → `completed(A)` → `started(B)`（同一毫秒内也是这个顺序），没见过 `started(B)` 先到。所以“`result` 只结算 `started` 过的”这条规则在实测里站得住，没有为反过来的顺序再加处理。S27a 原来按回复里有没有 THREE 判断“又跑了第三条”，模型常回“TWO 和 THREE 没有运行”，会误报，改成看真跑了的命令。
