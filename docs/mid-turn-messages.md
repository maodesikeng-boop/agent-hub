# 一轮中途写入的消息：claude 能不能马上看到（实测 + 改动方案）

> 结论：**能。** claude 2.1.314 在 stream-json 输入下，一轮还在跑时写进标准输入的 user 消息，会在**当前这个工具调用跑完之后、下一次问模型之前**被读进同一轮，模型据此改计划；不用等整轮结束。M0 实验 1（`docs/m0-report.md`）说“忙时写入的消息只能等下一轮”，那是 `--tools ""` 没工具时的结果，对有工具的会话不成立。
> 只实测、写文档，没改产品代码。脚本和剧本在 `experiments/steer/`（原始输出含本机信息，没提交，`out/` 已忽略；关键行摘在下面）。

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
- 另外 2 家（agy、codex）的驱动各有自己的 `#takeBatch`，本文不涉及；codex 的 app-server 是否有类似的插话机制，要做的话另测。
