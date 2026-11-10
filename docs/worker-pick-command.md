# 输入框里指定派 Worker 的厂商、模型、思考程度（方案）

用户原话：“在这里加入一个命令，用户输入的时候可以指定派出 worker 的厂商和模型和思考程度，输入后有提示，选择就行”。
“这里”是和项目经理聊天的输入框。这份只写方案，不改代码（Worker #314，2026-11-10）。

## 0. 推荐做法（一段话）

在已有的 “/” 列表最前面加一个 agent-hub 自己的命令 `/hub:worker`（只在项目经理对话里出现）。选中后像命令行补全一样一级一级往下选：
厂商 → 模型 → 思考程度，每一级都是同一个弹出列表，可以点也可以接着打字筛；选完整段命令从文字里拿掉，变成输入框里一个可删的小标签。
发送时这个选择作为消息的一个字段（`workerPick`）发给守护进程，存进 `meta`，交给项目经理时在原文前面单独加一块
`【用户指定：这条消息里派的 Worker 用 --vendor … --model … --effort …】`；项目经理提示词“用别家的模型”那条加一句怎么对待它。
清单只从 `GET /api/models`（背后 model-catalog）来，和资料页同一个 react-query 缓存，打字只在本地筛，不多发请求。

## 1. 现状（已核实）

- **“/” 和 “@”**：`composer-trigger.ts` 的 `detectComposerTrigger` 只认整条消息开头的 “/”，光标还在第一个词里才弹；
  `composer-suggest.ts` 的 `useComposerSuggest` 用 react-query 拉 `GET /api/conversations/:id/commands`（每次打开都重问，`staleTime: 0`），
  `rankCommands` 本地筛；`ComposerMenu.tsx` 画列表（`h-9` 行、最多 8 行、`onMouseDown` 阻止失焦）。列表为空或拉失败就不弹。
- **命令从哪来**：`daemon/composer.ts` → `commands-catalog.ts`（按厂商 + 目录缓存，`isHiddenCommand` 藏掉厂商自带的危险命令）。
  厂商名单里的名字是厂商 CLI 自己的（claude 的插件命令是 `插件:名字` 形式）。网页不认识厂商。
- **“/” 开头的消息会被厂商当命令**：`vendors/claude.ts` 的 `commandNameOf`、`blockReason`；只有最后一个 text 块以 “/” 开头才展开，
  所以我们加的字一律放在前面单独一块（`shared/worker.ts` 的 `deliveryParts` 的 `prefixes`，`USER_TO_WORKER_TAG` 就是这么加的）。
- **模型清单**：`driver/model-catalog.ts` 的 `createModelCatalogs().list()`，每家厂商一份 `ModelCatalog`（`models[]` 每项带 `efforts`，
  `defaultEfforts`、`defaultModel`、`availability`），按 `AGENT_VENDORS` 顺序，问不到用打包的；缓存 6 小时（`MODEL_CATALOG_FRESH_MS`），
  凭据或 CLI 变了按文件指纹立即重问，失败 5 分钟后再问。网页走 `GET /api/models`。
- **资料页怎么选**：`AgentRows.tsx` 用 `models.tsx` 的 `useVendorChoices`（没装的不列、没登录的灰掉标 `Not signed in`）、`useModelCatalog`、
  `effortsFor(catalog, model)`（只给这个模型支持的档位）、`defaultModelText`（“默认”写出实际用哪个）。react-query 键 `["models", 设备]`，
  `staleTime` 5 秒，拉到之前返回打包的名单 `BUNDLED`。**这几个函数直接复用。**
- **派活**：`hub worker start --vendor --model --effort`；`--vendor` 能选的 = `AGENT_VENDORS` 里这台设备上 `isSelectable` 的（`prompt.ts` 的 hub 用法按它列）。
- **发消息**：`PostMessageRequest { clientId, text, attachmentIds? }`；附件的先例：服务端算好放进 `meta.attachments`，`agentTextOf` 拼给 agent，网页从 `meta` 画。

## 2. 怎么触发、怎么选

- **触发**：在 “/” 列表里加 agent-hub 自己的命令 `/hub:worker`（说明 `Pick provider, model and effort for Workers`）。
  不另造触发符：“/” 用户已经熟，“#”“+” 在正文里常见（`#123`、`a+b`），会误弹。
- **和厂商命令撞名**：名字用 `hub:` 前缀（同厂商插件 `插件:名字` 的约定），厂商自带命令不带冒号，撞名只可能是用户装了叫 `hub` 的插件。
  hub 自己的命令由网页加在列表**最前面**（筛选时同一档里也排前面），不进 `commands-catalog`；厂商名单拉失败时它照样出现。
  只在项目经理对话（`conversation.kind === "pm"`）出现，Worker、总助的对话里没有。
- **三级，像命令行补全**（一级搜索把 3 家 × 几十个模型 × 档位摊平会有上百行，手机上没法挑）：
  1. 选中 `/hub:worker` → 文字变成 `/hub:worker `，列表换成**厂商**；
  2. 选厂商 → 插入厂商 id，`/hub:worker codex `，列表换成这家的**模型**，第一行 `Default`（说明写实际用的模型，`defaultModelText`）；
  3. 选模型 → 列表换成这个模型支持的**思考程度**（`effortsFor`），第一行 `Default`；只有一档或没有档位时跳过这一级。
  - 每一级都能接着打字筛（本地 `rankCommands` 同款规则：开头命中 > 包含 > 说明里有），Backspace 删到上一级就回上一级；
  - 选完最后一级：整段 `/hub:worker …` 从文字里拿掉，换成小标签，光标回到原位；
  - Esc 关列表，文字不动（和现在一样）；手打完整 `/hub:worker codex gpt-5.5 high` 再按 Enter 也认（最后一级选中即完成）。
- **只列能派的**：厂商按 `useVendorChoices` 规则——没装的不列，没登录的列出来但不可选，说明位写 `Not signed in`（和资料页一致）。
  模型只列这家名单里的（不提供“自定义模型名”，要自定义直接在话里写）；档位只列 `effortsFor` 给的。
- **默认值**：不选 = 不加标签 = 项目经理自己定（现状）。选了厂商、模型和档位都停在 `Default` 时，只传 `--vendor`。
  高亮默认停在第一行；厂商顺序照名单（`AGENT_VENDORS`），不按当前项目经理排。
- **实现位置**：`composer-trigger.ts` 加 `kind: "worker"`，解析 `/hub:worker` 后的参数（第几级、已选的、正在打的）；
  新文件 `src/web/worker-pick.ts` 放纯函数：按级别、已选参数、查询词从 `ModelCatalog[]` 算出列表行（`MenuItem`），`WeakMap` 按 catalogs 数组缓存；
  `composer-suggest.ts` 把它接进现有的 `menu / handleKey / select`，不新造一套键盘逻辑。

## 3. 选完在输入框里长什么样

- **小标签，不是纯文本**：纯文本会被当成消息正文发出去、被厂商当 “/” 命令，还容易被误删一半。标签放在“待发文件”那一排（同一个 `ul`，排在文件前面），
  样式照文件标签：`rounded-full bg-muted py-1 pr-1 pl-3 text-minor`，左边 `Bot` 图标（`size-4` 灰），然后厂商名、模型名、档位三项，
  `gap-2` 隔开，不用 “·”；`Default` 的项不显示（只选了厂商就只有厂商名）；最右边 `×`（`CHIP_CLOSE_CLASS`，自带 `touch-target`）。
- **可删可改**：点 `×` 删掉；点标签本身 = 在消息开头插入 `/hub:worker ` 重新走一遍（选完替换旧标签）；再打一次 `/hub:worker` 也是替换。一条消息最多一个标签。
- **跟着草稿走**：和文字一样按对话存（切走再回来还在），发出去后清掉；发送失败文字留在输入框时标签也留着，重发（`onRetry`）带同一个选择。
- **发出去的气泡**：用户气泡上方显示同样的标签（只读，没有 `×`），从 `meta.workerPick` 画，让人看得出这条带了指定。
- **手机外壳**：列表在输入框正上方占位（不浮层），软键盘弹着也看得见；触屏下列表行 `min-h-11`（44px，第 19 条，现在的 `ComposerMenu` 也缺，顺手补）；
  选行用 `onPointerDown` 阻止失焦，点了键盘不收起（iOS 上实测）；手机上 Enter 是换行，不影响点选。手机上走到第三级要点三下，比打字快。

## 4. 怎么送到项目经理

- **请求**：`PostMessageRequest` 加可选的 `workerPick: { vendor: string; model: string | null; effort: string | null }`。
  服务端用 zod 校验形状和长度（`vendor` 在 `AGENT_VENDORS` 里，`model` 过 `checkModel`，`effort` 是短字符串），**不**查这台设备现在能不能用
  （那是 `hub worker start` 的事，它本来就会报“没登录”）；不是项目经理对话带了它 → 400 `invalid`。
- **存**：放进消息的 `meta.workerPick`（和 `meta.attachments` 一样），库里原文不变，网页照原文显示。
- **交给项目经理**：`deliveryParts` 有 `workerPick` 时在 `prefixes` 加一块（原文仍是最后一块，“/” 命令照常能展开）：
  `【用户指定：这条消息里派的 Worker 用 --vendor codex --model gpt-5.5 --effort high】`（`Default` 的那项不写）。
  直接写成 `hub worker start` 的参数，项目经理照抄就行，不用再换算名字。拼这句的函数放 `shared/worker.ts`，挨着 `USER_TO_WORKER_TAG`，
  `prompt.ts` 文件头“给 agent 看的话不止这里”那张清单加一行。
- **提示词**：要加一句，加在 `prompt.ts` 的 `buildPmWorkerPrompt`“用别家的模型”那条后面（所有厂商的项目经理共用这一处）：
  “用户消息前面带【用户指定：…】时，回应这条消息派的 Worker 都按它传 `--vendor`/`--model`/`--effort`；派不派、派几个、怎么拆仍由你定；
  用户在话里另有说法以话为准。”只给偏好，不拦截：`hub worker start` 不检查它，项目经理不照做也不报错。
- **生效范围**：对回应**这一条消息**时派出的**所有** Worker 生效（拆成三个就三个都用它），不往后面的消息延续；`hub worker send` 打回已有的 Worker 不受影响（换不了模型）。

## 5. 统一

- 清单只从 `GET /api/models` 来（背后 `model-catalog.ts`），网页只用 `models.tsx` 已有的 hook 和 `shared/vendors.ts` 的 `effortsFor`、`isListed`、`isSelectable`、
  `effortLabel`，不读 `VENDOR_SPECS`、不写任何厂商名或模型名。`AGENT_VENDORS` 加一家、厂商 CLI 报出新模型，列表自动多出来。
- 拿哪台设备的清单：和资料页一样用 `useClient()`（对话所在设备的 DeviceScope），和这个对话的 `conversationSource` 是同一个 client——实现时用测试钉住。
- 校验和拼参数句子在 `shared/`，前后端共用一份；`hub:worker` 这个名字和说明也放 `shared/`（`HUB_COMPOSER_COMMANDS`），不散在组件里。

## 6. 性能

- **不加新接口、不加新缓存**：复用 react-query 键 `["models", 设备]`，和资料页、新建弹窗共用，`staleTime` 5 秒；守护进程那边是 model-catalog 已有的缓存。
- **数据量**：打包名单 3 家 17 个模型，JSON 2.4 KB、gzip 后 0.5 KB（本机实测）；厂商实报的带说明，单家上限 `MAX_CATALOG_MODELS` 50 个、
  说明截到 200 字，3 家最坏几十 KB，常见 5～10 KB，经 `@fastify/compress` 压缩后 1～3 KB。
- **请求次数**：检测到 “/” 触发（命令列表打开）时预取一次清单；之后选厂商、模型、打字筛都在本地算，**打字不发请求**。
- **第一次弹出要多久**：列表不等请求——还没拉到时先用打包的名单（`models.tsx` 现成行为），拉到后按 id 换上、高亮不跳。
  所以第一次弹出就是一次本地渲染；手机弱网（RTT 400 ms 左右）真名单约 0.5～1 秒后到，守护进程刚重启、名单没问过时，最慢等厂商探测（claude 约 0.9 秒，超时上限 15 秒），这段时间显示打包的。
- **4 件事**：失效、上限交给 model-catalog 已有的指纹和 `MAX_CATALOG_*`；新增的只有“每个对话一个草稿标签”，项目经理对话个数有限，发出或删除就清掉；
  `worker-pick.ts` 的行按 catalogs 数组 `WeakMap` 缓存，同一份名单同一级同一查询返回同一个数组；PR 里用 `benchmark-checklist` 记打字时的渲染次数（改前改后）。

## 7. 界面（对照 `docs/ui-standard.md`，已加载 frontend-rules）

- 列表沿用第 18 条：输入框正上方、同宽、占位、`rounded-2xl border p-1.5`、`h-9 rounded-xl px-3` 的行、高亮 `bg-sidebar-active`、最多 8 行。
- 每行左边主名字（15px、500），右边一句灰字（13.5px、`truncate`），中间 `gap-3`，**不用 “·”“/” 拼接**：
  - 厂商：`Claude Code`；不能用的灰掉、右边状态词英文 `Not signed in`；
  - 模型：模型的显示名（`label`），右边是厂商给的说明；第一行 `Default`，右边是实际用的模型；
  - 思考程度：`effortLabel` 的英文（`Low`、`Medium`、`High`…），第一行 `Default`。
- 不加标题、面包屑、提示小字：已选的路径就在输入框文字里（`/hub:worker codex gpt-5.5 `），列表只放选项。加载中不转圈（有打包名单兜底）。
- 没匹配：一行灰字 `No matching providers` / `No matching models` / `No matching effort`。
- **标准没覆盖、实现时先补进 `docs/ui-standard.md` 的**：
  1. 第 18 条“选中后纯文本，不做小标签”要加例外：`/hub:worker` 选完变标签（样式、位置、`×`、点击重选）；
  2. 第 18 条加“多级参数补全”：一条命令后面一级一级换列表、Backspace 回上一级、最后一级选完才收；
  3. 第 18 条加触屏：行 `min-h-11`、用 `onPointerDown` 阻止失焦（第 19 条只写了右栏的行）；
  4. 第 17 条用户气泡上方的只读标签；
  5. 第 3 条措辞表补：`Default`、`Remove`、`No matching providers/models/effort`、读屏名字 `Worker model`；
  6. 第 18 条“没有匹配”的示例还是中文（“没有匹配的命令”），代码早已是英文 `No matching commands`，顺手改成英文。

## 8. 拆分（3 个小 PR，都先写测试）

**PR1 后端和提示词**（不碰界面，可和 PR2 同时做）
- 改：`shared/api.ts`（`PostMessageRequest.workerPick`）、`shared/worker.ts`（类型、zod 校验、拼参数句子、`deliveryParts` 加前缀块）、
  `daemon/ui-server/` 收消息的校验、账本存 `meta.workerPick`、`daemon/prompt.ts`（`buildPmWorkerPrompt` 加一句、文件头清单加一行）。
- 先写的测试：`shared/worker.test.ts`（有/没有 pick 的 `prefixes`；只有厂商时只出 `--vendor`；原文以 “/” 开头仍在最后一块）；
  ui-server 的发消息测试（形状不对 400、非项目经理对话 400、存进 `meta`）；`daemon/prompt.test.ts`（这句在三家项目经理的提示词里都有，里面没有写死厂商名）。

**PR2 选择列表**（先补标准第 1～3、5、6 项，再改代码）
- 改：`docs/ui-standard.md`、`shared/` 的 `HUB_COMPOSER_COMMANDS`、`web/composer-trigger.ts`（`kind: "worker"` 和参数解析）、新 `web/worker-pick.ts`、
  `web/composer-suggest.ts`（hub 命令排最前、厂商名单拉失败也出现、只在项目经理对话）、`web/components/ComposerMenu.tsx`（触屏行高、`onPointerDown`）。
- 先写的测试：`composer-trigger.test.ts`（第几级、半个词、Backspace 回级、正文里的 `/hub:worker` 不触发）；
  `worker-pick.test.ts`（没装的不列、没登录的不可选、只列支持的档位、只有一档跳过、筛选排序、同输入同引用）；
  `composer-suggest.test.ts`、`Composer.test.tsx`（Enter/Tab 选中不发送、Esc、Worker 对话里没有）。

**PR3 标签、发送、气泡**（先补标准第 4 项）
- 改：`web/components/Composer.tsx`（标签、`×`、点击重选）、草稿存选择（`upload.ts` 的 `DraftSlot` 旁加一个按对话的 zustand store）、
  发消息和重发带 `workerPick`、`web/client.ts`、用户气泡的只读标签。
- 先写的测试：`Composer.test.tsx`（选完变标签、文字里不留命令、删、重选替换）、发送测试（请求体带 pick、重发带同一个、发出后清掉）、气泡测试；
  电脑和手机（Chrome 模拟 390×844 触屏）截图放 `docs/screenshots/worker-pick/`，iOS 上确认点选时键盘不收。

## 9. 要用户拍板的事

1. **命令名**：推荐 `/hub:worker`（带前缀，不会和厂商命令、用户自己的 skill 撞名）；另一个选择是更短的 `/worker`（打字少，但可能和用户的 skill 同名，两个都列出来）。
2. **生效范围**：推荐对这条消息派出的所有 Worker 都生效；另一个选择是只管第一个。
3. **标签留多久**：推荐只管这一条消息，发出就清掉；另一个选择是一直留着直到手动删（之后每条都带）。
4. **没登录的厂商**：推荐列出来但灰掉、写 `Not signed in`（和资料页一致，用户知道为什么选不了）；另一个选择是直接不列。
5. **要不要再加按钮**：推荐先只做 “/” 命令；手机上已经打了半条消息时要回到开头打 “/” 不方便，用着觉得麻烦再在回形针旁边加一个按钮打开同一个列表。
