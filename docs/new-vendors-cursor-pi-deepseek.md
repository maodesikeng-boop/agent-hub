# 接入 Cursor、Pi、DeepSeek 三家新厂商（方案）

- 只写方案，不改代码。实现等用户拍板、P4（PR #246）合并后再派。
- 对照的接口：`src/vendors/types.ts`（`VendorSpec`）、`src/vendors/daemon-types.ts`（`VendorDaemon`）、`src/shared/driver.ts`（`Driver`），以 `main@4e18b20` + PR #246 为准；能力分级照 `docs/vendor-plugin-design.md` 第 4 节。
- 查法：官方文档 + 本机 `--help` + 公开仓库；没逆向任何程序。本机实测只做了**不耗额度**的事：`--version`、`--help`、`cursor-agent status/models/about`、`cursor-agent acp` 的 `initialize`/`authenticate`/`session/new`（建了一个空会话，没发消息）、`pi --mode rpc` 的 `get_state`/`get_available_models`/`get_commands`（没发消息）。
- 本机版本：`cursor-agent 2026.10.22-27dcf5f`（官方已有 2026.11.05）、`pi 1.5.0`、DeepSeek 什么都没装（npm 上 `@deepseek-ai/dsh` 最新 `0.2.2-rc.1`）。
- 下文“未确认”= 文档没写、本机没法不花额度测出来，实现时第一件事实测。

---

## 0. 结论（先看这里）

| | Cursor | Pi | DeepSeek |
|---|---|---|---|
| 是什么 | Cursor 官方命令行 Agent（`cursor-agent`，也叫 `agent`） | earendil-works 的开源 Agent 外壳 Pi（npm `@earendil-works/pi-coding-agent`，MIT，[pi.dev](https://pi.dev)），自己不卖模型，接 30 多家模型商 | **有官方的**：DeepSeek Harness（命令 `dsh`，npm `@deepseek-ai/dsh`，MIT，**开发者预览**，官方写明“会有不兼容改动”） |
| 能不能接 | 能 | 能，**三家里最顺** | 能，但建议分两步 |
| 推荐怎么接 | 常驻进程走 ACP：`cursor-agent acp`（JSON-RPC，官方支持） | 常驻进程走 Pi 自己的 RPC：`pi --mode rpc`（JSONL，官方文档完整） | 第一步：Pi 接好后在 Pi 里选 DeepSeek 模型，零代码就能用；第二步：`dsh --profile acp` 接成独立厂商 `deepseek`，和 Cursor 共用一个通用 ACP 驱动 |
| 最大的坑 | ① 冷启动慢：实测 ACP 握手 0.75 秒 + 登录 6～8 秒 + 新建会话约 5 秒；② 自带 Seatbelt 沙箱，和我们的 sandbox-exec 不能嵌套，要关（关的参数在 ACP 下生不生效未确认）；③ 思考程度写在模型名里；④ 没有额度接口 | ① 自己没账号，用户要先在 Pi 里 `/login` 或配 API key；② 项目里的 `.agents/skills` 要“信任项目”才读，用 `--skill` 显式给；③ 没有额度接口 | ① 开发者预览，接口会变；② 自带沙箱（macOS Seatbelt、Linux bwrap），同样要关；③ 只有一次性命令行和 ACP/SDK，没有 `--model` 参数，模型和思考程度走 ACP 设置；④ 要 Node ≥ 24.9 |
| 哪家不建议接 | — | — | 不建议“Claude Code + DeepSeek 的 Anthropic 兼容接口”当独立厂商（3.2） |

**接口要不要改**：小改，都不碰现有三家的行为（第 5 节）：
1. 新增通用 ACP 驱动 `src/vendors/_common/acp/`（就是设计文档的可选 P6），Cursor 和 DeepSeek 共用；
2. `models.flags` 改成可选（ACP 的两家用协议设模型，不用命令行参数）；
3. 其余都能用现有能力位表达，不在公共代码写任何厂商名。

**要用户本人做的**：Cursor 已登录（本机实测 `authenticated`，Ultra 订阅）；Pi 要 `/login` 一个模型商或配 key（本机现在一个都没配）；DeepSeek 要去 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 开 API key（按量付费）；东京服务器上三家各装一次、登录一次；真机冒烟会花额度，要用户点头（第 8 节）。

---

## 1. 三家的身份和官方资料

- **Cursor**：文档 [cursor.com/docs/cli](https://cursor.com/docs/cli/overview)；无头模式 [headless](https://cursor.com/docs/cli/headless)；输出格式 [output-format](https://cursor.com/docs/cli/reference/output-format)；参数 [parameters](https://cursor.com/docs/cli/reference/parameters)；ACP [acp](https://cursor.com/docs/cli/acp)；权限 [permissions](https://cursor.com/docs/cli/reference/permissions)；配置 [configuration](https://cursor.com/docs/cli/reference/configuration)；沙箱 [sandbox.json](https://cursor.com/docs/reference/sandbox)、[run-modes](https://cursor.com/docs/agent/security/run-modes)、[沙箱实现博客](https://cursor.com/blog/agent-sandboxing)；技能 [skills](https://cursor.com/help/customization/skills)；[更新日志](https://cursor.com/docs/cli/changelog)。闭源。
- **Pi**：仓库 [github.com/earendil-works/pi](https://github.com/earendil-works/pi)（`packages/coding-agent`），文档随 npm 包发布在 `docs/`，同一份在 GitHub：[rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[rpc-commands.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)、[json.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)、[cli.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)、[security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)、[sessions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)、[providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)、[skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)、[mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)。t3code 的 Pi 接入是它“加一家”的参考实现（`docs/vendor-plugin-design.md` 2.1），实现时可以对照。
- **DeepSeek**：API 文档首页 [api-docs.deepseek.com](https://api-docs.deepseek.com/) 写着“DeepSeek Harness is now in developer preview”；介绍页 [deepseek.com/harness](https://www.deepseek.com/harness/en)；仓库 [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)；命令行帮助 [docs/cli-help.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)；一次性模式 [headless](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)；ACP [acp](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)；沙箱 [sandbox-local](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md)；权限预设 [permission-presets](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/permission-presets/README.md)；说明文件 [agent-instructions](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md)。另外 DeepSeek 官方给了 [Claude Code 接法](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)、[Anthropic 兼容接口](https://api-docs.deepseek.com/guides/anthropic_api)。

---

## 2. 逐项对照

### 2.1 总表

| 项 | Cursor（推荐 ACP） | Pi（推荐 RPC） | DeepSeek Harness（推荐 ACP） |
|---|---|---|---|
| **无头启动** | `cursor-agent acp`（常驻，JSON-RPC 2.0，一行一条）。备选：`cursor-agent -p --output-format stream-json --resume <chatId>`，每轮一个进程 | `pi --mode rpc --session-id <我们定的 id>`（常驻，JSONL）。备选：`pi -p --mode json`（一次性） | `dsh --profile acp`（常驻，ACP）。备选：`dsh --profile headless --json --session-id <id> "任务"`（每轮一个进程） |
| **输出事件** | ACP 标准 `session/update`：消息块、工具调用开始/更新、可用命令；Cursor 扩展 `cursor/ask_question`、`cursor/create_plan`（**阻塞，必须回**）、`cursor/update_todos`、`cursor/task`。print 模式的 stream-json：`system/init`、`user`、`assistant`、`tool_call started/completed`、`result` | `agent_start/end`、`agent_settled`（这一轮彻底结束）、`turn_start/end`、`message_start/update/end`（文字、**思考**、工具调用增量）、`tool_execution_start/update/end`、`queue_update`、`compaction_*`、`auto_retry_*` | ACP 标准：已提交的回复和思考、工具生命周期、配置变化、**上下文用量** |
| **思考** | print 模式**不出**（文档明说）；ACP 下出不出未确认 | 有（`thinking_delta`） | 有（整段提交后出，不是逐字） |
| **用量** | 更新日志说 stream-json 带每轮输入/输出/缓存 token，字段形状未确认；ACP 下未确认 | 有：每条回复带 `usage`（含美元成本）；`get_session_stats` 给累计和上下文占用 | 有上下文用量；token 明细未确认 |
| **多轮** | ACP 一个进程多轮；`session/load` 按会话 id 续接（`initialize` 实测 `loadSession: true`，还支持 `session/list`）。注意 `session/load` 会把历史重放一遍，驱动要吞掉 | 一个进程多轮；`--session-id` 是“这个目录下有就打开、没有就用这个 id 新建”，**会话 id 由我们定**（和 claude 的 `--session-id` 一样好用） | 一个进程多轮；`session/resume` 跨进程续接（不重放历史） |
| **一轮中途插话** | ACP 没有，排队 | **有**：`steer`（当前工具跑完、下次调模型前送达）；`follow_up` 排到这轮之后 | ACP 没有，排队 |
| **会话记录在哪** | `~/.cursor/chats/<哈希>/…`、`~/.cursor/projects/<路径>/`（格式未确认，不当可移植） | `~/.pi/agent/sessions/<按目录分>/…jsonl`（JSONL，格式有文档 `session-format.md`），`get_state` 直接给文件路径 | `$DSH_HOME`（默认 `~/.dsh`）下的 JSONL，具体路径未确认 |
| **复制会话（换代用）** | 没有 | **有**：命令行 `--fork <id>`、RPC `clone`/`fork` | 没有（ACP 文档写明不支持 fork） |
| **模型清单** | `cursor-agent models`（纯文本“id - 名字”，实测 4.0 秒，46 个左右）；ACP `session/new` 的 `configOptions.model` 也有（但会新建会话，不用来探测） | `pi --offline --list-models`（实测 0.38 秒，只列有凭据的模型商）；RPC `get_available_models` | ACP `session/new` 的配置项里有（会新建持久会话，不用来探测），用打包名单：`deepseek-v4-pro`、`deepseek-flash` |
| **思考程度** | 写在模型名里：`claude-opus-5-5-high`、`gpt-5.6-sol-xhigh-fast`；或方括号参数 `'claude-opus-4-8[effort=high]'`，参数名各模型不一样（ACP 实测有 `effort`、`reasoning_effort`） | `--thinking off/minimal/low/medium/high/xhigh/max`，按模型自动收窄；RPC `set_thinking_level` | ACP `session/set_config_option` 的 `reasoning_effort`（模型声明了才有）；官方 Claude Code 接法里 DeepSeek 支持 `high`、`max` |
| **系统提示词** | 没有参数；读项目根的 `AGENTS.md`、`CLAUDE.md` 和 `.cursor/rules`（[using](https://cursor.com/docs/cli/using)）。我们的角色提示词拼进第一条消息（agy 现成做法） | `--append-system-prompt <文件>`（和 claude 一样）；读 `AGENTS.md`、`CLAUDE.md`（从目录往上找，加 `-nc` 关） | ACP 没有参数；默认读 `AGENTS.md`、`CLAUDE.md`（及 `.local.md`），从项目根到工作目录逐层；我们的提示词拼进第一条消息 |
| **全自动免确认** | 普通模式下要确认的工具 ACP 会发 `session/request_permission`，**驱动自动回**（不回会卡住）；print 模式用 `--force`/`--yolo`；另需 `--trust`（信任工作区）、`--approve-mcps` | **本来就不问**，没有审批这一层（[security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)） | 权限预设 `danger-full-access`（不沙箱、不问）；ACP 下需要确认的发 `session/request_permission`，驱动自动回 |
| **自带沙箱** | 有：macOS Seatbelt（`sandbox-exec`），Linux Landlock + seccomp。关：`--sandbox disabled` | **没有** | 有：macOS Seatbelt，Linux bwrap 优先、Landlock 兜底；`danger-full-access` 时不套 |
| **和 write-scope 配合** | 包进我们的 OS 沙箱时必须关自带的（macOS 不能嵌套；Linux 上推断它要建 user namespace，会被我们的 `--disable-userns` 挡）→ `ownSandboxOffArgs: ["--sandbox", "disabled"]`。这个根参数放在 `acp` 子命令前生不生效**未确认** | 直接包，零冲突 | 同 Cursor，要关：启动时 `--patch <生成的 yml>` 把默认预设设成 `danger-full-access`（`launchFiles` 生成）。实测前未确认 |
| **只读 Worker** | `readonly: "os_sandbox"`：外层只读 OS 沙箱 + 驱动回 `request_permission` 时拒绝写类工具和没标只读的 MCP。不用它的 `ask` 模式（“no edits or command execution”，命令都不能跑，不符合我们“命令能跑”的定义）；`plan` 模式能不能跑命令未确认 | `readonly: "os_sandbox"`：外层只读 OS 沙箱 + `--exclude-tools edit,write`；MCP 第一版只读 Worker 加 `--no-mcp`，以后用 Pi 扩展按 `readOnlyHint` 拦（Pi 把注解给扩展，[mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)） | `readonly: "os_sandbox"`：外层只读 OS 沙箱；它自带的 `read-only` 模式要套自己的沙箱，嵌套不了，不用 |
| **能不能跑 `hub`** | 能（shell 工具） | 能（`bash` 工具） | 能（`bash` 工具） |
| **MCP** | 读 `~/.cursor/mcp.json` 和项目 `.cursor/mcp.json`；ACP `session/new` 也能传；团队级 MCP 在 ACP 下不支持 | 内置，`~/.pi/agent/mcp.json`、项目 `.pi/mcp.json`（项目的要信任）；工具名 `mcp__服务器__工具` | 默认不开任何 MCP；ACP `session/new` 传 |
| **技能** | 读 `.agents/skills`、`.cursor/skills`、`.claude/skills`、`~/.agents/skills` 等 → 我们的 `.agents/skills` 直接能用 | 读 `.agents/skills`，**但要信任项目**；加 `--skill <工作目录>/.agents/skills` 显式给（不用 `--approve`，免得连带加载项目里的 `.pi/extensions` 代码） | 读 `~/.agents`；项目级 `.agents/skills` 未确认 |
| **“/” 命令** | ACP 的 `available_commands_update`（实测会话一建就推，含技能） | RPC `get_commands`（扩展命令、模板、`skill:名字`） | ACP 文档写明不支持 commands |
| **登录** | `cursor-agent login`（浏览器；没浏览器设 `NO_OPEN_BROWSER` 打印链接）或 `CURSOR_API_KEY`；状态 `cursor-agent status --format json`（实测 3.9 秒） | 交互界面里 `/login`（订阅 OAuth 或 API key，存 `~/.pi/agent/auth.json`）或各家环境变量；状态 `pi auth check --provider <名> --json`（要指定模型商） | API key：启动环境 `DEEPSEEK_API_KEY` → 工作目录 `.env` → `$DSH_HOME/.env`；ACP 模式还读 Web 界面存的凭据 |
| **额度查询** | 只有交互界面 `/usage`，没有命令行/JSON 接口 → 不显示额度块 | 没有（只有每条的美元成本） | DeepSeek 是按量付费，官方 API 有余额接口，但它是“余额”不是“窗口”，现有 `quota` 结构放不下 → 第一版不显示 |
| **打断** | ACP `session/cancel` | RPC `abort`（先 `clear_queue` 再 `abort`，文档推荐） | ACP `session/cancel` |
| **退出和子进程** | 关标准输入后实测 **4.4 秒**才退；子进程靠我们按进程组杀 + Linux bwrap 的 PID namespace | 关标准输入就有序退出（实测立即）；bash 子进程同上 | 文档写 close 会等子任务、刷盘再退；同上 |
| **Linux** | 官方安装脚本 `curl https://cursor.com/install -fsS \| bash`（装到 `~/.local/bin`）；能用 | `curl -fsSL https://pi.dev/install.sh \| sh` 或 npm；要 Node ≥ 22.19 | `npm i -g @deepseek-ai/dsh`；要 Node ≥ 24.9；沙箱支持 Linux |

### 2.2 每家补充

**Cursor**
- 为什么选 ACP 不选 print 模式：现有三家驱动全是“一个会话一个常驻进程、往标准输入写”（`BaseSessionDriver`），ACP 正好是这个形状；print 模式每轮起一个进程，要么改底座，要么每轮多付一次启动+登录。ACP 还多两样：能现场回权限请求（只读 Worker 的 MCP 判断可以像 claude 一样现场做），`session/cancel` 是正规打断。
- 风险：`acp` 在官方参数表里写的是“advanced, hidden command”，但有专门文档页和更新日志（2026.09 起持续在加功能），可以用。
- 模型和思考程度：ACP 会话的 `configOptions` 里有 `model`（实测 46 项，值形如 `grok-4.7[context=256k,reasoning_effort=high,fast=true]`）和 `mode`（agent/plan/ask）；用 `session/set_config_option` 设。下拉里思考程度怎么拆见第 5 节。
- 默认模型：不传时用用户在 Cursor 里上次选的（本机是 Grok 4.7），所以我们要显式传（`explicitDefaultModel: true`）。
- 本机 `cursor-agent` 有两个名字：`agent` 和 `cursor-agent`。`cli.command` 用 `cursor-agent`：`agent` 这个词在我们代码里到处都是，守卫测试按 `cli.command` 生成正则会误报。

**Pi**
- 它是“外壳”：自己不卖模型，模型来自用户在 Pi 里登录的模型商（Anthropic、OpenAI、DeepSeek、GitHub Copilot、OpenRouter……，`pi --help` 列了 30 多个环境变量）。模型 id 是 `模型商/模型`，比如 `deepseek/deepseek-v4-pro`。
- 驱动最省事：RPC 有 `prompt`（带 `streamingBehavior: "steer"` 就是中途插话）、`abort`、`compact`（压缩）、`get_session_stats`（上下文占用，正好给换代阈值用）、`set_model`、`set_thinking_level`、`get_commands`。文档专门提醒别用 `node:readline` 切行（U+2028），我们的 `base-driver.ts:1057` 已经自己按 `\n` 切。
- 官方还导出了现成的 `RpcClient`，但它要把整个 Pi 包当依赖、版本和用户装的 Pi 绑死，不用；协议本身很简单，按文档写翻译层。

**DeepSeek Harness**
- 四种入口：`web`（浏览器界面）、`headless`（一次一问，`--json`、`--session-id` 续接）、`sdk`（JSON-RPC）、`acp`。我们选 `acp`：标准协议、常驻、能续接、能设模型和思考程度、能打断；和 Cursor 共用一个驱动。
- `headless` 不适合当主路：每轮起进程、没有 `--model` 参数、同一会话 id 正在用就拒绝。
- 开发者预览：仓库首页大写“THERE WILL BE COMPATIBILITY-BREAKING CHANGES”。好在 ACP 是标准协议，内部改动对我们影响小；版本号要钉住，冒烟测过才升。

---

## 3. DeepSeek：几种接法比较

| 接法 | 怎么做 | 好处 | 坏处 |
|---|---|---|---|
| **A. 官方 DeepSeek Harness** | 独立厂商 `deepseek`，命令 `dsh`，走 `dsh --profile acp` | 正是用户说的“deepseek harness”；官方、开源、MIT；DeepSeek 模型的思考回传、联网搜索这些细节官方自己调好了；ACP 能续接、打断、设模型和思考程度 | 开发者预览，会变；要装 Node 24.9+；自带沙箱要关（没实测）；没有 fork、没有“/”命令；冷启动、内存未测 |
| **B. Claude Code + DeepSeek 的 Anthropic 兼容接口** | 设 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL=deepseek-v4-pro` 跑 `claude`（[官方说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)） | Agent 本身最成熟；我们 claude 驱动的功能（后台叫醒、原生只读、复制会话）全有 | 要当独立厂商就得让两个厂商共用一个 claude 驱动：现在“不许跨家 import”，只能把 claude 驱动搬进 `_common/` 当引擎，**动现有 claude**；还要单独的 `CLAUDE_CONFIG_DIR` 免得和用户真的 Claude 登录混；模型名是映射的（`claude-opus*`→`deepseek-v4-pro`，其余→`deepseek-flash`），Claude 的登录状态、额度事件都对不上 |
| **C. 在 Pi 里选 DeepSeek 模型** | Pi 接好后，用户在 Pi 里配 `DEEPSEEK_API_KEY`（或 `/login`），派活时 Pi 下拉选 `deepseek/deepseek-v4-pro` | **零额外代码**；Pi 的驱动能力最全 | 下拉里不叫“DeepSeek”，在 Pi 下面；DeepSeek 的 OpenAI 兼容接口要求回传思考内容（[官方提醒](https://api-docs.deepseek.com/quick_start/agent_integrations/copilot_cli)），Pi 自带的 DeepSeek 接入有没有处理好未确认 |

**推荐：先 C 后 A，不做 B。**
- C 随 Pi 一起上，不花额外工夫，用户马上能用 DeepSeek 模型；
- A 是用户点名要的官方外壳，排在通用 ACP 驱动之后做（和 Cursor 共用，边际成本小）。等用户在本机装好 `dsh`、我们实测过“关自带沙箱”和续接再合；
- B 要改现有 claude 的结构，收益只是“DeepSeek 单独一行”，C 已经覆盖，不值得。

---

## 4. 缺的必需能力和降级（按设计文档第 4 节）

必需的只有两样：基本配置、会话驱动（起、恢复、发、打断、结束、清残留）。**三家都有**，没有缺必需能力的。可选能力缺的按第 4 节兜底：

| 能力 | Cursor | Pi | DeepSeek | 兜底 |
|---|---|---|---|---|
| 实时模型名单 `catalog` | 有（`models` 纯文本，要自己解析） | 有 | 不做探测（会新建会话），用打包名单 + “自定义” | 打包名单 |
| 登录状态 | 有（`status --format json`） | 有（`list-models` 为空 = 没配任何模型商；`auth check` 要指定模型商） | 看不出 → `unknown` | 会话真起来/报认证错时更新（现有） |
| 额度 | 无 | 无 | 无（余额不是窗口） | 不显示额度块，额度用完靠报错特征认 |
| “/” 命令 | 有 | 有 | 无 | 只给压缩命令 |
| 复制会话 `forkers` | 无 | **有** | 无 | 本会话里写交接 |
| 原始记录 `transcriptPath` | 格式未确认 → 先不给 | 有（JSONL，可移植） | 未确认 → 先不给 | 交接里不给路径 |
| 只读 | `os_sandbox` | `os_sandbox` | `os_sandbox` | 外层只读 OS 沙箱；没有 OS 沙箱的机器拒绝派 |
| 后台跑完叫醒 `backgroundWake` | 先写 `false`（更新日志说 ACP 有“后台 shell 输出匹配时叫醒”，实测后再开） | `false` | `false` | 提示词让项目经理把长命令派给 Worker |
| 中途插话 | 无 → 排队 | **有**（`steer`） | 无 → 排队 | 驱动层待发队列 |
| 换代阈值 | 上下文用量未确认 → 用默认 200k，拿不到用量就不触发 | 有 | 有 | `HANDOVER_TOKEN_THRESHOLD` |

**哪家不建议接**：三家都建议接。不建议的是 DeepSeek 的 B 接法（第 3 节）。

---

## 5. 插件接口够不够

逐项对照 `VendorSpec`、`VendorDaemon`（含 P4 加的 `launchFiles`、`paths.ts` 的 `installCommand`、`credentialEnv` 等），**大部分直接能填**。要动的只有下面几处，都是新增或放宽，现有三家不用改一行：

| 改什么 | 为什么 | 现有三家为什么不受影响 |
|---|---|---|
| **新增通用 ACP 驱动** `src/vendors/_common/acp/`（设计文档的 P6）：继承 `BaseSessionDriver`，翻译 ACP ↔ 我们的事件；用官方 TypeScript SDK `@agentclientprotocol/sdk`（npm 现版本 2.5.0）收发消息，不自己手写协议层。每家只传一个小配置：启动参数、怎么回权限请求、厂商扩展消息（Cursor 的 `cursor/ask_question` 要回“拒绝”，不然卡住）、模型和思考程度怎么设 | Cursor 和 DeepSeek 都是 ACP，各写一份重复 | 新目录，现有三家不引它。名字里没有厂商名，守卫测试照查 |
| **`models.flags` 改成可选** | ACP 的两家模型和思考程度用协议设（`session/set_config_option`），没有命令行参数可填。`agentLaunchArgs` 没有 `flags` 时返回 `[]`，由驱动自己读 `session.model`/`session.effort`（现在各家驱动本来就是自己读这两个字段再调 `agentLaunchArgs`） | 三家都写了 `flags`，行为不变；P1 快照原样过 |
| **Cursor 的思考程度** 不加新字段：用“每个模型名就是完整选择”的写法，`efforts` 只写一项（契约 S4 要求非空），网页 `efforts.length <= 1` 时本来就不显示思考程度（`web/worker-pick.ts:81`、`AgentRows.tsx:195`）；驱动发现只有一档时不传思考参数 | Cursor 模型名的后缀不规整（`-high-fast`、`-thinking-high`），套 agy 的 `effortInModelId` 拆不干净 | 不改公共代码 |
| **Pi**：不用改接口 | RPC 常驻，和 codex app-server 一个形状 | — |

**要注意的两点**（不改接口，但实现时要做对）：
- **厂商编号会进守卫正则**：`pi` 很短，`vendor-guard.test.ts` 按名单生成 `\bpi\b` 一类的正则，P4 把扫描范围扩到全仓后可能误报（比如注释里的英文）。Pi 那个 PR 先跑一遍守卫测试，误报了就在守卫里加排除规则，不换编号。
- **凭据变量**：Pi 认的 `*_API_KEY` 很多、DeepSeek 认 `DEEPSEEK_API_KEY`，按 P4 的 `paths.ts` `credentialEnv` 声明，准备命令统一去掉；agent 进程本身照常拿到（Pi 主要读自己的 `auth.json`，DeepSeek 推荐把 key 放 `~/.dsh/.env`，都不靠守护进程转交）。

---

## 6. 性能

### 6.1 实测（本机 arm64 Mac；`--version` 跑 3 次，其余 1～2 次）

| 项 | Cursor | Pi | DeepSeek |
|---|---|---|---|
| `--version` | 0.71 秒 | 0.33 秒 | 未装，未测 |
| 常驻进程就绪 | ACP `initialize` 回应 0.75 秒 | RPC 第一条回应 0.37 秒 | 未测 |
| 第一轮前的额外等待 | `authenticate` **5.8～7.7 秒** + `session/new` **约 5 秒** | 无 | 未测 |
| 模型名单 | `models` 4.0 秒，`status` 3.9 秒（并行约 4 秒） | `--offline --list-models` 0.38 秒 | 不探测 |
| 关标准输入到退出 | **4.4 秒** | 立即 | 未测 |

### 6.2 要怎么做

- **Cursor 冷启动**：每个进程只付一次（之后多轮复用，现有空闲关闭 `IDLE_CLOSE_MS` 照旧）。实现时先试“不调 `authenticate` 直接 `session/new`”（文档说预先 `agent login` 就算登录了），能省 6 秒就省；不行就接受，并把 `START_TIMEOUT_MS` 对这家够用（不够就在 Cursor 文件夹的 `limits.ts` 里另设，照设计文档拍板点 3）。
- **Cursor 退出慢**：`end`/空闲关闭要等它 4.4 秒；现有“关标准输入 → 宽限期 → SIGINT → SIGKILL 进程组”能兜住，宽限期别短于 5 秒（实测后定）。
- **模型名单缓存**：完全沿用 `src/daemon/driver/model-catalog.ts`：有人要才问、6 小时新鲜、失败只记 5 分钟、每家一格、最多 50 个模型、15 秒超时。新厂商只填 `catalogWatchPaths`：
  - Cursor：`.cursor/cli-config.json`（登录凭据存哪未确认，可能在系统钥匙串，先不监视，登录状态靠会话真起来/报认证错时更新）；
  - Pi：`.pi/agent/auth.json`、`.pi/agent/models.json`、`.pi/agent/settings.json`、`.pi/agent/models-store.json`，`configHome: { rel: ".pi/agent", env: "PI_CODING_AGENT_DIR" }`；
  - DeepSeek：不探测，不监视。
  - Cursor 的 `models` 列表约 46 项；Pi 登录的模型商多了可能超过 50，会被 `MAX_CATALOG_MODELS = 50` 截断，Pi 的 `catalog.ts` 里先按模型商分组、每家挑新的再截，不动公共上限。
- **10 家时**：加完是 6 家。P5 计划的“并发上限 3 + 落盘缓存”已经够；Cursor 是最慢的一家（4 秒），不会拖过 15 秒超时。
- **每轮额外开销**：三家都是常驻进程 + 一行一条 JSON，和现有三家同量级；没有新增轮询。
- 实现 PR 照 `CLAUDE.md` 用 `benchmark-checklist` 量“首次 `GET /api/models` 耗时”和“第一轮从派活到第一条事件的时间”，写进 PR。

---

## 7. 测试

**P1 的快照和共用检查**：契约测试（`src/vendors/contract.test.ts`，S1～S10）对 `VENDOR_LIST` 逐家 `describe.each`，新厂商进名单就自动多一组，不用写新的。迁移快照（`migration-snapshot.test.ts`）会因为名单多了而变：每个 PR 里更新快照，PR 描述里写清“只多了这一家，原有三家的条目没变”（审的人对一下 diff 就行）。

**驱动行为**（设计文档 5.3 的场景：`simple`、`multi_turn`、`queued_turn`、`turn_interrupt`、`resume`、`not_found`、`write_scope`）：
- 通用 ACP 驱动带一个**假 ACP 程序**（`_common/acp/fixtures/`，用 `@agentclientprotocol/sdk` 的 agent 端写，几十行），Cursor、DeepSeek 各自只补厂商差异的用例（Cursor 的阻塞扩展消息、`session/load` 重放要吞掉；DeepSeek 的 `--patch` 文件内容）。
- Pi 带一个**假 Pi 程序**（按 RPC 文档回 `response` 和事件），外加 `steer` 中途插话、`clone` 复制会话、`get_session_stats` 换代阈值的用例。
- 三家的 `spec.ts` 里的“只读用哪种”“关沙箱参数”由现有 `write-scope.test.ts` 按能力位覆盖（`WRITE_SCOPE_ENFORCERS` 从能力位推），不按厂商写用例。

**真机冒烟**（花额度，要用户同意后跑）：
- `test/smoke/multi-vendor.ts`：三家各加一段“建项目经理 → 让它跑 `hub status` 简短回复 → 断言有工具调用、`vendor_session_id` 写进库 → 重启守护进程后再发一条，确认续接”。Pi 用一个便宜模型（如 `deepseek/deepseek-flash`），顺带验证第 3 节的 C 接法。
- `test/smoke/write-scope.ts`：三家各加“Worker 在 OS 沙箱里跑 shell 命令**不报 exit 71**（验证关自带沙箱生效）、写不进 `state/`、能写自己的 worktree、能 `git commit`”；只读 Worker 加“命令能跑、写哪儿都写不进”。
- Linux（东京服务器）各跑一遍上面两项（重点是 bwrap 里 Cursor、DeepSeek 关沙箱后能跑命令）。

---

## 8. 实现分步

| PR | 内容 | 依赖 | 能否并行 |
|---|---|---|---|
| **PR-Pi** | `src/vendors/pi/`（spec、daemon、driver、protocol、catalog、composer、handover、transcript、paths、fixtures）+ 名单加一行 + 冒烟两处 | **P4 合并**（要用 P4 的 `launchFiles`、`credentialEnv`、`installCommand`、守卫扩范围） | 和 PR-ACP 并行 |
| **PR-ACP** | `src/vendors/_common/acp/` 通用驱动 + 假 ACP 程序 + `models.flags` 改可选；装 `@agentclientprotocol/sdk`，同 PR 更新 `AGENTS.md` 的组件一节 | P4 合并 | 和 PR-Pi 并行 |
| **PR-Cursor** | `src/vendors/cursor/`（spec、daemon、catalog、composer、paths、ACP 配置）+ 名单一行 + 冒烟 | PR-ACP | 和 PR-DeepSeek 并行 |
| **PR-DeepSeek** | `src/vendors/deepseek/`（spec、daemon、launchFiles 生成 `--patch` 文件、ACP 配置）+ 名单一行 + 冒烟 | PR-ACP；用户本机装好 `dsh` | 和 PR-Cursor 并行 |

想要“三家各一个 PR 完全并行”也行：把通用 ACP 驱动放进 PR-Cursor，PR-DeepSeek 等它合并再开——总时间更长，不推荐。

每个 PR 第一件事是把第 9 节里属于它的“未确认”实测掉，写进 `docs/vendors/<名>.md`（设计文档第 8 节的“可选”一项，这次建议必做），再写代码。

**要用户本人做的事**：
1. **Pi**：在终端开 `pi`，`/login` 选一个模型商（或配环境变量）。想用 DeepSeek 模型（第 3 节 C）就配 `DEEPSEEK_API_KEY`。
2. **DeepSeek**：在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 开 API key、充值（按量付费）；`npm i -g @deepseek-ai/dsh`（要 Node ≥ 24.9，本机 mise 的 node 24.21 满足）；把 key 写进 `~/.dsh/.env`。
3. **Cursor**：本机已登录，不用做；东京服务器上要 `cursor-agent login`（没浏览器时设 `NO_OPEN_BROWSER` 拿链接）或给 `CURSOR_API_KEY`。
4. **东京服务器**：三家各装一次（P4 后 `scripts/provision-linux.sh` 读各家 `installCommand` 自动装，登录仍要人做）。
5. **同意花额度跑真机冒烟**（每家几轮短对话）。

---

## 9. 没确认的事实（实现时先测）

| # | 事 | 怎么测 |
|---|---|---|
| 1 | Cursor：`cursor-agent --sandbox disabled acp`（根参数放子命令前）能不能关掉自带沙箱；`--trust`、`--approve-mcps`、`--model` 在 `acp` 下生不生效 | write-scope 冒烟：沙箱里跑命令不报 exit 71 |
| 2 | Cursor：不调 `authenticate` 能不能直接 `session/new` | 本机试 |
| 3 | Cursor：ACP 下有没有思考、token 用量、上下文占用 | 发一轮看 `session/update` |
| 4 | Cursor：`plan` 模式能不能跑只读命令；`session/load` 重放历史的形状 | 本机试 |
| 5 | Cursor：登录凭据存在哪（文件还是钥匙串）；会话记录格式 | 看官方文档有无更新，否则只靠事件更新登录状态 |
| 6 | Pi：`--skill <目录>` 在没信任项目时读不读得到 `.agents/skills` | 本机试 |
| 7 | Pi：自带 DeepSeek 接入是否正确回传思考内容（多轮 + 工具调用不报 400） | 冒烟里用 `deepseek/deepseek-flash` |
| 8 | Pi：订阅登录（如 ChatGPT、Claude 订阅）的模型商有没有额度事件 | 文档没写，暂按“没有” |
| 9 | DeepSeek：`--patch` 设 `danger-full-access` 在 ACP 下是否生效、在我们的沙箱里命令能跑 | write-scope 冒烟 |
| 10 | DeepSeek：会话记录路径、项目级 `.agents/skills` 读不读、冷启动耗时和内存 | 装好后本机试 |
| 11 | DeepSeek：能不能用 `--patch` 改系统提示词（不行就拼进第一条消息） | 看它的配置目录（`docs/config-catalog.md`） |

---

## 10. 要拍板的点（每点带推荐）

1. **DeepSeek 怎么接**：A 官方 DeepSeek Harness / B Claude Code + DeepSeek 接口 / C Pi 里选 DeepSeek 模型。**推荐先 C（随 Pi 免费得到）后 A，不做 B**（第 3 节）。
2. **Cursor 走 ACP 还是 print 模式**：**推荐 ACP**：常驻进程和现有驱动底座一致，能正规打断、能现场回权限；print 模式每轮多付一次启动和登录（约 6～12 秒），还拿不到思考。
3. **通用 ACP 驱动单独一个 PR 先做**：**推荐**，Cursor 和 DeepSeek 都等它，之后两家并行；它就是设计文档早就排了的 P6。
4. **厂商编号**：`cursor`、`pi`、`deepseek`（命令 `cursor-agent`、`pi`、`dsh`），下拉顺序排在现有三家后面。**推荐照此**；`pi` 如果守卫正则误报，加排除规则而不是改编号。
5. **DeepSeek 开发者预览要不要等正式版**：**推荐不等**，钉住版本号、冒烟过了再升；ACP 是标准协议，内部变化影响有限。
