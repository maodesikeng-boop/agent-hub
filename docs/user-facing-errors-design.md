# 报错变人话：错误码表（方案）

目标：用户在网页、hub 命令行、agent 在 hub 应答里看到的每条报错，都是“出了什么事 + 该怎么办”的中文。
内部错误码（internal_error、forbidden_host）、英文异常原文、系统码（ENOENT、ECONNREFUSED）、浏览器原文（Failed to fetch）不再透传。
厂商启动/运行失败的人话由 #164（describeFailure 按设备显示）负责，本方案只接它的出口，不重写。行号以 main@62eb769 为准。

## 1. 数据形状：一张表，放 `src/shared/errors.ts`

```ts
/** 接口错误：会出现在 HTTP 应答里，status 必填。 */
export const API_ERRORS = {
  invalid:          { status: 400, text: "请求内容不对" },                       // 业务原因（中文）由抛错处给，见第 2 节
  not_found:        { status: 404, text: "要找的东西不在了", hint: "刷新页面再试" },
  forbidden:        { status: 403, text: "没有权限做这件事" },
  conflict:         { status: 409, text: "状态变了，这一步做不了", hint: "刷新页面再试" },
  unauthorized:     { status: 401, text: "登录过期了", hint: "重新登录" },          // 网页不显示它：任何 401 直接切到登录界面
  forbidden_host:   { status: 403, text: "这个网址不能打开 agent hub", hint: "换成本机 agent hub 的网址打开" },
  forbidden_origin: { status: 403, text: "请求来源不对，已拦下", hint: "直接在 agent hub 页面里操作" },
  forbidden_identity:{ status: 403, text: "这台设备的主人不是你", hint: "换成这台设备主人的账号" },
  forbidden_peer:   { status: 403, text: "别的设备不能调这个接口" },
  peer_unauthorized:{ status: 401, text: "这台设备没有配对或已被移除", hint: "到设备页重新配对" },
  device_not_found: { status: 404, text: "没有这台设备", hint: "到设备页刷新设备清单" },
  device_offline:   { status: 502, text: "那台设备连不上", hint: "看那台设备开没开机、联没联网" },
  too_large:        { status: 413, text: "内容太大，发不出去" },
  busy:             { status: 429, text: "太忙了，稍后再试" },                  // 具体原因（同时上传太多、登录次数到上限）由抛错处传
  unavailable:      { status: 501, text: "这台机器不支持这个操作" },
  git_failed:       { status: 409, text: "git 没跑成", hint: "可以重试；或加 --no-worktree 在主文件夹里干" },
  internal:         { status: 500, text: "守护进程出了意外的错，已记进日志", hint: "重试一次；还不行看日志" },
} as const satisfies Record<string, { status: number; text: string; hint?: string }>;

/** 本地错误：只在客户端、命令行、启动时用，没有 status，不可能被当成 HTTP 应答发出去。 */
export const LOCAL_ERRORS = {
  network:          { text: "连不上守护进程", hint: "看守护进程有没有在跑" },
  port_in_use:      { text: "端口被占了", hint: "可能已经开了一个；或设 AGENT_HUB_PORT 换端口" },
  bad_port:         { text: "AGENT_HUB_PORT 不是端口号", hint: "改成 0–65535 的整数" },
} as const satisfies Record<string, { text: string; hint?: string }>;

export type ApiErrorCode = keyof typeof API_ERRORS;
export type LocalErrorCode = keyof typeof LOCAL_ERRORS;
export type ErrorCode = ApiErrorCode | LocalErrorCode;
export const GENERIC_ERROR_TEXT = "出错了";
export function errorBody(code: ApiErrorCode, reason?: string): ApiErrorBody;   // 只收接口错误码；{ code, error: reason ?? text }
export function humanize(body: unknown, status: number): { code: ErrorCode | null; text: string; hint?: string; raw: string };
```

- `LEDGER_ERROR_HTTP_STATUS`、`HUB_ERROR_HTTP_STATUS` 改成从 `API_ERRORS` 派生（`internal_error` 统一叫 `internal`），不再各写一份。
- 应答体 `ApiErrorBody = { code: ErrorCode; error: string }`：`code` 给程序认，`error` 永远是中文、可直接显示。不另发 `hint`，客户端按 code 查表拿（旧客户端看不到 hint 也不坏）。
- hub 应答保持 `{ ok:false, code, message }`，`code` 改为 `ApiErrorCode` 的子集，`message` 同上规则。
- `humanize` 是客户端唯一入口（网页、hub 命令行都用），规则见第 3 节。
- 厂商失败：#164 合了之后，把 `src/web/errors.ts` 的 `TEXT`/`describeFailure` 挪进 `shared/errors.ts`（同一文件两张表：接口错误 + 厂商失败），守护进程拼系统消息、网页、命令行都调它。三家厂商的特征仍在 `shared/vendors.ts`。

## 2. 边界：什么回给人，什么只进日志

| 情况 | 回给用户 / agent 的 error | 进日志 |
|---|---|---|
| 账本 `LedgerRequestError`（中文业务原因） | 原因原样（它本来就是写给人看的） | 否 |
| 请求体校验没过（Fastify 400、JSON 坏） | 表里 `invalid` 的话；agent 接口加字段名（`参数不对：缺 title`，由 schema 路径拼中文） | Fastify 英文原文 |
| 5xx / 意外异常 | 只给 `internal` 的话，**不带 err.message** | 完整 err + 堆栈 |
| 系统码 ENOENT/ECONNREFUSED、Failed to fetch | 映射成 `network` 的话 | 原文 |
| git 失败（用户仓库的问题） | `git_failed` + 原因行：取第一条以 `fatal:` 或 `error:` 开头的行，没有就取最后一个非空行，截 200 字（第一行常是 “Preparing worktree…” 这类进度） | 全文 |
| 鉴权/Host/Origin 拒绝 | 表里的话 + hint；网页遇到任何 401 直接切到现有登录界面（同 `device-hub.ts` 的 load），不弹报错 | 是（便于查是谁在敲门） |
| 第二期公网入口、没登录的请求 | 只回 `code` + 一句通用的话，**不带 hint**，不给陌生人透露细节。由入口规则表（PR #146 的 `entryRules`）决定，现在不实现 | 是 |

**必须带“怎么办”**：用户自己能动手解决的（forbidden_host、peer_unauthorized、device_offline、network、port_in_use、bad_port、git_failed、internal）。hint 只写跟连法无关的话，不写死 Tailscale、ssh 隧道或某一种登录办法（扫码、一次性链接都会有）。
纯业务拒绝（invalid/conflict 的具体原因）原因里通常已含做法，不强加 hint。

## 3. 兼容：多设备新旧版本混跑

入口设备把请求转给别的设备，回来的应答体可能来自老版本（只有 `error`，可能是英文码）。`humanize` 按顺序判：
1. `code` 在表里 → `error` 是中文就用它，否则用表里的 text；hint 按 code 查。
2. 没有 code、`error` 形如 `^[a-z_]+$`（老服务端的 `not_found`、`internal_error`）→ 当 code 查表（`internal_error` 当 `internal`；`unauthorized` 直接切登录界面）。
3. 没有 code、`error` 含中文 → 原样用（老服务端的业务原因）。
4. 其余（英文原文、非 JSON、空体）→ `出错了（状态码）`。
原文一律放 `raw`：网页放在 `title`（悬停可见），toast/行内错误不展开。老客户端连新服务端：它原样显示 `error`，现在是中文，只会变好。

## 4. 各出口怎么改（只列要点）

- **界面服务** `ui-server/server.ts:446 fail()` 改成 `fail(reply, code: ErrorCode, reason?: string)`，状态从表取；19 处 `fail(reply, 4xx, "英文码")` 随之改为传 code。错误处理器 `:536-550`：Fastify 4xx 英文原文只进日志；500 不变但已有日志。`:537 PickFolderError`、`:539 UploadError`、`:568/:715/:716` 的中文常量改为 `fail(code, 中文原因)`。**等 #164 合了再接**（它在改这个文件）。
- **联机** `peers/service.ts:55,57,339`（`body must be a JSON object` 等）改中文；`:232` 对方回的 error 先过 `humanize`；“没有这台设备”三种写法（`routes.ts:24` 的 `error:"not_found"`、`proxy.ts:135`、`service.ts` 的设备查找）统一 `device_not_found`，带名字时 `“X”已经把这台移除了`。
- **网页** `client.ts:57 failureMessage` 换成 `humanize`，`ApiError` 加 `code`、`hint`、`raw`；fetch 抛错（Failed to fetch）→ `network`。`format.ts:111 errorText` 改返回 `{ text, hint, raw }`（或删掉，统一走 `web/errors.ts`）。`BrowserSessions.tsx:19`、`FilePreview.tsx:244`、`PmProfile.tsx:260,275`、`device-hub.ts:217`、`Messages.tsx:545 pending.reason` 改用它，hint 接在 text 后，raw 放 title。界面按 `docs/ui-standard.md` 第 17 条。
- **agent 接口** `agent-api/server.ts:305` 不再回 `err.message`，回 `internal` 的话；日志、`reportHealth` 保留原文。`:298/:301` 的“参数不对：<英文>”改为按 schema 错误拼中文，写出字段名（如 `参数不对：缺 title`）。`ledger/workers.ts:317 gitFailed` 按第 2 节取原因行，改抛 `LedgerRequestError("git_failed", …)`，不再走 internal 分支、不再记一次接口故障。
- **hub 命令行** `hub/cli.ts:209` parseArgs 按 `err.code`（`ERR_PARSE_ARGS_UNKNOWN_OPTION` 等）出中文；`:480` 的 `err.code` 只进括号外的 hint（`network` 的话 + “看守护进程有没有在跑”），不打 ENOENT；`:563` 意外异常改新退出码：`HUB_EXIT` 加 `internal: 4`（注释同步），不再与用法错共用 2。
- **系统消息** `ledger/schedules.ts:226`、`ledger/handover.ts:598` 拼消息前先过 `describeFailure(reason, { unknown: "raw" })`，原文存进 meta 供 title；codex 适配器存 `failure_reason` 时取 `error.message`，不 `JSON.stringify` 整个对象。**等 #164 合了再接**。
- **启动** `daemon.ts:117 parsePort` 报 `bad_port`；`server.ts:929 app.listen` 捕获 `EADDRINUSE` 抛带 `port_in_use` 的错；`entry.ts:18` 对已知码只打一句话 + hint，未知异常打一句 + “详情在 <日志路径>”，堆栈写日志不上终端。

## 5. CI 检查（放 `src/shared/errors-guard.test.ts`，用 fs 扫文件，不依赖 rg）

| 规则 | 等价 rg | 现在命中 |
|---|---|---|
| 守护进程 fail 第三参不许是英文码 | `rg -n 'fail\(reply, [0-9a-zA-Z_.\[\]]+, "[a-z_]+"' src/daemon` | 19（全在 ui-server/server.ts） |
| 应答体不许直接 `error: "英文码"`（排除 *.test.ts） | `rg -n 'error: "[a-z_]+"' src/daemon -g '!*.test.ts'` | 2（routes.ts:24 真命中；handover.ts:137 是别的枚举，加白名单） |
| 回给人的不许是 err.message（排除日志行） | `rg -n 'fail\(reply, [^,]+, (err\|error)\.message' src/daemon` | 7（ui-server 5、agent-api 2） |
| 组件不许直接显示 err.message | `rg -n '(err\|error)\.message' src/web -g '*.tsx'` | 5（BrowserSessions、FilePreview、PmProfile×2、ChartBlock；ChartBlock 是图表语法错，白名单） |
| 每个码的 text 含中文、hint 必填的码都有 hint、hint 不含 Tailscale/127.0.0.1 等连法字样 | 单测遍历两张表 | — |

做法：测试里写“允许清单 + 期望数”，A 块落地时把现有命中全列进去，每个实现块改完从清单里删自己那几条（棘轮只降不升）；全部做完清单只剩两条白名单。B 块把 `fail()` 改成只收 `ApiErrorCode` 后，第 1 条由类型检查保证，B 里顺手删掉这条扫描，不留两份。

## 6. 性能

只是查一张常量表（约 20 条，打包后 <2 KB），O(1)。不多发任何请求、不加轮询；`hint` 客户端本地查，不改应答大小。启动时不做额外工作（表是模块常量）；日志只在出错时写。

## 7. 统一

网页、hub 命令行、agent 接口、联机转发、系统消息都 import `shared/errors.ts`；三家厂商的失败经 `describeFailure`（#164 后挪进同一文件）出话。新增出错场景只加一行表，不在组件里散写。

## 8. 实现拆块（A 先合，B–E 可并行）

| 块 | 内容 | 验收 |
|---|---|---|
| A 表 + 守卫 | `shared/errors.ts`、`humanize`、`errorBody`；派生两张状态表；第 5 节测试（允许清单=现状） | `humanize` 单测覆盖第 3 节 4 种输入；守卫测试通过；typecheck |
| B 界面服务 + 联机 | 第 4 节界面服务、联机两条；删掉第 5 节第 1 条扫描。**等 #164 合了再接** | server.test 断言：403 Host 回 `{code:"forbidden_host",error:中文}`；500 不含异常原文且日志有；Fastify 400 不含英文；设备不在只一种回法 |
| C 网页 | client.ts、errors.ts、各组件；401 切登录界面 | 单测：老服务端 `{error:"not_found"}`、新服务端、Failed to fetch、非 JSON 四种显示；截图看 hint 和 title |
| D 命令行和终端输出 | agent-api、workers git、cli.ts、`HUB_EXIT.internal`；parsePort、EADDRINUSE、entry 输出 | 测试：内部错应答不含原文、reportHealth 仍记；参数错写出字段名；git 失败回 409 `git_failed`、原因是 fatal/error 行且不记故障；cli 未知参数中文、守护进程没开不打 ENOENT、意外异常退出码 4；同端口起两个守护进程终端一句话 + hint 无堆栈；`AGENT_HUB_PORT=abc` 中文 |
| E 系统消息 | schedules、handover、codex 适配器。**等 #164 合了再接** | ledger 测试：失败原因为厂商原文时消息是人话、meta 留原文；codex 错误对象不出现 `{"` |

每块完成时把守卫允许清单里自己那几条删掉。同步更新 `docs/ui-standard.md` 第 17 条（指向这张表）。

## 9. 已定（项目经理 11-08）

1. hub 意外异常用新退出码 4（提示词里没写死退出码）。
2. git 失败回给项目经理带原因行（取法见第 2 节）。
3. agent 接口参数错写出字段名。
