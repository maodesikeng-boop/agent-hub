# 方案和验收证据做成能点开的文件

## 给用户看

要验收的文件：

- [方案全文](/Users/yuxin.zhangnewsbreak.com/.agent-hub/worktrees/7/595/docs/deliverables-design.md)：就是这份文件。
- [桌面草图](/Users/yuxin.zhangnewsbreak.com/.agent-hub/worktrees/7/595/docs/screenshots/deliverables/sketch-desktop.png)：总助里一张等你确认的卡和一条做完的简报。卡片和简报下面都有一排文件：方案、验收结论是蓝色链接，截图、录屏是小图，点开就看，录屏点开就播。
- [手机草图](/Users/yuxin.zhangnewsbreak.com/.agent-hub/worktrees/7/595/docs/screenshots/deliverables/sketch-mobile.png)：同样内容在手机上的样子。小图放不下时左右滑。

要拍板的事：

1. **截图、录屏在卡片里怎么显示。**
   - A：直接显示 96px 高的小图，录屏小图上有播放键（草图就是这样）。
   - B：和方案一样，只列一行文件名，点开才看到图。
   - 推荐 A：你说要“很方便地看到”，小图不用点就能看到大概，卡片也只多一行高。

## 用户目标

用户原话（优先级最高）：

> 「我并不能知道方案是什么」
> 「我的理想状况是从router处就可以得到具体的方案，同时方案是一个文件，我至少要可以很方便的看到才行，包括验收的情况，截图，录屏什么的」
> 同一天更早：「只需要给我验收的文件 + 需要我排版的问题 + 我直接问你的时候」（“排版”是“拍板”）

附的截图里，卡片标题是“方案标准改好了，请验收：/tmp/plan-standard.md（85 行）”，路径是纯文字，点不开。

我的理解：每件事做出来的方案、验收结论、截图、录屏，都是一个个文件。它们要跟着这件事走到用户面前：对话里的卡片、右栏、总助，三处点一下就能看，手机和桌面都行。用户不翻对话，不找路径。

## 现状

1. **总助拍板卡的标题是纯文字，路径点不开。** 实测：写临时测试渲染 `RouterDecisionCard`，标题传“方案标准改好了，请验收：/tmp/plan-standard.md（85 行）”，`<h3>` 的内容就是这串文字，没有链接（`src/web/components/RouterDecisionCard.tsx:116`）。
2. **总助拍板卡的补充说明里，本机文件链接不会变成文件。** 实测：同一个临时测试里补充说明写 `[plan](/tmp/plan-standard.md)`，渲染出 `<a href="/tmp/plan-standard.md">`，没有 `[data-file-link]`。原因是 `<Markdown>` 没带 `files`（`RouterDecisionCard.tsx:48`）。点它会在新窗口打开界面地址下的 `/tmp/...`，守护进程没有这条路由，回 `not_found`（`src/daemon/ui-server/server.ts:1098`，推断，没在线上点）。
3. **对话里的提问卡（`hub ask`）也一样。** 实测：临时测试渲染带 `needsUser` 的消息，正文写 `[plan](/tmp/plan-standard.md)` 和 `![shot](/tmp/a.png)`，结果是一个普通 `<a target="_blank">`，图片换成了说明文字，没有文件链接。原因是提问卡消息入库时只写 `AskMeta`，不跑存副本（`src/daemon/ledger/messages.ts:156`）；存副本只在 agent 普通回复入库时做（`messages.ts:361`）。所以 `AskCard` 拿到的 `files` 永远是空的（`src/web/components/Messages.tsx:329`）。
4. **任务图的“通过 / 打回”检查点卡只带摘要、交棒、提交、PR，不带文件。** 实测（读代码）：卡片正文由 `src/daemon/ledger/task-graphs.ts:3747` 起的一段拼出来，只有这几项；Worker 汇报里的“测试”栏（截图路径一般写在这里）没放进去。它也是提问卡，同第 3 条，正文里就算有链接也点不开。
5. **`hub router report --file` 存的是一条普通链接，总助里显示成灰字。** 实测：库里第 55 条简报的 `links_json` 是 `[{"label":"PR #330",…},{"label":"plan-standard.md","target":"/tmp/plan-standard.md"}]`（`sqlite3 -readonly hub.sqlite "SELECT links_json FROM router_items WHERE id=55"`）。`--file` 只是把路径当链接地址塞进 `links`（`src/hub/cli.ts:936`）；网页的 `parseBriefingLink` 只认网址、`worker:`、`conversation:`，别的走灰字 `<span>`（`src/web/components/RouterStream.tsx:74`、`:142`）。
6. **右栏 Needs You 的提问行、果皮轨的门禁卡也不带 `files`。** 读代码：`src/web/components/RightRail.tsx:193`、`src/web/components/PeelTrack.tsx:274`（推断，没单独渲染）。
7. **项目经理在普通回复里写 `[名字](/绝对路径)` 能变成可预览的文件。** 任务说明里已实测。可分享的目录：项目文件夹、本项目 worktree、会话 cwd、上传目录、`/tmp`（`src/daemon/ledger/sent-files.ts:61`）。副本按“文件名 + 内容”的哈希命名，同一个文件发多次只存一份（`src/daemon/sent-files.ts` 文件头）。
8. **录屏能播。** 实测：`pnpm vitest run src/web/file-preview.test.tsx src/daemon/ui-server/file-actions.test.ts`，46 个测试全过。其中“视频、音频：原生播放器”断言预览窗里是带 `controls` 的 `<video>`（`src/web/components/FilePreview.tsx:273`）；“视频：带 Range 取得到”断言取副本支持单段 Range、回 206（`server.ts:692`）。认的视频扩展名：mp4、m4v、mov、webm（`src/shared/sent-files.ts:64`）。单个文件上限 50 MB（`MAX_SENT_FILE_BYTES`）。
9. **预览窗支持的格式。** 读代码（`src/shared/preview.ts` 的 `previewKindOf`）：图片、pdf（内联）、html（沙箱 iframe）、md（渲染，可切源码）、csv/tsv（表格）、代码和纯文本（上色）、视频、音频，别的只给下载。
10. **证据放在 worktree 里会丢。** 读代码：worktree 收工 3 天后清掉（`WORKTREE_RETENTION_DAYS`），被 `.gitignore` 忽略的截图跟着删（`src/daemon/worktree-cleanup.ts:13`）。副本留 30 天（`FILE_RETENTION_DAYS`），和总助条目留的天数一样。
11. **现在的零散做法。** 项目经理在卡片标题里写 `/tmp/...` 纯文字；验收结果贴在 PR 评论里（库里第 48 条简报的链接写的是“PR #328（验收评论”）；Worker 在汇报“测试”栏里写截图路径（`src/shared/worker.ts:36`）。这三处用户都点不开或要离开总助才能看。

## 做法比较

先定数据形状。交给用户看的文件统一叫“交付物”（`Deliverable`）：一份存好的副本加一个给人看的标签。方案、验收结论、截图、录屏不分四种类型，类型由文件本身决定（md/pdf 是文档，png 是图，mp4 是视频），“方案”“验收结论”就是标签。它们挂在三处：

| 挂在哪 | 从哪来 | 到哪去 |
| --- | --- | --- |
| 任务图步骤 `artifact.deliverables` | Worker 汇报新加的“文件”栏；`hub ask --node --file` | 检查点卡、果皮轨门禁卡、总助拍板卡；`graph finish` 时汇总进简报 |
| 提问卡 `AskMeta.deliverables` | `hub ask --file`；检查点卡带步骤的 | 对话里的卡、右栏 Needs You；同一事务写进总助条目 |
| 总助条目 `router_item_deliverables` | 上一行桥接；`hub router report --file`；`graph finish` 汇总 | 总助拍板卡、简报 |

三种做法：

| | A：哪里有文字链接就在哪里存副本 | B：交付物是一份结构化列表（推荐） | C：另建一个交付物目录和浏览页 |
| --- | --- | --- | --- |
| 做法 | 提问卡、总助条目入库时都跑一遍现有的存副本，网页各处 `<Markdown>` 带上 `files` | 上表。存副本还是现有那一处，只是认出来的文件记成列表，跟着步骤、卡片、条目走；一个组件在四处显示 | 文件拷到 `~/.agent-hub/deliverables/<任务图>/`，总助加一个页面按任务图列文件 |
| 卡片标题里的路径 | 还是点不开（标题不是 Markdown） | 文件不放标题里，放卡片下面一排 | 要去另一个页面看 |
| 一件事的全部文件 | 散在各条消息里，总助看不到全貌 | `graph finish` 自动汇总，总助一条简报就全了 | 有，但离开了卡片 |
| 截图、录屏 | 只能是正文里 240px 的大图或链接 | 小图一排，点开预览 | 页面里看 |
| 新代码量 | 少 | 中：一个类型、一个组件、汇报加一栏、两个 `--file` | 多：新存储、新清理、新权限判断、新页面 |
| 跟现有机制 | 复用存副本 | 复用存副本、预览窗、清理 | 和存副本重复一套 |

推荐 B。A 解决不了“标题点不开”和“总助看不到一件事的全部文件”，项目经理还得每次手写链接。C 重做了已有的存副本、清理和权限判断。B 只在现有存副本上加一层“这些是交付物”的记录：拷文件、判断能不能分享、30 天清理、预览窗都不动。

B 的几个具体规定：

- **Worker 汇报加第 9 栏“文件”**，每个写成 `[标签](路径)`，没有写“无”。`测试` 栏不再写截图路径。汇报消息入库时本来就存副本，账本只按“文件”栏挑出对应的副本记进步骤，不再拷。再交一次汇报时换成新的。
- **验收步骤交一份“验收结论”文件**（Markdown，写结论、怎么验的、每张截图说明什么），连同截图、录屏写进“文件”栏。只读 Worker 写到 `/tmp/<主题>-verify/` 也能分享。
- **录屏用 mp4（H.264）**。浏览器自动化录出来的多是 webm，用 `ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4` 转（本机已装 ffmpeg）。理由：macOS 的 WKWebView、Windows 的 WebView2、iOS Safari 都能播 H.264 mp4；webm 在旧版 Safari 上不稳（推断，没逐个试）。单个不超过 50 MB。
- **项目经理挂卡用 `--file`**：`hub ask --file 方案=docs/x-design.md`、`hub router report --file …`，可写多个。不再把路径写进标题。`--link` 的地址是本机路径时拒绝，提示改用 `--file`。
- **卡片里的样子**照 `docs/ui-standard.md` 第 22 条（这次新加）：标题 → 摘要（正文第一段）→ 文件 → 细节（交棒、提交、PR、链接；一行放得下直接显示，超过一行默认收起）。文件两行，文档一行蓝色链接，图片和视频一行 96px 小图。四处共用 `<CardBody>`。

## 性能

| 常量（`src/shared/limits.ts`） | 值 | 怎么算的 |
| --- | --- | --- |
| `DELIVERABLES_PER_CARD_MAX` | 6 | 方案、验收结论、桌面截图、手机截图、录屏，再留 1 个 |
| `DELIVERABLES_PER_STEP_MAX` | 10 | 和一条消息最多存几个副本（`MAX_SENT_FILES_PER_MESSAGE`）一样，汇报栏里多写的也存不下 |
| `DELIVERABLES_PER_REPORT_MAX` | 12 | 一张图常见 3 步，每步 4 个 |
| `DELIVERABLE_LABEL_MAX_CHARS` | 40 | 标签是“方案”“桌面截图”这种短词 |
| `HUB_FILE_ARGS_MAX` | 6 | 同一张卡的上限 |

一个交付物的 JSON 约 230 字节（标签、16 位编号、文件名、类型、大小、原链接、来源消息）。

1. **失效。** 交付物指向的是副本，副本按内容哈希命名，原文件改了、Worker 再交一次汇报，会存成新副本、换成新列表；不会显示旧内容当新的。删除：`router_item_deliverables` 跟着总助条目删（外键级联，条目留 30 天）；副本 30 天后被清，卡片显示“文件已过期”。不缓存失败结果：这次不加任何请求缓存，取文件失败由组件当场显示。
2. **上限。** 每张卡、每步、每条简报都有上表的上限。快照：等你拍板的卡最多 50 张（`ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX`），平时不到 10 张，10 × 6 × 230 ≈ 14 KB；简报已有 24 KB 的字节上限（`ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES`），带文件的简报多了，快照里的条数会少几条，更早的走翻页。任务图步骤的交付物，全量快照里只给等你拍板的步骤带，单图详情都带。磁盘：同一个文件在汇报、检查点卡、简报里是同一份副本（内容哈希），汇总不多拷。一个月 300 个 Worker、每个一段 20 MB 录屏，最多约 6 GB，30 天清一轮；这和现在 agent 在回复里发文件的上限一样，没有新增。
3. **前端引用稳定。** `groupDeliverables`、`sentFilesOfDeliverables` 按输入数组用 `WeakMap` 缓存，同一个列表返回同一个对象；`pendingDecisionsOf` 原样带上条目里的数组引用，不复制。
4. **验证。** `src/daemon/ledger/snapshot-size.test.ts` 有两个场景：
   - 一个月数据集再加 10 张各带 6 个常见长度交付物的待拍板卡：354,432 字节，不超过 `SNAPSHOT_MONTH_MAX_BYTES`（384 KB）。
   - 最坏情况：总助写满，等你拍板的卡补满 50 张各带 6 个，等确认的步骤各带 10 个，文件名 255 字节、原链接 4096 字节（`MAX_PATH_BYTES`）：1,593,345 字节，gzip 后 638,911 字节，守 `SNAPSHOT_DELIVERABLES_WORST_MAX_BYTES`（2 MB）。
   - 超过 384 KB 时运行时不裁剪：快照整份发，压缩后传，网页照常显示。实测：真守护进程上“总助写满 + 10 张卡各带 6 个”的 `/api/state` 返回 200，413,329 字节（gzip 17,542 字节），25 张待拍板卡、每张的交付物都在，桌面和手机页面正常（`docs/screenshots/deliverables/snapshot-worst-desktop.png`）。

## 统一

- **厂商。** 汇报格式只在 `src/shared/worker.ts` 的 `WORKER_REPORT_FORMAT` 一处，原样进每家 Worker 的提示词；项目经理的说明在 `src/daemon/prompt.ts`；`--file` 在 `src/hub/cli.ts`。都不分厂商（`src/shared/vendors.ts` 里有几家都一样）。以后加一家新厂商，这块不用改任何文件。
- **平台。** 能不能分享、路径比对都走现有的 `isShareable`（Windows 走 `src/daemon/platform/index.ts` 的 `isPathInsideOrEqual`、`normalizePathForComparison`）。`parseHubFileArg` 认 `C:\…` 这类 Windows 路径（`=` 前面含 `\` 时不当标签）。播放：三种桌面外壳都用系统 WebView，统一交 mp4（H.264）。
- **多设备。** 交付物的地址按条目所在设备取：总助里别的设备的卡片和简报包在那台设备的 `DeviceScope` 里，`client.url` 自动走代理。老版本设备发来的条目没有 `deliverables`，当空列表。

## 删掉什么

同一个 PR 删掉或改掉：

- `src/hub/cli.ts:936`：`--file` 塞进 `links` 的那段，改成 `files`。
- `src/shared/worker.ts:36`：“测试”栏里的“界面改动附截图路径”，挪到新的“文件”栏。
- `src/daemon/ledger/router.ts` 的 `reportIn`：`links` 里收本机路径的口子，改成拒绝并提示用 `--file`。
- `src/daemon/prompt.ts:293` 下面加一句：给用户看的文件挂卡时用 `--file`，不写在标题里。`src/shared/task-graph-skill.ts` 里“怎么算做完”的证据写法改成“写进汇报的文件栏”。
- 旧说法：验收结果贴 PR 评论、卡片标题写 `/tmp/...`。项目经理的提示词和任务图手册里不再这样教。

保留：普通回复里的 `[名字](/绝对路径)`（第 7 条，聊天里发文件照旧）；`RouterStream.tsx:142` 的灰字分支（老简报的链接还要显示，30 天后自然没有）。

## 骨架文件

- `src/shared/deliverables.ts`：交付物的类型和纯函数（解析、合并、汇总整张图、分组、给 `<Markdown>` 用的文件列表、解析 `--file`）。
- `src/shared/deliverables.test.ts`：上面这些的 `it.todo`。
- `src/daemon/deliverables.ts`：从汇报“文件”栏、正文链接、`--file` 认出交付物。
- `src/daemon/deliverables.test.ts`：同上的 `it.todo`。
- `src/daemon/ledger/sent-files.ts`：新加 `filesForArgs`，`--file` 存副本走和回复链接同一套规则。
- `src/daemon/ledger/messages.ts`：`insertAskMessage` 多一个 `deliverables` 参数。
- `src/daemon/ledger/router.ts`：行类型多一个 `deliverables_json`（从新表 LEFT JOIN）。
- `src/daemon/ledger/deliverables-flow.test.ts`：汇报 → 步骤 → 检查点卡 → 总助、`--file`、`graph finish`、快照体积的 `it.todo`。
- `migrations/0028_deliverables.sql`：新表 `router_item_deliverables`（旁表，迁移能重跑）。
- `src/shared/domain.ts`：`TaskArtifact.deliverables`、`AskMeta.deliverables`。
- `src/shared/router.ts`：拍板项、简报的 `deliverables`。
- `src/shared/decisions.ts`：`PendingDecision.deliverables`。
- `src/shared/hub.ts`：`ask`、`router.report` 的 `files`。
- `src/shared/worker.ts`：`WorkerReport.files`（“文件”栏原文）。
- `src/shared/limits.ts`：上面性能表里的常量。
- `src/web/components/Deliverables.tsx`：四处共用的 `<DeliverableFiles>`。
- `src/web/deliverables.test.tsx`：组件和四处入口的 `it.todo`。
- `src/hub/cli.test.ts`、`src/shared/worker.test.ts`：`--file` 和“文件”栏的 `it.todo`。
- `docs/ui-standard.md` 第 22 条：交付物在卡片里的样子。
- `docs/screenshots/deliverables/`：草图（`sketch.html` 是源文件）。

## 验收方法

1. **测试。** 上面列的 `it.todo` 全部变成真断言并通过：`pnpm vitest run src/shared/deliverables.test.ts src/daemon/deliverables.test.ts src/daemon/ledger/deliverables-flow.test.ts src/web/deliverables.test.tsx src/shared/worker.test.ts src/hub/cli.test.ts src/daemon/ledger/snapshot-size.test.ts`，加 `pnpm typecheck`。
2. **在真守护进程上走一遍。** 用本机守护进程建一张三步的小任务图（方案、实现、验收，验收步骤 `confirm: true`），Worker 在汇报“文件”栏交：方案 md、验收结论 md、桌面截图、手机截图、一段 mp4 录屏。然后核对：
   - 对话里的检查点卡、右栏果皮轨门禁卡、总助拍板卡，三处都列出这 5 个文件；点方案打开渲染好的 md；点截图看大图；点录屏能播、能拖进度条。
   - `hub graph finish` 后，总助简报下面列出整张图的文件。
   - `hub ask --file 方案=/tmp/x.md` 挂的卡，三处都能点开 `x.md`。
   - 关掉 worktree（或删掉原文件）后，卡片里的文件仍能打开（看的是副本）。
3. **证据。** 实现步骤交：桌面截图（1280 宽）和手机截图（390 宽）各一张，拍总助里的检查点卡；一段 mp4 录屏，从总助点开方案、截图、录屏。这三个文件本身写进实现步骤汇报的“文件”栏，验收时直接在总助那张检查点卡里点开看。录屏可以用 Playwright 的 `recordVideo` 或 chrome-devtools 的录屏，再用 ffmpeg 转 mp4。
4. **快照体积。** `snapshot-size.test.ts` 新场景前后的字节数写进 PR。
