# 输入框 “/” 命令和 “@” 文件：实测记录

2026-11-05，本机 `claude` 2.1.314，模型 haiku。对应 `composer-plan.md` 第 3 节的 T1～T9。
测试脚本在仓库外（`/tmp/composer-probe/`，不提交），每次都在 `mktemp -d` 的临时目录里跑。

## 怎么跑的（共同部分）

起 `claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --model haiku`
（就是 `MODEL_QUERY_ARGS` 加 `--model haiku`），标准输入逐行写 JSON，按行读标准输出。长期会话就是不关标准输入、一轮一轮往里发。
临时目录里放：

- `.claude/commands/x.md`（`description`、`argument-hint: [word]`，正文 `Reply with exactly: XCMD-EXPANDED $ARGUMENTS`）；
- `.claude/skills/y/SKILL.md`；
- `README.md`（第一行 `SECRET-FIRST-LINE-7731`）、`a b.md`（第一行 `SPACEFILE-LINE-4492`）。

**测“有没有展开”的坑**：自定义命令同时也是 skill，模型自己会调 `Skill` 工具把它跑出同样的结果，看输出分不出是 claude 展开的还是模型自己调的。
所以 T3、T4 用的命令都带 `disable-model-invocation: true`，正文里放一个每次随机、消息里从没出现过的标记（如 `TKB87177`）：
回复里有标记 = claude 展开了；没有（模型自己编、或说“没有这个命令”）= 没展开。
（不加这一项时，`prefix\n/zc three`、`please run /zg seven` 这类都会因为模型调 Skill 工具而“看起来能用”，结论会错。）

## T1　`initialize` 回应里的 `commands`

跑法：`MODEL_QUERY_ARGS` 起 claude，写
`{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}`，等 `control_response`。

- **耗时**：0.87～0.90 秒（和 `docs/model-catalog.md` 的模型名单是同一次回应，没有额外开销）。之前只会出 `system/hook_started`、`hook_response`。
- 回应里 `response.commands` 是数组，**每项字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 命令名，不带 `/`；插件的是 `插件:名字` |
| `description` | string | 一句说明；末尾带来源：`(user)`、`(project)`，插件命令开头带 `(slack)` 这样的前缀；有的很长（`sales:call-prep` 有几百字） |
| `argumentHint` | string | 参数提示，没有是 `""`；`/compact` 是 `<optional custom summarization instructions>` |
| `aliases` | string[]，可能没有 | 别名；插件命令的短名也放这里（`slack:block-kit` 的别名是 `block-kit`） |
| `builtin` | true，可能没有 | claude 自带的命令带 `true`；自定义命令、skill、插件命令没有这个字段 |

真实例子（原样）：

```json
{"name":"x","description":"probe command x (project)","argumentHint":"word"}
{"name":"y","description":"probe skill y (project)","argumentHint":""}
{"name":"compact","description":"Free up context by summarizing the conversation so far","argumentHint":"<optional custom summarization instructions>","builtin":true}
{"name":"clear","description":"Start a new session with empty context; previous session stays on disk (resumable with /resume)","argumentHint":"[name]","aliases":["reset","new"],"builtin":true}
{"name":"model","description":"Set the AI model for Claude Code","argumentHint":"<model>","builtin":true}
{"name":"slack:standup","description":"(slack) Generate a standup update based on your recent Slack activity","argumentHint":""}
```

- 在这台机器上共 210～218 项（不同时刻略有差别，见 T8）：自带 54 项（`builtin:true`）、插件命令 115 项（名字带 `:`）、其余是用户和项目的 skill / 命令。
- **x、y 都在**（项目里的命令和 skill 都进同一个 `commands`，没有区分）。
- **插件命令在**，名字是 `插件:名字`。
- **`/clear`、`/model`、`/effort` 都在**（`builtin:true`），所以要靠我们自己的隐藏名单拦。其他应该进隐藏名单的自带命令：`fast`、`config`、`mcp`、`agents`、`rename`、`import`、`output-style`、`auto-mode-setup`、`heapdump`、`goal`……要拿到的列表为准。
- **只在终端界面能用的也在**：`doctor`、`color`、`focus`、`reload-plugins`。名单没有标记它们，要靠 T2 里 `system/init` 的 `terminal_slash_commands`（见下）去掉；但那个只在第一条消息之后才有，所以隐藏名单里要把这四个也写死。
- 没有 `/help`、`/review`。`/init`、`/compact`、`/context`、`/usage`（别名 `cost`、`stats`）、`/security-review` 在。
- 这次没有 `mcp__server__prompt` 形式的项（本机没有提供 prompt 的 MCP）。

## T2　`system/init` 的 `slash_commands` 对比 T1

跑法：同一个目录，发一条 `say only: hi`，读第一条 `system/init`。

- `system/init` 里和命令有关的字段：`slash_commands`（210 个名字，只有名字）、`skills`（164 个名字）、`terminal_slash_commands`（`["doctor","color","focus","reload-plugins"]`）。
- 和 T1 的 `commands` 对比：
  - 内容基本一致，T1 有的它都有，x、y、`clear`、`model`、`compact` 都在；
  - 差别只有一处：`anthropic-skills:docx` 这类（共 9 个）在 `slash_commands` 里带插件前缀，在 `commands` 里是不带前缀的短名（`docx`）；
  - `skills` 是 `slash_commands` 的子集（没有自带命令）。
- 结论：`system/init` 没有说明文字和参数提示，**只能当补充，不能代替 T1**；唯一有用的是 `terminal_slash_commands` 标出了只能在终端用的。
- `system/init` 是**每一轮**开头都会出一条（不是每个会话一条），每次都带着完整名单。

## T3　长期会话里连续两轮 `/x 参数`

跑法：不关标准输入，发 `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"/za one"}]}}`，收到 `result` 再发 `/zb two`、`/zc three`，三个命令各带自己的随机标记。

```
@3416 assistant ["TKA19699 one"]    ← 第 1 轮，会话里的第一条消息
@4823 assistant ["TKB38324 two"]    ← 第 2 轮
@6044 assistant ["TKC66949 three"]  ← 第 3 轮
```

结论：**每一轮都展开**，第一条消息也不例外（没有“命令还没加载”的问题）；参数 `$ARGUMENTS` 正确代入。
展开后不再出现“用户消息”事件，直接是模型照命令正文回复。第一次展开后会出一条 `system/commands_changed`（带完整名单，见 T8）。

## T4　两个 text 块 `["【用户直接对你说】", "/x"]`（最关键）

跑法：长期会话里，每个变体用一个新命令（标记每次不同，`disable-model-invocation: true`），先发一条 `say only: ok` 热身，再发：

| 变体 | content 里的 text 块 | 展开了吗 |
|---|---|---|
| A | `["/za one"]`（对照） | **展开**（`TKA70630 one`） |
| B | `["【用户直接对你说】", "/zb two"]` | **展开**（`TKB87177 two`） |
| C | `["【用户直接对你说】\n/zc three"]`（同一块里先加字再换行） | **没展开**（模型编了 `TKC three`） |
| D | `["/zd four", "TRAILING-BLOCK"]`（命令在前、别的块在后） | **没展开**（`TRAILING-BLOCK four`，没有标记） |
| E | `["【用户连发了 2 条】", "1. hello", "/ze five"]` | **展开**（`TKE45875 five`） |
| F | `["  /zf six"]`（前面一个空格） | **没展开** |
| G | `["please run /zg seven"]` | **没展开** |
| H | `["PFX-MARKER", "/zh eight，再告诉我你看没看到 PFX-MARKER"]` | **展开**，并且模型说“看到了 PFX-MARKER” |
| I | `["/zi AAA", "/zj BBB"]`（两块都是命令） | 只展开最后一块：`TKJ47768 BBB`，`/zi` 被当普通字 |

结论（**决定我们发消息的格式怎么改**）：

1. claude 只认**最后一个 text 块**是不是以 `/` 开头；前面的块不参与判断，也不挡着，**前面的块里的字模型照样看得到**（H）。
2. 所以格式改成：“【用户直接对你说】”、重启说明、“【用户连发了 N 条】”这些我们加的字，**各放进前面的 text 块**；**用户原文单独放在最后一个 text 块，并且原文要从 `/` 开头**（不能有前导空格）。方案里的“加的字放前面的块、用户原文放最后一块”**成立**，不需要“`/` 开头的消息不加标签”这个退路。
3. 不能把加的字和原文拼在同一个块里（C），也不能把命令放在非最后一块（D、I）。
4. 连发拼一条时，**`/` 开头的消息不能和别的拼在一起**：拼成一条以后只有最后一条有机会展开，前面的 `/xxx` 会变成普通字（I）。方案里的“`/` 开头的消息不和别的拼在一起”照做。
5. 展开后命令正文替换的是整条消息还是只替换最后一块：从模型的表现看，前面的块是保留的（H），命令正文照常执行。

`src/shared/driver.ts` 的 `buildUserLine` 现在只写一个 text 块，需要改成接收“前缀数组 + 原文”，前缀每项一块，原文放最后。`checkUserLine` 已经允许多个 text 块，不用改。

## T5　`@README.md` 会不会读进文件内容

跑法：`--tools ""`（关掉所有自带工具）起会话，发 `Quote the first line of @README.md verbatim`。

```
assistant ["The first line of `README.md` is:\n\n```\nSECRET-FIRST-LINE-7731\n```"]
```

没有任何 `tool_use`，却逐字引出了文件第一行 → **会自动把文件内容读进来**（`-p` 加 stream-json 下照样有效）。
对照：同样的话去掉 `@`（在没读过文件的新会话里），模型说读不到文件、需要权限。（这个对照里本机的 MCP 工具还在，模型试着调了两个，都被拒；没有文件内容。）
注意：`--tools ""` 只关自带工具，本机装的 MCP 工具（codegraph、pdf-viewer）还在，模型会试着调。

## T6　带空格的路径

跑法：同 T5，`--tools ""`，各发一条：

| 写法 | 结果 |
|---|---|
| `@"a b.md"` | **能认**：引出 `SPACEFILE-LINE-4492` |
| `@a\ b.md` | **不认**：模型说读不到 |
| `@a b.md`（不加引号） | **不认**：只当 `@a`，模型说读不到 `a b.md` |
| `"a b.md"`（没有 `@`，对照） | 读不到 |

结论：带空格的路径插入 `@"a b.md" `（带双引号），和方案一致。

## T7　`/compact` 和 `/clear`

跑法：不加 `--no-session-persistence`（要测 `--resume`，会写会话文件），先让它记一个暗号 `BANANA-42`，再发 `/compact`，问暗号，发 `/clear`，再问暗号；之后分别用原来的会话 ID 和新 ID `--resume` 问暗号。

`/compact` 的输出（按顺序）：

```
{"type":"system","subtype":"status","status":"compacting",...}
{"type":"system","subtype":"hook_started","hook_name":"SessionStart:compact",...}   ← 用户的钩子照常跑
{"type":"system","subtype":"status","status":null,"compact_result":"success",...}
{"type":"system","subtype":"compact_boundary",...,"compact_metadata":{"trigger":"manual","pre_tokens":29305,"post_tokens":10321,"cumulative_dropped_tokens":18984,"duration_ms":4941}}
{"type":"user","message":{"content":"This session is being continued from a previous conversation ... <summary>"}}
{"type":"user","message":{"content":"<local-command-stdout>Compacted ...</local-command-stdout>"}}
{"type":"result","subtype":"success","result":""}
```

- 没有 assistant 文字，`result` 是空串（正常结束，不是错误）；约 5 秒（haiku）。
- 会话 ID 不变；**之后问暗号还能答 `BANANA-42`**（摘要里带着）。
- `system/compact_boundary` 有 `trigger`、`pre_tokens`、`post_tokens`、`duration_ms`，可以用来显示“已压缩上下文”。
- 注意 `compact_boundary` 前后会出两条 `type:"user"` 的事件（摘要和 `<local-command-stdout>`），驱动层不能把它们当用户发的消息显示。

`/clear` 的输出：

```
{"type":"conversation_reset","new_conversation_id":"a5bbc99f-cf7c-…","trigger":"clear","user_message_uuid":"…","session_id":"253926f2-…"}   ← 旧 ID
{"type":"system","subtype":"init",...,"session_id":"9018891a-…"}                                                                              ← 新 ID
{"type":"result","subtype":"success","result":"",...,"session_id":"9018891a-…"}
```

- 之后问暗号答 `UNKNOWN`（上下文清空了）。
- **之后事件里的 `session_id` 换成了新的 `9018891a-…`**（`conversation_reset` 里的 `new_conversation_id` 和它不同，是另一个 ID，别拿它当会话 ID）。
- `--resume 原ID`：接回的是 **清空之前**的对话，答 `BANANA-42`。`--resume 新ID`：答 `UNKNOWN`。
- 结论：我们存的是旧 ID，`/clear` 之后重启接回的会是清空之前的内容，和用户看到的对不上 → **`/clear` 要拦**；驱动层认出 `conversation_reset` 记日志。

## T8　往正在跑的会话再发 `initialize`

跑法：会话里分四个时刻各发一次 `initialize`：没发过任何消息时、一轮结束后、往 `.claude/commands/` 里新加 `newcmd.md` 之后、一轮进行中。

| 时刻 | 结果 |
|---|---|
| 发消息之前 | 回 211 项，0.87 秒（第一次） |
| 一轮结束后 | 回 `success`，211 项，**10 毫秒** |
| 中途新加 `newcmd.md` 后 | 回 `success`，**列表里有 `newcmd`**，7 毫秒（会重新读目录） |
| 一轮进行中 | 回 `success`，218 项，11 毫秒，不影响正在跑的一轮 |

- 能重复发，每次都重新回完整列表，而且很快；所以可以直接问正在跑的会话，不用另起一个 claude。
- 列表会变：这次 211 → 218（后面多出来的应该是 MCP 连上后才有的项），所以缓存不能当成永远不变。
- 会话中途列表变了 claude 还会主动推 `{"type":"system","subtype":"commands_changed","commands":[…]}`，**里面带完整的 `commands` 名单**（形状和 `initialize` 的一样），可以直接拿来更新缓存。
- 试了 `get_commands`、`list_commands`、`supported_commands`，都回 `Unsupported control request subtype`，只有 `initialize` 能用。

## T9　不存在的 `/foo`

跑法：发 `/foo bar`。

```
assistant ["`/foo` isn't a command in this session, so it didn't run. The closest match is `/loop`. Did you mean that, or did you want something else? ..."]
result success
```

当普通消息处理：**算一轮**，有 `system/init`、有模型回复（要花一次模型调用），不报错、没有专门的“未知命令”事件。
所以手打的 `/xxx` 不在列表里也可以照常发。

## 总表

| 项 | 能用吗 | 怎么处理 | 来源 |
|---|---|---|---|
| 自定义命令 `/x`、skill `/y` | 能，每轮都展开 | 进列表 | T1、T3 |
| 插件命令 `/slack:standup`（也能用短名 `/standup`） | 在列表里（展开没单独测，机制同 skill） | 进列表 | T1 |
| `/compact` | 能；`compact_boundary`，无文字回复，会话 ID 不变 | 进列表；驱动层认出 `compact_boundary` 显示“已压缩上下文” | T7 |
| `/context`、`/usage`、`/init`、`/security-review` | 在列表里 | 进列表 | T1 |
| `/clear`（别名 `reset`、`new`） | 会换会话 ID，`--resume` 旧 ID 接回清空前 | **拦**，提示用“开新会话”之类的按钮 | T7 |
| `/model`、`/effort` | 在列表里 | **拦**（和资料页设置打架） | T1 |
| `/fast`、`/config`、`/mcp`、`/agents`、`/rename`、`/import`、`/output-style`、`/auto-mode-setup`、`/heapdump`、`/goal` 等会改设置的自带命令 | 在列表里 | 隐藏名单里放，具体哪些由 C 定 | T1 |
| `/doctor`、`/color`、`/focus`、`/reload-plugins` | 在 `commands` 里，但只在终端能用 | **隐藏**（`system/init` 的 `terminal_slash_commands` 标出了它们） | T1、T2 |
| `/help`、`/review` | 不在列表里 | 手打照常发给 claude | T1 |
| 不存在的 `/foo` | 当普通消息，算一轮，模型说没有这个命令 | 照常发，不拦 | T9 |
| 命令位置 | 只认**最后一个 text 块**以 `/` 开头；前面有加字的块没关系 | 发送格式：加的字在前面的块，原文放最后一块 | T4 |
| 命令和别的消息拼一条 | 只有最后一条能展开 | `/` 开头的消息不和别的拼 | T4 |
| `@path` | 文件内容自动读进来 | 插入 `@path ` | T5 |
| `@"a b.md"` | 能认带空格路径 | 带空格的插 `@"a b.md" `；`@a\ b.md` 和不加引号都不行 | T6 |

**列表从哪拿**：`initialize` 控制请求的 `commands`（有说明、参数提示、别名、`builtin` 标记）。
可以直接问正在跑的会话（10 毫秒，会重新读目录，T8），不用另起 claude；起一个新的约 0.9 秒。
`system/commands_changed` 带完整名单，可以用来更新缓存。`system/init` 的 `slash_commands` 没有说明，只用它的 `terminal_slash_commands`。

## 和 `composer-plan.md` 不一样的地方

- 方案没写的：`commands` 里有 `builtin` 字段，可以直接分出“自带”和“自定义/插件”。
- 方案没写的：`commands` 里混着只能在终端用的 `doctor`、`color`、`focus`、`reload-plugins`，需要隐藏。
- 方案说“拿不到命令列表时”要重新问：实测可以直接问正在跑的会话（T8），不用再起 claude；方案里“如果 T8 可行就改成直接问正在跑的会话”这条成立。
- T4 比方案猜的更宽松：不需要 `/` 开头消息不加标签的退路，加字放前面的块、原文放最后一块就行（但原文不能有前导空格，也不能和前面的加字写在同一块）。
- 测试时发现：自定义命令同时是 skill，模型会自己调 `Skill` 工具跑，容易误判成“命令展开了”。以后写测试要加 `disable-model-invocation: true` 加随机标记。

## 后台怎么接的（#53）

网页只认通用接口，不认识哪家厂商：

- `GET /api/conversations/:id/commands` → `{ commands: { name, description, argumentHint? }[] }`：已经去掉隐藏的，问不到给空列表。
- `GET /api/conversations/:id/files?q=` → `{ entries: { path, root, insert }[], truncated }`：`insert` 是插进输入框的文字（claude 是 `@path`、`@"a b.md"`），主文件夹里的用相对路径，别的用绝对路径。
- 发消息时手打了隐藏的命令：`POST messages` 回 400（`code: "invalid"`），`error` 是给用户看的原因，这条不存、不发。

文件分工：

| 文件 | 管什么 |
|---|---|
| `src/shared/vendors.ts` 的 `VENDOR_SPECS[厂商].composer` | 纯数据：命令开头的字符、隐藏名单（含别名）和每个的拦截原因 |
| `src/daemon/vendors/types.ts` | 厂商接口 `VendorComposer`：`queryCommands`（会话没在跑时另起进程问）、`parseCommands`、`isHiddenCommand`、`isCommand`、`blockReason`、`mention`、`buildUserContent` |
| `src/daemon/vendors/claude.ts` | claude 的实现；`index.ts` 按厂商登记 |
| `src/daemon/driver/claude-driver.ts` | `queryCommands(sessionId)`：往正在跑的进程再写一次 `initialize`；`system/commands_changed` → `commands.changed` 事件；`compact_boundary` → `context.compacted` 事件；`conversation_reset` 只记日志 |
| `src/daemon/commands-catalog.ts` | 命令列表：在跑的会话每次直接问它；没在跑的按（厂商、目录）缓存，过期先给旧的、后台再问；`commands.changed` 直接更新 |
| `src/daemon/workspace-files.ts` | 文件搜索（跟厂商无关）：`git ls-files` 或自己遍历，每个文件夹最多 25000 个，缓存 30 秒，文件名命中排在路径命中前面，最多 50 条 |
| `src/daemon/composer.ts` | 按对话找会话、厂商、目录（`Ledger.composerTarget`），把上面几样接起来给界面服务 |
| `src/daemon/ledger/messages.ts` | 拦隐藏的命令；`context.compacted` 记一条系统消息“已压缩上下文” |

可调的数都在 `src/shared/limits.ts` 的“输入框”一节。

发出去的格式（T4）：恢复、重启、重发说明，“【用户直接对你说】”，“【用户连发了 N 条】”和连发的每一条，各占一个 text 块放在前面；
用户原文单独放最后一块。以命令开头的用户消息不和别的拼，按到达顺序单独写一行。连发拼一条时，每一条里的标签、重发说明和以前一样写在那一条里。

以后接 Codex、Gemini：

1. `shared/vendors.ts` 加厂商清单，带 `composer`（它的命令开头字符、隐藏名单和原因）；
2. 平级加 `daemon/vendors/<厂商>.ts` 实现 `VendorComposer`（怎么问命令列表、`@` 文件怎么写、一条用户消息的 content 怎么拼），在 `vendors/index.ts` 登记；
3. 它的驱动层实现 `Driver.queryCommands`（不支持就返回 null，退回另起进程问），列表变了发 `commands.changed`，压缩了发 `context.compacted`。
网页、账本、命令缓存、文件搜索都不用改。
