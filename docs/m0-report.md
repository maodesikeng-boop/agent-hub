# M0 实验报告

实验日期 2026-11-02，本机 macOS，`claude` 版本 2.1.314，模型除特别说明外都是 `claude-haiku-5-5`。实验在 `mktemp -d` 建的临时目录（下文写作 `<tmp>`）里的一次性 git 仓库中进行，结束后已删除。脚本在 `experiments/m0/`，用法见文末。

按用户新定的两条执行：不做隔离实验（第 8.2 节表里第 2～8 项不测），同时跑的 `claude` 不设上限。

## 总结

**成立的假设**

- stream-json 输入格式就是第 7.3 节写的那行 JSON；一个进程能连续跑多轮；忙的时候写进去的消息会排队。
- `--session-id` 预先指定、`--resume` 恢复都行；换 `--add-dir` 后 `--resume` 同一个会话能接着聊，新目录生效、旧目录失效。`--resume` 在别的工作目录下也能找到会话。
- HTTP `PermissionRequest` 钩子在 `-p` 下每次都触发；`timeout: 330` 生效，测试服务挂 300 秒再回 `allow`，`claude` 一直等着并照做；请求头里能带环境变量；拒绝的原因原样回给模型。超时时当拒绝。
- `--json-schema` 分拣：10 条消息跑两轮，20 次全部有 `structured_output`，两轮结论完全一致。
- 10 个 `claude` 同时跑没出问题。

**要改的地方**

1. **一轮忙时写进去的多条消息会合并成一轮**（第 7.3 节）：不是一条一轮，而是攒在一起变成一条有多段文字的用户消息，模型可能只回应其中一条。系统消息“等空闲再写”的做法要保留，并且最好**每次只写一条，等 `result` 再写下一条**。
2. **`SIGINT` 会让整个进程退出**（第 7.4 节）：不是“结束这一轮、进程还在”。会话保留，可以 `--resume`。想不杀进程只停这一轮，要在标准输入写 `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`，实测可行，但这是没写进文档的内部协议，需要兜底。
3. **一行格式错的输入会让进程直接退出**（第 7.3 节）：驱动层写入前必须校验，`role` 必须是 `"user"`。
4. **`--replay-user-messages` 的回显不是“收到”而是“开始处理”**（第 7.3 节）：消息排队时不会马上回显，“已送达”的含义要改成“已开始处理”。
5. **命令里不能直接写 `$HUB_TOKEN`**（第 8.1 节）：权限检查遇到命令里的变量会直接拒绝（“A variable in this command can't be checked before it runs”），连允许规则都不管用。`hub` 必须自己从环境变量读令牌，agent 只敲 `hub ping` 这样的命令。
6. **沙箱打开时连守护进程的设置跟第 8.2 节写的不一样**（第 8.2 节）：TCP 要 `sandbox.network.allowLocalBinding: true`，光 `allowedDomains` 加 `127.0.0.1` 不行；Unix socket 要在 `allowUnixSockets` 里写**解析过符号链接的真实路径**（macOS 上 `/var` → `/private/var`）。
7. **用户全局的 `~/.claude/` 设置会跟着进每个 agent**（第 7.2 节）：全局 `CLAUDE.md`、全局钩子（包括另一个 `PermissionRequest` 钩子）都会加载。用户已定“权限沿用 agent 自己的设置”，这是预期内的，但要写进文档。
8. **`AGENTS.md` 会自动读，但只在目录里没有 `CLAUDE.md` 的时候**（第 7.2 节提示词）：两个都有时只读 `CLAUDE.md`。提示词里“先读 `AGENTS.md`”这句要保留。
9. **`osascript` 通知点了不能跳到我们的页面**（第 3.7 节）：点击只会打开“脚本编辑器”，不能带链接。要么接受“只提醒，不跳转”，要么用浏览器通知。
10. **第 7.6 节、第 15 章第 4 条的并发上限**：按用户新定的规则删除。

**agent 连守护进程选的通道：Unix socket。** 默认设置（沙箱没开）下 TCP 和 Unix socket 都通；开了沙箱后两条都要专门放行，TCP 放行用的 `allowLocalBinding` 会放开本机所有端口，Unix socket 只放一个文件，范围小得多。理由和第 8.2 节原来的判断一致，具体设置要按第 6 条改。

## 实验 1：stream-json 输入

**要弄清什么**：每行用户消息的 JSON 格式；一个进程能不能连续跑多轮；一轮没结束时再写入会怎样。

**怎么试的**：`experiments/m0/drive.py` 启动 `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --tools ""`，按剧本往标准输入写消息、记下每个输出事件和到达时间。

**结果：行，但有三个要注意的地方。**

- 格式：`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}` 可以；`content` 直接写字符串也可以。
- 连续多轮：同一个进程跑了 3 轮，会话 ID 不变。每一轮开头都会再发一次 `system/init`。
- 一轮还在跑时写入两条消息：两条都没丢，但**合并成了下一轮的一条用户消息**（回显里是两段 `text`），模型只回了第一条：

  ```
  4.97 result/success  （第一轮结束）
  5.00 system/init
  6.15 user [replay] text:Reply with just the word SECOND. | text:Reply with just the word THIRD.
  6.15 assistant text:SECOND
  6.19 result/success
  ```

- 回显时间：第一条消息在 0 秒写入，回显在 4.9 秒和模型回复一起出来；排队的消息在它那一轮开始时才回显。
- 坏输入：不是 JSON 的一行 → 标准错误 `Error parsing streaming input line (type=unknown, 16 chars): SyntaxError`，进程退出，退出码 1。少了 `role` → `Error: Expected message role 'user', got 'undefined'`，进程退出。

**对设计的影响**：第 7.3 节

- “用户的消息马上写进去”改成：会话忙时先存在我们自己的队列里，等 `result` 到了再写，一次一条。这样每条消息一轮，回复和消息对得上。代价是用户连发几条时要等前一轮结束；如果想让用户的补充马上被看到，可以把连发的几条在我们这边拼成一条，标清楚“用户连发了 N 条”。
- “收到回显才标已送达”改成“收到回显标‘处理中’”；写进标准输入成功就标“已送达”。
- 写入前校验 JSON 和 `role`；进程意外退出时按第 7.4 节 `--resume` 重启。

2026-11-06 开着工具用 claude 2.1.314 重测，一轮中途写入的消息会在当前工具跑完后同一轮读到，见 `docs/mid-turn-messages.md`。

## 实验 2：会话

**要弄清什么**：`--session-id` 预先指定 ID、`--resume` 接着聊；先 `--add-dir A`，再 `--add-dir B` 去 `--resume`，能不能接着用同一个会话。

**怎么试的**：第一次用 `--session-id <uuid> --add-dir <tmp>/dirA --tools Read`，让它记住暗号并读 `dirA/a.txt`；第二次 `--resume <uuid> --add-dir <tmp>/dirB`，问暗号、读 `dirB/b.txt`、再读 `dirA/a.txt`。另外试了重复用同一个 `--session-id`、`--resume` 不存在的 ID、在别的工作目录 `--resume`。

**结果：行。**

- `system/init` 里的 `session_id` 就是我们给的 UUID。
- 恢复后记得暗号；`b.txt` 读成功；`a.txt` 被拒：`decision_reason: "Path is outside allowed working directories"`。会话 ID 不变。
- 再用同一个 `--session-id` 启动：`Error: Session ID … is already in use.`，退出码 1。
- `--resume` 不存在的 ID：标准错误 `No conversation found with session ID: …`，并输出一条 `result`，`subtype: error_during_execution`，退出码 1。
- 在 `<tmp>/dirB` 里 `--resume` 一个在 `<tmp>/repo` 建的会话：能接上，`init` 里 `cwd` 变成新目录。
- 会话记录存在 `~/.claude/projects/<按工作目录生成的名字>/<会话 ID>.jsonl`。

**对设计的影响**：第 7.4 节写法成立。补两条：

- 第一次启动和之后恢复必须分清：`--session-id` 只能用一次，之后一律 `--resume`。驱动层可以用“`agent_sessions` 里有没有成功跑完过一轮”来判断；判断错了也只会得到上面两个明确的报错，可以自动换另一个参数重试。
- 换 `--add-dir` 后模型会被告知环境变了，不一定要我们再发“附加文件夹改成了……”，但发了也无害，建议保留。

## 实验 3：打断

**要弄清什么**：给正在跑的进程发 `SIGINT`，进程和会话变成什么状态，之后还能不能 `--resume`。

**怎么试的**：让它写 1200 字文章，开始 3 秒后发 `SIGINT`；然后在另一个工作目录 `--resume`，问暗号和文章写完没有。对照组：同样情况发 `SIGTERM`；空闲时发 `SIGINT`；不发信号，改写一行 `control_request` 的 `interrupt`。

**结果：部分行。会话能保留，但进程会退出。**

- `SIGINT`：先输出已经写出的半截回复，再输出一条用户消息 `[Request interrupted by user]`，再输出 `result`（`subtype: error_during_execution`，`is_error: true`），然后**进程退出**，退出码 0。之后写标准输入会 `Broken pipe`。
- `--resume` 后模型记得暗号，也知道“文章写到第二段就被打断了”。
- `SIGTERM`：没有 `result`，进程直接退出，退出码 143。
- 空闲时 `SIGINT`：进程退出，退出码 0。
- 写一行 `{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}`：马上回 `{"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":[]}}}`，再出 `[Request interrupted by user]` 和一条 `result`（`subtype: success`，`result` 为空），**进程不退出**，下一条消息照常跑。

**对设计的影响**：第 7.4 节“打断”一条改成：

- 首选在标准输入写 `interrupt` 控制消息，进程和会话都留着。这是 `claude` 命令行自己的标准输入协议，不经过 Agent SDK，但官方文档没写，版本升级可能变。
- 控制消息 5 秒内没有回应，就发 `SIGINT`，等进程退出，下次有消息时 `--resume`。
- 不用 `SIGTERM`。
- 打断后的那条 `result` 不能当“这一轮正常结束”处理：`SIGINT` 时 `is_error: true`；控制消息时 `subtype: success` 但前面有 `[Request interrupted by user]`。驱动层按“前面有没有这条打断消息”来标“已停止”。

## 实验 4：权限请求

**要弄清什么**：HTTP 类型的 `PermissionRequest` 钩子在 `-p` 下是不是每次都触发；能不能设 330 秒超时；请求头里能不能带环境变量；测试服务挂 5 分钟不回会怎样。

**怎么试的**：`experiments/m0/fake_daemon.py` 起本机测试服务，按参数回 `allow`、`deny` 或挂着不回。单独的设置文件用 `--settings` 传入，没有动 `~/.claude/`：

```json
{"hooks":{"PermissionRequest":[{"hooks":[{"type":"http",
  "url":"http://127.0.0.1:<端口>/hooks/permission",
  "headers":{"Authorization":"Bearer $HUB_TOKEN","X-Hub-Session":"$HUB_SESSION","X-Not-Allowed":"$HOME"},
  "allowedEnvVars":["HUB_TOKEN","HUB_SESSION"],"timeout":330}]}]}}
```

让它用 Bash 跑 `touch <文件>`（默认要批准）。

**结果：行。**

- 每次都触发：一个进程里连续两轮各触发一次，测试服务都收到 POST，回 `allow` 后文件建出来了。
- 请求头：`Authorization: Bearer tok-abc123`、`X-Hub-Session: sess-42` 都到了；没列进 `allowedEnvVars` 的 `$HOME` 变成空字符串。
- 请求体里有 `session_id`、`transcript_path`、`cwd`、`prompt_id`、`permission_mode`、`tool_name`、`tool_input`、`permission_suggestions` 等，足够做收件箱卡片。
- 回 `deny` 加 `message`：模型收到的工具结果就是这段原因；`system/permission_denied` 事件里 `decision_reason_type: "hook"`；`result.permission_denials` 里有这次调用。
- 超时（设 10 秒，服务挂 40 秒）：10 秒时钩子状态变 `cancelled`（`"output": "Hook cancelled"`），这次调用被当成**拒绝**，模型收到 “needs approval” 的报错。没有配 `onFailure`，默认就是拒绝。
- 挂 5 分钟（设 330 秒，服务 300 秒后回 `allow`）：`claude` 一直等着，没有超时、没有报错，进程也没退出。第 2.8 秒发出请求，第 302.8 秒收到 `allow`，第 303.3 秒命令跑完，文件建出来，这一轮正常结束（`result/success`）。说明 330 秒的超时生效。
- 同时有两个 `PermissionRequest` 钩子在跑：我们的，和用户全局设置里的另一个（回 `{}`，不做决定）。`--settings` 里的钩子是**加上去**的，不会替换全局钩子。

**对设计的影响**：第 7.5 节

- 设置文件写法成立。`onFailure` 这个字段不需要，超时和连不上默认就是拒绝，建议从示例里删掉，免得以为它在起作用。
- 用户全局设置里的钩子也会一起跑。如果全局钩子给出了决定，可能和我们的冲突，第 7.5 节要加一句：守护进程启动时检查用户全局设置里有没有会做决定的 `PermissionRequest` 钩子，有就在设置页提示。
- 收件箱卡片可以直接用请求体里的 `tool_name`、`tool_input`、`cwd`，用 `session_id` 对回我们的会话，不用另外查。

## 实验 5：agent 连守护进程

**要弄清什么**：在 `claude` 的 Bash 工具里，连本机 TCP（127.0.0.1:端口）和 Unix socket 上的测试服务，默认设置下各试一次；沙箱默认没开，所以再开着沙箱各试一次。

**怎么试的**：`fake_daemon.py` 同时监听 `127.0.0.1:47815` 和 `<tmp>/hub.sock`。最小的 `experiments/m0/bin/hub`：`hub ping tcp|unix`，从环境变量 `HUB_TOKEN`、`HUB_TCP`、`HUB_SOCK` 读参数，用 `curl` 发请求。让 `claude --tools Bash` 依次跑 `hub ping tcp`、`hub ping unix`，看结果和测试服务收到的请求头。用户全局设置里没有 `sandbox`，所以默认是沙箱关着。

**结果：默认设置下行；开沙箱后要专门放行才行。**

| 设置 | TCP | Unix socket |
|---|---|---|
| 默认，命令里直接写 `curl -H "Authorization: Bearer $HUB_TOKEN" …`，允许 `Bash(curl:*)` | 被拒：`A variable in this command can't be checked before it runs` | 同左 |
| 默认，`hub ping …`，允许 `Bash(hub:*)` | 通，令牌正确 | 通，令牌正确 |
| 沙箱开（`enabled`、`autoAllowBashIfSandboxed`、`allowUnsandboxedCommands:false`），网络什么都不放 | 不通：`curl: (7) Failed to connect to 127.0.0.1 port 47815` | 不通 |
| 沙箱开 + `allowedDomains: ["127.0.0.1"]` | 不通 | 不通 |
| 沙箱开 + `allowUnixSockets: ["/var/…/hub.sock"]`（带符号链接的路径） | 不通 | 不通 |
| 沙箱开 + `allowLocalBinding: true` | **通** | 不通 |
| 沙箱开 + `allowUnixSockets: ["/private/var/…/hub.sock"]`（真实路径），`hub` 也用真实路径 | 不通 | **通** |

沙箱里的 `NO_PROXY` 包含 `localhost,127.0.0.1`，所以 `curl` 连 127.0.0.1 不走沙箱的代理，`allowedDomains` 管不到它。

**对设计的影响**：第 8.1、8.2 节

- `hub` 必须自己读环境变量里的令牌和地址，不能让 agent 在命令里写 `$HUB_TOKEN`。允许规则写成 `Bash(hub:*)`。
- 通道选 Unix socket。沙箱没开时（用户现在的默认）两条都行；以后开沙箱时，Unix socket 只放行一个文件，TCP 要 `allowLocalBinding: true`，那会放开本机所有端口，包括界面端口。
- socket 路径在写进设置和环境变量之前先解析成真实路径（`realpath`）。数据目录 `~/.agent-hub/` 一般没有符号链接，但仍要做。
- 第 8.2 节的“三组设置”改成上表最后两行的写法；隔离相关的第 2～8 项按用户决定不做。

## 实验 6：`AGENTS.md`

**要弄清什么**：Claude Code 会不会自动读工作目录里的 `AGENTS.md`，还是只认 `CLAUDE.md`。

**怎么试的**：四个目录，各放一句不同的暗号：只有 `AGENTS.md`；只有 `CLAUDE.md`；`CLAUDE.md` 里只写 `@AGENTS.md`；两个文件都有、暗号不同。`--tools ""` 下问它项目说明里的暗号。

**结果：部分行。**

| 目录里有 | 模型说出的暗号 |
|---|---|
| 只有 `AGENTS.md` | `AGENTS.md` 的 |
| 只有 `CLAUDE.md` | `CLAUDE.md` 的 |
| `CLAUDE.md` 写 `@AGENTS.md` | `AGENTS.md` 的 |
| 两个都有 | 只有 `CLAUDE.md` 的 |

也就是说，`AGENTS.md` 只在没有 `CLAUDE.md` 时自动读。另外用户全局的 `~/.claude/CLAUDE.md` 每次都会加载（haiku 两次自己去找 `CLAUDE.local.md`，就是全局说明里的要求）。

**对设计的影响**：第 7.2 节提示词里“先读项目根目录的 `AGENTS.md`”保留。可以改得更精确：守护进程启动前看一下，项目有 `CLAUDE.md` 且没有引用 `AGENTS.md` 时才加这句，避免重复。

## 实验 7：总助分拣

**要弄清什么**：便宜模型加 `--json-schema` 分拣 10 条消息，输出格式稳不稳。

**怎么试的**：`experiments/m0/triage.sh`，每条消息一次 `claude -p --output-format json --json-schema <triage_schema.json> --tools "" --no-session-persistence --model claude-haiku-5-5 --strict-mcp-config`，提示词从标准输入传入。格式里 `project`、`action`、`confidence` 都是枚举。10 条消息中英文混合，有明确的小活、要讨论的、问状态的、指代不清的。10 个进程同时跑，整组约 11 秒。跑了两轮。

**结果：行。**

- 20 次全部有 `structured_output`，都符合格式；`result` 字段里是同一份 JSON 的字符串。
- 两轮结论（项目 + 处理方式 + 把握）10/10 一致。
- 指代不清的“那件我们聊过的事”→ `none / ask_user / low`；问 RSS 进度 → `blog / answer`；跟进行中工单 #3 相关的 RSS 改动 → `to_pm`，没有自己派活，符合第 2.1 节“保守”的要求。
- 每次约 0.0011～0.0012 美元（`total_cost_usd`，订阅登录下只作参考）。

**对设计的影响**：第 2.1、7.2 节写法成立。建议把项目名做成格式里的枚举（每次按当前项目列表生成），这样模型不会编出不存在的项目名。

## 实验 8：通知

**要弄清什么**：`osascript` 发的 macOS 通知能不能弹出来、点了会不会跳转；浏览器通知在 127.0.0.1 上能不能用。

**怎么试的**

- `osascript -e 'display notification "…" with title "agent-hub M0" sound name "Glass"'`，退出码 0。弹没弹出来我没法自动看到（没有截用户的屏幕）。
- 浏览器：`python3 -m http.server --bind 127.0.0.1` 放 `experiments/m0/notify_test.html`，用自动化的 Chrome 打开并在页面里检查。

**结果：部分行，需要用户手动确认。**

- `osascript`：命令成功。按 macOS 的规矩，这种通知算“脚本编辑器”发的，**点了只会打开脚本编辑器，不能跳到我们的页面**。本机没有 `terminal-notifier` 之类的工具，按约束不安装。
- 浏览器：`http://127.0.0.1:<端口>/` 是安全上下文（`isSecureContext: true`），有 `Notification` 接口和 Service Worker。自动化的 Chrome 会自动拒绝授权（`requestPermission()` 直接返回 `denied`），所以真正弹不弹、点了跳不跳，要手动验证。

**请用户手动验证的步骤**

1. 终端里跑：`osascript -e 'display notification "M0 测试" with title "agent-hub"'`。看右上角有没有弹出；没有的话，到“系统设置 → 通知 → 脚本编辑器”打开“允许通知”再试。点一下，记下打开了什么。
2. 终端里进入 `experiments/m0/`，跑 `python3 -m http.server 47816 --bind 127.0.0.1`。
3. 用平常的 Chrome 打开 `http://127.0.0.1:47816/notify_test.html`，点“1. Allow notifications”，在弹窗里点允许。
4. 点“2. Send test notification”，切到别的应用，看通知有没有弹出；点通知，看是否回到这个标签页、页面上出现 “clicked at …”。
5. 用完在终端按 Ctrl+C 停掉服务。如果第 3 步没有弹窗，到“系统设置 → 通知 → Google Chrome”看是否允许。

**对设计的影响**：第 3.7 节

- 要“点了能跳转”，用浏览器通知（页面开着时）。`osascript` 只做兜底提醒，文字里写清楚去哪里看。
- 首次打开界面时引导用户允许浏览器通知。

## 实验 9：额度用完

**要弄清什么**：碰上额度用完时报错长什么样。

**结果：没碰上。** 按约束没有故意耗额度。实验中看到的是每轮都有的 `rate_limit_event`，额度正常时长这样：

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793619600,
 "rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,
 "unifiedWindows":{"five_hour":{"utilization":0.37,"resetsAt":1793619600,"status":"allowed"},
                   "seven_day":{"utilization":0.59,"resetsAt":1793646000,"status":"allowed"}}}}
```

整个实验期间没有出现 `system/api_retry`。

**对设计的影响**：第 7.3 节的事件表加一行 `rate_limit_event`：记下 `utilization` 和 `resetsAt`，界面可以提前显示“5 小时额度已用 N%”；`status` 不是 `allowed` 时显示“等额度”。额度真用完时的样子，等实际碰上再补。

## 其他发现

- `init` 事件的 `additional_directories` 里会出现工作目录本身（`/var/…` 和 `/private/var/…` 两种写法各算一个），不影响使用。
- 每个工作目录会在 `~/.claude/projects/` 下生成一个目录，存会话记录和自动记忆。实验用到的这些目录已经删了。
- `--include-hook-events` 会把所有钩子的开始和结果都输出成 `system/hook_started`、`system/hook_response`，调试权限钩子时很有用。

## 后台任务事件（#69）

**要弄清什么**：agent 用 Bash 的 `run_in_background`（或 Monitor）把命令放到后台后，claude 怎么告诉我们“后台还有任务在跑”。驱动层的空闲关闭（`IDLE_CLOSE_MS`，10 分钟）不能把这种会话当闲着，否则等 CI、跑冒烟的命令超过 10 分钟就跟着 claude 进程一起被杀。

**出处**：
- 官方文档 [Agent SDK TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript) 的 `SDKBackgroundTasksChangedMessage`（要求 Claude Code v2.1.203 以上）、`SDKTaskStartedMessage`、`SDKTaskUpdatedMessage`、`SDKTaskNotificationMessage` 几节。
- 2026-11-06 用真 claude（2.1.314，`claude-haiku-5-5`，`-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`，临时目录里）实测：让 agent 用 Bash 工具 `run_in_background: true` 跑 `sleep 30 && echo BGDONE`；另用 Monitor 工具跑 `sleep 20; echo MONDONE` 对照。

**文档的说法**：
- `system/background_tasks_changed` 在后台任务名单变化时发（任务开始、结束、被杀，前台 agent 转后台，条目的 `description`、`ambient`、`parent_task_id` 变了）。
- `tasks` 是**完整的当前名单**，不是增量：“用每次的内容整个换掉缓存，别靠 `task_started`、`task_notification` 配对去算，下一次名单变化会纠正漏掉的事件。”
- 一个任务结束时，它的 `task_updated`、`task_notification` 先到，再到把它从名单里去掉的 `background_tasks_changed`；别的先后不保证。
- 启动时不发。进程起来（含重启）时把记的名单清空，等下一次变化再填。对已经在跑的会话再发 `initialize` 控制消息，claude 会在回应后补发一条当前名单（哪怕是空的）。
- `ambient: true` 的条目不算会话的活（Claude Code 自己的任务、实时更新的 watcher），文档说统计活动时要排除。

**实测的事件原样**（去掉 `session_id`）：

```json
{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bfzd9im3k","run_id":"0mw4e9un2-f55a4808","task_type":"local_bash","description":"Sleep 30 seconds then echo BGDONE"}],"uuid":"2d859a6c-…"}
{"type":"system","subtype":"task_started","task_id":"bfzd9im3k","run_id":"0mw4e9un2-f55a4808","tool_use_id":"toolu_01HHTk7w…","description":"Sleep 30 seconds then echo BGDONE","is_backgrounded":true,"task_type":"local_bash","uuid":"034b6e2d-…"}
…（任务跑完时）
{"type":"system","subtype":"task_updated","task_id":"bfzd9im3k","run_id":"0mw4e9un2-f55a4808","patch":{"status":"completed","end_time":1793934513827},"uuid":"09bf36ec-…"}
{"type":"system","subtype":"task_notification","task_id":"bfzd9im3k","run_id":"0mw4e9un2-f55a4808","tool_use_id":"toolu_01HHTk7w…","status":"completed","output_file":"…/tasks/bfzd9im3k.output","summary":"Background command \"Sleep 30 seconds then echo BGDONE\" completed (exit code 0)","uuid":"eefe17d6-…"}
{"type":"system","subtype":"background_tasks_changed","tasks":[],"uuid":"80736f28-…"}
```

字段：`tasks[]` 每条有 `task_id`、`run_id`、`task_type`（Bash 命令和 Monitor 都是 `local_bash`，子代理是 `local_agent`）、`description`，可能有 `subagent_type`、`parent_task_id`、`ambient`。实测的 Bash 后台任务和 Monitor 任务都没有 `ambient` 字段（不算 ambient）。

**一次完整的事件顺序**（Bash 后台 `sleep 30`，时间从发消息起算，毫秒）：

| 时间 | 事件 |
|---|---|
| 0 | 写入用户消息 |
| ~2800 | `assistant`（tool_use，`run_in_background: true`） |
| ~3170 | **`background_tasks_changed`（tasks 有 1 条）**、`task_started` |
| ~3200 | `user`（tool_result：“Command running in background with ID …”） |
| ~4130 | `assistant`（“started”） |
| ~4190 | `result`（这一轮结束；**后台任务还在跑**） |
| ~5900 | `commands_changed`（和后台任务无关） |
| ~33200 | `task_updated`、`task_notification`，然后**`background_tasks_changed`（tasks 为空）** |
| ~33310 | `init`（claude 自己开的一轮，没有我们写的消息；#64 已支持） |
| ~34360 | `assistant`（汇报后台输出）、`result`（自己开的一轮结束） |

要点：
1. **后台任务通常在一轮里就出现，轮结束（`result`）时它还在跑**，所以光看“这一轮结束”会误判成闲着；必须记名单。
2. 名单清零（`tasks: []`）在 claude 自己开的那一轮的 `init` **之前**约 100 毫秒到。所以清零时不能立刻当成“可以关”，但空闲计时远大于这个间隔，下一轮 `init` 会把计时停掉（驱动层 `#onInit` 本来就这么做）。
3. 一次对话里这个事件可以反复来，每次都是完整名单；同一份名单重复发也无妨（整个换掉）。

**对驱动层的影响**（`src/daemon/driver/background-tasks.ts`、`claude-driver.ts` 的 `#armIdle`、`#onBackgroundTasksChanged`）：
- 每个会话记当前后台任务名单（按 `task_id` 去重，不算 `ambient` 的）。每次事件整个换掉；`tasks` 不是数组的残缺事件忽略。
- 有后台任务时，空闲计时不用 `IDLE_CLOSE_MS`，换成兜底 `BACKGROUND_TASKS_HOLD_MAX_MS`（4 小时，见 `limits.ts`）；任务清零时（正在算空闲）从头重新算 `IDLE_CLOSE_MS`。一轮在跑时不动计时，轮结束 `#afterTurn` 按当时的名单算。兜底到点照常关，记一条日志。
- 进程起来、退出（崩溃、停止、空闲关闭、end、关机）时把名单清空：后台任务跟着进程走，下一个进程不带旧的。
- 冒烟 S26（`test/smoke/background-idle.ts`）：空闲调到 6 秒、后台 `sleep 24`，没被杀、自己开的一轮正常汇报；S26b 对照（兜底压到最短）确实被杀。
- agy、codex 驱动：同样有空闲关闭，但没有对应的信号，这次没改，驱动层里没有认出后台任务的信号（agy 没实测，codex 本机没装），这次没改。

## 脚本

都在 `experiments/m0/`，只用系统自带的 `python3`、`sh`、`curl`。

| 文件 | 做什么 |
|---|---|
| `claude_clean.sh` | 去掉父会话留下的环境变量（`CLAUDECODE` 等）再运行 `claude` |
| `drive.py` | 按剧本驱动一个 stream-json 的 `claude` 进程：写消息、等 `result`、发信号、关标准输入，输出带时间的事件记录 |
| `summarize.py` | 把 `drive.py` 的记录打印成时间线 |
| `fake_daemon.py` | 假守护进程：TCP + Unix socket，记下每个请求；`/hooks/permission` 按参数回 `allow`、`deny` 或挂着 |
| `bin/hub` | 最小的 `hub ping tcp|unix` |
| `run_connect.sh` | 实验 5：让 `claude` 在 Bash 里跑 `hub ping` |
| `prompt_hub.txt`、`prompt_connect.txt` | 实验 5 的提示词 |
| `triage.sh`、`triage_schema.json`、`triage_context.txt`、`triage_messages.txt` | 实验 7 |
| `notify_test.html` | 实验 8 的浏览器通知页 |

例子：

```sh
# 实验 1：一轮没结束时写入两条
echo '[{"send":"Write a 300-word story."},{"wait_type":"system"},{"sleep":2},
       {"send":"Reply SECOND."},{"send":"Reply THIRD."},
       {"wait":"result"},{"wait":"result"},{"close":true},{"exit":60}]' > s.json
python3 experiments/m0/drive.py s.json out.jsonl -- -p --input-format stream-json \
  --output-format stream-json --verbose --replay-user-messages \
  --model claude-haiku-5-5 --strict-mcp-config --tools ""
python3 experiments/m0/summarize.py out.jsonl

# 实验 4：权限钩子
python3 experiments/m0/fake_daemon.py --log hook.jsonl --port 47811 --decision deny &
```
