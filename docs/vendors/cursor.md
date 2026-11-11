# Cursor（`cursor-agent`）接入实测与协议笔记

本文记录在 macOS arm64 本机对 `/Users/yuxin.zhangnewsbreak.com/.local/bin/cursor-agent` 进行零额度命令与 ACP 握手实测的结果（不逆向二进制、不发送消耗模型额度的 `session/prompt`），对应 `docs/new-vendors-cursor-pi-deepseek.md` 第 9 节第 1～5 项待核实点。

## 1. 版本、安装与命令入口

- **实测版本**：`2026.10.22-27dcf5f`（`cursor-agent --version`，冷跑约 0.7s）。
- **可执行文件名**：官方安装脚本在 `~/.local/bin/` 下同时提供 `cursor-agent` 与 `agent`，Fusa 统一使用 `cursor-agent`（避免 `agent` 命中全仓守卫正则误报）；macOS `/Applications/Cursor.app/Contents/Resources/app/bin` 下仅有 `cursor`、`code`、`cursor-tunnel`，不含 `cursor-agent`。
- **官方安装命令**：`curl https://cursor.com/install -fsS | bash`（macOS / Linux 通用，无需 root）。
- **登录命令**：桌面端 `cursor-agent login`，无浏览器环境 `NO_OPEN_BROWSER=1 cursor-agent login`，或通过环境变量 `CURSOR_API_KEY` 鉴权。

## 2. CLI 参数顺序与关闭自带沙箱（第 9 节 #1）

实测以下三种参数位置组合在 `cursor-agent` 中均合法（退出码 `0`）：

1. 全部置于 `acp` 子命令之前：`cursor-agent --sandbox disabled --trust --approve-mcps acp`
2. 全部置于 `acp` 子命令之后：`cursor-agent acp --sandbox disabled --trust --approve-mcps`
3. 根参数在前、子命令参数在后：`cursor-agent --sandbox disabled acp --trust --approve-mcps`

`src/daemon/driver/write-scope.ts` 与 `AcpSessionDriver` 会把 `spec.capabilities.ownSandboxOffArgs` 拼在 `launchArgs` 前面：
- `ownSandboxOffArgs`: `["--sandbox", "disabled"]`
- `launchArgs`: `["--trust", "--approve-mcps", "acp"]`（不带 `--model`，见 4.3）

拼接结果为 `cursor-agent --sandbox disabled --trust --approve-mcps acp`，语法合法，且关闭了 `cursor-agent` 自带沙箱，避免在外层 macOS Seatbelt 或 Linux `bwrap` 沙箱内再次调用 `sandbox_apply` 触发 `Operation not permitted`（exit 71）。

## 3. ACP 握手与免 `authenticate` 直连（第 9 节 #2）

在临时空目录与项目 worktree 下启动 `cursor-agent --sandbox disabled --trust --approve-mcps acp` 实测：

1. **`initialize`**（耗时约 `788ms`）：
   - `protocolVersion`: `1`
   - `agentCapabilities`:
     ```json
     {
       "loadSession": true,
       "mcpCapabilities": { "http": true, "sse": true },
       "promptCapabilities": { "audio": false, "embeddedContext": false, "image": true },
       "sessionCapabilities": { "list": {} }
     }
     ```
     注：未声明 `sessionCapabilities.resume` 与 `sessionCapabilities.close`，声明了顶层 `loadSession: true`。
   - `authMethods`: `[{ "id": "cursor_login", "name": "Cursor Login", "description": "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in." }]`。
2. **不调 `authenticate` 直接 `session/new`**：
   - 本机已登录状态下，跳过 `authenticate` 直接发送 `session/new` **一次成功**（耗时约 `7.28s`），省去 `5.8～7.7s` 的 `authenticate` 往返；
   - 因此驱动配置 `authenticate: { enabled: false }`，并将冷启动超时预算放宽至 `CURSOR_START_TIMEOUT_MS = 45_000`。
3. **退出耗时**：
   - 关闭 `stdin`（EOF）后，空会话约 `0.79s` 退出（`code: 0`），活跃会话实测最长约 `4.4s` 退出；
   - 驱动设置 `CURSOR_SHUTDOWN_GRACE_MS = 8_000`、`CURSOR_INTERRUPT_GRACE_MS = 5_000`，确保正常刷盘退出且超时后按进程组补信号清理。

## 4. 会话模式、模型 ID 编码差异与默认模型

### 4.1 会话模式（`modes`）
`session/new` 返回：
- `currentModeId`: `"agent"`
- `availableModes`:
  - `"agent"`：完整工具与命令权限（Fusa 会话默认模式；只读 Worker 由外层 OS 只读沙箱 + `decideAcpPermission` 拦截写操作与非只读 MCP 工具）；
  - `"plan"`：只读规划模式（会触发 `cursor/ask_question` 与 `cursor/create_plan` 交互审批）；
  - `"ask"`：纯问答模式（无文件编辑与命令执行）。

### 4.2 `cursor-agent models` 与 ACP `configOptions` 的关键差异
1. **`cursor-agent models` 输出**（耗时约 `4.0s`）：
   - 纯文本列表，首行 `Available models`，末行 `Tip: use --model <id> ...`，中间共约 **275 项** `<id> - <label>`；
   - 第一项为 `auto - Auto (default)`；其余将思考程度与 Fast 变体展开为独立 CLI 模型 ID（如 `composer-2.5`、`claude-opus-5-5-high`、`gpt-5.6-sol-high`、`gpt-5.3-codex-high`、`gemini-4-carbon-high`、`grok-4.7-high-fast`）；
   - **输出清洗注意**：部分标签含连续双空格及末尾零宽字符 `\u200b`（如 `grok-4.7-high-fast - Grok 4.7  High Fast\u200b\u200b`），`catalog.ts` 解析时剥离 ANSI 控制序列与零宽字符 `[\u200B-\u200D\uFEFF]`、折叠多余空白。
2. **ACP `configOptions` 模型项**：
   - `session/new` 返回 `id: "model"`（`category: "model"`, `type: "select"`），`options` 共 **47 项**，每个模型家族只有**一个**预设值（`name` 是家族名），例如：
     - `default[]`（`name: "Auto"`）
     - `composer-2.5[fast=true]`（`name: "composer-2.5"`）
     - `claude-opus-5-5[context=300k,effort=medium,fast=false]`（`name: "claude-opus-5-5"`）
     - `claude-sonnet-5-5[context=300k,reasoning_effort=high]`（`name: "claude-sonnet-5-5"`）
     - `gpt-5.6-sol[context=272k,reasoning=medium,fast=false]`（`name: "gpt-5.6-sol"`）
     - `gemini-4-carbon[reasoning_effort=medium]`（`name: "gemini-4-carbon"`）
     - `grok-4.7[context=256k,reasoning_effort=high,fast=true]`（`name: "grok-4.7"`）
   - 同一结果里还有非标准的 `models: { currentModelId, availableModels }`，内容与上面 47 项相同。
   - **严格校验行为**：`session/set_config_option` 与 `session/set_model` 都只接受 `options[].value` 中**精确存在**的字符串；裸 CLI 模型名（`claude-opus-5-5-high`）和不在候选集里的参数组合（实测 `claude-opus-5-5[context=300k,effort=high,fast=false]`、`composer-2.5[fast=false]`）都报：
     ```json
     { "code": -32602, "message": "Invalid params", "data": { "message": "Invalid model value: ..." } }
     ```

### 4.3 `--model` 在 ACP 下不生效，模型只能经 `set_config_option` 选（2026-11-11 复测，`2026.10.22-27dcf5f`）

在空目录分别以 `--model claude-opus-5-5-high`、`--model composer-2.5`、`--model gpt-5.6-sol-high`、`--model auto`、不带 `--model` 启动 `cursor-agent acp` 后发 `session/new`：

- **`currentValue` 与 `--model` 无关**：五次都等于 `~/.cursor/acp-config.json` 的 `selectedModelVariantId`（当时为 `default[]`）。先 `set_config_option` 成 `claude-opus-5-5[...]` 后，它写进 `acp-config.json`，下一次 `--model gpt-5.6-sol-high` 的 `session/new` 回的也是 `claude-opus-5-5[...]`。即 ACP 新会话的初始模型是**全局**的“上一次任何会话 set 过的值”。
- **`--model` 有副作用**：每次都改写用户自己的 `~/.cursor/cli-config.json`（`model`、`selectedModel`、`modelSelectionHistory`，`--model composer-2.5` 还把 `modelParameters.composer-2.5` 从 `fast=false` 改成 `fast=true`），污染用户在终端里用 `cursor-agent` 的默认模型。
- **`session/load`**：没有对话轮次的空会话 `session/load` 一律回 `-32602 Session "…" not found`（不论带不带 `--model`）；有轮次的会话要发 `session/prompt` 才能造出来，零额度下没测，驱动续接后照样显式设模型，不依赖 load 回来的 `currentValue`。
- **思考档位不可选**：每个家族在 ACP 里只有一个预设值，`claude-opus-5-5-high` 这种档位/Fast 变体通过 ACP 选不到。

据此 Fusa 的做法：

- 启动参数不带 `--model`。
- 模型名单（`catalog.ts`）把 `cursor-agent models` 的约 275 个 ID 按家族归并成一项一个（本机 42 个，`cursorModelFamily`：去 `cursor-` 前缀和档位/Fast 后缀，旧式 `claude-4.6-sonnet` 改成 ACP 的 `claude-sonnet-4-6`），ID 就是 ACP 的 `name`；名单默认模型固定 `auto`，`spec.ts` 不开 `explicitDefaultModel`。
- 每次新建或续接后都按 `row.model`（没选就是 `auto`）显式 `set_config_option`：精确 `value` → 忽略大小写 → `auto`/`default` 映射 `default[]` → 家族名匹配 `name`；`currentValue` 已经是目标值才跳过。旧行里存的档位 ID 落到家族预设值。
- 认不出的模型名原样交给 `set_config_option`，让 Cursor 报 `Invalid model value`，不静默跑在别的会话留下的全局模型上。

## 5. `session/load` 续接、错误结构与命令补全（第 9 节 #3、#4）

- **`session/load` 与缺失会话报错形状**：
  - `continuation` 设为 `{ mode: "load", swallowReplayOnLoad: true, fallbackToNewOnFailure: true }`，加载已有会话期间吞掉重放的历史轮次消息，仅消费命令/配置/模式/用量同步；
  - 当会话不存在（或刚 `session/new` 尚未落盘对话轮次）时，`cursor-agent acp` 返回：
    ```json
    {
      "code": -32602,
      "message": "Invalid params",
      "data": { "message": "Session \"00000000-0000-0000-0000-000000000000\" not found" }
    }
    ```
    注意错误码为 `-32602` 且 `"not found"` 位于 `error.data.message` 内，因此 `driver.ts` 定制 `isSessionNotFoundError` 与 `classifyTurnError` 递归提取 `error.data.message`，保证缺失会话平滑回退到 `session/new`。
- **`/` 命令补全**：
  - 运行中会话通过 ACP `available_commands_update` 实时推送可用命令，驱动确保内置 `/compact` 始终兜底存在；
  - 会话未运行时，`composer.ts` 直接扫描工作目录与用户目录的 `.cursor/commands/*.md`、`.cursor/skills/*/SKILL.md`、`.agents/skills/*/SKILL.md` 并合并 `/compact`，毫秒级返回且不拉起耗时 ~8s 的重型 ACP 进程。
- **思考、Token 与上下文占用**：
  - 由通用 ACP 底座按标准 `agent_thought_chunk`、`usage_update` 与 `PromptResponse.usage` 处理（零额度实测不发 `session/prompt`，由假 ACP 单测覆盖）。
  - 2026-11-11 发 `session/prompt` 实测：ACP 层不发 `usage_update`、`compaction_update`，`PromptResponse` 只有 `stopReason`；经 ACP 发 `/compact` 不是真压缩（模型自己回一段总结，第 0 条消息还在）。
- **产品提示词**（docs/system-prompt-channels.md 第 4 节）：没有常驻入口（只读会话工作目录里的规则，`--add-dir`、`--plugin-dir` 在 ACP 下不读），
  spec 声明 `capabilities.systemPrompt: "first_message"`：拼进新会话第一条消息，initialize 声明 `session.compaction`，收到 `compaction_update` 后重拼。
  cursor 现在不发压缩信号，自动压缩后产品提示词仍会丢（已知限制）；保留信号重拼兜底，不修改用户全局 `~/.cursor/hooks.json`。

## 6. 私有扩展方法、登录状态与只读沙箱目录（第 9 节 #5）

- **Cursor 私有扩展方法**：
  - **阻塞式客户端请求（必须立即带双层 `outcome` 结构响应，否则子进程挂死）**：
    - `cursor/ask_question`：返回 `{ outcome: { outcome: "cancelled" } }`；
    - `cursor/create_plan`：返回 `{ outcome: { outcome: "rejected", reason: "..." } }`（中止信号触发时返回 `{ outcome: { outcome: "cancelled" } }`）；
    - 其他未知 `cursor/*` 阻塞请求：统一返回 `{ outcome: { outcome: "cancelled" } }`。
  - **单向扩展通知**：`cursor/update_todos`、`cursor/task`、`cursor/generate_image` 等在 `onNotification` 中安全消费并忽略，不留驻内存状态。
- **登录状态与凭据存储**：
  - `cursor-agent status --format json`（耗时约 `3.9s`）返回 JSON：
    ```json
    { "status": "authenticated", "isAuthenticated": true, "hasAccessToken": true, "hasRefreshToken": true }
    ```
    据此判定 `"available"` / `"signed_out"`；
  - OAuth 令牌存放在系统钥匙串，环境变量凭据仅剥离 Cursor 专属变量 `CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`CURSOR_ACCESS_TOKEN`（绝不剥离 `GH_TOKEN` 等通用变量）；
  - `~/.cursor/` 下包含 `cli-config.json`、`agent-cli-state.json`（列入 `catalogWatchPaths`）、`mcp.json`（`0600`）、`acp-sessions/<sessionId>/meta.json`、`chats/`、`projects/`、`ai-tracking/`、`statsig-cache.json`；会话记录不透明，设 `transcriptPortable: false`。
- **只读 Worker 沙箱**：
  - `capabilities.readonly: "os_sandbox"`；
  - `readonlySandbox` 仅放行 `~/.cursor` 下运行时必需可写的会话/缓存子目录（`acp-sessions`、`chats`、`projects`、`ai-tracking`、`logs`）及 `~/.cursor/statsig-cache.json`，工作目录、`cli-config.json`、`mcp.json`、`hooks.json`、`auth.json` 保持严格只读；
  - 实测（隔离 `HOME`、`~/.cursor` 设成只读）：`cursor-agent acp` 一启动就要建 `~/.cursor/projects/<工作目录>`，`projects/` 不存在时进程在回 `initialize` 前就退出；`projects/` 先建好就能正常启动（`statsig-cache.json` 写不了不影响）。所以底座在起进程前把这些目录建好再放行（新登录的机器第一次就开只读 Worker 也不会挂）；
  - 重启清残留进程只认 Fusa 自己起的命令行（`isFusaCursorAcpCommand`：有 `cursor-agent`、带 `--trust` 和 `--approve-mcps`、最后一个参数是 `acp`），用户自己在终端或 IDE 跑的 `cursor-agent acp` 复用旧 PID 时不误杀。
