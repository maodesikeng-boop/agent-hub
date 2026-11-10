# 新厂商一家一个文件夹（方案）

目标：以后接第 N 家命令行 agent，**新建一个文件夹 + 名单里加一项**就能跑；公共代码（账本、提示词、组装、网页、测试工具）不出现任何厂商名。

- 行号以 `main@01ed711` 为准。
- 对标：t3code（github.com/pingdotgg/t3code）`main@9e12eca`（2026-11-10 取，`git clone --depth 1` 到 `/tmp/t3code-provider/`）。下文 `t3:` 开头的路径都是相对它的仓库根目录。
- 前一版方案 `docs/vendor-registry-design.md` 已经做完（声明表 `VENDOR_SPECS`、守护进程登记表 `DAEMON_VENDORS`、守卫测试 `src/shared/vendor-guard.test.ts`）。本方案在它的基础上继续收口，不推翻。

---

## 0. 结论（先看这里）

1. **现状**：清单共 43 条（第 1 节）。扣掉“本来就该每家一份”的 10 条（表 C）和测试脚本文档的 8 条（表 D），加一家要在公共代码里动 **18 个源文件、25 处**（表 A 16 处 + 表 B 9 处）。其中 9 处是“按家登记表”（编译器会逼你填，但分散在 7 个文件），16 处是公共代码里写死了厂商名、按家字段或只认一家的逻辑（编译器不会提醒，漏了就静默出错）。
2. **网页、`apps/macos` 核实过**：代码里没有写死厂商名（只有注释），都按 `AGENT_VENDORS` / `VENDOR_SPECS` 循环。网页的问题只是它要读厂商的纯数据，所以厂商文件夹必须拆出“网页也能引的那部分”。
3. **目标结构**（对标 t3code 后调整过，见第 2 节）：文件夹放 `src/vendors/<厂商>/`（不放 `src/daemon/vendors/`），每家两个入口：
   - `spec.ts`：配置（纯数据 + 纯函数，**不许 import `node:*`**，网页、hub 命令行、守护进程都引）；
   - `daemon.ts`：守护进程侧（driver、模型/登录探测、"/" 命令、换会话复制、只读、原始记录路径……）。
   名单只在 `src/vendors/registry.ts` 一处；守护进程按约定路径 `./<厂商>/daemon.ts` 加载，不再另外登记。
4. **能力分必需 / 可选**：必需只有 `spec.ts` 的基本配置 + `daemon.ts` 的 `createDriver`；其余每项缺了都有通用兜底（第 4 节表）。能力写成显式的能力位，公共代码只看能力位、不看厂商名（借鉴 t3code 的 capability + degradation policy）。
5. **迁移分 5 步**（第 5 节），外加可选的第 6 步“通用 ACP 驱动”。每步先加快照/契约测试再搬代码，行为不变。和 #315、#316、#319 冲突的文件集中在第 4 步（`test/e2e/harness.ts`、`src/shared/limits.ts`、`ui-server/server.ts`、`web/selectors.ts`），排在它们合并之后。

---

## 1. 现状清单：加一家现在必须改的地方

### 1.1 怎么查的

```sh
# 字面量（含驼峰、常量、注释外的代码行），排除测试后逐个文件看
git ls-files | grep -vE '^(docs|experiments|\.agents|migrations)/|\.test\.tsx?$' \
  | xargs grep -nE '\b(agy|codex|claude|antigravity|AGY|CODEX|CLAUDE)\b|(agy|codex|claude)[A-Z_]|[a-z](Agy|Codex|Claude)'
# 按家分支、按家登记表
grep -rnE 'vendor\s*[!=]==?\s*"|Record<AgentVendor|satisfies Record<|AGENT_VENDORS\.find' src test
# 网页、Mac App 单独查
grep -rniE 'agy|codex|claude|antigravity' src/web apps/macos
```

103 个非测试文件命中（第一条命令），逐个看过，按性质分四类：

- **A 不该写死**：公共代码里出现厂商名、按家字段、只认某一家的逻辑。必须改成从厂商文件夹读。
- **B 按家登记表**：`Record<AgentVendor, …>` 一家一项。现在编译器会逼着补，但分散在多处；迁移后收进各家文件夹。
- **C 本来就该每家一份**：协议翻译、厂商自己的格式。不改逻辑，只是搬进各家文件夹。
- **D 测试、脚本、文档**。

### 1.2 表 A：不该写死（16 条）

| # | 位置 | 现在怎么写 | 为什么必须改 |
|---|---|---|---|
| A1 | `src/daemon/ledger/handover.ts:142` | `options.fromVendor === "agy" && options.toVendor !== "agy"` → “原始记录格式是 agy 的，读不了” | 新厂商的原始记录如果也是二进制库，这里不会提醒，新会话会被告知去读一个读不了的文件。应改成 `spec.handover.transcriptPortable` |
| A2 | `src/daemon/ledger/handover.ts:91` | 交接提示词里写死例子“比如 claude 的后台任务、codex 的 apply_patch” | 换到新厂商时例子不对。改成从 `fromVendor` 的 spec 取“只有这家才有的工具”描述 |
| A3 | `src/daemon/daemon.ts:469-474` | `AGENT_VENDORS.find(v => VENDOR_SPECS[v].quota?.fetched)`：只取**第一家**要按需查额度的厂商 | 第二家也要按需查额度时被静默忽略。改成每家各自的 `daemon.quota`，按家合并 |
| A4 | `src/shared/paths.ts:15-17、85-90、137-139` | `ResolvePathsInput.claude/agy/codex`、`HubPaths.claudePath/agyPath/codexPath`，直接用 `ENV_CLAUDE/ENV_AGY/ENV_CODEX` | 加一家要加两个字段、一行解析；`resolveVendorExecutables`（`paths.ts:245`）靠模板类型 `` `${AgentVendor}Path` `` 才凑上。`VendorSpec.envVar`（`vendors.ts:79`）其实已经有了但这里没用它。改成 `vendorPaths: Record<AgentVendor, string>`，按 spec 循环 |
| A5 | `src/shared/limits.ts:401-403` | `ENV_CLAUDE / ENV_AGY / ENV_CODEX` 三个常量 | 每家一个常量。改成 spec 里 `cli.envVar`（约定 `AGENT_HUB_<大写编号>`，契约测试查） |
| A6 | `src/shared/limits.ts:244-251、256-257` | `AGY_DENIED_CONTINUE_MAX`、`AGY_CONNECTOR_*`、`CODEX_OPTIONAL_RPC_GRACE_MS` | 只有一家用的可调数放在公共 limits。见第 9 节拍板点 3 |
| A7 | `src/shared/vendors.ts:134-136、628-661` 和 `src/shared/paths.ts:332-356` | agy 的数据目录 `agyCliDataDir / agyDataPaths / agyHomePaths` **写了两份**（一份纯字符串、一份 `node:path`） | 厂商专属路径放在公共文件里，而且重复。收进 `src/vendors/agy/` |
| A8 | `src/shared/vendors.ts:778-784` | `inferVendorFromRaw`：三条正则 `/agy\|antigravity/`、`/codex\|openai\|chatgpt/`、`/claude\|anthropic/` | 新厂商的报错认不出是谁的。改成 spec 的 `failure.rawHint` |
| A9 | `src/shared/vendors.ts:616-626` | `readonlyNeedsSandboxMessage`、`READONLY_AGY_NEEDS_SANDBOX_MESSAGE` | 生产代码已经不用（`workers.ts:478` 现在对所有 Worker 一律要求 OS 沙箱，agy 驱动用的是 `readonly-agy.ts:21` 那份），只剩 `vendors.test.ts` 在测。删掉 |
| A10 | `src/shared/driver.ts:505-506` | 公共的 `DriverOptions.claudePath` | 别家都 `Omit<DriverOptions, "claudePath">` 再自己加（`base-driver.ts:209-210`、`codex-driver.ts:122-125`、`vendors/index.ts:31-32`），codex 还“没传 codexPath 就退回 claudePath”（`codex-driver.ts:149`）。改成公共的 `executablePath` |
| A11 | `src/daemon/driver/base-driver.ts:47-49、383-388` | 公共基类 import 三家的 composer，写死 `{ claude, agy, codex }` 表 | 公共基类认识每一家。改成由注册表把 composer 传进来（`opts.composer` 已经有，去掉默认表） |
| A12 | `src/daemon/driver/protocol.ts:322-340` | `PARENT_SESSION_ENV`（`CLAUDECODE`、`CLAUDE_CODE_*`…），`buildChildEnv` 给**所有厂商**的子进程用 | 只去掉了 claude 的“父会话”变量；新厂商（或 codex、agy）自己的父会话变量不会被去掉。改成各家 `cli.parentSessionEnv` 的并集。另外这个文件名义上是“claude 协议”，却放着三家共用的 `buildChildEnv / userContent / mergeUserTexts`（`agy-protocol.ts:14`、`handover/codex.ts:15` 都从这里引），要拆开 |
| A13 | `src/daemon/setup/setup.ts:29-32` | 准备命令的环境变量只去掉 `ANTHROPIC_*`、`CLAUDE_CODE_*` 等 claude 的凭据 | 别家的 API 密钥会原样进准备命令（准备命令跑的是仓库里的脚本）。改成各家 `cli.credentialEnv` 的并集。codex、agy 具体是哪几个变量名**未核实**，要查官方文档后写进各自 spec（行为变化，见第 9 节拍板点 4） |
| A14 | `src/daemon/prompt.ts:52-55、385、416` | `needsAgentsNote`：“有 CLAUDE.md 时 claude 不读 AGENTS.md”，对所有厂商一样加“先读 AGENTS.md” | 这是 claude 的规则。改成 spec 的 `prompt.instructionFile`（这家优先读的说明文件），只有它遮住 AGENTS.md 时才加 |
| A15 | `src/shared/policy.ts:35、87-90` 和 `src/daemon/launch.ts:85-99` | `WORKER_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }` 给所有厂商的 Worker；每个会话都生成一份 claude 格式的 `settings.json` | agy、codex 不读这个文件（`protocol.ts:314` 只有 claude 拼 `--settings`），新厂商也会白拿一份 claude 设置。改成厂商可选钩子 `daemon.launchFiles`，只有要的那家生成 |
| A16 | `src/shared/step-labels.ts:4、37-122` | `TOOL_TEXT`、`TOOL_CATEGORY` 按三家原样工具名列文案；`describeMcpTool` 只认 claude 的 `mcp__` 前缀 | 文件头自己写了“这是写死了厂商的”。新厂商的工具全显示成 `Using xxx`、统计算“认不出”。改成各家 spec 把工具名翻成通用动作，这里只按通用动作出文案 |

另外几处小的、和上面同一类（并入对应条目，不单独计数）：`src/daemon/driver/process.ts:36-43` 的 `claudeOfSession`（只有 claude 驱动用，放在公共 process.ts，并入 C1）；`src/daemon/driver/persona-note.ts:12` 的 `CODEX_RESUME_REBAKES`（codex 专属常量放公共文件，改成能力位 `resumeRebakesSystemPrompt`，并入第 3 节能力位）；`src/daemon/driver/index.ts:2-4`、`src/daemon/vendors/index.ts:97-109` 的三家导出和 `LEGACY_COMPOSER_CREATORS`（并入 B6）。

### 1.3 表 B：按家登记表（9 条，现在一家一项、分散 7 个文件）

| # | 位置 | 登记了什么 |
|---|---|---|
| B1 | `src/shared/vendors.ts:6` | `AGENT_VENDORS = ["claude", "agy", "codex"]` |
| B2 | `src/shared/vendors.ts:177-358` | `VENDOR_SPECS`（界面名、模型、思考程度、额度、命令拦截、提示词用的工具名……） |
| B3 | `src/shared/vendors.ts:157-175` | `VENDOR_HOME_PATHS`（配置目录、密钥文件、模型缓存指纹文件） |
| B4 | `src/shared/vendors.ts:732-776` | `VENDOR_FAILURE_SIGNS`（三家内容几乎一样，只差 `<厂商>_not_found` 和服务名） |
| B5 | `src/shared/paths.ts:208-237` | `VENDOR_FALLBACK_PATHS` + 三个 `default*FallbackPaths` |
| B6 | `src/daemon/vendors/index.ts:8-25、51-74` | `DAEMON_VENDORS`（composer、probe、catalog、createDriver）+ 8 行 import |
| B7 | `src/daemon/handover/forkers.ts:3-12` | `FORKERS`（换会话复制的办法） |
| B8 | `src/daemon/driver/write-scope.ts:564-571` | `WRITE_SCOPE_ENFORCERS` + `AGY_SANDBOX_OFF_ARGS` |
| B9 | `src/daemon/driver/transcript.ts:131-139` | `vendorTranscriptPath` 的 finders 表；以及 `src/shared/paths.ts:270-273` 的 `VENDOR_CONFIG_HOME`（只 codex 有，`Partial`，漏了不报错） |

### 1.4 表 C：本来就该每家一份（10 条，只搬家不改逻辑）

| # | 现在的位置 | 内容 |
|---|---|---|
| C1 | `src/daemon/driver/claude-driver.ts`、`protocol.ts` 的 claude 部分（`buildClaudeArgs` 等）、`process.ts:36-43` | claude stream-json 协议 |
| C2 | `src/daemon/driver/agy-driver.ts`、`agy-protocol.ts` | agy stream-json 协议 |
| C3 | `src/daemon/driver/codex-driver.ts`、`codex-protocol.ts` | codex app-server JSON-RPC 协议 |
| C4 | `src/daemon/vendors/claude.ts`、`claude-catalog.ts`、`agy.ts`、`codex.ts` | "/" 命令、`@` 文件写法、登录状态判断 |
| C5 | `src/daemon/driver/model-catalog.ts:39-48、67-262、265-640` | 三家各自的“问模型名单”和解析（`parseInitializeModels`、`parseAgyModels`、`parseCodexModels`、`query*`）**和通用缓存引擎 `createModelCatalogs`（:727 起）混在一个文件** |
| C6 | `src/daemon/handover/claude.ts`、`agy.ts`、`codex.ts` | 换会话复制（`--fork-session`、拷 sqlite、`thread/fork`） |
| C7 | `src/daemon/driver/claude-readonly.ts`、`src/shared/claude-readonly-settings.ts`、`readonly-agy.ts`、`agy-connectors.ts`、`codex-protocol.ts:238-300` | 只读的各家翻译 |
| C8 | `src/daemon/driver/transcript.ts:37-128` | 三家原始记录的位置 |
| C9 | `src/shared/vendors.ts:110-132、178-357` | 三家的拦截原因文案、模型名单、`shortModelName` |
| C10 | `src/shared/vendors.ts:263-274`（agy 的 `/usage` 解析配置）、`codex-protocol.ts` 的 `parseCodexRateLimits` | 额度 |

### 1.5 表 D：测试、脚本、文档（8 条）

| # | 位置 | 问题 |
|---|---|---|
| D1 | `test/e2e/harness.ts:146-148` | 只把 agy、codex 指到不存在的路径；新厂商的**真程序**会被端到端测试起起来。改成按名单循环 |
| D2 | `test/smoke/kit.ts:68-96` | 收尾删原始记录按 `row.vendor === "codex" / "agy"` 分支。改成调各家 `daemon.removeTranscript`（可选，缺了不删） |
| D3 | `src/shared/vendor-guard.test.ts:61-64` | 守卫正则写死 `(claude\|codex\|agy)`：**新厂商不受守卫保护**。改成从名单生成 |
| D4 | `src/shared/vendors.test.ts:36`、`src/daemon/multi-vendor.test.ts:330` | 断言名单就是这三家（保留，作为迁移前后不变的快照） |
| D5 | `src/daemon/driver/write-scope.test.ts:81-83` | 逐家断言 `ownSandboxOffArgs`（迁到各家文件夹的测试里） |
| D6 | `scripts/provision-linux.sh:34-36、240` | 安装命令、登录命令写死三家。改成读 spec 的 `cli.installCommand / loginCommand`（脚本调一个小的 `node scripts/print-vendors.ts`） |
| D7 | `AGENTS.md`、`CLAUDE.md` 的 pstack 一节 | 写的是三家各自从哪读 `.agents/skills`；新厂商要补一句（文档，不影响代码） |
| D8 | `test/fake-claude/`、`src/daemon/driver/test-helpers.ts:122` | 只有 claude 有假程序；新厂商的驱动测试要自带假程序或录制回放（见 5.3） |

### 1.6 已核实没问题的

- **网页 `src/web`**：只有注释提到厂商名。代码都按名单循环：`selectors.ts:152`（`QUOTA_VENDORS`）、`selectors.ts:381`（`fetchedQuotaUsage`）、`selectors.ts:398-402`、`models.tsx:81`（打包名单）、`AgentRows.tsx:104`。
- **`apps/macos`**：0 处。
- **`src/hub`**、`ledger/hub-commands.ts:12,32`、`shared/worker-pick-schema.ts:16`：用 `AGENT_VENDORS` / `isAgentVendor`，不写死。
- **数据库**：`migrations/0001_init.sql:34`、`0006_agent_settings.sql:7,18-19` 只有 `DEFAULT 'claude'`，没有 `CHECK (vendor IN …)`，加厂商不用迁移。
- **已经插件式、只差搬家的**：`handover/forker.ts`（`SessionForker` 接口）、`vendors/types.ts`（`VendorComposerBase`、`VendorCatalogProbe`）、`model-catalog.ts:645-662`（`VendorCatalogSource`）、`shared/readonly-policy.ts:96`（`connectorToolAllowed`，三家共用）、`driver/write-scope.ts:45`（`WriteScopeEnforcer`）。

### 1.7 顺带发现的问题（迁移时一起修，单独列出便于验收）

1. `daemon.ts:342`：codex 驱动问默认模型调 `models.list()`，没带 `{ vendor }`，第一次起 codex 会话会把**所有厂商**的名单都问一遍。改成 `models.list({ vendor })`。
2. `paths.ts` 没用 spec 里已有的 `envVar`（A4），两处写法可能对不上。
3. A3 的“只认第一家”、A9 的死代码、A7 的重复实现、A13 的凭据漏去。

---

## 2. 对标 t3code

t3code 是同类开源产品，接了 codex、claude、cursor、grok、opencode、antigravity、kiro、pi、muse、fx 十家，外加 ACP Registry 里的任意 agent。它的“加一家”说明在 `t3:docs/internals/adding-a-provider.md`。

### 2.1 它的结构

- **一家一个包**：`t3:packages/provider-<名字>/`，参考实现是 Pi（`t3:docs/internals/adding-a-provider.md:104-109`）。老的 codex、claude、antigravity 还没搬完，仍在 `t3:apps/server/src/provider/` 下（`ClaudeProvider.ts`、`CodexProvider.ts`、`AntigravityProvider.ts` 等 80 多个文件）。
- **分入口**（`t3:packages/provider-pi/package.json` 的 `exports`）：`./settings`（设置的 schema）、`./client`（界面名、图标，**必须浏览器和 React Native 都能用**）、`./server`（driver）、`./testing`（`t3:docs/internals/adding-a-provider.md:110-115`）。
- **接口**：`ProviderDriver { driverKind, metadata, configSchema, defaultConfig, create, usage? }`（`t3:packages/provider-core/src/server/driver.ts:105-116`）；`create` 返回 `ProviderInstance { snapshot, refreshModels?, invalidateCaches?, orchestrationAdapter, textGeneration, auth?, … }`（同文件 :35-78）。注释写着“Failures become unavailable snapshots; never throw defects”（:111）。
- **能力位 + 退化策略**：`t3:docs/orchestration-v2/provider-capability-system.md`，11 组能力（session、thread、turn、streaming、tools、approvals、planning、subagents、context、checkpointing、identity），:216-248 逐条写“缺了怎么退”（fork 不支持 → 用文字摘要做交接；主动插话不支持 → 打断后重发……）。说明里强调“A capability left on that fails at runtime is a bug”（`adding-a-provider.md:24-28`）。
- **会话恢复是必需的，不是能力位**：“Provider-thread resumption is not a capability. It is a required adapter primitive.”（`provider-capability-system.md` 的 Session Capabilities 一节）。
- **状态探测**：先给一份不起进程的初始快照，再在后台起探测（`t3:packages/provider-core/src/server/managedProvider.ts:45、71、326`）；之后每 5 分钟后台刷新（`t3:packages/contracts/src/settings.ts:1066` 的 `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL`）；状态快照**落盘**，重启后先用旧的（`t3:apps/server/src/provider/providerStatusCache.ts:14`）。硬规定：后台探测不许开会打开 MCP、跑钩子、弹登录的会话（`adding-a-provider.md:44-45`，`providers.md:52-57`）；登录状态看不出就报 unknown，不当已登录（`adding-a-provider.md:102`）。
- **ACP 通用接入**：遵守 ACP（Agent Client Protocol，agentclientprotocol.com）的 agent 走一个通用适配器，**不写任何按 agent 的代码**；只有规范覆盖不到的行为才单独做一个“薄的 flavor”，比如 Grok、Antigravity（`adding-a-provider.md:10-17`；`t3:docs/user/providers-acp.md`）。用户还能在设置里直接加“本地 ACP 命令”，填可执行文件和参数就能用。
- **测试**：真厂商录下来的对话做回放，所有厂商跑同一组场景 `simple、multi_turn、queued_turn、turn_interrupt、message_steering、provider_thread_resume`、审批类（`adding-a-provider.md:59-63`），公共测试工具在 `t3:packages/provider-testing/`（`fakeCli.ts`、`replayTranscript.ts`）。
- **凭据隔离**：启动环境去掉这个实例没配置的环境凭据（`adding-a-provider.md:41-43`；`providers.md` 写 Antigravity “removes ambient Google credentials”）。

### 2.2 它加一家要动几处

照 `adding-a-provider.md:119-128`：新包 + `t3:apps/server/src/provider/builtInDrivers.ts:33-45`（driver 列表）+ 同文件 :58-69（额度列表，可选）+ `providerStatusCache.ts:30-39`（显示顺序，写死名字的数组）+ `model-manifest.json` + contracts 里的默认模型 + `t3:packages/client-runtime/src/providerClients.ts`（网页、手机的界面登记）+ 设置搜索词 + 文档。**约 6～7 处登记**。

### 2.3 它公共代码里还有没有写死厂商名

有，而且不少。它的文档说“Orchestration and clients read capabilities, never the driver kind”（`adding-a-provider.md:20-21`），但代码没做到，也没有 lint 规则拦（`t3:oxlint-plugin-t3code/rules/` 里没有这一条）：

- 编排层：`t3:apps/server/src/orchestration-v2/Orchestrator.ts:1174`（`driver === "codex" || driver === "claudeAgent"`）、`ProviderTurnStartService.ts:845`、`IdleCompactionService.ts:41-42`、`NativeChildWorkQuery.ts:67`；
- 网页：`t3:apps/web/src/modelSelection.ts:51、86、285`、`composerDraftStore.ts:948、1130、1160`、`components/ChatView.tsx:3547`；`apps/web/src` 下 36 个非测试文件有厂商名字面量。

### 2.4 逐个设计点：它怎么做、我们怎么做

| 设计点 | t3code | 我们 | 相同/不同的理由 |
|---|---|---|---|
| 一家一个目录 | 一个 workspace 包 `packages/provider-<名>`（`adding-a-provider.md:104`） | 一个文件夹 `src/vendors/<名>/` | **相同**。我们是单包仓库，用文件夹不用 workspace 包；边界靠守卫测试（不许跨家 import、spec.ts 不许引 node） |
| 网页能用的部分单独一个入口 | `./client` 必须浏览器安全（`adding-a-provider.md:110-113`） | `spec.ts` 必须浏览器安全，`daemon.ts` 只给守护进程 | **借鉴**。原定放 `src/daemon/vendors/<名>/` 会让网页从 daemon 目录引代码，所以**改成 `src/vendors/<名>/`**（这是本方案相对任务原定结构的唯一改动） |
| 登记几处 | 6～7 处（2.2） | 名单 1 处（`registry.ts`），守护进程侧按约定路径加载 | **不同，比它少**。它的显示顺序数组、额度列表、网页登记都是第二份名单，正是我们要消灭的东西 |
| 厂商编号的类型 | 开放的品牌字符串 `ProviderDriverKind`（`t3:packages/contracts/src/providerInstance.ts:17`） | 从名单推出的联合类型 `AgentVendor` | **不同**。它支持用户运行时加 ACP 实例，必须开放；我们的厂商都是代码里的，联合类型能让编译器查漏 |
| 接口形状 | `ProviderDriver.create → ProviderInstance`，可选方法 `refreshModels?`、`auth?`、`usage?` | `VendorDaemon`：必需 `createDriver`，其余可选（3.3） | **相同思路**：必需的少、可选的有兜底。它的 `metadata.supportsMultipleInstances`（多账号）我们不需要 |
| 能力位 | 11 组能力位 + 退化策略表 | `spec.capabilities`，只列我们真用到的 6 个（3.2），每个配兜底（第 4 节） | **借鉴做法，不照抄全表**。它的 rollback、subagent、plan 卡片我们没有对应功能，加了也没人读 |
| 公共代码不认厂商名 | 文档要求，代码没做到，无 lint（2.3） | 已有 `vendor-guard.test.ts`，迁移后正则从名单生成、范围扩到全仓（含网页、测试工具） | **我们更严**。它的现状正好说明光靠文档守不住 |
| 状态探测时机 | 后台每 5 分钟轮询 | 有人要时才问 + stat 指纹变了立即重问（`model-catalog.ts:715-726`） | **不同，保持我们的**。10 家时轮询 = 每 5 分钟起 10 个进程；按需 + 指纹在不用时零开销 |
| 探测不能有副作用 | 不开会话、不连 MCP、不跑钩子（`providers.md:52-57`） | claude 问名单用 `INITIALIZE_QUERY_ARGS`（不跑钩子、不连 MCP，见 `vendors/claude.ts:4`）；codex 起 app-server 只发 `model/list`、`account/read` | **相同**，写进契约：`catalog.query` 不得打开会话 |
| 探测结果落盘 | `providerStatusCache.ts` 写 JSON，重启先用旧的 | 现在只在内存（`createModelCatalogs`） | **借鉴**（第 5 步）：重启后首屏直接有名单和状态，后台再刷新 |
| 登录看不出 | 报 unknown，不当已登录（`adding-a-provider.md:102`） | `VendorAvailability` 的 `unknown`，当能用（`vendors.ts:666-689`） | **相同** |
| 会话恢复 | 必需原语 | `Driver.start` 必须能 `--resume` / `thread/resume`，契约测试测 | **相同** |
| 复制原对话 | `canForkThread` 能力位；不支持就文字摘要交接（`t3:docs/internals/context-handoffs.md`） | `daemon.forkers` 可选；空或全部 `ForkUnsupportedError` → 在本会话里写交接（`handover/forker.ts`、`ledger/handover.ts` 已有） | **相同** |
| 只读 / 权限 | 只提供厂商原生能强制的模式；“Do not imitate a missing mode by answering approvals”（`adding-a-provider.md:29-35`） | 原生（claude 设置、codex sandboxPolicy）优先；没有原生的（agy）用外层只读 OS 沙箱 + 连接器拦截兜底，没有 OS 沙箱就拒绝派 | **大体相同**：都优先原生。我们多一层 OS 沙箱，比“替 agent 回审批”更硬，所以保留兜底，但能力位如实写 `os_sandbox` |
| 环境凭据 | 去掉实例没配的凭据（`adding-a-provider.md:41-43`） | 现在只去 claude 的（A13） | **借鉴**：每家 spec 声明自己的凭据变量，公共代码取并集 |
| 通用协议 | ACP 通用适配器，按 agent 写代码是禁止的（`adding-a-provider.md:10-17`） | 现在没有 | **借鉴**（可选第 6 步）：做一个通用 ACP 驱动当“通用做法”，支持 ACP 的新厂商只写 spec。我们三家现有的原生驱动不换（codex app-server、claude stream-json 给的信息比 ACP 多） |
| 测试 | 录制回放 + 所有厂商同一组场景 | 契约测试（5.3）：静态契约现在就做；驱动行为场景照它的场景名做 | **借鉴**场景清单和“假 CLI”做法 |

**结论**：t3code 的“一家一个包、分 client/server 入口、能力位 + 退化表、ACP 通用接入”都比我们原定的好或者我们没有，直接借鉴；它“多处登记”“公共代码仍写死厂商名”“后台轮询”三点不如我们的目标，不照搬。原定的“一家一个文件夹”保留，只把位置从 `src/daemon/vendors/<名>/` 改到 `src/vendors/<名>/` 并拆成 `spec.ts` / `daemon.ts` 两个入口。

---

## 3. 目标结构

### 3.1 文件夹

```text
src/vendors/
  registry.ts          名单（唯一要改的一处）：import 各家 spec，按顺序列出
  types.ts             VendorSpec、VendorCapabilities（纯类型，网页也引）
  daemon-types.ts      VendorDaemon（只给守护进程）
  daemon-registry.ts   按名单加载 ./<id>/daemon.ts（加厂商不用改）
  contract.test.ts     契约测试：名单里每一家跑同一套
  _common/             通用兜底实现
    composer.ts          没有 "/" 命令列表时的通用 composer（只认前缀、隐藏名单、compact）
    mcp-tools-probe.ts   自己问 MCP 服务器 tools/list 拿 readOnlyHint（由 agy-connectors.ts 泛化来）
    acp/                 （可选第 6 步）通用 ACP 驱动
  claude/
    spec.ts            配置：纯数据 + 纯函数（shortModelName 等），不许 import node:*
    daemon.ts          export default defineVendorDaemon({...})
    driver.ts protocol.ts process.ts      ← driver/claude-driver.ts、protocol.ts 的 claude 部分、process.ts:36-43
    catalog.ts composer.ts                ← vendors/claude.ts、claude-catalog.ts、model-catalog.ts 的 claude 部分
    handover.ts transcript.ts readonly.ts readonly-settings.ts
    *.test.ts
  agy/      同上，另有 connectors.ts、paths.ts（agyDataPaths 唯一一份）
  codex/    同上，另有 paths.ts（codexHomeDir）
```

公共代码留在原处，只认接口：`shared/vendors.ts`（`checkModel`、`agentLaunchArgs`、`modelLabel`……这些通用函数，改成读 `registry.ts`，导出名不变，调用方不动）、`daemon/driver/base-driver.ts`、`multi-driver.ts`、`model-catalog.ts`（只剩通用缓存引擎）、`write-scope.ts`（只剩通用 OS 沙箱）、`handover/forker.ts`、`runner.ts`、`transcript.ts`（只剩按家分发）。

### 3.2 网页也能引的部分：`src/vendors/types.ts`（草稿）

```ts
// 只放类型和纯函数，网页、hub 命令行、守护进程都引；不许 import node:* 或 src/daemon（守卫测试查）。
import type { ComposerSpec, FailureKind, FetchedQuotaSpec, QuotaWindowKey, ToolCategory } from "../shared/index.ts";

/** 工具的通用动作：公共的状态文案、统计只认这些，不认厂商的工具名。 */
export type ToolAction = "command" | "read" | "edit" | "search" | "web" | "skill" | "subagent" | "todo" | "other";

export interface VendorCapabilities {
  /** 命令跑完能自己开新一轮叫醒 agent（现 backgroundCommands）。false：提示词让项目经理把长命令派给 Worker。 */
  backgroundWake: boolean;
  /** 恢复会话时会换用新的系统提示词（现 persona-note.ts:12 的 CODEX_RESUME_REBAKES）。false：恢复后第一条消息补性格设定说明。 */
  resumeRebakesSystemPrompt: boolean;
  /** 只读 Worker 怎么落实：settings=厂商设置文件原生沙箱；driver=协议里的原生只读参数；os_sandbox=外层只读 OS 沙箱兜底。 */
  readonly: "settings" | "driver" | "os_sandbox";
  /** 包进 OS 沙箱时要关掉厂商自带沙箱的参数（macOS 沙箱不能嵌套；现 write-scope.ts:565 的 AGY_SANDBOX_OFF_ARGS）。 */
  ownSandboxOffArgs?: readonly string[];
  /** 未选模型时把名单里的默认模型显式传给驱动（现 explicitDefaultModel，codex 要）。 */
  explicitDefaultModel?: boolean;
}

export interface VendorSpec<Id extends string = string> {
  /** 存进 agent_sessions.vendor、pms.vendor，发布后不改。 */
  id: Id;
  label: string;
  cli: {
    /** 默认可执行文件名；也用于提示词里“严禁直接调 CLI”的列表。 */
    command: string;
    /** 覆盖路径的环境变量，约定 AGENT_HUB_<大写 id>（契约测试查）。 */
    envVar: string;
    /** PATH 里找不到时去哪找（现 paths.ts 的 default*FallbackPaths）。不写 = 只认 PATH。 */
    fallbackPaths?: (userHome: string, platform: string) => string[];
    loginCommand: string;
    /** provision-linux.sh 装它用的命令。不写 = 脚本跳过、提示手动装。 */
    installCommand?: string;
    /** 起子进程前要去掉的“父会话”变量（现 protocol.ts:322 只有 claude 的）。 */
    parentSessionEnv?: readonly string[];
    /** 这家的凭据变量：准备命令（setup.ts）一律去掉。 */
    credentialEnv?: { names?: readonly string[]; prefixes?: readonly string[]; pattern?: RegExp };
  };
  home: {
    dirs: readonly string[];
    readonlySecrets: readonly string[];
    catalogWatchPaths: readonly string[];
    /** 配置根目录能被环境变量改位置的（codex 的 CODEX_HOME）。 */
    configHomeEnv?: { rel: string; env: string };
  };
  models: {
    bundled: readonly { id: string; label: string; efforts?: readonly string[] }[];
    customModel: boolean;
    customModelExample: string;
    efforts: readonly string[];
    effortInModelId?: boolean;
    flags: { model: string; effort: string };
    shortName?: (model: string) => string | null;
  };
  quota?: { name: string; windows: readonly QuotaWindowKey[]; warningStatus?: string; fetched?: FetchedQuotaSpec };
  composer: ComposerSpec;
  prompt: {
    subagentTools: readonly string[];
    backgroundCommandTool: string;
    /** 这家优先读的说明文件，会遮住 AGENTS.md 的才写（claude："CLAUDE.md"）。 */
    instructionFile?: string;
    /** 换厂商写交接时提醒“别写只有这家才有的工具”的例子（现 ledger/handover.ts:91 写死）。 */
    vendorOnlyTools?: string;
  };
  failure: {
    serviceName: string;
    /** 原文里认出是这家的特征（现 vendors.ts:779-783）。 */
    rawHint?: RegExp;
    /** 不写用通用的（COMMON_*_PATTERN + `<id>_not_found`）。 */
    signs?: readonly { kind: FailureKind; pattern: RegExp }[];
  };
  /** 工具名 → 通用动作（现 step-labels.ts 的 TOOL_TEXT、TOOL_CATEGORY）；不写全显示 “Using <名>”。 */
  tools?: {
    actions: Readonly<Record<string, ToolAction>>;
    /** 连接器工具名怎么拆（claude：mcp__服务器__工具）。不写按 mcp__ 前缀认。 */
    connectorName?: (name: string) => { server: string; tool: string } | null;
  };
  handover: {
    tokenThreshold?: number;
    /** 原始记录别家能不能读（agy 是 sqlite，false）。 */
    transcriptPortable: boolean;
  };
  capabilities: VendorCapabilities;
}

export function defineVendor<const Id extends string>(spec: VendorSpec<Id>): VendorSpec<Id> {
  return spec;
}
```

### 3.3 守护进程侧：`src/vendors/daemon-types.ts`（草稿）

现有的接口（`VendorComposerBase`、`VendorCatalogProbe`、`SessionForker`、`Driver`）原样复用，这里只是把它们收到一个对象里。

```ts
import type { ComposerCommand, Driver, DriverOptions, LaunchFiles, QuotaResponse, VendorAvailability } from "../shared/index.ts";
import type { CommandsTarget, VendorCatalogProbe, VendorComposerBase } from "../daemon/vendors/types.ts";
import type { SessionForker } from "../daemon/handover/forker.ts";
import type { TranscriptRef, TranscriptRoots } from "../daemon/driver/transcript.ts";

/** 守护进程给每家的东西：解析好的可执行文件、用户主目录、环境变量。 */
export interface VendorRuntime {
  executablePath: string;
  userHome: string;
  env: NodeJS.ProcessEnv;
}

export interface VendorDaemon {
  /** 必需：会话驱动（启动、恢复、发消息、打断、结束、清残留）。 */
  createDriver(deps: DriverOptions & { executablePath: string; defaultModel?: () => Promise<string | null> }): Driver;

  /** 可选：输入框。缺了用 _common/composer.ts（只认 spec.composer 的前缀、隐藏名单、compact）。 */
  composer?: {
    base?: Partial<VendorComposerBase>;
    /** 会话没在跑时问命令列表；缺了只列 compact。 */
    queryCommands?(target: CommandsTarget, signal: AbortSignal, rt: VendorRuntime): Promise<ComposerCommand[]>;
  };

  /** 可选：模型名单和登录状态，同一次查询。不得打开会话、连 MCP、跑钩子。缺了用打包名单，状态靠装没装 + 真跑的结果。 */
  catalog?: {
    query(signal: AbortSignal, rt: VendorRuntime): Promise<unknown>;
    probe: VendorCatalogProbe;
    /** probe 给 unknown 时的补充判断（读凭据文件、跑 `auth status`）。 */
    confirm?(signal: AbortSignal, rt: VendorRuntime): Promise<VendorAvailability>;
  };

  /** 可选：事件流里没有额度、要另起进程问的（agy 的 `-p /usage`）。事件流里有的由驱动直接报，不用写这个。 */
  quota?: { query(signal: AbortSignal, rt: VendorRuntime): Promise<QuotaResponse> };

  /** 可选：换会话复制原对话的办法，按顺序试。缺了 = []，在本会话里写交接。 */
  forkers?: readonly SessionForker[];

  /** 可选：原始记录在哪。缺了 = null，交接里不给路径。 */
  transcriptPath?(ref: TranscriptRef, roots: TranscriptRoots): string | null;
  /** 可选：冒烟测试收尾删这次会话的原始记录。 */
  removeTranscript?(ref: TranscriptRef, roots: TranscriptRoots): string[];

  /** 可选：启动前要生成的厂商专属文件（claude 的 settings.json）。缺了不生成。 */
  launchFiles?(input: { role: "pm" | "worker"; readonly: LaunchFiles["readonly"]; hubSock: string; stateDir: string; osSandboxed: boolean; denyWrite: string[] }): { settings?: string; env?: Record<string, string> };

  /** 可选：只读时拿不到连接器工具注解的厂商，给出它的 MCP 配置位置，由 _common/mcp-tools-probe.ts 自己问（现 agy-connectors.ts）。 */
  connectorConfig?(rt: VendorRuntime): { file: string; parse(text: string): Record<string, unknown> } | null;
}

export function defineVendorDaemon(daemon: VendorDaemon): VendorDaemon {
  return daemon;
}
```

### 3.4 名单只在一处

```ts
// src/vendors/registry.ts —— 加厂商只改这里
import agy from "./agy/spec.ts";
import claude from "./claude/spec.ts";
import codex from "./codex/spec.ts";

/** 顺序 = 下拉、额度面板里的顺序；第一个是默认厂商。 */
export const VENDOR_LIST = [claude, agy, codex] as const;
export type AgentVendor = (typeof VENDOR_LIST)[number]["id"];
```

```ts
// src/vendors/daemon-registry.ts —— 加厂商不用改：按约定路径加载，契约测试保证每家都有 daemon.ts
import { VENDOR_LIST, type AgentVendor } from "./registry.ts";
import type { VendorDaemon } from "./daemon-types.ts";

export const VENDOR_DAEMONS: Readonly<Record<AgentVendor, VendorDaemon>> = Object.fromEntries(
  await Promise.all(VENDOR_LIST.map(async (s) => [s.id, (await import(`./${s.id}/daemon.ts`)).default as VendorDaemon])),
) as Record<AgentVendor, VendorDaemon>;
```

- 守护进程是 Node ESM（`node src/daemon/main.ts`），支持顶层 await 和带 `.ts` 的动态 import；网页只引 `registry.ts`（静态 import，Vite 正常打包），不会碰到 `daemon.ts`。
- `knip` 会把按约定加载的 `daemon.ts` 当没人用：在 knip 配置里加入口 `src/vendors/*/daemon.ts`。
- 现在的 `AGENT_VENDORS`、`VENDOR_SPECS`、`VENDOR_HOME_PATHS`、`VENDOR_FAILURE_SIGNS`、`DAEMON_VENDORS`、`FORKERS`、`WRITE_SCOPE_ENFORCERS`、`VENDOR_FALLBACK_PATHS` 都改成从这两个文件**推出来**的派生值（导出名保留，调用方不动），不再手写一家一项。

### 3.5 公共代码只认接口：迁移后各处怎么写

| 现在 | 迁移后 |
|---|---|
| A1 `fromVendor === "agy"` | `!specOf(fromVendor).handover.transcriptPortable` |
| A3 `AGENT_VENDORS.find(…fetched)` | 每家 `VENDOR_DAEMONS[v].quota`，`/api/quota` 按家合并（响应里每组带 `vendor`） |
| A4 `claudePath/agyPath/codexPath` | `HubPaths.vendorPaths: Record<AgentVendor, string>`，按 `spec.cli.envVar` 循环解析 |
| A11 基类里的 composer 表 | `createVendorDrivers` 把 `VENDOR_DAEMONS[v].composer` 合成好传进去 |
| A12 `PARENT_SESSION_ENV` | `VENDOR_LIST.flatMap(s => s.cli.parentSessionEnv ?? [])` |
| A13 准备命令去凭据 | 现有 claude 那几条 + 各家 `cli.credentialEnv` 的并集 |
| A14 `needsAgentsNote(cwd)` | `needsAgentsNote(cwd, spec.prompt.instructionFile)`，没写 instructionFile 的不加 |
| A15 每个会话写 claude 设置 | `VENDOR_DAEMONS[v].launchFiles?.(…)`，没写的不生成 settings.json |
| A16 `TOOL_TEXT[name]` | `ACTION_TEXT[specOf(vendor).tools?.actions[name] ?? "other"]`；工具步骤事件里带上 vendor（驱动层已知） |
| 守卫正则写死三家 | 从 `VENDOR_LIST` 的 id、`cli.command`、`prompt.subagentTools` 生成 |

---

## 4. 必需 vs 可选能力，缺了怎么退

原则：**优先用厂商自带的功能，自己造的只当兜底**；能力位如实写，公共代码按能力位走，不按厂商名走。

| 能力 | 必需？ | 厂商自带（优先） | 缺了时的通用做法 | 现在已有的兜底代码 |
|---|---|---|---|---|
| 会话驱动（起、恢复、发、打断、结束、清残留） | **必需** | 各家原生协议 | 无（起不来就报 `<id>_not_found` / `spawn_failed`） | — |
| 基本配置（编号、界面名、命令名、环境变量、登录命令、思考程度、模型参数名） | **必需** | — | — | — |
| 装没装 | 不用写 | — | 通用：`findExecutable(command, PATH, fallbackPaths)` 只查文件 | `paths.ts` 的 `findExecutable` |
| 登录状态 | 可选 `catalog.probe` / `confirm` | claude `initialize` 的 account、`claude auth status --json`；codex `account/read` | 通用：报错是 ENOENT → 没装，认证类报错 → 没登录，其余 unknown（当能用）；会话真起来了 / 真报认证失败时直接更新 | `model-catalog.ts:663-667`、`daemon.ts:371-375` |
| 实时模型名单 | 可选 `catalog.query` + `probe.parse` | claude `initialize`、agy `agy --output-format json models`、codex `model/list` | 用 spec 里打包的名单（`source: "bundled"`），下拉里有“自定义”可填完整模型名 | `bundledModelCatalog`（`vendors.ts:539`） |
| 额度 | 可选 | 事件流里报的（claude `rate_limit_event`、codex `account/rateLimits/updated`，驱动直接发）；或厂商的查询命令（agy `-p /usage`） | 不显示这家的额度块；额度用完靠报错特征认成 `quota` 类失败 | `selectors.ts:152` 只列 `quota` 不为空的 |
| "/" 命令列表 | 可选 `composer.queryCommands`，运行中 `Driver.queryCommands` | claude `initialize` 的 commands、codex `skills/list`、agy `-p /skills` | 列表只给 `compact`；手打照样发给 agent（隐藏名单里的照样拦） | — |
| `@` 文件 | 可选 `composer.base.mention` | — | `@path`，带空格写 `@"a b"`（三家都这么认） | `vendors/codex.ts:125` 的写法 |
| 换会话复制原对话 | 可选 `forkers` | claude `--fork-session`、codex `thread/fork`（`ephemeral`） | 在本会话里写交接（agy 现在的 `agy-copy` 是自造的“拷库”，也只当兜底，格式对不上就退到这一步） | `ledger/handover.ts`、`ForkUnsupportedError` |
| 原始记录 | 可选 `transcriptPath`、`handover.transcriptPortable` | — | 交接里不给路径，只给交接 + 原话 | `transcriptLine(null)` |
| 只读 Worker | 能力位 `readonly` | claude 设置文件原生沙箱（`settings`）；codex `sandboxPolicy: readOnly`（`driver`） | `os_sandbox`：外层只读 OS 沙箱（macOS sandbox-exec、Linux bwrap）；连接器用 `_common/mcp-tools-probe.ts` 自己问 `readOnlyHint`，问不到的整个拒；没有 OS 沙箱的机器拒绝派 | `write-scope.ts:544`（`wrapInReadonlyOsSandbox`）、`agy-connectors.ts`、`readonly-agy.ts` |
| 可写范围（普通 Worker） | 不用写 | — | 一律外层 OS 沙箱；没有就拒绝启动 | `spawnInWriteScope`（`write-scope.ts:577`） |
| 长命令后台跑完叫醒 | 能力位 `backgroundWake` | claude `run_in_background` + `task_notification` | 提示词让项目经理把长命令派给 Worker | `prompt.ts:69-70` |
| 一轮中途插话 | 驱动自己报（`Driver.send` 的结果） | claude `capabilities`、codex `turn/steer` | 排队到下一轮 | `base-driver.ts` 待发队列 |
| 性格设定改了 | 能力位 `resumeRebakesSystemPrompt` | — | 恢复后第一条消息前补说明（默认 false，保守） | `persona-note.ts` |
| 换会话阈值 | 可选 `handover.tokenThreshold` | — | `HANDOVER_TOKEN_THRESHOLD`（200k） | `handoverTokenThresholdOf` |
| 错误识别 | 可选 `failure.signs` | — | 通用 `COMMON_*_PATTERN` + `<id>_not_found` | `vendors.ts:727-730` |
| 工具文案 | 可选 `tools.actions` | — | `Using <工具名>`；`mcp__` 前缀的显示 “Calling 服务器 工具” | `step-labels.ts:144-150` |
| 模型简称 | 可选 `models.shortName` | — | 原样显示完整模型名 | `modelShortLabel` |
| 启动专属文件 | 可选 `launchFiles` | — | 不生成 | — |

**最小可跑的新厂商** = `spec.ts`（必需字段，capabilities 全写保守值：`backgroundWake: false`、`readonly: "os_sandbox"`、`resumeRebakesSystemPrompt: false`）+ `daemon.ts`（只有 `createDriver`）。能派项目经理和 Worker、能恢复会话、能只读（有 OS 沙箱的机器上）、能换会话（本会话写交接），下拉里是打包名单。

---

## 5. 迁移步骤

### 5.1 分几个 PR

每个 PR 先加测试（快照、契约）再搬代码；搬家用 `git mv` 保留历史；导出名保留，调用方尽量不动。

| PR | 内容 | 改哪些文件 | 和 #315/#316/#319 冲突 |
|---|---|---|---|
| **P1 测试先行** | 迁移前快照 + 静态契约测试（5.3 的 S1～S10，先跑在现有 `VENDOR_SPECS`/`DAEMON_VENDORS` 上）+ 守卫正则改成从名单生成（D3） | 新增 `src/vendors/contract.test.ts`、`src/vendors/migration-snapshot.test.ts`（存 `VENDOR_SPECS`/`VENDOR_HOME_PATHS`/`VENDOR_FAILURE_SIGNS`/`VENDOR_FALLBACK_PATHS` 序列化结果、三家 × 两种角色的提示词、`agentLaunchArgs` 各组合的输出）；改 `src/shared/vendor-guard.test.ts` | 无 |
| **P2 拆 spec** | 建 `src/vendors/{types,registry}.ts` 和三家 `spec.ts`；`shared/vendors.ts` 的通用函数改读名单，`VENDOR_SPECS` 等改成派生导出；agy、codex 的专属路径搬进各家 `paths.ts`（A7）；删 A9 死代码 | `src/shared/vendors.ts`、`src/shared/paths.ts`（只动 A5/A7/B5/B9 的路径函数，不动 `HubPaths`）、`src/vendors/**`、`src/shared/index.ts`（加一行导出） | `src/shared/index.ts`（#316 也改，各加一行，好合）。**不碰** `limits.ts`（`ENV_*` 先保留，spec 引用它们）、`web/selectors.ts`、`web/models.tsx` |
| **P3 搬 daemon 侧** | 建 `daemon-types.ts`、`daemon-registry.ts`、三家 `daemon.ts`；驱动、协议、composer、名单查询（从 `model-catalog.ts` 拆出各家部分，C5）、交接复制、只读、原始记录（C1～C8）搬进各家文件夹；`DAEMON_VENDORS`、`FORKERS`、`WRITE_SCOPE_ENFORCERS`、transcript finders 改成派生（B6～B9）；基类去掉 composer 表（A11）；`protocol.ts` 拆出通用部分（A12 的拆文件部分）；`DriverOptions.claudePath` → `executablePath`（A10）；顺带修 1.7 第 1 条 | `src/daemon/driver/*`、`src/daemon/vendors/*`、`src/daemon/handover/*`、`src/daemon/daemon.ts`（装配处）、`src/shared/driver.ts`、`src/vendors/**`、对应测试（搬家） | 无（三个分支都不改这些文件；#316 只改 `ledger/workers.test.ts`，P3 不碰账本） |
| **P4 去掉剩下的写死** | A1～A6、A8、A12～A16；`HubPaths` 改 `vendorPaths`；`ENV_*` 从 `limits.ts` 删掉；`/api/quota` 按家合并；e2e harness 和冒烟工具按名单循环（D1、D2）；provision 脚本读 spec（D6）；守卫范围扩到 `src/web`、`test/` | `src/daemon/ledger/handover.ts`、`setup/setup.ts`、`prompt.ts`、`launch.ts`、`shared/policy.ts`、`shared/step-labels.ts`、`shared/limits.ts`、`shared/paths.ts`、`daemon/daemon.ts`、`daemon/ui-server/server.ts`（quota 路由）、`shared/api.ts`（QuotaResponse 加 vendor）、`web/selectors.ts`（`fetchedQuotaUsage`）、`test/e2e/harness.ts`、`test/smoke/kit.ts`、`scripts/provision-linux.sh` | **冲突集中在这一步**：`limits.ts`（#315、#316、#319 都改）、`test/e2e/harness.ts`（#315、#316）、`shared/api.ts`（#315、#316）、`ui-server/server.ts`（#315）、`web/selectors.ts`（#316）。**排在三者合并之后**开工 |
| **P5 性能** | 名单和状态缓存落盘、并发上限（第 6 节） | `src/daemon/driver/model-catalog.ts`、`src/shared/limits.ts`、`src/shared/paths.ts`（缓存文件路径） | `limits.ts`（同上，P4 之后就没有了）；和 #316 的首屏数据要对一下：首屏要不要带名单（见第 9 节拍板点 5）。#319 读名单走 `GET /api/models`，响应形状不变，不冲突 |
| P6（可选） | 通用 ACP 驱动 `src/vendors/_common/acp/`：支持 ACP 的新厂商 `daemon.ts` 一行 `createDriver: acpDriver({ args })` | 新增文件为主 | 无 |

#319 的 `src/web/worker-pick.ts`、`models.tsx` 只读 `ModelCatalog`（`GET /api/models`），P2～P5 都不改这个接口的形状，所以它不用跟着动。

### 5.2 每一步怎么保证行为不变

- P1 落地的快照测试在 P2～P4 每一步都必须原样通过（P4 里 A13、A15 是有意的行为变化，单独改快照并在 PR 里说明）。
- 每个 PR 本机跑：
  - `pnpm typecheck`
  - `pnpm vitest run src/vendors src/shared/vendors.test.ts src/shared/vendor-guard.test.ts src/shared/paths.test.ts src/shared/write-scope.test.ts`
  - P3 加：`src/daemon/driver`（三家驱动测试、`model-catalog.test.ts`、`write-scope.test.ts`、`readonly-*.test.ts`、`transcript.test.ts`、`multi-driver.test.ts`）、`src/daemon/handover`、`src/daemon/vendors`、`src/daemon/multi-vendor.test.ts`
  - P4 加：`src/daemon/ledger/handover.test.ts`、`src/daemon/prompt.test.ts`、`src/daemon/launch.test.ts`、`src/daemon/setup`、`src/shared/step-labels*.test.ts`、`src/web/selectors*.test.ts`、`test/e2e`
  - `pnpm exec knip`（确认搬家后没有遗留的死导出）
- 云端 CI（Ubuntu 4 路）全绿；涉及驱动的 P3、P4 合并前各跑一次真厂商冒烟：`test/smoke/multi-vendor.ts`、`codex-resume.ts`、`write-scope.ts`、`auto-renew.ts`。

### 5.3 契约测试：每家都必须过的同一套

`src/vendors/contract.test.ts` 对 `VENDOR_LIST` 里每一家 `describe.each`，再额外放一个**测试专用的假厂商 `acme`**（只在测试里注册），证明“新文件夹 + 名单一项”真的够用。

静态契约（P1 做，不起进程）：

| # | 查什么 |
|---|---|
| S1 | 名单和文件夹一一对应：每个 id 有 `src/vendors/<id>/spec.ts` 和 `daemon.ts`，`daemon.ts` 默认导出带 `createDriver` |
| S2 | `spec.ts` 浏览器安全：不 import `node:*`、不 import `src/daemon/**`、不 import 别家文件夹 |
| S3 | 编号唯一、只用小写字母数字；`cli.envVar === "AGENT_HUB_" + id.toUpperCase()`；`cli.command` 唯一 |
| S4 | 打包模型都过 `checkModel`；`efforts` 非空；`agentLaunchArgs({ vendor, model: null, effort: null })` 是 `[]` |
| S5 | `home.readonlySecrets`、`catalogWatchPaths` 都在 `home.dirs` 里面 |
| S6 | `composer.blockedCommands` 的键不带 `/`；`compactCommand` 不在隐藏名单里 |
| S7 | `vendorFailureOf("<id>_not_found: …", id)` 认成 `missing`；`rawHint` 不会误认别家的样例报错 |
| S8 | `catalog.probe.parse(null)`、`parse("垃圾")` 返回 null 不抛；`availabilityOf(垃圾)` 在 `VENDOR_AVAILABILITIES` 里 |
| S9 | 所有厂商的 `forkers` 的 `id` 全局唯一（存进 `fork_ref`，重启后要凭它找回） |
| S10 | `transcriptPath` 对不存在的会话返回 null 不抛；`capabilities.readonly === "os_sandbox"` 的厂商在没有 OS 沙箱时派只读被拒 |

驱动行为契约（P3 起，照 t3code `adding-a-provider.md:59-63` 的场景名）：每家提供一个假程序或录制回放（`src/vendors/<id>/fixtures/`），跑同一组场景：`simple`（一轮问答）、`multi_turn`、`queued_turn`（忙时再发）、`turn_interrupt`（停止，含“刚发就停”）、`resume`（重启守护进程后接着聊）、`not_found`（程序不存在报 `<id>_not_found`）、`write_scope`（Worker 包进 OS 沙箱）。claude 已有 `test/fake-claude/`，agy、codex 的驱动测试里已有手写帧，先收成 fixtures；新厂商必须带。

---

## 6. 性能

### 6.1 现在启动时会不会探测

**不会**。现状（`model-catalog.ts:715-726` 注释、`daemon.ts:248-262`）：

- 守护进程启动不问任何厂商；第一次有人要（网页打开资料页、新建弹窗、`hub worker start`）才问，各家**并行**。
- 装没装只 stat 文件（`installed()`），没装的不起进程。
- 问到的名单缓存 6 小时（`MODEL_CATALOG_FRESH_MS`），过期先给旧的、后台再问；没问到的只记 5 分钟（`MODEL_CATALOG_RETRY_MS`）。
- 失效：可执行文件和登录/配置文件的 stat 指纹（`VENDOR_HOME_PATHS.catalogWatchPaths`）变了立即重问，指纹 3 秒内只算一次（`MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS`）；会话真起来了、真报认证失败时直接改状态（`daemon.ts:371-375`）。
- 上限：每家一格（`LRUCache max = AGENT_VENDORS.length`），每家最多 50 个模型（`MAX_CATALOG_MODELS`），单次查询最多 15 秒（`MODEL_CATALOG_TIMEOUT_MS`）。

迁移本身（P2～P4）只是换文件位置和查表方式，全是内存常量和对象属性读取，**不新增任何 I/O 或子进程**。唯一的新开销是 `daemon-registry.ts` 启动时动态 import 各家 `daemon.ts`——和现在 `vendors/index.ts` 的静态 import 加载的是同一批模块，只是换成异步，量级不变（P3 用 `benchmark-checklist` 量启动到 `ui.sock` 可连的时间，前后对比写进 PR）。

### 6.2 厂商多到 10 家时

| 场景 | 现在的表现 | 问题 | 方案（P5） |
|---|---|---|---|
| 第一次打开厂商下拉 | 10 家并行各起一个进程（claude 起完整 CLI 发 `initialize`、codex 起 app-server……） | 瞬时 10 个进程，内存、CPU 尖峰；最慢的一家拖住整个 `GET /api/models`（等 `Promise.all`） | ① 并发上限 `MAX_CONCURRENT_CATALOG_QUERIES = 3`（写进 `limits.ts`，同 `MAX_CONCURRENT_COMMAND_QUERIES = 2` 的做法）；② 网页按家渲染，先回已缓存的，没问到的那家显示“检查中”（响应形状不变：`source: "bundled"`、`availability: "unknown"`） |
| 守护进程重启后 | 内存缓存全丢，首个请求又要问 10 家 | 首屏慢 | 借鉴 t3code `providerStatusCache.ts`：名单 + 状态落盘 `state/vendor-catalogs.json`（每家一项，带指纹和时间）；重启后先用盘上的、指纹对不上的才重问；失败结果不落盘（只记 5 分钟的规则不变） |
| 没装的厂商 | 只 stat，零进程 | 无 | 不变 |
| `hub worker start` 指定某家 | `ensureUsable` 只问这一家 | 无 | 不变；修 1.7 第 1 条（codex 默认模型别问全部） |
| 提示词里列可用厂商 | 只读缓存的状态，不问 | 无 | 不变 |
| `/api/models` 响应大小 | 每家最多 50 模型 | 10 家约 500 项 | 已有 `@fastify/compress`；不用改 |
| 不轮询 | 有人要才问 | 无 | **保持**。t3code 每 5 分钟后台刷新每个实例，10 家就是每 5 分钟起 10 个进程，我们不学 |

验证（照 `CLAUDE.md` 的缓存四件事）：P5 用 10 个假厂商（`acme0`～`acme9`，假程序 sleep 1 秒后回名单）量“首次 `GET /api/models` 耗时、峰值子进程数、峰值 RSS”和“重启后首次耗时”，改前改后写进 PR；守卫测试加一条“落盘缓存文件大小有上限”。

---

## 7. 统一

- **一处定义**：厂商的一切（配置、能力位、驱动、探测、复制、只读、路径、环境变量、工具名翻译）都在 `src/vendors/<id>/`；名单只在 `registry.ts`。现在散在 7 个文件的 9 张一家一项的表全部改成从名单派生（3.4），公共代码里不再有 `Record<AgentVendor, …>` 的字面量。
- **所有厂商共用一套通用逻辑**：模型缓存引擎（`createModelCatalogs`）、可写范围和只读的 OS 沙箱（`write-scope.ts`）、只读连接器判断（`shared/readonly-policy.ts:96` 的 `connectorToolAllowed`，三家已经共用）、交接流程（`ledger/handover.ts` + `SessionForker`）、错误分类（`shared/errors.ts` + spec 的特征）、状态文案（按通用动作）都只有一份，各家只填翻译。
- **连接器不写死**：没有任何地方列连接器名单。只读时判断一律按 MCP 工具自己声明的 `readOnlyHint`（加用户在资料页补的放行/排除）；厂商能把注解带给我们的（claude 的 `mcp_status`、codex 的审批请求）直接用，带不了的（agy）用 `_common/mcp-tools-probe.ts` 读它的 MCP 配置、自己问 `tools/list`——这段现在是 agy 专用（`agy-connectors.ts`），泛化后任何“拿不到注解”的新厂商只要在 `daemon.connectorConfig` 里说配置文件在哪。用户新装的连接器下次启动会话自动生效（清单按配置内容缓存，配置变了失效，`agy-connectors.ts` 现有规则）。
- **工具清单不写死**：状态文案、步骤统计只认通用动作（`ToolAction`）；工具名到动作的翻译在各家 `spec.tools`；没翻译的新工具显示 `Using <名>`、统计里按原名单独计数，不会报错也不用改公共代码。"/" 命令列表一律问厂商要（`initialize`、`skills/list`、`/skills`），我们只维护“要拦下的”名单。技能目录三家共用 `.agents/skills/`（`AGENTS.md` 的 pstack 一节），新厂商能读这个目录就自动有。
- **守住**：守卫测试从名单生成正则，扫全仓（`src/daemon`、`src/hub`、`src/shared`、`src/web`、`test/` 的工具文件），厂商文件夹以外出现任何厂商 id、`cli.command`、`subagentTools` 字面量即失败。t3code 的现状（2.3）说明光写在文档里守不住。

---

## 8. 加第 N 家厂商的操作清单（迁移后，以 `foo` 为例）

**新建**（一个文件夹）：

```text
src/vendors/foo/
  spec.ts          必需：defineVendor({ id: "foo", label, cli: { command: "foo", envVar: "AGENT_HUB_FOO", loginCommand }, home, models, composer, prompt, failure, handover, capabilities })
  daemon.ts        必需：export default defineVendorDaemon({ createDriver })；有就加 catalog / composer / quota / forkers / transcriptPath
  driver.ts        必需：实现 Driver（继承 BaseSessionDriver，只写 foo 的协议翻译）
  protocol.ts      驱动用的纯函数（启动参数、事件解析）
  catalog.ts       可选：问模型名单和登录状态
  composer.ts      可选：问 "/" 命令列表
  handover.ts      可选：foo 自带的复制会话
  fixtures/        必需：契约测试用的假程序或录制回放
  foo.test.ts      foo 专属的单测
```

**改一处**：`src/vendors/registry.ts` 加 `import foo from "./foo/spec.ts";` 并在 `VENDOR_LIST` 里加 `foo`（同一个文件里的一个 import + 名单一项）。

**不用改**：数据库（`vendor` 列没有 CHECK）、网页、Mac App、账本、提示词、组装代码、`limits.ts`、`paths.ts`、e2e 工具、守卫测试、provision 脚本（读 `cli.installCommand`）。

**跑**：`pnpm typecheck`、`pnpm vitest run src/vendors`（契约测试自动多出 foo 一组）、`src/shared/vendor-guard.test.ts`；有真程序时跑一次 `test/smoke/multi-vendor.ts`。

**可选**：`docs/vendors/foo.md` 记实测（命令行参数、事件形状、哪些能力没有），参考现在的 `docs/model-catalog.md`、`docs/composer-commands.md` 的写法；`AGENTS.md` 的 pstack 一节补 foo 从哪读技能。

**如果 foo 支持 ACP**（做了可选的 P6 之后）：`driver.ts`、`protocol.ts` 都不用写，`daemon.ts` 里 `createDriver: acpDriver({ args: ["acp"] })`；模型名单、"/" 命令也从 ACP 会话里拿。哪些厂商命令行支持 ACP **未核实**：t3code 用的是 ACP Registry 里单独的适配程序（`codex-acp`、`claude-acp`、`antigravity-acp`，见 `t3:packages/client-runtime/src/providerClients.ts`），不是我们现在调的 `codex`、`claude`、`agy` 本身。

---

## 9. 要拍板的点（每点带推荐）

1. **文件夹放哪**：任务原定 `src/daemon/vendors/<id>/`；本方案改成 `src/vendors/<id>/`，拆 `spec.ts`（网页也引）/ `daemon.ts`。**推荐改**：网页要读厂商的纯数据（模型名单、额度窗口、简称函数），放 daemon 目录下会让网页依赖 daemon 目录，t3code 也是拆 `./client` / `./server`。
2. **守护进程侧怎么登记**：A 按约定路径动态加载 `./<id>/daemon.ts`（名单一处）；B `daemon-registry.ts` 再静态 import 一行（名单两处，但 knip、跳转定义更直观）。**推荐 A**，契约测试 S1 兜住“漏了 daemon.ts”。
3. **只有一家用的可调数**（`AGY_CONNECTOR_*`、`CODEX_OPTIONAL_RPC_GRACE_MS`）放哪：A 留在 `src/shared/limits.ts`（守“可调的数集中一处”的规矩，但加厂商要改公共文件）；B 放各家 `src/vendors/<id>/limits.ts`。**推荐 B**，同时在 `limits.ts` 文件头写一句“厂商专属的在各家文件夹的 limits.ts”，公共可调数仍集中在 `limits.ts`。
4. **准备命令去掉别家的凭据**（A13）：这是行为变化——用户仓库的准备脚本以后拿不到 `OPENAI_API_KEY` 这类变量（具体变量名待查官方文档）。**推荐做**（和 t3code“去掉没配置的环境凭据”一致），放 P4，PR 里列清楚去掉了哪些。
5. **模型名单要不要进首屏数据**：落盘缓存后，可以把各家的状态（不含模型列表）放进 #316 瘦身后的首屏数据，下拉打开不用再等。**推荐先不放**：P5 只做落盘 + 并发上限，首屏仍按需拉 `GET /api/models`（react-query 缓存），等 #316 合并后量过再决定，避免和 #316 抢同一块。
6. **通用 ACP 驱动（P6）做不做**：**推荐做，但排在 P1～P5 之后、有第四家要接时再做**；先核实那家命令行是否原生支持 ACP。做了以后“支持 ACP 的新厂商只写 spec”。
7. **假厂商 `acme` 放哪**：A 放 `src/vendors/acme/`、只在测试里注册（名单里不出现）；B 放 `test/fixtures/vendors/acme/`。**推荐 B**，生产名单和目录保持干净，契约测试 S1 只扫生产名单。
