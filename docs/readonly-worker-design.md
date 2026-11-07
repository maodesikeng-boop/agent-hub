# 只读 Worker 统一方案（三家 + 连接器）

状态：方案，第 8 节用户已拍板（2026-11-07）。W1 统一定义已做（Worker #132：`src/shared/readonly-policy.ts`、`LaunchFiles.readonly`），S1–S6 实测脚本在 `experiments/readonly/smoke.py`（7.3 节），其余 W2–W6 待做。调研和实测来自 Worker #110。
实测脚本在 `experiments/readonly/`（测试目录 `/tmp/ro110`，用完已清掉）。

## 0. 目标和结论

**只读的统一定义**：哪里都能读（令牌、密钥等敏感文件除外），命令能跑，任何地方都不能写（每个会话自己的临时目录除外，见 4.3），连接器只能用只读工具。

现在接入的厂商以 `src/shared/vendors.ts` 的 `AGENT_VENDORS` 为准：claude、agy、codex。实测版本：claude 2.1.314、agy 1.5.3、codex-cli 0.162.0-alpha.17.2。

| 厂商 | 现在的做法实测 | 自带能力实测 | 推荐 |
|---|---|---|---|
| claude | dontAsk + 白名单：不在白名单里的一律拒，读 /tmp 都不行，`ls`、`wc` 也拒（10 步拒 10 步） | `plan`：读哪都行，只读命令能跑，Write/Edit 被拦，**但 Bash 写文件不拦**（`echo >`、`python`、`touch` 都写成了，关掉全部钩子也一样）；MCP 原生按 readOnlyHint 放行；allow 规则、PreToolUse 钩子都**加不回** plan 拒掉的工具 | `default` 模式 + `--permission-prompt-tool stdio`，驱动现场判断（MCP 看 `mcp_status` 的 annotations）；Bash 写由 claude 自带沙箱挡（要先过 7.3 的实测，不过就退回外层只读沙箱） |
| agy | `--mode plan`：**根本用不了**。工作区里 `ls -la` 也要批准，无头模式自动拒，而且**整轮直接结束、回复为空**；读工作区外的文件也一样 | `plan` + `--settings` 里的 permissions：`read_file(*)`、`command(*)` 放行后读和命令都正常；**plan 不拦命令行写**（3 种写法都写成了）；显式 deny 规则只报错、不结束这一轮；MCP 原生按 readOnlyHint 放行；终端沙箱（`--sandbox`）是“工作区可写、不联网”，不符合只读 | plan + permissions 规则 + **外层只读 OS 沙箱**（agy 没有原生的只读 shell，只能自己兜） |
| codex | 自带 `readOnly` 沙箱，审批一律拒：apply_patch 被拒；MCP 原生按 readOnlyHint 放行（只读的直接调，别的发 `mcpServer/elicitation/request`，驱动回的格式不对，但效果是拒） | 同左；手动补充用 `mcp_servers.<服务器>.tools.<工具>.approval_mode="approve"`，排除用 `disabled_tools`，都实测有效；程序里有 `permissions.filesystem` 的 deny_read（可禁读密钥，未实测） | 保持原生 readOnly，进程不包；补上连接器的补充/排除和密钥禁读 |

**我这次测不了的**（我自己就在 agent-hub 包的 sandbox-exec 里，再起 sandbox-exec 报 `sandbox_apply: Operation not permitted`，exit 71）：claude 自带沙箱、agy `--sandbox`、codex readOnly 下真跑命令、外层只读 seatbelt 的写法。这些要在没包沙箱的地方跑一次（7.3 有清单和脚本），**合并前必须跑**。

## 1. 实测细节

测法：临时目录 `/tmp/ro110/ws`（git 仓库，当工作目录）、`/tmp/ro110/outside`（工作目录外，放 `note.txt` 和假密钥 `.env`）、一个本地测试 MCP 服务器（`server.mjs`：`ro_lookup` 带 `readOnlyHint: true`，`rw_save` 是 `readOnlyHint: false` 会写文件，`plain_tool` 没有 annotations）。提示词要求模型逐条真调用工具、由权限系统决定（不然 plan 模式下模型自己就不去写，测不出来）。都是不弹窗的无头方式跑（claude `-p`、agy `--print`、codex `exec` / `app-server`），跟我们驱动一样。跑完看文件到底写没写。

### 1.1 claude

| 配置 | 读工作区外 | 只读命令 | Write 工具 | Bash 写 | 读 .env（有 deny 规则时） | MCP 只读 / 写 / 没标记 | 会不会卡住 |
|---|---|---|---|---|---|---|---|
| `plan` | 能 | 能 | 拒 | **写成了** | 拒（`cat .env` 也被拒：claude 会拿 Read 拒绝规则查 Bash 命令里的路径） | 放行 / 拒 / 拒 | 不卡，16–35 秒跑完 |
| `dontAsk`（无白名单） | 拒 | 拒 | 拒 | 拒 | 拒 | 拒 / 拒 / 拒 | 不卡 |
| `default` + `--permission-prompt-tool stdio` + allow [Read, Glob, Grep, Bash, WebSearch, WebFetch] + deny [Edit, Write, NotebookEdit, Read(//…/.env)] | 能 | 能 | 拒 | 写成了（测试环境没包只读沙箱；生产靠沙箱挡） | 拒 | 放行 / 拒 / **手动补充后放行** | 不卡 |

其它：
- plan 下 `allow: ["mcp__rotest__plain_tool"]` 无效，PreToolUse 钩子返回 `permissionDecision: "allow"` 也无效——plan 拒掉的工具加不回来，所以 plan 做不了“手动补充”。
- `deny: ["mcp__rotest__ro_lookup"]` 会把这个工具整个拿掉（模型看不到），排除有效。
- `can_use_tool` 控制请求带 `tool_name`、`mcp_server`、`input`、`tool_use_id`，不带 annotations；annotations 用 `mcp_status` 控制请求拿（每个工具 `{readOnly, destructive, openWorld}`）。
- 用户真实连接器的标记（`mcp_status` 实测）：claude.ai 的 Slack 14 个只读、Gmail 6、Google Drive 8、Atlassian 27、Sheets 2、Docs 1——跟 `policy.ts` 手写的 `READONLY_CONNECTOR_TOOLS` 一致，还更全（Drive 多了 `download_file_content`、`list_shared_drives`、`get_shared_drive_metadata`，Atlassian 多了 `getContentFormatGuide`）。完全没标记的：jenkins（36 个工具一个都没有）、pdf-viewer（9 个）、chrome-devtools 24 个、rea 94 个。所以“手动补充”有真需求（比如 jenkins 的 `get_*`）。

### 1.2 agy

| 配置 | 结果 |
|---|---|
| `--mode plan`（现在生产的只读） | 第一步 `ls -la`（工作区里）就要批准 → 无头自动拒 → **这一轮结束，回复为空**，stderr：`a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied`。读工作区外的文件同样 |
| plan + `--settings` allow [`read_file(*)`, `command(*)`] | 读、`ls`、`git log`、读 `~/.agent-hub/state` 都正常；**`echo >`、`python` 写、`touch` 都写成了**；`write_file` 没有规则时要批准 → 整轮结束 |
| 再加 deny [`write_file(*)`] | `write_file` 报 `Permission denied … Matches user-configured deny rule.`，模型照常往下做（显式 deny 不结束这一轮） |
| deny 读密钥 | `read_file(/private/tmp/ro110/outside/.env)` 有效；`read_file(/tmp/…)` 无效（agy 按真实路径比，要 realpath）；`read_file(**/id_rsa)`、`read_file(*.env)` 通配都**无效** |
| 规则优先级 | deny `mcp(*)` 压过 allow `mcp(codegraph/codegraph_explore)`（更具体的 allow 也压不过）|
| MCP（plan，不加规则） | `ro_lookup`（readOnlyHint）直接放行；`plain_tool`（没标记）要批准 → 整轮结束 |

其它：
- agy 的 MCP 工具在 init 里只露出一个 `call_mcp_tool`，init 和它缓存的工具定义（`~/.gemini/antigravity-cli/mcp/<服务器>/<工具>.json`）都不带 annotations；agy 程序里有 `ToolAnnotations.readOnlyHint`，plan 下自己会用。
- 规则语法（程序和报错里）：`read_file(<路径>)`、`write_file(<路径>)`、`command(<前缀>)`、`read_url(<域名>)`、`execute_url(<域名>)`、`mcp(<服务器>/<工具>)`，`*` 表示全部。
- 终端沙箱的语义（程序内置提示词）：“Standard Sandbox Mode：workspace、artifact/scratch 目录、/tmp 可读写，不联网”，绕出去要人批准——不是只读，也不能联网，不用。
- **现在的漏洞问题**：生产这套（只 `--mode plan`）命令行一条都跑不了，所以没有“命令行写”的漏洞，但也什么都干不了；`checkWorkerToolViolation` 只拦编辑工具，而且是看到工具开始（ACTIVE）后才 SIGINT，属于事后拦。

### 1.3 codex

`codex exec --sandbox read-only` 和 app-server（`thread/start` sandbox read-only + approvalPolicy on-request + turn `sandboxPolicy: readOnly`，跟驱动一样）：
- apply_patch 新建文件：被拒（只读沙箱）。
- shell 命令：我这里每条都 `sandbox_apply: Operation not permitted`（嵌套），测不了；#108 里非只读的 codex 实测过它自己的 seatbelt 能用。
- MCP：`ro_lookup` 直接调；`plain_tool`、`rw_save` 发 `mcpServer/elicitation/request`（`_meta.codex_approval_kind: "mcp_tool_call"`），回 `{action:"decline"}` → `user rejected MCP tool call`；回驱动现在默认分支的 `{decision:"decline"}` 结果一样（格式不对但被当拒绝）。
- 补充：`-c 'mcp_servers.rotest.tools.plain_tool.approval_mode="approve"'` → plain_tool 直接调成功（`"auto"` 不行）。排除：`-c 'mcp_servers.rotest.disabled_tools=["ro_lookup"]'` → `Tool unavailable`。
- `mcpServerStatus/list` 返回每个工具带 annotations（`readOnlyHint`、`destructiveHint`）。用户的 codex：codex_apps 254 个工具里 137 个只读，jenkins 0 个。

顺带发现（不在本题范围）：codex 驱动把所有 elicitation 都拒了，**非只读**的 codex Worker 也用不了没标只读的 MCP 工具（比如发 Slack）。要不要放行另开一题。

## 2. 统一：一处定义，各家只是翻译

### 2.1 现状的问题

- 只读这件事有三套：claude 在 `policy.ts`（dontAsk + 白名单），codex 从 claude 的设置文件里**反读** `defaultMode === "dontAsk"`（`readCodexLaunchConfig`），agy 也反读（`isReadonlySettings`）。改 claude 的模式名就会把另两家弄坏。
- 连接器只读工具手写死在 `policy.ts`，只给 claude 用。
- 只读 Worker 的写限制：claude 靠权限、codex 靠原生沙箱、agy 靠事后 SIGINT；OS 沙箱用的是普通 Worker 的可写范围（自己的 worktree 能写）。

### 2.2 一处定义：`src/shared/readonly-policy.ts`（新）

跟厂商无关，只回答“只读是什么”：

```ts
export interface ReadonlyPolicy {
  /** 禁读的敏感路径（绝对路径、已展开 ~，目录按子树算）。各家都能表达。 */
  secretPaths: string[];
  /** 禁读的通配（如 **\/.env、**\/id_rsa）。只有 claude 沙箱和 seatbelt 正则能表达，agy 规则表达不了（见 5）。 */
  secretGlobs: string[];
  /** 连接器：默认只放 readOnlyHint 为 true 的；extraAllow 手动补充，deny 手动排除（deny 优先）。写法 "<服务器>/<工具>"，工具可以是 *。 */
  connectors: { extraAllow: string[]; deny: string[] };
  /** 内置工具里只读、可以放行的（claude：Read、Glob、Grep、WebSearch、WebFetch……）由各家翻译时给，不在这里。 */
}
export const READONLY_POLICY: ReadonlyPolicy = { … };   // 默认值，可调的数集中在这
export function connectorToolAllowed(policy, server, tool, annotations): boolean;  // 三家共用的判断
```

- `LaunchFiles` 加一个明确的字段 `readonly?: ReadonlyPolicy`（launch.ts 按 WorkerRecord.readonly 填），**删掉**两处反读设置文件（`isReadonlySettings`、`readCodexLaunchConfig` 里的 readonly 解析）。
- 只读 Worker 的可写范围：`WriteScope` 加一种“全不能写”（`writableDirs: []` 且范围是整个文件系统，不只数据目录），由 `shared/write-scope.ts` 给出，跟普通 Worker 同一个入口。

### 2.3 各家翻译：`src/daemon/driver/readonly.ts`（新）

```ts
export interface ReadonlyEnforcer {
  /** 写不了的硬保证在哪一层："native"＝厂商自带的命令沙箱（进程不包外层，macOS 沙箱不能嵌套）；"outer"＝我们的只读 OS 沙箱包整个进程。 */
  writeGuard: "native" | "outer";
  /** 启动参数 / 设置文件 / 协议参数里要加的东西。 */
  launch(policy: ReadonlyPolicy, ctx): VendorLaunchPatch;
  /** 厂商来问批准时怎么答（claude can_use_tool、codex elicitation/审批）。agy 没有问的通道，返回 null。 */
  decide?(req, policy, catalog): "allow" | "deny";
}
export const READONLY_ENFORCERS: Readonly<Record<AgentVendor, ReadonlyEnforcer>> = { claude, agy, codex };
```

键是 `AGENT_VENDORS`：加厂商漏了这里编译不过（跟 `WRITE_SCOPE_ENFORCERS` 一样）。

| | claude | agy | codex |
|---|---|---|---|
| 权限模式 | `default` + `--permission-prompt-tool stdio` | `--mode plan` | 原生 `read-only` / `readOnly`，approvalPolicy on-request |
| 内置读、命令 | allow Read、Glob、Grep、Bash、WebSearch、WebFetch、`Bash(hub:*)` | allow `read_file(*)`、`command(*)`、`read_url(*)` | 原生 |
| 编辑工具 | deny Edit、Write、NotebookEdit | deny `write_file(*)` | 原生拒 |
| 写不了的硬保证 | native：claude 自带沙箱（7.3 不过就改 outer） | outer | native |
| 密钥 | 权限 deny `Read(//<路径>)` + 沙箱 `denyRead`（支持 `~/**/.env`）/ `credentials` | deny `read_file(<真实路径>)` + 外层沙箱 denyRead（seatbelt 支持正则） | `permissions.filesystem` deny_read（待实测） |
| 连接器只读 | 驱动在 `can_use_tool` 里判断（`mcp_status` 拿 annotations） | 原生（plan 认 readOnlyHint） | 原生（认 readOnlyHint） |
| 连接器补充 | 同上（判断时查 extraAllow） | allow `mcp(<服务器>/<工具>)` | `approval_mode="approve"` |
| 连接器排除 | deny `mcp__<服务器>__<工具>` | deny `mcp(<服务器>/<工具>)` | `disabled_tools` |
| 被拒后 | 模型拿到错误继续 | 显式 deny：继续；“要批准”的：整轮结束 → 驱动自动补一轮（见 2.4） | 模型拿到错误继续 |

### 2.4 现有自造代码：删哪些、留哪些

| 代码 | 处理 |
|---|---|
| `policy.ts` 的 `READONLY_PERMISSION_MODE`（dontAsk）、`READONLY_WEB_ALLOW_RULES`、`READONLY_GIT_ALLOW_RULES`、`READONLY_GIT_DENY_RULES`、`READONLY_CONNECTOR_TOOLS`、`readonlyAllowRules`（含只读 worktrees 那条） | **删**。换成 claude 翻译器生成的 allow/deny |
| `agy-protocol.ts` 的 `isReadonlySettings`、`codex-protocol.ts` 里反读 readonly | **删**，改读 `LaunchFiles.readonly` |
| `agy-protocol.ts` `AGY_PLAN_PERMISSION_ARGS` | 留（plan），加 `--settings` 的权限规则 |
| `checkWorkerToolViolation` 的只读分支（`AGY_WRITE_TOOLS` + SIGINT） | **删只读分支**（deny 规则 + 外层沙箱替代，事后 SIGINT 会把这一轮打断）；没有 OS 沙箱时的可写范围兜底分支**留** |
| agy 驱动 | **加**：结果里 `denied_actions` 非空且回复为空时，自动补发一条“上一步的 X 在只读模式下被拒了，换别的办法继续，别再调用它”（只读和非只读都有用，最多补 N 次防死循环） |
| codex `decideCommandApproval` / `decideFileChangeApproval` 里 `readonly → decline` | 留 |
| codex 驱动 `mcpServer/elicitation/request` | **加**专门分支：按 `connectorToolAllowed` 回 `{action:"accept"|"decline"}`（只读会话里补充的工具其实已经由 approval_mode 放行了，这里是兜底；非只读另议） |
| `write-scope.ts` | **加**只读档的 seatbelt profile（4.1）和 Linux bwrap 参数（4.2）；`WRITE_SCOPE_ENFORCERS` 不变 |
| `stateDirDenyRule` | 留（普通 Worker 用；只读 Worker 的 Edit 本来就全拒） |

### 2.5 以后接新厂商、新连接器

**新厂商**：
1. `READONLY_ENFORCERS` 加一项（不加编译不过）。按顺序查这家有没有：①原生只读命令沙箱（有 → `writeGuard: "native"`，进程不包外层；没有 → `"outer"`）；②权限规则或审批回调（用来放行读和命令、拒编辑工具）；③MCP 是不是原生认 readOnlyHint、有没有补充/排除的配置。
2. 跑 `experiments/readonly/` 的同一套 13 步（读外面、只读命令、编辑工具写、3 种命令行写、读密钥、3 个 MCP 工具），结果补进第 1 节的表。
3. 无头下“要批准”会不会把整轮结束（agy 会），会的话驱动要自动补一轮。

**新连接器**：什么都不用改。标了 readOnlyHint 的只读工具自动能用；没标或标错的，在 `READONLY_POLICY.connectors` 里加一行 extraAllow / deny（以后可以做成设置页）。不再维护手写清单。

## 3. 性能：工具清单怎么缓存、启动会不会变慢

实测（这台 Mac）：

| 测量 | 毫秒 |
|---|---|
| claude 起进程到 `initialize` 回来 | 415–749（跟只读与否无关） |
| claude `mcp_status`，只连测试服务器，到 connected | 640–980（从起进程算） |
| claude `mcp_status`，用户全部连接器（~40 个，含连不上、要认证的），等到没有 pending | **14 752** |
| claude `mcp_status`，已连上之后再问 | **0.1–0.3** |
| codex `mcpServerStatus/list` 全部服务器 | **6 586**（卡在 amplitude 认证失败） |
| codex `mcpServerStatus/list` 只问一个服务器（`serverName`） | 329 |
| agy plan 一轮（简单） | 10 000–16 000（模型时间，跟只读与否无关） |

结论：**启动时不去拿清单**（全量要 6–15 秒，不能放在启动路径上）。

- claude：不建持久缓存。每个会话进程在内存里放一张“工具名 → annotations”表，**第一次**有 MCP 工具来问批准（`can_use_tool`）时调一次 `mcp_status` 填表（那时它要调的服务器已经连上，0.1–0.3 毫秒）；之后表里查不到的工具名（新连上的服务器、服务器 `tools/list_changed`）再调一次刷新。进程重启表就没了，自然失效。启动 0 毫秒额外开销；每次 MCP 调用多一次驱动往返（本机管道，亚毫秒）。
- codex、agy：原生认 readOnlyHint，不需要清单。补充/排除直接写进启动配置，0 毫秒。
- 外层只读沙箱（agy）：普通 Worker 已经包 sandbox-exec（#108），只读只是换一份规则，启动时间不变（sandbox-exec 本身的开销这次在嵌套环境里量不了，#108 时没感知到变慢）。

## 4. OS 沙箱：只读 = 可写范围为空

只给 `writeGuard: "outer"` 的厂商用（现在是 agy；claude 自带沙箱不过 7.3 时也用）。`native` 的厂商进程不包（macOS 沙箱不能嵌套，跟现在只读 codex 一样）。

### 4.1 macOS（sandbox-exec）

```scheme
(version 1)
(allow default)
(deny file-write*)                                   ; 哪都不能写
(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")
       (regex #"^/dev/tty") (regex #"^/dev/fd/"))
(allow file-write* (subpath "<本会话私有临时目录>"))   ; TMPDIR 指到这，每个会话一个，退出时删
(allow file-write* (subpath "<厂商运行时目录>") …)     ; 见下表，只放子目录，不放配置文件
(deny file-read* (subpath "<密钥目录>") (regex #"/\.env(\..*)?$") …)   ; 密钥（5）
```

厂商自己运行时要写的（实测 `find -newer`，有别的会话干扰，按路径归类）：

| 厂商 | 要放的 | 不放（防止只读 Worker 改了影响以后的会话） |
|---|---|---|
| agy | `~/.gemini/antigravity-cli/{conversations,brain,cache,log,presence,updater,crashes,annotations,implicit}`、`…/cli.log`、`…/conversation_summaries.db*`、`…/jetbox_summaries_proto.pb`、`…/last_check.timestamp`、`~/.gemini/antigravity/conversation_summaries.db*`、`…/agyhub_summaries_proto.pb` | `~/.gemini/antigravity-cli/settings.json`、`~/.gemini/config/`（mcp_config、hooks、plugins） |
| claude（退回 outer 时） | `~/.claude/{projects,sessions,session-env,shell-snapshots,state,todos,plugins}`、`~/.claude.json*`、`~/Library/Caches/claude-cli-nodejs/` | `~/.claude/settings*.json`、`~/.claude/CLAUDE.md`、`~/.claude/agents|skills|commands` |

注意：
- `~/.claude.json` 里有用户级 mcpServers 配置，放了写就是一个残留风险（shell 能改它，影响以后的会话）。这是 claude 优先用自带沙箱的原因之一。
- 外层包的是整个进程，厂商起的 **stdio MCP 服务器也在里面**：好处是它们也写不了本地文件；坏处是要写缓存的服务器会坏（实测 claude 起的 MCP 会写 `~/.cache/uv`）。`~/.cache`、`~/Library/Caches` 等通用缓存目录：已拍板放开（第 8 节第 3 条），W3 的 profile 里加上。
- 路径要 realpath（`/var` → `/private/var`），跟现在的 `seatbeltProfile` 一样。

### 4.2 Linux（bubblewrap，接 `pm-notes/linux-write-scope.md`）

```
bwrap --ro-bind / /                    # 整个文件系统只读
      --dev /dev --proc /proc
      --bind <会话私有临时目录> <同路径> --setenv TMPDIR <同路径>
      --bind <厂商运行时子目录> <同路径> …   # 同 4.1 的表（Linux 上 ~/.cache 等路径按实际补）
      --tmpfs <密钥目录> …               # 盖掉密钥目录
      --ro-bind /dev/null <密钥文件> …    # 盖掉单个密钥文件
      --share-net --die-with-parent -- <厂商命令>
```

- 只读比普通 Worker 简单：普通 Worker 要“数据目录只读、里面的 worktree 可写”，只读是“全部只读、几个运行时目录可写”。
- bwrap 不支持按正则禁读：`**/.env` 这种只能启动时在工作目录和 home 下找一遍再逐个盖（有上限，找不全的靠权限规则那层）。
- 跟 macOS 一样不能嵌套：包了外层的进程不能再开厂商自带沙箱（claude 的 Linux 沙箱也是 bwrap；Ubuntu 24.04 还有非特权 user namespace 的 AppArmor 限制，claude 文档给了 AppArmor profile）。
- codex 在 Linux 上的 readOnly 用它自己的 Linux 沙箱（landlock/bwrap），不用我们管；claude 自带沙箱要装 bwrap、socat。
- 没装 bwrap / 内核不支持：照 #108 记警告，退回各家的权限规则那层（agy 没有外层时命令行写挡不住——已拍板：这种机器上派只读 agy **直接报错**，见第 8 节第 5 条）。

### 4.3 “任何地方都不能写”的例外

每个会话一个私有临时目录（TMPDIR），否则 git、编译器、shell heredoc 都会坏。claude 自带沙箱本来就是“只能写 per-user temp”。agy/outer 用我们建的目录，会话结束删。

## 5. 安全：密钥怎么排除，各层挡住什么

**默认禁读清单**（`READONLY_POLICY`，可调）：
- 目录：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.config/gh`、`~/.netrc`、`~/.git-credentials`、`~/.npmrc`、`~/.pypirc`、`~/.codex/auth.json`、`~/.gemini/oauth*`、`~/Library/Keychains`、agent-hub 自己的令牌文件（`state/` 里的 hub 令牌）。
- 通配：`**/.env`、`**/.env.*`、`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/id_ed25519*`。
- **不禁** `~/.agent-hub/state/hub.sqlite` 和日志（排查要读，这是这次改的初衷）。放开前已经查过库里有没有令牌（2026-11-07，Worker #132，见下面“令牌检查”）：**没有现行令牌**，只单独禁读 `state/ui-token` 这个文件。

**令牌检查（hub.sqlite）**：
- 会话令牌（`HUB_TOKEN`）：`agent-api/tokens.ts` 只放内存，进程环境变量里有，库里、文件里都没有。界面令牌：只在 `state/ui-token`（0600 文件），库里没有。
- 用只读方式扫了真实库的全部 15 张表（14 张有文本列，共约 2.3 万行），找：界面令牌原文、`HUB_TOKEN=值`、`sk-`、`sk-ant-`、`ghp_`/`github_pat_`、`AKIA`、`xox`、私钥头、`Bearer 值`、`password/secret/token/api_key = 值`。除 `messages` 外 14 张表（含 `hub_calls`、`actions`、`session_steps`、`agent_sessions`）**0 命中**。
- `messages` 只有工具记录（`kind=tool`，text/meta）命中：47 条是 Worker 起的**别的守护进程（测试用）打印的登录链接** `http://127.0.0.1:<端口>/auth?token=…`，不是现行 `ui-token`（原文 0 命中），那些进程早退出，令牌作废；另有几条是 Worker 写测试时的假密钥（`sk-a…`、`AKIA…`、`xoxb…`）和 `GH_TOKEN=$(gh auth token …)` 这种命令（取值的命令，不是值）。日志目录（108 个建工作区日志）、`launch/`（提示词和设置文件，令牌只在 env）、`personas/` 里没有令牌。
- 结论：没有“有令牌的表”，不用单独禁读某张表（SQLite 是单个文件，OS 沙箱和各家规则也都没法按表禁读）。`READONLY_SECRET_STATE_FILES` 里放了 `ui-token`；以后要在库里存令牌，**先挪到 `state/` 下单独的文件再加进清单**，不要让只读 Worker 读到整库。`messages` 的工具记录是自由文本，agent 以后 `cat .env`、`env` 的输出会原样进去——这是“能读库”的固有代价，跟“能联网所以读到能外发”同一类，不承诺挡住。
- 环境变量：只读 Worker 的子进程不带 `HUB_TOKEN` 以外的敏感变量（claude 有 `credentials.envVars` 和 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`）。

**各层挡什么**：

| 层 | 挡住 | 挡不住 |
|---|---|---|
| 1. 厂商权限规则（claude deny Read、agy deny read_file） | 读文件工具读密钥；claude 还会查 Bash 命令行里写明的路径（实测 `cat .env` 被拒） | 命令里拼出来的路径（`python -c`、变量）；agy 不支持通配 |
| 2. 厂商原生沙箱（claude `denyRead`/`credentials`、codex deny_read） | shell 命令及其子进程按真实路径读密钥，支持通配 | 厂商进程自己（编辑/读文件工具不在沙箱里，靠第 1 层）；MCP 服务器 |
| 3. 我们的外层 OS 沙箱（agy） | 整个进程树：编辑工具、shell、子进程、stdio MCP 服务器的写和读密钥 | 远程连接器（在别人服务器上）、网络外发 |
| 4. 连接器只读（readOnlyHint + 补充/排除） | 连接器的写操作（发消息、改工单） | 标记撒谎的服务器（readOnlyHint 是服务器自报的） |

写的保证：claude/codex 靠第 2 层（shell）+ 第 1 层（编辑工具），agy 靠第 3 层。读密钥：三层叠着挡，不承诺 100%（只读 Worker 能联网，读到就能外发，这是“能联网”的固有代价）。

## 6. 测试计划（TDD）

单元测试（先写测试，CI 跑）：
1. `readonly-policy.test.ts`：`connectorToolAllowed`——readOnly 放行、没标记拒、destructive 拒、extraAllow 放行、deny 压过 extraAllow 和 readOnly、`服务器/*` 通配。
2. claude 翻译：只读 Worker 的设置文件 = default 模式、allow/deny 如上、带 `--permission-prompt-tool stdio`、沙箱段（denyWrite、denyRead、allowUnsandboxedCommands: false、failIfUnavailable）；非只读不变。
3. claude 驱动：假进程发 `can_use_tool`（MCP 工具）→ 驱动先发 `mcp_status`、按 annotations 回 allow/deny；表里没有的工具名会再查一次；非 MCP、不在放行表里的回 deny 带中文原因。
4. agy 翻译：参数含 `--mode plan` 和 `--settings`，规则含 `read_file(*)`、`command(*)`、deny `write_file(*)`、补充/排除的 `mcp(…)`、密钥 deny 是 realpath；进程走只读 profile。
5. agy 驱动：结果 `denied_actions` 非空、回复为空 → 自动补一轮；最多 N 次。
6. codex 翻译：config 里有 `mcp_servers.<s>.tools.<t>.approval_mode="approve"`、`disabled_tools`、deny_read；elicitation 按判断回 `{action}`。
7. `write-scope.test.ts`：只读 profile 文本（deny file-write*、放的目录、密钥 deny）；Linux bwrap 参数。
8. `LaunchFiles.readonly` 替代反读设置文件：改 claude 设置文件的模式名不影响 agy/codex（回归测试）。

真 CLI 冒烟（`experiments/readonly/`，必须在**没包沙箱**的地方跑，比如项目经理或用户自己的终端）：三家各跑一次第 1 节的 13 步，期望：1–4 成功、5–9 全部没写成（看文件）、10 被拒、11 成功、12 拒、13 拒（加补充后成功）、整轮不中断。

## 7. 实现拆分（建议的 Worker 划分）

1. **W1 统一定义**（小，已做：Worker #132）：`readonly-policy.ts` + `LaunchFiles.readonly` + launch.ts 填它 + 删反读设置文件；测试 1、8。其它几个都依赖它，先合。`policy.ts` 里 claude 的只读白名单（dontAsk 那套）这次没动，W2 删。
2. **W2 claude**（中）：翻译器 + 驱动处理 `can_use_tool` 和 `mcp_status` 表；删 `policy.ts` 的只读白名单；测试 2、3。
3. **W3 agy**（中）：翻译器 + 外层只读 seatbelt profile + 自动补一轮 + 删只读 SIGINT 分支；测试 4、5、7（mac 部分）。
4. **W4 codex**（小）：补充/排除/deny_read 配置 + elicitation 分支；测试 6。
5. **W5 Linux**（中，等 Linux 兼容合了）：只读 bwrap，跟 `linux-write-scope.md` 一起做。
6. **W6 冒烟**（小，必须不在沙箱里跑）：7.3 的清单。W2–W4 可以并行，W6 在它们之后、合并前。

### 7.3 合并前必须补测的（这次测不了）

**一键跑**：`python3 experiments/readonly/smoke.py`（在没包沙箱的终端里；`--only S1,S3` 选几项，`--no-mcp` 不碰 agy 的 MCP 配置，`--dry-run` 只检查脚本，`--keep` 不删现场）。每项输出 通过 / 不通过 / 跳过 + 证据，最后一张汇总表，完整证据存 JSON；跑完删自己建的临时目录（`/tmp/ro-smoke-*`、`~/.ro-smoke-*`），S4 临时加进 agy 的 MCP 配置无条件恢复。退出码：0 全通过，1 有不通过，3 有跳过，2 环境不对（包着沙箱会直接退出）。脚本里的外层只读 profile 是 4.1 的参考写法，W3 做进 `write-scope.ts` 后换成直接生成那份再跑一遍。S6 要在 hub 会话里跑（用 `HUB_SOCK`、`HUB_TOKEN`），否则跳过。


| # | 测什么 | 怎么判 |
|---|---|---|
| S1 | claude 自带沙箱只读档：`denyWrite` 盖住工作目录和 add-dir 后，Bash 的 `echo >`/`python`/`touch` 写工作目录和外面都失败，`/tmp` 外写不了，TMPDIR 能写 | 文件没写成 |
| S2 | claude 自带沙箱的网络：`network.allowedDomains` 通配全部（`*` 能不能用）后 `curl`、`gh`、`git fetch` 能通；不能通配就退回 outer | 命令成功 |
| S3 | claude 自带沙箱 `denyRead: ["~/**/.env"]` 和 `credentials.files` 生效 | `cat` 报错 |
| S4 | agy 外层只读 profile：13 步全对，agy 自己不报写错误（会话能保存、能 `--conversation` 恢复） | 同上 |
| S5 | codex readOnly 真跑命令：读外面、只读命令能跑，3 种写都失败；`permissions.filesystem` deny_read 生效 | 同上 |
| S6 | 只读 Worker 跑 `hub` 命令照常（hub.sock 在只读沙箱里能连） | `hub status` 成功 |

S1–S3 任何一条不过：claude 改 `writeGuard: "outer"`，跟 agy 用同一份只读 profile（4.1 表里 claude 那行），权限部分不变。

## 8. 已拍板（用户，2026-11-07）

1. **只读 Worker 能联网**（WebSearch、curl、连接器读）。读到的东西能被外发，是已知的代价。
2. **写的例外：允许每个会话一个私有临时目录**（TMPDIR）。
3. **放开通用缓存目录**（`~/.cache`、`~/Library/Caches` 等）：外层沙箱里 uv、npx 这类 MCP 服务器能起；缓存里可执行的东西理论上能被“投毒”，接受。W3 的只读 profile 里加上，不再只放厂商自己的那几个子目录。
4. **密钥清单用第 5 节的默认清单；`hub.sqlite` 和日志放开读**——放开前先查库里有没有令牌，有令牌的表单独禁读。已查（第 5 节“令牌检查”）：库里没有现行令牌，所以没有要单独禁读的表，只禁读 `state/ui-token` 文件。
5. **没有 OS 沙箱的机器上，派只读 agy 直接报错**（agy 没有原生只读 shell，没有外层沙箱命令行写挡不住），不是警告后照跑。W3 在派活（`hub worker start --vendor agy --readonly`）和驱动启动两处都要拦，报错说清楚原因。
6. **claude 用自带沙箱还是外层沙箱**：先用自带（符合“优先厂商自带”，MCP 服务器不受影响，`~/.claude.json` 不用开写），前提是 7.3 的 S1–S3 通过；不过就改外层。
7. **codex 非只读 Worker 用不了没标只读的 MCP 工具**（比如发 Slack）：另开一题，这次不做。
