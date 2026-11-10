# Pi（`@earendil-works/pi-coding-agent`）本机实测与接入说明

> 实测环境：macOS arm64，Node.js v24.21.0，`pi 1.5.0`（`/Users/yuxin.zhangnewsbreak.com/.local/share/mise/installs/node/24/bin/pi`）。
> 全部探测均使用 `--help`、`--version`、`--offline --list-models` 与 `--mode rpc --offline` 在本地离线完成，零大模型请求、零额度消耗，未逆向任何程序。

---

## 1. 安装、目录与凭据

- **官方安装命令**：`curl -fsSL https://pi.dev/install.sh | sh`（默认装入 `~/.local/bin/pi`；npm 安装方式为 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`，要求 Node.js ≥ 22.19）。
- **配置与状态目录**：默认 `~/.pi/agent`，可通过环境变量 `PI_CODING_AGENT_DIR` 覆盖；会话目录默认 `<配置目录>/sessions`，可通过 `PI_CODING_AGENT_SESSION_DIR` 覆盖。
- **核心文件**：
  - `auth.json`：`/login` 写入的 OAuth 令牌与 API key（敏感凭据，跨厂商只读禁读）。
  - `models.json`：用户自定义的模型商与模型配置（可含内联 `apiKey`，跨厂商只读禁读）。
  - `settings.json`：默认模型、思考档位等全局设置。
  - `models-store.json`：动态模型商拉取的模型列表本地缓存。
- **父会话与凭据环境变量**：
  - Pi 运行命令工具时会注入 `AI_AGENT=pi` 等标识；清理父会话环境时剥离 `AI_AGENT`、`PI_CODING_AGENT`、`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。
  - 支持 `DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY` 等 30+ 模型商环境变量（`paths.ts` 通过前缀与 `/_API_KEY$/` 统一声明，由准备脚本剥离）。

---

## 2. 模型目录与登录状态探测（`pi --offline --list-models`）

1. **未登录 / 无凭据**：
   - 退出码 `0`，标准输出为：
     ```text
     No models available. Use /login to log into a provider via OAuth or API key, or set an API key environment variable. See /Users/.../README.md for setup instructions.
     ```
   - 判定：`parse` 返回 `null`（回退打包兜底模型），`availabilityOf` 返回 `"signed_out"`。
2. **已配置凭据（隔离目录写入假 key 离线实测）**：
   - 退出码 `0`，输出按空白列对齐的纯文本表格：
     ```text
     provider  model            context  max-out  thinking  images
     deepseek  deepseek-flash   1M       384K     yes       yes
     deepseek  deepseek-v4-pro  1M       384K     yes       no
     ```
   - 传给 `pi --model` 的完整模型标识为 `<provider>/<model>`（如 `deepseek/deepseek-v4-pro`、`deepseek/deepseek-flash`）。
   - `thinking` 列为 `yes` 时支持思考档位（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，Pi 会自动按该模型的 `thinkingLevelMap` 钳位到最接近的支持档位）；为 `no` 时仅支持 `["off"]`。
3. **超过 `MAX_CATALOG_MODELS`（50）时的分组保新截断**：
   - 实测同时配置 5 家模型商环境变量时，`pi --offline --list-models` 返回 **90 个模型**，且按 `provider` 字典序、组内 `model` 字典序升序输出（同系列较新版本如 `claude-opus-5-5`、`gpt-5.4`、`grok-4.7` 排在组内靠后位置）。
   - `catalog.ts` 先按 `provider` 分组，组内按模型家族版本号降序 / 原序倒置将较新模型排在前面，再按各模型商轮询抽取至 `MAX_CATALOG_MODELS`（50），既不撑破公共上限，又保证已配置的每一家模型商都有最新模型入选。

---

## 3. 未信任项目加载 `.agents/skills` 与 DeepSeek 思考回传实测

### 3.1 `--skill <目录>` 在未信任项目中的行为（设计文档第 9 节 #6）
在未执行 `/trust` 且不传 `--approve` 的临时目录同时放置 `.agents/skills/demo-skill/SKILL.md`、`.agents/skills/hidden-skill/SKILL.md`（设 `disable-model-invocation: true`，与仓库 pstack 技能一致）及 `.pi/extensions/untrusted.ts`，运行 `pi --mode rpc --offline` 发送 `get_commands`：
- **不传 `--skill`**：`get_commands` 返回 `{"commands":[]}`，项目级 `.agents/skills` 与 `.pi/extensions` 均因项目未信任被跳过。
- **显式传 `--skill <cwd>/.agents/skills`（仍不传 `--approve`）**：
  - `get_commands` 完整返回 `skill:demo-skill` 与 `skill:hidden-skill`（含 `disable-model-invocation: true` 的手打技能）；
  - 未信任的 `.pi/extensions/untrusted.ts` 与 `.pi/mcp.json` **依旧不加载、不执行**。
- 当 `--skill` 指向不存在的目录时，实测 Pi 退出码仍为 `0` 且正常回应；实现上仅对已存在的 `<cwd>/.agents/skills`（及 `addDirs` 下的 `.agents/skills`）追加 `--skill`。

### 3.2 DeepSeek 内置模型思考回传配置（设计文档第 9 节 #7）
通过 `pi --mode rpc --offline` 调用 `get_available_models` 检查内置模型定义：
- `deepseek/deepseek-v4-pro`（DeepSeek V4 Pro，1M 上下文）与 `deepseek/deepseek-flash`（DeepSeek V4.1 Flash，1M 上下文）均内置：
  ```json
  {
    "compat": {
      "requiresReasoningContentOnAssistantMessages": true,
      "thinkingFormat": "deepseek"
    }
  }
  ```
  表明 Pi 原生已在多轮与工具调用消息历史中开启 DeepSeek 所需的 `reasoning_content` 回传。真机多轮工具调用待用户配置 `DEEPSEEK_API_KEY` 后由冒烟测试进一步验证。

---

## 4. RPC 常驻协议（`pi --mode rpc`）

- **行切分**：Pi 官方文档明确要求严格按 `\n` 切分 JSONL（去除末尾可选 `\r`），禁止使用 `node:readline`（会将字符串内的 U+2028 / U+2029 当作换行截断 JSON）。`BaseSessionDriver` 底层已按 `\n` 切分，独立辅助进程（`composer.ts`、`handover.ts`）同样只按 `\n` 切分。
- **启动参数**：
  - 常驻：`--mode rpc --session-id <vendorSessionId> --append-system-prompt <promptFile>`，配合 `agentLaunchArgs` 生成的 `--model <provider/model>` 与 `--thinking <level>`，以及已存在的 `--skill <dir>/.agents/skills`。
  - `--session-id <id>` 在该项目已有同 ID 会话时直接续接，不存在时以该 ID 创建新会话（实测 stderr 仅打印一行提示，不影响 stdout JSONL）。
  - 只读 Worker 额外追加 `--exclude-tools edit,write --no-mcp`。
- **握手与命令映射**：
  - 启动后立即发 `{"id": "...", "type": "get_state"}`；收到成功 `response` 后读取 `sessionId`、`sessionFile`、`model`，发出 `session.started`。
  - 普通发送：`{"id": "...", "type": "prompt", "message": "..."}`。若 `disposition === "handled"`（扩展命令同步消费、不触发模型轮次），当即结束本轮。
  - 中途插话（`steer`）：会话忙时发送 `{"id": "...", "type": "prompt", "message": "...", "streamingBehavior": "steer"}`；收到 `message_start`（`role: "user"`）时标记该批次进入 `processing`，轮末未消费的插话按统一规则退回或取消。
  - 手打 `/compact`：Pi 的 `/compact` 属于 TUI 内置命令，不走 `prompt`；驱动将其翻译为 RPC `{"id": "...", "type": "compact", "customInstructions"?: "..."}`，配合 `compaction_end` 发出 `context.compacted` 并在 `compact` 回执到达时收尾本轮。
  - 打断（`interrupt`）：先发 `{"id": "...", "type": "clear_queue"}` 清空排队中的 steering / follow-up，再发 `{"id": "...", "type": "abort"}`，超时后升级为 `SIGINT` → `SIGKILL` 进程组。
  - 命令列表：运行中会话直接走 `get_commands`；空闲会话由 `composer.ts` 短暂起 `pi --mode rpc --no-session --offline --no-mcp` 查询 `get_commands`，并补入内置 `compact` 命令。
  - 上下文用量与换代阈值：流式阶段从 `message_update` / `message_end` 提取单次请求 `usage`；`agent_settled` 到达后调一次 `get_session_stats`，用 `contextUsage.tokens`（回退最后一条 assistant 消息上下文）写入 `usage.context`，对接 `HANDOVER_TOKEN_THRESHOLD`。
  - 阻塞式扩展 UI 防挂起：收到 `extension_ui_request` 且 `method` 为 `select` / `confirm` / `input` / `editor` 时，立即回写 `{"type": "extension_ui_response", "id": "...", "cancelled": true}`。

---

## 5. 会话记录路径、复制会话与沙箱

- **会话 JSONL 路径（`transcript.ts`）**：
  - 位于 `<sessionsDir>/--<encoded-cwd>--/<ISO-timestamp>_<sessionId>.jsonl`，其中 `<encoded-cwd>` 为去掉前导 `/` 或 `\` 后将 `/`、`\`、`:` 替换为 `-`。
  - 实测在 macOS 上（如 `/var/folders/...` 软链到 `/private/var/folders/...`），Pi 子进程按 `realpath` 后的 `process.cwd()` 编码目录名；因此 `piTranscriptPath` 同时检查 `realpathSync(cwd)` 与原始 `cwd` 编码目录，并在未命中时扫描 `<sessionsDir>` 一层子目录兜底。
- **复制会话写交接（`handover.ts`）**：
  - `forker.id = "pi-native"`（`kind: "native"`）。`fork()` 仅生成新 `UUID`；`write()` 在剥离 `HUB_*` 环境变量后启动 `pi --mode rpc --fork <原会话文件或ID> --session-id <forkId> --append-system-prompt <promptFile> --exclude-tools edit,write,bash,powershell --no-mcp`，发送交接提示词并读取回复与 `get_session_stats` 用量；若原会话尚未落盘（Pi 退出码 `1` 并报 `No session found matching ...`），抛出 `ForkUnsupportedError` 交由上层回退本会话交接；`remove()` 删除 `<forkId>` 对应的 `.jsonl` 文件。
- **沙箱与缺失能力**：
  - Pi 无自带终端沙箱，`capabilities.ownSandboxOffArgs` 无需设置，普通 Worker 直接由 `spawnInWriteScope` 包入外层 OS 沙箱。
  - 只读 Worker（`readonly: "os_sandbox"`）由 `wrapInReadonlyOsSandbox` 包入外层只读沙箱：仅放行会话私有 `TMPDIR`、Pi 运行时目录（`sessions`、`logs`）及通用缓存目录可写；为避免 Pi 自身启动读不到凭据而报未登录（实测禁读 `auth.json` 会使可用模型归零），仅对 Pi 自身外层沙箱放开 `<configDir>/auth.json` 与 `<configDir>/models.json` 的只读权限（不可写），其余敏感路径与别家凭据一律禁读。
  - **暂缺能力**：Pi 无订阅额度查询接口（依赖错误特征识别配额/速率错误），无后台命令完成自动唤醒（`backgroundWake: false`）。
