# 厂商声明表统一（方案）

目标：将散落在提示词、账本、启动准备、守护进程组装和各驱动文件里的厂商特定知识收拢到统一声明表，业务代码一律按能力字段判断或遍历 `AGENT_VENDORS`，并用 CI 守卫测试防止回潮。行号以 `main@ef52f59` 为准。

## 1. 现状与迁移前后对比

| 散落位置 | 现状（手写厂商分支 / 字面量） | 迁移后（声明表 + 遍历） |
|---|---|---|
| `src/daemon/prompt.ts:60,134,135,265,273` | 手写 `Agent`、`Task`、`spawn_agent`（漏 `invoke_subagent`）、`Bash 工具的 run_in_background`、`agy`/`codex` | 从 `VENDOR_SPECS` 的 `subagentTools`、`backgroundCommandTool`、`cliCommand` 动态拼装 |
| `src/daemon/ledger/workers.ts:358` | `if (readonly && vendor === "agy" && !ctx.osSandboxed())` | `VENDOR_SPECS[vendor].readonlyMode === "os_sandbox"` + `readonlyNeedsSandboxMessage(vendor)` |
| `src/daemon/launch.ts:82` | `session.vendor === "claude"` 判断是否把只读写进 `settings.json` | `VENDOR_SPECS[session.vendor].readonlyMode === "settings"` |
| `src/daemon/daemon.ts:139-141,193,236-240,308-330,421,431-434` | 手写三家路径、驱动、`c.vendor === "codex"` 默认模型、`VENDOR_SPECS.agy.quota?.fetched`、关机步骤名 `"claude"` | `resolveVendorExecutables` + `DAEMON_VENDORS` 循环注册；关机步骤名改为 `"驱动层"`（或 `"driver"`） |
| `handover/agy.ts`、`transcript.ts`、`readonly-agy.ts`、`agy-connectors.ts` | 4 个文件 9 处重复拼接 `.gemini/antigravity-cli` 及子路径 | 集中到 `src/shared/paths.ts` 的 `agyDataPaths` / `agyHomePaths` |
| `src/shared/limits.ts:72`、`src/daemon/ledger/handover.ts:206` | 所有厂商共用一个 `AUTO_RENEW_CONTEXT_TOKENS = 200_000` | `VENDOR_SPECS[vendor].handoverTokenThreshold`（默认 `HANDOVER_TOKEN_THRESHOLD = 200_000`） |

## 2. 共享层数据形状（`src/shared/vendors.ts`、`src/shared/limits.ts`）

在 `src/shared/limits.ts:72` 导出 `HANDOVER_TOKEN_THRESHOLD = 200_000`（`AUTO_RENEW_CONTEXT_TOKENS` 保留别名兼容），在 `src/shared/vendors.ts:38-75` 扩展 `VendorSpec`：

```ts
/** 只读 Worker 落实方式：settings=写进 claude settings.json 原生沙箱；driver=驱动层原生参数；os_sandbox=依赖外层 OS 沙箱。 */
export type VendorReadonlyMode = "settings" | "driver" | "os_sandbox";

export interface VendorSpec {
  // ...保留现有 label, loginCommand, models, customModel, efforts, effortInModelId, modelFlag, effortFlag, flags, quota, shortModelName, backgroundCommands, composer
  /** CLI 命令名（默认可执行文件名，也用于提示词禁直接调 CLI 的列表）。 */
  cliCommand: string;
  /** 覆盖可执行文件路径的环境变量名（ENV_CLAUDE / ENV_AGY / ENV_CODEX）。 */
  envVar: string;
  /** 厂商内置子代理工具名（提示词里严禁直接调用的列表）。 */
  subagentTools: readonly string[];
  /** 后台运行长命令的工具写法说明（如 "Bash 工具的 `run_in_background`"）；用于拼提示词。 */
  backgroundCommandTool: string;
  /** 只读 Worker 落实方式。 */
  readonlyMode: VendorReadonlyMode;
  /** 未选模型时是否需把 ModelCatalog.defaultModelId 显式传给驱动（codex 为 true）。 */
  explicitDefaultModel?: boolean;
  /** 项目经理自动换新会话的上下文 token 阈值（默认 HANDOVER_TOKEN_THRESHOLD = 200_000）。 */
  handoverTokenThreshold: number;
}
```

三家声明的关键字段取值：

| 字段 | `claude` | `agy` | `codex` |
|---|---|---|---|
| `cliCommand` / `envVar` | `"claude"` / `ENV_CLAUDE` | `"agy"` / `ENV_AGY` | `"codex"` / `ENV_CODEX` |
| `subagentTools` | `["Agent", "Task"]` | `["invoke_subagent"]` | `["spawn_agent"]` |
| `backgroundCommands` / `backgroundCommandTool` | `true` / ``"Bash 工具的 `run_in_background`"`` | `false` / ``"`run_command` 的 `WaitMsBeforeAsync`"`` | `false` / ``"后台命令参数"`` |
| `readonlyMode` | `"settings"` | `"os_sandbox"` | `"driver"` |
| `explicitDefaultModel` | `false` | `false` | `true` |
| `handoverTokenThreshold` | `HANDOVER_TOKEN_THRESHOLD` (200_000) | `HANDOVER_TOKEN_THRESHOLD` (200_000) | `HANDOVER_TOKEN_THRESHOLD` (200_000) |

辅助函数（放 `src/shared/vendors.ts`）：
- `handoverTokenThresholdOf(vendor: string): number`：认识的厂商返回 `VENDOR_SPECS[vendor].handoverTokenThreshold`，否则 `HANDOVER_TOKEN_THRESHOLD`。
- `readonlyNeedsSandboxMessage(vendor: AgentVendor): string`：生成无 OS 沙箱时拒绝派只读 Worker 的报错（替代 `READONLY_AGY_NEEDS_SANDBOX_MESSAGE` 写死调用）。

## 3. 六项改造细节

### 3.1 提示词里的厂商工具名与命令名（`src/daemon/prompt.ts`）
- **后台命令说明**（第 60、68、239、273、280 行）：`buildPmModePrompt(mode, vendor)` 与 `workerRulesSection(vendor)` 从 `VENDOR_SPECS[vendor]` 读 `backgroundCommands` 与 `backgroundCommandTool`，拼出 `用后台运行（如 ${spec.backgroundCommandTool}）`，不再手写 `Bash 工具的 run_in_background`。
- **严禁内置子代理**（第 134、265 行）：新增 `formatSubagentTools(specs = VENDOR_SPECS)`，汇总去重各家 `subagentTools`（渲染为 `` `Agent`、`Task`、`invoke_subagent`、`spawn_agent` ``）与厂商 `label`；项目经理和 Worker 提示词共用，补齐此前漏掉的 `invoke_subagent`。
- **严禁直接跑 CLI**（第 135 行）：从 `AGENT_VENDORS` 取各家 `VENDOR_SPECS[v].cliCommand` 拼出 `` `claude`、`agy`、`codex` ``。

### 3.2 只读落实、默认模型、额度查询与驱动循环注册
- **只读检查与设置**（`src/daemon/ledger/workers.ts:358`、`src/daemon/launch.ts:82`）：
  - `workers.ts`：`if (readonly && VENDOR_SPECS[vendor].readonlyMode === "os_sandbox" && !ctx.osSandboxed()) throw fail("invalid", readonlyNeedsSandboxMessage(vendor));`
  - `launch.ts`：`const nativeReadonly = readonlyPolicy !== undefined && VENDOR_SPECS[session.vendor]?.readonlyMode === "settings";`
- **守护进程厂商模块表**（`src/daemon/vendors/index.ts`）：
  ```ts
  export interface VendorDriverDeps extends DriverOptions {
    executablePath: string;
    defaultModel: () => Promise<string | null>;
  }
  export interface DaemonVendorModule {
    base: VendorComposerBase;
    createComposer: (options: { executablePath: string; env?: Record<string, string | undefined>; timeoutMs?: number }) => VendorComposer;
    probe: VendorCatalogProbe;
    catalog: (options: VendorCatalogSourceOptions) => VendorCatalogSource;
    createDriver: (deps: VendorDriverDeps) => Driver;
  }
  export const DAEMON_VENDORS: Readonly<Record<AgentVendor, DaemonVendorModule>> = { ... };
  ```
- **`daemon.ts` 全部改为循环装配**：
  - 路径解析：`paths.ts` 提供 `resolveVendorExecutables(paths, env.PATH, userHome): Record<AgentVendor, { cmd: string; path: string }>`，遍历 `AGENT_VENDORS` 调 `resolveExecutable` 与 `VENDOR_FALLBACK_PATHS[v]`。
  - 驱动与默认模型：`createVendorDrivers(deps)` 遍历 `AGENT_VENDORS` 调 `DAEMON_VENDORS[v].createDriver`；当 `VENDOR_SPECS[v].explicitDefaultModel` 为真时，`defaultModel` 从 `models.list()` 取对应 `vendor` 的 `defaultModelId`。
  - 额度查询（第 431–434 行）：遍历 `AGENT_VENDORS` 查找 `VENDOR_SPECS[v].quota?.fetched`，用 `executables[v].path` 构造 `queryFetchedQuota`，不再点名 `VENDOR_SPECS.agy` 与 `agyPath`。
  - 关机步骤名（第 193 行）：`if (driver) await step("驱动层", () => driver.shutdown());`（把 `"claude"` 改为 `"驱动层"`，与“执行器”“模型名单”等步骤名一致）。

### 3.3 AGY 数据根目录与厂商专属路径集中定义（`src/shared/paths.ts`）
在 `src/shared/paths.ts` 集中定义 AGY 数据路径函数（常量 `AGY_CLI_HOME_REL = ".gemini/antigravity-cli"`、`AGY_LEGACY_HOME_REL = ".gemini/antigravity"`、`AGY_MCP_CONFIG_REL = ".gemini/config/mcp_config.json"`）：

```ts
export function agyCliDataDir(userHome: string = homedir()): string {
  return join(userHome, AGY_CLI_HOME_REL);
}
export function agyDataPaths(root: string = agyCliDataDir()) {
  return {
    root,
    conversationDb: (id: string) => join(root, "conversations", `${id}.db`),
    brainDir: (id: string) => join(root, "brain", id),
    mcpCacheDir: join(root, "mcp"),
    summaryDb: join(root, "conversation_summaries.db"),
    subDir: (sub: string) => join(root, sub),
  };
}
export function agyHomePaths(userHome: string = homedir()) {
  return { cliDir: agyCliDataDir(userHome), legacyDir: join(userHome, AGY_LEGACY_HOME_REL), mcpConfigFile: join(userHome, AGY_MCP_CONFIG_REL) };
}
```

4 个文件（9 处拼接）全部改为引用上述函数：
1. `src/daemon/handover/agy.ts:20,102,157,172,191,241`（5 处：`AGY_DATA_DIR`、`conversations/<id>.db` ×2、`brain/<id>`、`conversation_summaries.db`）→ 调 `agyDataPaths(root)`。
2. `src/daemon/driver/transcript.ts:125`（1 处：`conversations/<id>.db`）→ `agyDataPaths(agyCliDataDir(roots.home)).conversationDb(id)`。
3. `src/daemon/driver/readonly-agy.ts:75-76`（2 处：`cli` 与 `legacy` 目录）→ `agyHomePaths(home)`。
4. `src/daemon/driver/agy-connectors.ts:222,234`（1 处 `.gemini/antigravity-cli/mcp` + 1 处 `.gemini/config/mcp_config.json`）→ `agyDataPaths(agyCliDataDir(homeDir)).mcpCacheDir` 与 `agyHomePaths(homeDir).mcpConfigFile`。

### 3.4 自动换会话的 token 阈值按厂商声明（`src/daemon/ledger/handover.ts`）
- `src/daemon/ledger/handover.ts:206-275`：将固定常量 `contextTokens` 改为函数 `thresholdOf = (vendor: string) => options.autoRenew?.contextTokens ?? handoverTokenThresholdOf(vendor)`。
- 启动重建 `queue`（第 217–223 行）、`autoAllowed(session)`（第 274 行）与 `afterDriverEvent`（第 704 行）均按 `session.usage.context >= thresholdOf(session.vendor)` 判断。

## 4. 守卫测试（CI 检查，`src/shared/vendor-guard.test.ts`）

仿照 `src/shared/errors-guard.test.ts`，用 `node:fs` 扫描源码（排除注释行和 `*.test.ts`），断言 `expected: 0`：

| 规则 | 扫描范围（合法定义处除外） | 匹配正则 | 合法定义处（不扫） |
|---|---|---|---|
| 业务代码不许写死单家厂商分支 | `src/daemon/**/*.ts`、`src/hub/**/*.ts` | `/\bvendor\s*[!=]==?\s*["'](claude\|codex\|agy)["']\|\bVENDOR_SPECS\.(claude\|codex\|agy)\b/` | `src/daemon/driver/**`、`src/daemon/vendors/**`、`src/daemon/handover/**`（以及 `daemon.ts` 厂商模块汇集处，收进 `vendors/index.ts` 后 `daemon.ts` 亦为 0） |
| AGY 数据目录字面量只许在路径定义处 | `src/**/*.ts` | `/\.gemini\/antigravity-cli\|["']\.gemini["']\s*,\s*["']antigravity-cli["']/` | `src/shared/paths.ts`、`src/shared/vendors.ts` |
| `prompt.ts` 不许硬编码厂商工具名或 CLI | `src/daemon/prompt.ts` | `/\b(spawn_agent\|invoke_subagent\|run_in_background\|WaitMsBeforeAsync)\b\|` + `` /`(Agent\|Task\|claude\|codex\|agy)`/ `` | `src/shared/vendors.ts` |

## 5. 性能

- **零额外 I/O**：`VENDOR_SPECS`、`DAEMON_VENDORS`、路径拼接函数都是内存常量或纯字符串拼接；启动、拼提示词、每次 `hub worker start` 派活和 `turn.ended` 检查换会话阈值均不新增任何文件读写、子进程或网络请求。
- **O(1) 查找与常数级遍历**：按厂商取配置是对象属性读取 `O(1)`；`AGENT_VENDORS` 遍历只有几项，提示词格式化与驱动注册耗时在微秒级，无重复计算。

## 6. 统一

- **前后端纯数据归 `src/shared/vendors.ts`**：`VendorSpec`、`VENDOR_HOME_PATHS`、`VENDOR_FAILURE_SIGNS` 均不依赖 Node API，网页、CLI、账本、提示词共用；路径拼接归 `src/shared/paths.ts`（含 `VENDOR_FALLBACK_PATHS` 与 `agyDataPaths`）。
- **守护进程运行时钩子归 `src/daemon/vendors/`**：`DAEMON_VENDORS` 汇总各家的驱动工厂、命令列表与模型名单探测器；交接复制器在 `src/daemon/handover/forkers.ts`（`FORKERS`），原始记录路径在 `src/daemon/driver/transcript.ts`。
- **编译期强制完备**：所有注册表均声明为 `Record<AgentVendor, ...>`。未来新增厂商只需在 `AGENT_VENDORS` 加名字，TypeScript 编译期会强制要求在 `VENDOR_SPECS`、`VENDOR_HOME_PATHS`、`VENDOR_FAILURE_SIGNS`、`VENDOR_FALLBACK_PATHS`、`DAEMON_VENDORS`、`FORKERS` 补齐该厂商条目，业务层代码一行不用改。

## 7. 任务拆分

拆成 2 个互不冲突的小步，每步独立可合、测试绿：

1. **步骤 A：共享声明表扩展 + 提示词/换会话阈值/AGY 路径收拢**
   - **改哪些文件**：`src/shared/limits.ts`、`src/shared/vendors.ts`、`src/shared/paths.ts`、`src/daemon/prompt.ts`、`src/daemon/ledger/handover.ts`、`src/daemon/handover/agy.ts`、`src/daemon/driver/transcript.ts`、`src/daemon/driver/readonly-agy.ts`、`src/daemon/driver/agy-connectors.ts` 及对应单测。
   - **怎么验**：`pnpm typecheck`；跑 `vendors.test.ts`、`paths.test.ts`、`prompt.test.ts`（断言提示词包含 `invoke_subagent`、按厂商切换后台命令工具说明）、`handover.test.ts`（按厂商阈值触发自动换会话）、`readonly-agy.test.ts`。
2. **步骤 B：只读能力与守护进程循环注册 + 守卫测试落地**
   - **改哪些文件**：`src/daemon/ledger/workers.ts`、`src/daemon/launch.ts`、`src/daemon/vendors/index.ts`、`src/daemon/daemon.ts`、新增 `src/shared/vendor-guard.test.ts`。
   - **怎么验**：`pnpm typecheck`；跑 `vendor-guard.test.ts`（3 条扫描规则全部 0 违例）、`workers.test.ts`、`launch.test.ts`、`daemon.test.ts`。
