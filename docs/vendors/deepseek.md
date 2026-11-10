# DeepSeek Harness（`deepseek` / `dsh`）接入核实记录

> 核实日期：2026-11-11
> 核实对象：官方 MIT 开源仓库 `deepseek-ai/deepseek-harness`，npm 包 `@deepseek-ai/dsh@0.2.2-rc.1`（在系统临时目录独立解包与无 key 本地握手实测，测毕已彻底清理临时目录）。

---

## 1. 版本与安装命令

- **npm 包名与许可证**：`@deepseek-ai/dsh`，`MIT`（Node 引擎要求 `>=24.9`）。
- **当前最新预览版本号**：`0.2.2-rc.1`（`dist-tags.latest`）。
- **固定安装命令（`paths.ts` `installCommand`）**：
  ```bash
  npm install -g @deepseek-ai/dsh@0.2.2-rc.1
  ```
  开发者预览版在 `0.x` 演进期间可能调整 CLI / Cordis 配置项，因此 `installCommand` 钉死实测通过的精确版本 `0.2.2-rc.1`。
- **无头登录/配置方式（`headlessLoginCommand`）**：
  向 `~/.dsh/.env`（或 `$DSH_HOME/.env`）写入 `DEEPSEEK_API_KEY=<key>`，或在终端运行 `dsh` 完成交互式账号登录 / API Key 存储。

---

## 2. CLI 启动形态与 `--patch` 关闭自带沙箱

### 2.1 CLI 参数（出处：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-acp-app`、`@deepseek-ai/dsh-app-boot`）

- 启动命令：
  ```bash
  dsh --profile acp --patch <patch-file> [--patch <model-patch-file>]
  ```
- `--profile acp` 加载 `@deepseek-ai/dsh-acp-app` 与 `@deepseek-ai/dsh-acp`，以标准 stdio NDJSON 运行 ACP（`protocolVersion: 1`，基于 `@agentclientprotocol/sdk`）。`stdin` EOF 时自动触发有界退出（`exitOnStdinEnd`）。
- `--patch <file>` 可重复传入多个覆盖层，按命令行顺序依次叠加，且优先级高于用户 `$DSH_HOME/cordis.patch.yml` 与 profile 默认 `cordis.yml`（`dsh-app-boot/lib/index.js` `loadOverlayPatches`）。

### 2.2 `--patch` 真实配置文件格式、后缀与字段路径

- **解析器与后缀**：`loadOverlayPatches`（`@deepseek-ai/dsh-app-boot/lib/index.js:4708-4752`）对文件内容调用 `yaml.load(content, { schema: userPatchesSchema })`，**不限制文件后缀名**；由于 JSON 是 YAML 1.2 的严格子集，Fusa `launch.ts` 生成的 `settings.json`（及会话目录内的 `.json` 补丁文件）可直接传给 `--patch`。
- **顶层结构**：**必须是顶层数组**（Cordis loader entry patch 列表），若传顶层对象会抛 `overlay patch must be a top-level list of loader patch entries`。
- **关闭自带沙箱与免交互权限的精确字段**（出处：`@deepseek-ai/dsh-sandbox-policy`、`@deepseek-ai/dsh-user-approval`、`@deepseek-ai/dsh-permission-presets`、`@deepseek-ai/dsh-bash-sandbox`、`@deepseek-ai/dsh-fs-sandbox`）：
  ```json
  [
    { "id": "sandbox-policy", "config": { "mode": "danger-full-access" } },
    { "id": "approval", "config": { "policy": "never" } },
    { "id": "permission", "config": { "defaultPreset": "danger-full-access" } }
  ]
  ```
  - 当 `mode === "danger-full-access"` 时，`SandboxBashExecutor` 与 `SandboxedFileSystem` 直接旁路内置的 macOS `sandbox-exec` / Linux `bwrap` 包装器，在当前进程环境中直接运行工具命令。
  - 这使得外层可以安全包裹 Fusa 的 `write-scope` OS 沙箱（普通 Worker 限制只写自身 worktree，只读 Worker 走 `readonly: "os_sandbox"` 全盘只读 + 敏感路径禁读），不会触发 macOS Seatbelt 嵌套 `sandbox_apply: Operation not permitted (exit 71)` 或 Linux userns 嵌套失败。

---

## 3. ACP 协议行为核实（`@deepseek-ai/dsh-acp`）

### 3.1 `initialize` 与认证

- 无 `DEEPSEEK_API_KEY` 下 `initialize` 与 `session/new`、`session/resume` 均正常返回，不会在启动握手阶段失败；缺失或无效凭据仅在 `session/prompt` 调大模型时报错。
- `initialize` 返回：
  - `protocolVersion: 1`
  - `authMethods: []`（无需调用 `authenticate`）
  - `agentCapabilities`:
    - `mcpCapabilities: { http: true }`
    - `promptCapabilities: { image: false, audio: false, embeddedContext: false }`
    - `sessionCapabilities: { close: {}, list: {}, resume: {} }`

### 3.2 `session/new`、`session/resume` 与 `additionalDirectories` 限制

1. **`additionalDirectories` 不支持（重要边界）**：
   `dsh-acp` 的 `validateWorkspaceParams`（`lib/index.js:1378-1381`）只要检测到 `params.additionalDirectories` 非空，立即拒绝并返回 JSON-RPC `-32602`：
   ```json
   { "code": -32602, "message": "Invalid params: additionalDirectories is not supported" }
   ```
   `initialize` 回的 `sessionCapabilities` 里也没有 `additionalDirectories`。通用 ACP 驱动（`src/vendors/_common/acp/driver.ts`）只在 agent 声明了 `sessionCapabilities.additionalDirectories` 时才带这个字段，所以 dsh 收不到；Linux 只读沙箱照常按 `row.addDirs` 扫敏感文件。多目录访问由 `danger-full-access`（项目经理无外层限制 / Worker 由 `writeScope` 放行可读）覆盖。
2. **跨进程续接 `session/resume`**：
   - `session/resume` 直接原地恢复磁盘会话状态并返回 `{ configOptions }`，**不会重放历史消息事件**。
   - 当会话 ID 在磁盘不存在时，`dsh-acp` 返回 `-32602`：`Invalid params: session is not resumable: <sessionId>`。`driver.ts` 在 `errors.isSessionNotFoundError` 中额外匹配 `session is not resumable`，配合 `continuation: { mode: "resume", fallbackToNewOnFailure: true }` 自动回退 `session/new`。

### 3.3 系统提示词与仓库指令文件

- `@deepseek-ai/dsh-system-prompt`（`lib/index.js:160-184, 235-244`）会对 `personaPrefix` / `personaSuffix` 做严格的 `{{variable}}` 模板插值校验，遇到未知双花括号（例如代码片段或 Markdown 示例中的 `{{foo}}`）会直接抛致命错误终止启动。
- 因此**不通过 `--patch` 的 `system-prompt.config.personaSuffix` 注入 Fusa 动态提示词**，而是统一使用 `createAcpDriver` 的 `systemPromptInjection: "first_turn_new_session"`（新会话首轮前置 `<system_instructions>` XML 块，后续 `persona` 变更注入增量说明）。
- `@deepseek-ai/dsh-agent-instructions` 原生自动发现工作区与全局的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md` 及 `.agents/skills`。

### 3.4 模型与思考程度（`configOptions`）

- **官方打包模型（`@deepseek-ai/dsh-llm-deepseek` `DEFAULT_MODELS`，1M 上下文）**：
  - `deepseek-v4-pro`（显示名 `DeepSeek-V4-Pro`）
  - `deepseek-flash`（显示名 `DeepSeek-V4.1-Flash`，支持多模态文本/图片）
  - `dsh` 同时支持自定义模型 ID 与 OpenAI / Anthropic 兼容路由（`customModel: true`）。
- **`dsh-acp` 的 `model` 编码格式**：
  - `dsh-acp`（`lib/index.js:349-483`）将 `configOptions` 中 `id: "model"` 的候选值编码为 JSON 二元组字符串 `JSON.stringify([provider, model])`，例如 `'["deepseek-official","deepseek-v4-pro"]'`。
  - 同时 `AcpModelControl.set("model", value)` 仅接受当前 `choices` 列表内已存在的选项值；离线或自定义模型未出现在远端 `/models` 列表时，只有启动期 `acp.config.{provider, model}` 会被加入 `choices`。
  - 因此 `deepseek` 驱动采用**双保险**：
    1. 启动时若 `row.model` 非空，在会话启动目录生成模型补丁 `{ "id": "acp", "config": { "provider": "<provider>", "model": "<model>" } }` 追加 `--patch`，确保初始模型与任意自定义模型在 `session/new` 时即刻生效并进入 `choices`；
    2. 运行中切换或恢复时，`configOptions.resolveModelValue` 自动在裸模型名（如 `deepseek-v4-pro`）、`provider/model` 与 JSON 二元组 `["deepseek-official","deepseek-v4-pro"]` 之间双向匹配。
- **思考程度 `reasoning_effort`（`@deepseek-ai/dsh-llm-deepseek/lib/index.js:472-497`）**：
  - `configOptions` 条目：`id: "reasoning_effort"`，`category: "thought_level"`。
  - 支持精确档位值：`["off", "low", "high", "max"]`（`dsh` 默认值为 `"high"`，无 `"medium"` 档）。

---

## 4. `$DSH_HOME` 目录结构、凭据隔离与只读沙箱

- **主目录解析（`@deepseek-ai/dsh-home-paths`）**：优先读环境变量 `$DSH_HOME`，未设置时默认 `~/.dsh`（已在 `spec.home.configHome` 声明 `{ rel: ".dsh", env: "DSH_HOME" }`）。
- **凭据存储（`@deepseek-ai/dsh-credentials-local` & `dsh-app-boot`）**，优先级从高到低：
  1. `$DSH_HOME/.credentials.yaml`（权限强制 `0600`，存 `refs` API Key 与 `records` 网页登录令牌 grant）；
  2. 进程继承环境变量（`DEEPSEEK_API_KEY`）；
  3. `<进程 cwd>/.env`（项目层，`dsh-app-boot` 的 `loadLayeredEnv`）；
  4. `$DSH_HOME/.env`。
- **工作区 `.env` 与工作区配置（核对 `dsh@0.2.2-rc.1` 源码）**：
  - dsh 以 Worker 的工作目录为进程 cwd 启动，会读 `<cwd>/.env`。`dsh-app-boot` 的 `BOOTSTRAP_NAMES` / `BOOTSTRAP_PREFIXES` 禁止项目 `.env` 设 `DEEPSEEK_BASE_URL`、`DEEPSEEK_SEARCH_BASE_URL`、`DSH_*`、`HTTP(S)_PROXY`、`NODE_OPTIONS`、`SSL_CERT_*`、`GIT_SSH*` 等，出现即启动失败，所以恶意仓库改不了请求发往的地址，偷不走 key。
  - 项目 `.env` 能设 `DEEPSEEK_API_KEY`，且排在 `$DSH_HOME/.env` 前面（dsh 的设计是信任启动它的项目）：key 只写在 `$DSH_HOME/.env` 时，仓库里的 `.env` 能换成别的 key。要防这一点，把 key 存进 `.credentials.yaml`（`dsh` 交互登录或网页的 Models 页）或导出到守护进程的环境变量，这两处都排在项目 `.env` 前面。
  - 只读 Worker 的外层沙箱禁读 `**/.env`，工作区 `.env` 读不到（dsh 只打一行警告）。
  - 工作区里 dsh 还会自动读 `AGENTS.md`、`CLAUDE.md`、`.dsh/skills`、`.agents/skills`（只是提示词）；不读工作区级的 `cordis.patch.yml`、MCP 配置或钩子。MCP 服务器只来自 ACP `session/new` 的 `mcpServers`（驱动传 `[]`）。
- **敏感路径与 worktree `setup` 环境变量剥离**：
  - `spec.home.readonlySecrets`: `[".dsh/.credentials.yaml", ".dsh/.env"]`（阻止其他厂商的只读 Worker 读取 DeepSeek 凭据）。
  - `spec.home.catalogWatchPaths`: `[".dsh/.credentials.yaml", ".dsh/.env", ".dsh/cordis.patch.yml"]`（监听本地凭据与配置指纹，支持 `DSH_HOME` 重定向；`daemon.ts` 不设 `catalog` 以避免创建持久空会话）。
  - `paths.ts` `credentialEnv`: `names: ["DEEPSEEK_API_KEY"]`。dsh 只从这个变量取密钥（各处 `apiKeyEnv` 的默认值）；`DEEPSEEK_BASE_URL` 这类非密钥配置和 `GH_TOKEN`、`AWS_*`、`OPENAI_BASE_URL` 一样照常传给准备命令（`setup.test.ts` 的 A13）。
  - `paths.ts` `parentSessionEnv`: `["DSH_SHELL", "DSH_SESSION_ID", "DSH_PROFILE", "DSH_PROFILE_DIR"]`（来自 `@deepseek-ai/dsh-shell-env`，保留 `DSH_HOME` 不剥离）。
- **会话持久化格式（`@deepseek-ai/dsh-session-persistence-jsonl`）**：
  - 路径位于 `$DSH_HOME/sessions/<encoded-cwd>/<uuid>/session.v4.jsonl.zstd`，采用 Zstandard 二进制压缩帧存储，非跨厂商可直接读取的明文 JSONL；因此不设 `transcript.ts`，`spec.handover.transcriptPortable` 设为 `false`，跨厂商换会话自动走 Fusa 账本摘要降级。
- **只读 Worker（`readonly: "os_sandbox"`）**：
  - `$DSH_HOME/profiles/acp/` 不能给只读 Worker 写：`cordis.patch.yml` 是这个 profile 的用户补丁层，允许 `!!js` 表达式，`node_modules` 是插件，项目经理和普通 Worker 下次起 dsh 都会加载执行。`$DSH_HOME/storages/` 也不能写：dsh 的定时任务（`dsh-schedule`）、工作区记录存在这里，别的 profile（桌面版、网页版）会读来执行。
  - 实测（真实 dsh + 临时 `DSH_HOME`）：profile 已初始化时，一次启动加一轮对话在共享 `$DSH_HOME` 下只写 `profiles/acp/cordis.yml`（每次启动先重写成空列表再加载）、`.anonymous-user-id`；会话记录、KV 存储、附件的位置都能用 `--patch` 改（`session-persistence-jsonl.root`、`storage-json.root`、`attachment-local.dshHome`）；`jobs`、`spill` 在 `TMPDIR` 下。
  - 所以只读 Worker：多加一个 `--patch <启动目录>/dsh-readonly.patch.json`，把这三样改到会话私有的 `<启动目录>/dsh-readonly-state/`（在启动目录不在 `TMPDIR`，恢复会话要用）；共享 `$DSH_HOME` 下只放行 `llm-deepseek/`（图片上传索引）目录和 `profiles/acp/cordis.yml`、`.anonymous-user-id` 两个文件可写，根目录、`profiles/`、`storages/`、`sessions/` 都不可写。
  - profile 还没初始化时只读沙箱里建不了，驱动先在沙箱外跑一次 `dsh --profile acp --dump-config`（只建 profile、打印配置就退出，不起会话、cwd 是启动目录、不读工作区 `.env`）。
  - 自身凭据：`dsh-credentials-local` 启动时读 `$DSH_HOME/.credentials.yaml`，禁读会报 `EPERM` 终止；key 只写在 `$DSH_HOME/.env` 时也得读得到。`readonlySandbox.readableFiles` 把这两个文件从禁读路径里去掉，seatbelt 在 `**/.env` 禁读规则之后加一条 `allow file-read*`（bwrap 不遮成 `/dev/null`）；它们不在任何可写规则里，写不了。工作区和别处的 `.env`、别家凭据照常禁读。代价同 agy 放行自身 Keychain、pi 放行 `auth.json`：只读 Worker 的 shell 能读到 DeepSeek 自己的 key。
  - 内置写工具（`write`、`edit`、`apply_patch` 等）与非 `readOnlyHint: true` 的 MCP 工具由外层只读 OS 沙箱 + ACP `decideAcpPermission` 双重拦截。
- **残留进程清理**：`matchesDeepSeekStaleProcess` 只认命令行里带本会话启动目录 `/launch/<会话号>/` 的 `dsh --profile acp`，用户自己在终端开的 `dsh` 不会被当成残留进程杀掉。

---

## 5. 冷启动握手耗时实测（macOS Darwin arm64，Node v24.21.0）

在无 `DEEPSEEK_API_KEY` 环境下连续 5 次冷启动运行 `dsh --profile acp --patch patch.json` 并完成 JSON-RPC `initialize` 与 `session/new` 握手：

| 轮次 | `initialize` 耗时 (ms) | `initialize + session/new` 总耗时 (ms) |
| ---: | ---------------------: | -------------------------------------: |
| 1 | 1254 | 1325 |
| 2 | 1268 | 1307 |
| 3 | 1291 | 1342 |
| 4 | 1269 | 1313 |
| 5 | 1446 | 1497 |
| **中位数** | **1269** | **1325** |

完全在通用 ACP 驱动默认 `SESSION_START_TIMEOUT_MS`（30,000 ms）安全裕度内。
