# 每台设备只显示装了、能用的厂商（方案）

## 1. 问题

三家厂商（`AGENT_VENDORS`）在哪台设备上都一律列出来：网页厂商下拉（`web/models.tsx`，问不到用打包名单照样显示）、
额度面板（`web/selectors.ts` 的 `QUOTA_VENDORS`）、项目经理提示词（`daemon/prompt.ts` 的“能用的厂商有…”和
`--vendor` 列表，而且 `PM_WORKER_PROMPT` 是模块加载时算好的常量）、`hub worker start --vendor` 只查是不是三家之一。
没装的厂商真跑才报错，而且 `codex-driver.ts:978`、`agy-driver.ts:907` 没找到程序时抛的是 `claude_not_found`，界面显示“找不到 claude”。

## 2. 状态

每台设备、每家厂商一个状态，类型只在 `shared/vendors.ts` 定义一处：

```ts
export const VENDOR_AVAILABILITIES = ["available", "not_installed", "signed_out", "unknown"] as const;
export type VendorAvailability = (typeof VENDOR_AVAILABILITIES)[number];
/** 界面上的状态词（英文，界面统一用英文状态词）；能用 / 认不出不显示。 */
export const AVAILABILITY_LABELS: Record<VendorAvailability, string | null> = {
  available: null, unknown: null, not_installed: "Not installed", signed_out: "Not signed in",
};
/** 列不列、能不能选，全仓库只用这两个函数判断，不各处比字符串。 */
export const isListed = (a: VendorAvailability) => a !== "not_installed";
export const isSelectable = (a: VendorAvailability) => a === "available" || a === "unknown";
```

`ModelCatalog` 加一个字段 `availability: VendorAvailability`。状态就跟着模型名单走：同一个接口（`GET /api/models`）、
同一份缓存、同一条按设备转发的路，不另开接口。老服务端回的名单没有这个字段 → 网页 `complete()` 补成 `unknown`（当能用）。

| 状态 | 下拉（新建项目经理 / 换模型 / Worker） | 额度面板 | 提示词厂商列表 | `hub worker start --vendor` |
|---|---|---|---|---|
| available / unknown | 正常 | 显示 | 列 | 放行 |
| signed_out | 显示、灰掉、后面标 `Not signed in` | 不显示 | 不列 | 报错“这台设备的 codex 没登录，先在终端跑 `codex login`”（见 7.2） |
| not_installed | 不出现 | 不显示 | 不列 | 报错“这台设备没装 codex” |

**例外：已经在用这家的**：下拉当前选中的值总是显示（就算没装，也显示并标状态词），额度面板里有这家会话的照常显示；
老项目经理、老 Worker 的对话照常显示，跑的时候报对的名字（第 6 节）。

## 3. 判断：各家写在各自模块里

`daemon/vendors/<厂商>.ts` 各导出一个纯函数的 `<厂商>CatalogProbe` 和起进程的 `create<厂商>CatalogSource`（claude 的在
`claude-catalog.ts`：`claude.ts` 给账本用，不能引入起进程的代码），`vendors/index.ts` 的 `VENDORS` 用 `satisfies Record<AgentVendor, …>`
登记——加厂商漏写编译不过；别处只按 `AGENT_VENDORS` 遍历，不写厂商名。实际接口（`vendors/types.ts`、`driver/model-catalog.ts`）：

```ts
interface VendorCatalogProbe {          // 各家纯函数（vendors/types.ts）
  parse(raw: unknown): ModelCatalog | null;
  availabilityOf(raw: unknown): VendorAvailability;           // 问到了：同一次回应里看，看不出是 unknown
  availabilityOfError?(error: unknown): VendorAvailability;  // 没问到：不写按通用的（ENOENT → 没装，认证类 → 没登录）
}
interface VendorCatalogSource extends VendorCatalogProbe {  // 加上起进程的（driver/model-catalog.ts）
  query(signal): Promise<unknown>;
  confirm?(signal): Promise<VendorAvailability>;  // 上面给 unknown 时的补充（读凭证文件 / 状态命令）
  installed?(): boolean;                           // findExecutable，只查文件
}
```

各家的依据（本机实测 + 现有代码）：

| 厂商 | 名单查询本来就在跑的 | 从里面看登录 | 补充（只在 unknown 时） |
|---|---|---|---|
| claude | 起 claude 发 initialize | 回应里有 `account`（实测有 email、organization）→ available；没有 → 交给补充 | `claude auth status --json`（实测回 `loggedIn`，没登录退出码非 0） |
| codex | 起 `codex app-server` 发 model/list | 同一个进程多发一条 `account/read`，回 `account: null` → signed_out | 读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）在不在，不起进程 |
| agy | 起 `agy … models` | 成功回名单 → available；没登录时退出码也是 0、打印一段话不是 JSON（东京实测 `Error: Please sign in to view available models. …`），所以按“解析不出名单、原话里有 sign in”判 signed_out | 无（agy 没有状态命令） |

“没装”不起进程：新加 `findExecutable(cmd, PATH, fallbackPaths): string | null`（`shared/paths.ts`），`resolveExecutable`
直接建在它上面（同一份候选路径，PATH 里没有、候选路径里有也算装了，如 ChatGPT.app 里带的 codex；候选路径加了 `~/Applications`），只查文件在不在。每次 `list()` 都先查一遍：用户装好后不用重启守护进程就能看到。
查询时 spawn 报 ENOENT 也判 not_installed（PATH 变了的情况）。

## 4. 性能

- **不另起进程**：登录状态从模型名单那次查询的回应里拿（claude 的 initialize、codex 同一个 app-server 多一条 RPC、agy 的成败）。
  只有回应说不清（unknown）时才用补充判断，codex 是读文件；claude 才可能多起一次 `claude auth status`。
- **一起缓存**：状态存在 `createModelCatalogs` 每家的槽里，和名单同一个 `cachedAt`、同一个 `MODEL_CATALOG_FRESH_MS`（6 小时）。
  顺手把槽从手写三项改成按 `AGENT_VENDORS` 生成（查询函数和解析函数也从各家登记里取）。
- **不轮询**：仍是“有人要时问”。只有不是 available 的状态缓存得短：signed_out、not_installed 按失败处理，
  过 `MODEL_CATALOG_RETRY_MS`（5 分钟）之后有人要时再问；装没装每次 `list()` 都查文件（几乎零成本）。
- **提示词不等查询**：项目经理启动时用缓存里的状态；还没问过就只用“装没装”（查文件），登录状态当 unknown（列出来）。
  守护进程启动时**不**预热查询（保持现在的行为，不在启动时起三个进程）。

## 5. 用户登录完怎么刷新

1. **网页**：打开厂商下拉时（`pointerdown` / `focus`），如果这台有不能用的厂商，**在后台**带 `?refresh=unusable` 再拉一次——
   守护进程只重问那几家。下拉立刻按缓存打开、不等，回来了再更新那几项；同一台同时只发一次。（`?refresh=1` 不变。）
2. **真跑的结果反过来更新状态**（免费信号）：会话起来、收到第一条 init → 这家标 available；会话失败被
   `vendorFailureOf` 判成 `auth` → 标 signed_out；spawn ENOENT → not_installed。这样不用等缓存过期。
3. 5 分钟重问（第 4 节）兜底。

## 6. 报对名字

- `shared/driver.ts` 的 `DRIVER_ERROR_CODES`：`claude_not_found` 换成按厂商的 `` `${AgentVendor}_not_found` ``
  （类型从 `AGENT_VENDORS` 生成，不手写三个）；`RETRYABLE_DRIVER_ERRORS` 同理。三个驱动统一用 `notFoundCode(vendor)`。
- `web/format.ts` 的“找不到 claude”改成按厂商生成“找不到 <厂商名>”（`vendorLabel`）。
- `VENDOR_FAILURE_SIGNS`、`inferVendorFromRaw` 本来就认 `<厂商>_not_found`，不用改。

## 7. 各处怎么用

### 7.1 网页
- `useModelCatalogs()` 返回含 `availability` 的名单；新加 `useVendorOptions(current?: AgentVendor)`：过滤掉 `!isListed`，
  但保留 `current`；下拉项 `disabled = !isSelectable`，后面标 `AVAILABILITY_LABELS`。新建项目经理、换模型、Worker 相关的下拉都改用它。
- 新建项目经理：选着的厂商（默认那家、或换了设备之前选的）这台用不了，**不悄悄换掉**（删掉了原来的 `VendorGuard`），
  下拉里标状态词、“创建”禁用，用户自己换；不加解释文字。下拉文字是 `Codex (Not signed in)`（原生 option 不能分样式）。
- 失败的那句话（`web/errors.ts`）：新增一类 `missing`“找不到 <厂商>”；顶部提醒（`Notices`）改用 `describeFailure`，删掉
  `format.ts` 写死“claude …”的旧表，认不出的原样显示不加粗；消息里的失败原因传对话自己的厂商（`MessageActions.vendorOf`）。
  健康状态按模块记、不属于某个会话，厂商靠错误码（`codex_not_found`）认。
- 额度面板：不用改。它本来就只显示有会话数据的厂商（`quotaUsage` 按会话的额度事件，agy 的按需查也要有 agy 会话才出现），
  没装、没登录的厂商没有会话，自然不出现；已经在用这家的老会话照常显示，正是“例外”要的。
- 样式按 `docs/ui-standard.md`：灰掉用标准里的禁用色；状态词用次要文字色、同一行右对齐。标准里没有“下拉项禁用 + 状态词”就先补进标准。

### 7.2 后台
- `hub worker start --vendor`：agent 接口在调账本之前（异步）问 `ModelCatalogs.ensureUsable(vendor)`——不能用的先重问这一家一次，
  结果连同设备名放进 `HubCallContext.vendorStatus`，账本（`workers.ts`）照它拒绝：“这台设备（东京）没装 codex” /
  “这台设备（东京）的 codex 没登录：先在这台设备的终端里跑 `codex login` 登录，再派”（登录命令在 `VENDOR_SPECS[厂商].loginCommand`）。
  不写 `--vendor` 不查。资料页改厂商（`persona.ts`）只从网页来，网页不让选不能用的，后台不另查。
- 提示词：`LaunchContext.vendorAvailability`（`launch.ts` 从缓存填，不等查询），`buildLaunchPrompt` 的厂商列表和
  `buildHubUsagePrompt(vendors)` 的 `--vendor a|b` 只列 `isSelectable` 的。
  状态变了**不**为它重启项目经理会话（fingerprint 只在下次正常重启时变），避免登录一下就打断正在干活的项目经理。

## 8. 多设备

名单已按设备取（网页 `catalogKey(client)`，请求经 `/d/<设备>/api/models` 转发给那台的守护进程），状态在名单里，
自然按设备走；每台守护进程只判断自己。项目经理提示词、`hub worker start` 都在项目经理所在设备的守护进程上算，也是那台的状态。
设备离线时网页用打包名单（状态 unknown），新建项目经理本来就不能选离线设备，不受影响。

## 9. 测试（先写会失败的）

截图：`docs/screenshots/vendor-availability/`（真守护进程 + 真 CLI：agy 指向不存在的路径，codex 用空的 `CODEX_HOME`）。

- `shared/vendors.test.ts`：`isListed` / `isSelectable`；`AVAILABILITY_LABELS` 每个状态都有项。
- `daemon/driver/model-catalog.test.ts`：claude 回应有 / 没有 `account`；codex 的 `account/read` 回 null；agy 报认证错；
  spawn ENOENT → not_installed；signed_out 5 分钟内不重问、之后有人要再问；`refresh: "signed_out"` 只重问那几家；
  已装文件消失 → 下次 `list()` 立刻 not_installed。
- `daemon/vendors/*`：各家 probe 的判断（假回应）。
- `daemon/prompt.test.ts`：没装、没登录的不进厂商列表和 `--vendor` 列表。
- 账本 / handlers：`worker start --vendor codex` 在没装时报“这台设备没装 codex”。
- `codex-driver.test.ts`、`agy-driver.test.ts`：ENOENT 抛 `codex_not_found` / `agy_not_found`。
- 网页（`m2.test.tsx`、`devices.test.tsx`）：没装不列、没登录灰掉；打开下拉后台重问不等；选着的用不了不换掉、“创建”灰。
