# 按项目经理管理 Skill、MCP 与 Connector

## 给用户看

### 要验收的文件

- 本文：先做后端（每个项目经理一份选择、各家按会话生效、接口）。界面等后端完成后另起一步，本文不含界面。
- 各家 CLI 能不能按会话隔离的实测表：本文「现状」一节的表格。

### 要你拍板的事

1. **Worker 用谁的选择。**
   - A（推荐）：Worker 一律用所属项目经理的选择，包括只读 Worker 和审查 Worker，不另设。理由：Worker 在项目经理的项目里干活，项目经理关掉的东西 Worker 也不该用；少一个要管的地方。
   - B：Worker 不受限，全开。
2. **总助用谁的选择。**
   - A（推荐）：总助不受任何项目经理影响，和现在一样全开。总助跨项目调度，按某个项目经理收窄不合理。
   - B：总助也单独有一份，放在全局设置里。
3. **新建项目经理默认怎么开。**（后端只定默认值，界面上怎么选之后再做）
   - A（推荐）：不指定时全开；创建接口可以带“复制某个已有项目经理”，整份复制它的选择。
   - B：不指定时复制最近打开的那个项目经理。
   - C：不指定时全关。一百多个技能要逐个开，不推荐。
4. **做不到按会话隔离的厂商怎么办。** 实测 Cursor 的技能、MCP、连接器都只有全局开关；agy 的技能和云端连接器、pi 和 DeepSeek 的云端连接器也没有。
   - A（推荐）：这几类照旧用全局配置；接口返回每家能做到什么（`isolation`），以后界面据此标出“这家用全部”。
   - B：项目经理用这类厂商时，接口拒绝关掉这几类。
   - C：驱动层看到被关的工具调用就打断。这是补丁，挡不住技能（技能是读文件），不推荐。
5. **和全局 Vendor sync 怎么分工。**
   - A（推荐）：Vendor sync 继续管“本机各家都装上同一套 MCP 和技能”（加、删都在这里），项目经理的选择只管“这个项目经理用哪些”。后端的库存直接复用 Vendor sync 的扫描适配器。同步预览里只读的 Cloud connectors 一组等做界面时再删。
   - B：把 Vendor sync 也并进项目经理的选择，全局只留一个“同步”动作。改动大，用户已经定过的“别家应用自带的 MCP 默认不勾选”等规则要重做，不推荐。

## 用户目标

> 我想我可以方便的管理每个项目经理的skill，mcp，connector，而不是所有的共用一个

现在所有项目经理（和它们的 Worker）启动时看到的是本机各家厂商的全局全量池：claude 实测 166 个技能、71 个 MCP 服务器（含 20 个 claude.ai 云端连接器）。目标是每个项目经理有自己的一份开关，改起来省事：能搜、能整组开关、新出现的东西有默认值、新建项目经理不用从头勾；各家厂商按会话生效，不改写用户的全局配置，多个项目经理同时跑互不影响。

## 现状

### 代码

- 实测（读代码）：项目经理和 Worker 每次启动走 `createLaunchPreparer`，厂商专属的启动文件只有 `launchFiles` 一个口子，现在只给提示词、claude 的设置文件、环境变量、只读策略，没有任何按项目经理收窄技能或 MCP 的东西。`src/daemon/launch.ts:136`、`src/daemon/launch.ts:187`。
- 实测（读代码）：只读 Worker 的统一定义放在 `LaunchFiles.readonly`，各家在自己的驱动层翻译（claude 写进设置文件、agy 写 `--settings` 的 permissions 规则、pi 加 `--exclude-tools`）。这次照同一个模式做。`src/shared/driver.ts:527`、`src/vendors/agy/protocol.ts:76`、`src/vendors/pi/protocol.ts:52`。
- 实测（读代码）：claude 已经每次启动带 `--settings <启动目录>/settings.json`。`src/vendors/claude/protocol.ts:347`、`src/vendors/claude/settings.ts:86`。
- 实测（读代码）：codex 每个会话一个 `codex app-server` 进程，配置覆盖在 `buildCodexLaunchConfig` 里拼。`src/vendors/codex/protocol.ts:80`、`src/vendors/codex/protocol.ts:129`。
- 实测（读代码）：DeepSeek 的 MCP 本来就是建会话时经 ACP `session.mcpServers` 注入的，只读 Worker 传空数组。`src/vendors/deepseek/driver.ts:424`。
- 实测（读代码）：全局 Vendor sync 扫各家全局配置的 MCP（`scanMcp`）和标准技能目录（`collectCanonicalSkills`），把并集写回每家的全局配置；云端连接器只识别出来、只读展示。`src/daemon/vendor-sync/engine.ts:176`、`src/daemon/vendor-sync/engine.ts:237`、`src/web/components/VendorSyncSettings.tsx:161`、`src/web/mobile/settings/VendorSyncPage.tsx:115`。
- 实测（读代码）：资料页的分组在 `PmEditor` 里，按 `SettingsGroup` 排。`src/web/components/PmProfile.tsx:339`。

### 各家 CLI 能不能按会话隔离

全部在 `/tmp/pmcap-probe` 里跑，不改任何用户配置。claude 读 `-p --output-format stream-json --verbose` 的第一条 `system/init`（列出 `mcp_servers`、`skills`、`plugins`）；codex 起 `codex app-server`，问 `skills/list`、`mcpServerStatus/list`、`app/list`；其余看 `--help` 和二进制里的设置项说明。

| 厂商 | 技能 | MCP | 云端连接器 | 怎么测的 |
| --- | --- | --- | --- | --- |
| claude 2.1.326 | session：`--settings` 里 `skillOverrides {"aws-auth":"off"}`，init 的 skills 从 166 变 129（同时关了一个插件），`aws-auth` 不在。插件里的技能是 tool_deny：`skillOverrides` 对它不生效（二进制里插件技能只认 claude.ai 同步来的技能的设置），改用 `permissions.deny` 的 `Skill(data:analyze)`，init 里还列着，调用返回 `Skill execution blocked by permission rules` | session：`--settings` 里 `deniedMcpServers [{"serverName":"codegraph"}]`，init 里没有 codegraph；插件带的 MCP 写全名（`plugin:parallel:parallel-search`）也一样 | session：同上，`{"serverName":"claude.ai Gmail"}` 后 init 里没有 claude.ai Gmail | 实测。整个插件：`enabledPlugins {"sales@synced":false}` 后插件带的技能和 MCP 一起没了，这家从这个插件拿到的项全关时才这样写。`--strict-mcp-config` 会把云端连接器和插件 MCP 一起清零，不能用来挑 |
| codex 0.169.0 | session：`-c 'skills.config=[{name="aws-auth",enabled=false}]'`，`skills/list` 里 62 个只剩 61 个 enabled。插件技能的名字是 `<插件>:<SKILL.md frontmatter 的 name>`（`spreadsheets:Spreadsheets`，不是目录名），按这个名字关才生效 | session：`-c 'mcp_servers={"codegraph"={enabled=false}}'`，`mcpServerStatus/list` 里 codegraph 工具数从 1 变 0。插件带的 MCP 写 `-c 'plugins={"unified-computer-use@openai-bundled"={mcp_servers={"cua_repl"={enabled=false}}}}'`，cua_repl 工具数从 3 变 0；写成顶层 `mcp_servers.cua_repl` 会因为 config.toml 里没有它的定义，app-server 报 `invalid transport` 退出 | session：`-c 'apps={"connector_openai_chatgpt_pets"={enabled=false}}'`，`app/list` 里它的 isEnabled 变 false（本机 10 个已连接） | 实测。`-c` 的键按 `.` 直接切段、不认引号，`plugins."visualize@openai-bundled".enabled=false` 会变成一个叫 `"visualize@openai-bundled"` 的键，不生效；所以键只写顶层表名，名字放在内联表的引号键里，codex 把它和 config.toml 逐层合并。`skills/config/write` 会写 `~/.codex/config.toml`，不用 |
| agy 1.5.9 | shared：没找到按会话的开关（`--settings` 只收 settings.json 的键，`skillOverrides` 只出现在云端 protobuf 里） | tool_deny：`--settings` 的 `permissions.deny` 写 `mcp(<服务器>/*)`，服务器照起、调用被拒 | shared：agy 的连接器就是 MCP，按 MCP 算 | 实测。带 `--mode auto --dangerously-skip-permissions` 与 `--settings` 的 `mcp(codegraph/*)` 规则时，`call_mcp_tool` 调 codegraph 返回 `ERROR`，不带的对照会话返回 `DONE`。多个 `--settings` 只认最后一个：包进 OS 沙箱的 Worker 前面已有关终端沙箱的 `{"enableTerminalSandbox":false}`，能力规则要和它合成一条 |
| pi 1.5.2 | session：`--no-skills` 关自动发现，再逐个 `--skill <目录>` | tool_deny：`--exclude-tools mcp__<服务器>__*`（服务器名非 `[A-Za-z0-9_]` 换成 `_`） | shared：没有云端连接器 | 实测。`get_commands` 只剩允许的技能；`--exclude-tools` 在工具注册阶段剔除匹配的 MCP 工具，模型请求的工具列表里不可见 |
| deepseek dsh 0.2.2-rc.1 | session：`--patch` 给 skill-filesystem 设 `includeDefaultRoots:false` + `customSkillDirs` | session：`session.mcpServers` 只传开着的 | shared：没有云端连接器 | 实测。带补丁起 `dsh --profile acp`，首轮请求里的 `<available_skills>` 只含允许目录和产品技能，默认项目根与全局根技能都不在；`session.mcpServers` 按选择过滤 |
| cursor 2026.11.10 | shared：ACP 下读不到 `--plugin-dir` 的技能（2026-11-12 实测），没有按会话的技能开关 | shared：`mcp enable/disable` 写本地批准名单，启动带 `--approve-mcps` 全部批准 | shared | `--help` 和 `mcp --help`，推断 |

结论：claude、codex 三类都能精确按会话隔离，只有 claude 插件里的单个技能只能拒调用（`VendorCapabilities.pluginIsolation`，接口里是 `pluginIsolation`）；deepseek 技能和 MCP 可以；pi 技能可以、MCP 只能拒调用；agy 只有 MCP 能拒调用；cursor 都不行。所有能做到的都是启动参数或只对这次会话生效的设置，不用碰用户的全局配置。

## 做法比较

| 做法 | 隔离强度 | 动不动用户全局配置 | 多个项目经理并发 | 登录态 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. 守护进程算出这次启动要关的清单，放进 `LaunchFiles.capabilities`，各家翻译成只对这次会话生效的参数（claude `--settings`、codex `-c`、agy `--settings`、pi 参数、dsh `--patch` 和 `session.mcpServers`） | 能做到的那几类是厂商原生的隔离 | 不动 | 每个会话各带各的参数，互不影响 | 不动 | 推荐 |
| B. 每个项目经理一份独立的厂商配置目录（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`PI_CODING_AGENT_DIR` 指到私有目录） | 强 | 要复制一份 | 互不影响 | claude.ai、ChatGPT 登录态和对话历史跟着配置目录走，每个项目经理要重新登录或复制令牌；agy、cursor 不支持换目录 | 不用 |
| C. 启动前改写全局配置（切换 `~/.claude.json` 的 mcpServers 等），启动后改回 | 弱 | 每次都改 | 两个项目经理同时启动会互相覆盖，要加全局锁串行 | 不动 | 不用，违反“先分开再串行化共享状态” |
| D. 不改启动参数，驱动层看到被关的工具调用就打断 | 只管得住 MCP 工具，技能是读文件挡不住 | 不动 | 互不影响 | 不动 | 只当 A 做不到时的兜底，这次不做（拍板第 4 条） |

“方便管理”在后端这一侧落成三件事：库存按来源分组（全局、项目、插件、厂商自带、账号），接口一次能改一整组；新出现的东西走“这一类的默认”；存储只记和默认不同的项，所以存量项目经理不用迁移，新建项目经理可以整份复制。界面另起一步。

## 性能

1. **失效。** 库存（`daemon/pm-capabilities/inventory.ts`）按 `PM_CAPABILITY_INVENTORY_TTL_MS` 缓存；各家配置文件（`~/.claude.json`、`~/.codex/config.toml`、`mcp_config.json` 等）和技能目录的 mtime 变了提前失效；Vendor sync apply 之后、用户点刷新时 `invalidate()`。某家扫描失败（读不了、`codex app-server` 超时）那家只缓存 `PM_CAPABILITY_INVENTORY_RETRY_MS`。项目经理删除时选择随外键级联删掉；库存按项目目录缓存，项目移除后条目随 LRU 淘汰。
2. **上限。** 见下表。按一个月的量算：300 个已收工 Worker 不存任何东西（Worker 用项目经理的选择）；项目经理数量和现在一样，每个最多 `PM_CAPABILITY_OVERRIDES_MAX` 行。GET 响应最大约 2,000 项 × 每项约 250 字节 ≈ 500 KB，走已有的 `@fastify/compress`。给 agent 的命令行参数：claude 和 agy 写进设置文件不占命令行；codex 的 `skills.config` 合成一条；pi 的 `--skill` 每个允许的技能一个，按本机 33 个全局技能算不到 4 KB。
3. **前端引用稳定。** 这一步没有前端。库存服务在缓存有效期内对同一个项目目录返回同一个对象，以后界面按它做 `WeakMap` 缓存。
4. **验证。** 实现步骤用 pstack 的 `benchmark-checklist` 量：改前改后单个项目经理启动耗时（`prepareLaunch` 到第一条事件）、`GET /api/pms/:id/capabilities` 的冷热耗时和响应大小、守护进程 RSS，写进 PR。`blast-radius` 列出 `LaunchFiles` 和 `VendorCapabilities` 的调用方。

| 常量（`src/shared/limits.ts`） | 值 | 怎么算的 |
| --- | --- | --- |
| `PM_CAPABILITY_INVENTORY_MAX_ITEMS` | 2,000 | 本机 claude 166 技能 + 71 MCP，codex 62 技能 + 12 MCP + 10 连接器，合并后约 280 项，留七倍 |
| `PM_CAPABILITY_OVERRIDES_MAX` | 2,000 | 每项最多一行，和库存上限相同 |
| `PM_CAPABILITY_INVENTORY_TTL_MS` | 60,000 | 技能和 MCP 很少变，mtime 失效兜住大部分变化 |
| `PM_CAPABILITY_INVENTORY_RETRY_MS` | 5,000 | 同 `FETCHED_QUOTA_RETRY_MS` 的思路 |
| `PM_CAPABILITY_DESCRIPTION_MAX_CHARS` | 200 | 列表里每项一两行说明，本机最长的 SKILL.md description 1,052 字（aws-storage），超出截断 |
| `PM_CAPABILITY_PATCH_MAX_KEYS` | 500 | 一次 PATCH 可以改一整组，本机最大的插件组 37 个技能 |

## 统一

- 一处定义覆盖所有厂商：`LaunchFiles.capabilities`（`src/shared/driver.ts`）是这次启动要关的、只开的清单，由 `resolveSessionCapabilities`（`src/shared/pm-capabilities.ts`）按项目经理的选择、库存和厂商算出来，对所有厂商一样。
- 每家能做到什么写在 `VendorCapabilities.isolation`（`src/vendors/types.ts`，必填），各家 `spec.ts` 照上面的实测表填；界面打 `uses all` 标签、守护进程决定给不给那一类，都只读这个字段，不写死厂商。插件里的项单独关时做不到那么干净的，另写在 `pluginIsolation`（目前只有 claude 的技能是 `tool_deny`）。
- 插件归属按厂商记在库存项的 `plugins`（厂商 → 插件编号），不看分组：同名技能会合进先扫到的那家的插件组，按分组算会把别家插件里没关的项一起关掉。`SessionCapabilities.deny.pluginOf` 告诉翻译函数哪些名字来自插件。
- fingerprint 只算各家翻出来的结果（`VendorDaemon.capabilityLaunch`），不算原始清单：改了这家看不到、用不上的项（比如 claude 不用的允许清单）不重启。
- 每家怎么翻译放在 `src/vendors/<厂商>/capabilities.ts`，由该家 `protocol.ts` 或 `driver.ts` 调用；isolation 是 shared 的那一类不翻译。cursor 三类都是 shared，没有这个文件。
- 库存的厂商专属部分（插件、厂商自带技能、账号连接器）走 `VendorSyncAdapter.scanCapabilities`（`src/vendors/daemon-types.ts`），和 Vendor sync 用同一个适配器，不另起一套扫描。
- 三个平台：所有手段都是命令行参数、会话设置文件或 ACP 字段，不碰文件权限和沙箱，macOS、Windows、Linux 一样；路径拼接走各家已有的 `paths.ts`，`src/daemon/platform/index.ts` 不用改。
- 以后加一家新厂商：在它的 `spec.ts` 填 `isolation`；三类里有不是 shared 的，加 `src/vendors/<厂商>/capabilities.ts` 并在它的 protocol 里接上；要进库存的专属东西实现 `scanCapabilities`。

## 删掉什么

- 后端这一步没有被取代的旧代码：新清单 `LaunchFiles.capabilities` 和现有的只读翻译（`LaunchFiles.readonly`）并列合并（agy 的 deny 规则、pi 的 `--exclude-tools` 两边都要留），Vendor sync 的扫描被库存复用。
- 留给界面那一步删（同一个 PR 删，不并存）：同步预览里只读的 `Cloud connectors` 一组（`src/web/components/VendorSyncSettings.tsx:161`、`src/web/mobile/settings/VendorSyncPage.tsx:115`），以及只给它用的 `VendorSyncPreviewResponse.nonSyncable`、`VendorSyncNonSyncableItem`（`src/shared/vendor-sync.ts`）和 `engine.ts` 里拼它的那段；`docs/ui-standard.md` 里对应的说法。各家 `scanMcp` 识别连接器的逻辑保留，改由 `scanCapabilities` 用。

## 骨架文件

- `src/shared/pm-capabilities.ts`：领域类型（库存、分组、项目经理的选择、一次启动的清单、接口形状）和三个纯函数 `capabilityEnabled`、`applyCapabilitiesPatch`、`resolveSessionCapabilities`。
- `src/shared/pm-capabilities.test.ts`：上面三个函数和 `capabilityKey` 的 `it.todo`。
- `src/shared/driver.ts`：`LaunchFiles.capabilities`。
- `src/shared/api.ts`：`API_PATHS.pmCapabilities`、`CreatePmRequest.capabilities`。
- `src/shared/limits.ts`：上表六个常量。
- `src/shared/index.ts`：导出 `pm-capabilities.ts`。
- `src/vendors/types.ts`：`VendorCapabilities.isolation`；六家 `spec.ts`、测试假厂商 `test/fixtures/vendors/acme/spec.ts` 和 `src/vendors/_common/acp/driver.test.ts` 里的假 spec 照实测表填上。
- `src/vendors/daemon-types.ts`：`VendorSyncAdapter.scanCapabilities`、`VendorCapabilityScan`。
- `src/vendors/claude/capabilities.ts`：清单翻成 `--settings` 里的 `skillOverrides`、`deniedMcpServers`、`enabledPlugins`，插件里的技能翻成 `permissions.deny` 的 `Skill(<名字>)`。
- `src/vendors/codex/capabilities.ts`：清单翻成 `codex app-server` 的 `-c` 参数（`skills.config`、`mcp_servers`、`plugins.<插件>.mcp_servers`、`apps`，不整个关插件）。
- `src/vendors/agy/capabilities.ts`：清单翻成 `permissions.deny` 的 `mcp(<服务器>/*)`。
- `src/vendors/pi/capabilities.ts`：清单翻成 `--no-skills`、`--skill`、`--exclude-tools`。
- `src/vendors/deepseek/capabilities.ts`：清单翻成 skill-filesystem 的补丁和过滤后的 `session.mcpServers`。
- 上面五家各一个 `capabilities.test.ts`。
- `src/daemon/pm-capabilities/inventory.ts` 和测试：库存服务，带缓存和失效。
- `src/daemon/ledger/pm-capabilities.ts` 和测试：项目经理的选择读写、新建时复制。
- `migrations/0033_pm_capabilities.sql`：`pm_capability_policies`、`pm_capability_overrides` 两张表。**编号接在图 #26 的 PR #341（`0032_project_catalogs.sql`）后面，必须在它之后合并**：迁移按 `user_version` 只跑更大的编号，先合 0033 会让已升级的库永远跳过 0032。

接线留给实现步骤：`createLaunchPreparer` 调 `resolveSessionCapabilities` 填 `LaunchFiles.capabilities` 并把它算进 `launchFingerprint`；各家 protocol 调自己的 `capabilities.ts`；界面服务加 GET、PATCH 两个路由（zod 校验，PATCH 后发 `pm.updated`）；`createPm` 接 `capabilities` 字段并调 `init`。

界面（资料页入口、搜索、分组、整组开关、手机整屏页）等后端完成后另起一步，照本文的 GET、PATCH 接口做。

## 验收方法

- 单元测试：上面每个 `it.todo` 改成真断言后全绿，重点是 `resolveSessionCapabilities` 的“全开返回 null”（存量项目经理启动参数逐字不变，用 `src/vendors/migration-snapshot.test.ts` 的快照守着）和各家翻译函数的输出。
- 真机，各家一条：两个项目经理，A 关掉 `aws-auth` 技能、`codegraph` MCP 和 claude.ai Gmail，B 全开，同时各派一个 Worker。
  - claude：从驱动日志取两个会话的 `system/init`，A 的 skills 里没有 `aws-auth`、mcp_servers 里没有 codegraph 和 claude.ai Gmail，B 的都有。
  - codex：对两个会话的 app-server 发 `skills/list`、`mcpServerStatus/list`，A 的 `aws-auth` enabled 为 false、codegraph 工具数为 0。
  - agy、pi：让 A 的会话调 codegraph 的工具，被拒；B 正常。
  - deepseek：A 的会话记录里技能目录没有 `aws-auth`。
  - 证据：命令和输出贴进 PR。
- 全局配置不变：实验前后对 `~/.claude.json`、`~/.claude/settings.json`、`~/.codex/config.toml`、`~/.gemini/config/mcp_config.json`、`~/.pi/agent/mcp.json`、`~/.cursor/mcp.json` 取 sha256，前后一致，贴进 PR。
- 接口：用 `curl` 对 `GET /api/pms/:id/capabilities` 和 `PATCH` 走一遍（关一项、整组关、改 base、复制到新项目经理），响应贴进 PR；PATCH 后下一条消息前项目经理和它的 Worker 按 fingerprint 重启，看驱动日志。
- 性能：`benchmark-checklist` 的改前改后数字写进 PR（见性能一节）。
