# 史莱姆视觉收口：总助新形象、左栏对齐、聊天跟跳、换水果换颜色

## 给用户看

要验收的文件：

- [对比大图](/tmp/fusa-slime-cohesion-candidates.png)，仓库里同一张在 `docs/screenshots/slime-cohesion/candidates.png`。第一块是总助新形象 3 选 1，每套放进左栏顶部、Router 顶栏和时间流、右栏任务图、桌面 Dock 里比，下面附“现代底壳 + 像素角色”和“全界面像素边框”的对照；第二块是左栏改前改后；第三块是同一只换颜色、资料页换形象的浮层、聊天里干活跟跳。

要你拍板的事：

1. 总助新形象。每套带自己的右栏任务进度图标、等你拍板标记和桌面应用图标，整套一起换。
   - A 珍珠领队：珍珠白史莱姆戴一顶小金冠，和 20 只水果是同一物种，干活时一样蹦。进度图标是千层果冻，拍板标记是小金冠，应用图标是橙底上的它。
   - B 藤编果篮：一只藤篮，篮口冒出三颗果子，干活时果子轮流探头。进度图标是浆果花环，拍板标记是小旗，应用图标是浅绿底的果篮。
   - C 嫩芽铃：铜金色手铃，铃身一张小脸，嫩芽当提钮，干活时左右摇。进度图标是嫩芽生长，拍板标记是小铃，应用图标是深绿底的铃。
   - 推荐 A。它本身就是一只史莱姆，在左栏里和项目经理排在一起最统一，动画直接用现有的蹦跳；白色是中性色，和 Router 工作台的白底也搭。想混搭（比如 A 的形象配 C 的进度图标）直接说。
2. 左栏名字放多大：17px（推荐，用现有的标题字号）或 16px（要在界面标准里新加一档字号）。
3. 没有消息预览的项目经理行：名字固定在第一行（推荐，整列名字在同一高度）或名字放到行正中（现在的做法）。
4. 换形象从哪进：资料页点头像，加上新建项目经理弹窗里点头像（推荐）；或者再让对话顶栏点头像直接弹出（顶栏头像现在是打开资料页，改了之后进资料页要多点一下）。
5. 颜色几种：20 种水果原色加天蓝、青碧、樱粉、石墨 4 种新色，共 24 种（推荐）；或只用 20 种原色。

## 用户目标

用户原话（2026-11-18，优先级最高）：

> 可以这个新风格很好👍👍👍，不过咋们整体也得往这个头像靠靠拢了，这个小刀感觉就不是很合适了，之后设计的活让 opus5.5 来吧用 max

> 我觉得有几个要改的点项目经理做事的时候聊天部分的头像要跟着跳动
> 然后所有的水果要支持换颜色，所有的项目经理要支持换水果！

> 小刀换一下？做成什么样子比较好，整体都要像素一点？然后，左侧人物框可以把 pm 的名字搞大一点，然后总感觉对齐有点小问题，因为每个 pm 的高度都不一样

> github 上面的 readme 和安装包也得更新了

此前定下的世界观：

> 我喜欢A的右边的那个小动物版本的，很可爱，用这个，还可以做动画，蹦蹦跳跳的，piece也是它不过薄一点，像纸一样，因为它的概念可能就是史莱姆，不会被切了就成片了，而是一个小生命，不然就太残忍了

我理解的目标：界面里所有“角色”都换成和 20 只水果史莱姆同一套 12×12 像素画，小刀、切面轮、橘瓣应用图标这些“切水果”的东西全部去掉；文字、按钮、输入框保持现在的清爽排版。左栏每行等高、名字更大、史莱姆在框里看着居中。项目经理干活时，聊天里正在进行的那一轮的头像也跳。每个项目经理能单独换造型、单独换颜色，网页和飞书群头像一起变。README 换图和新安装包是后面的步骤，这里先把应用图标定下来。

## 现状

1. 头像是静态文件，造型和颜色绑死。`scripts/render-avatars.ts:34` 的 `SPRITES` 是 20 只的像素稿，颜色直接写在每只的稿里，脚本生成 `assets/avatars/` 下 60 个文件（主形象 SVG、纸片分身 SVG、飞书 PNG 各 20）。网页在 `src/web/lib/palette.ts:21` 按文件名引用，`Avatar`（`src/web/components/Avatar.tsx:10`）只收 `colorKey`（项目经理编号），`paletteOf`（`palette.ts:36`）按编号对 20 取余。实测：读代码，`ls assets/avatars`。
2. 项目经理身上没有存形象的地方。`Pm`（`src/shared/domain.ts:141`）只有 `avatarFile`，`pms.avatar_file` 从 0001 就有，全仓库没有写它的代码。实测：grep `avatar_file`、`avatarFile`，只有 `src/daemon/ledger/rows.ts:163` 读，其余是测试里的 `null`。
3. 改项目经理设置都走 `PUT /api/pms/:id/persona`（`src/daemon/ui-server/server.ts:1676`，调 `ledger.editPersona`），每次改都记一条性格设定的修改记录，能撤销。实测：读代码。
4. 总助是小刀，任务进度是切面轮。`KnifeAvatar` 用在 `Sidebar.tsx:78`、`:105`，`RouterWorkbench.tsx:637`，`RouterStream.tsx:271`、`:961`，拍板那一步用在 `PeelTrack.tsx:391`、`TaskGraphDialog.tsx:317`。`SliceWheelIcon` 用在 `PeelTrack.tsx:1165`、`RightRail.tsx:422`、`TaskGraphDialog.tsx:213`；同一个文件还导出 `fruitTrackVars`、`computeGraphLayers`、`computeGraphComponents`（`SliceWheelIcon.tsx:8`、`:27`、`:79`），果皮轨和放大全览在用。实测：grep。
5. 应用图标是橙底上一瓣白边橘子（`scripts/render-icons.ts:14`、`:84`），出到 `src/web/public/icons/`；Mac 的 icns 由 `scripts/build-mac-app.sh:72` 从 `icon-512.png` 转。Windows 的 `apps/windows/crates/fusa-desktop/icons/`（`tauri.conf.json:19` 列的 5 个文件）是建 Windows 外壳时手工提交的，没有脚本生成。实测：`git log` 只有 00b5c513 一次提交，仓库里没有生成它的脚本。
6. 左栏的行本来就一样高，但名字会跳。`Sidebar.tsx:156` 的行是 `py-2.5`，头像 44px（`:162`），文字块 `min-h-12`（`:164`），名字 `text-body` 15px、600（`:167`）。实测：按同样的类名在 Chromium 里渲染 7 行（有无预览、圆点、时间混排），默认“大”界面下每行都是 74px；没有预览的行，名字被挪到行正中，和别的行的名字不在一条线上。
7. 史莱姆在框里偏下，有耳朵的显得更高。20 只的脚都踩在画布最后一行，眼睛都在第 6、7 行；不算耳朵、叶子、触角，身体的上下中点在第 7 到 7.5 格，比画布中线低 1 到 1.5 格，在 44px 的头像里低 3.7 到 5.5px。文字块按头像框的中线居中，所以史莱姆看着比名字低；兔子、瓢虫这类有长耳朵、触角的顶到框顶，小鸡只到第 3 格，连着几行看就高低不齐。实测：脚本读 `SPRITES` 算每只的身体范围，对比图第二块的红线就是这个差。用户说的“每个 pm 的高度都不一样”我理解是这一条和上一条（推断）。
8. 只有对话顶栏的头像会跳。`working` 只在 `Conversation.tsx:153`、`:156` 和 `WorkerConversation.tsx:122` 传了；消息流里每一轮开头的头像是 `AgentHead`（`Messages.tsx:100`），`Messages.tsx:499` 已经算出这一轮在不在跑（`running`），但没传给头像。实测：grep `working={`。
9. 飞书群头像按水果认。`src/daemon/feishu/chats.ts:40` 用 `pmFruitOf(pm.id)`，`service.ts:843` 对齐时读 `assets/avatars/<水果>.png` 算哈希；`feishu_avatars`（0037）和 `feishu_chats.avatar_fruit`（0034）都按水果名存。实测：读代码。
10. 迁移要能从 `user_version = 8` 重跑（`test/migration.test.ts` 逐个版本回退重跑），`ALTER TABLE ADD COLUMN` 重跑会报重复列。实测：先给 `pms` 加列写了一版 0038，21 个迁移测试挂了；改成单独建表后全部通过。

## 做法比较

换颜色怎么画：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| 运行时按共享的像素稿和色板画：网页内联 SVG，守护进程用 sharp 出 PNG（推荐） | 只有一份数据；加一种颜色只加一条；不用生成和打包图片文件；飞书按需画 | 每个头像在页面里多几条 path（不到 10 条），要记住算过的结果 |
| 预先生成全部组合：主形象和纸片 SVG 960 个、飞书 PNG 480 张 | 网页照旧用 `<img>` | 仓库和安装包多上千个文件；加一种颜色要重跑脚本、提交几十个文件 |
| SVG 文件里写 CSS 变量，用 `<use>` 引用换色 | 文件少 | `<img>` 里变量不生效，还是得改成内联；飞书 PNG 要另画一套 |

推荐第一种：像素稿本来就是数据（`SPRITES`），画法也已有（`render-avatars.ts` 的 `outline`），搬进 `src/shared/` 就能三处共用；sharp 已经是依赖（`AGENTS.md`「我们用的组件」）。

形象存哪：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| 新表 `pm_looks`，一个项目经理最多一行，没有行或某列为 NULL 就是默认（推荐） | `CREATE TABLE IF NOT EXISTS` 能重跑；不重建 `pms`；老项目经理零迁移、看起来不变；和 0033 的 `pm_capability_policies` 同一个写法 | 读项目经理时多一次左连接 |
| `pms` 加两列 | 字段就在项目经理身上 | 加列不能重跑，要按 0026 的办法重建 `pms`，它被十几张表引用，迁移测试要跟着改 |
| 存浏览器 `localStorage` | 不动后端 | 别的设备、飞书都不知道；换浏览器就没了 |

改形象的接口：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| 新增 `PUT /api/pms/:id/look`，账本 `setPmLook`（推荐） | 纯外观，不写性格设定的修改记录，不影响 agent | 多一个接口 |
| 并进 `PUT /api/pms/:id/persona` | 少一个接口 | 每换一次颜色记一条修改记录，混进撤销 |

光学对齐：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| 每只按身体（不算耳朵、叶子、触角）的上下中点往上挪，挪多少从像素稿算（推荐） | 身体都在框的正中，眼睛仍在一条线上（各只只差 0.5 格以内） | 耳朵会伸出头像框，框本来就是 `overflow-visible`，不裁 |
| 统一往上挪 1.25 格 | 一个数 | 白柚小狗、青柠青蛙身体本来就高，会偏上 |
| 重画 20 只，把身体挪到画布中间 | 不用算 | 兔耳、触角要出画布，等于重画 |

总助新形象（用户拍板，见第一节）：

| 方案 | 好处 | 坏处 |
| --- | --- | --- |
| A 珍珠领队 | 同一物种，最统一；动画复用 `.slime-pet`；白色中性 | 和椰子小奶牛都是浅色身体，靠金冠和冷灰描边区分 |
| B 藤编果篮 | “大家的家”，暖；一眼是果篮 | 是个物件不是角色，在时间流里“说话”有点怪；要单独做探头动画 |
| C 嫩芽铃 | “召唤”的意思最直接；拍板标记小铃很好懂 | 黄色和柠檬小鸡、菠萝接近；要单独做摇摆动画 |

换形象的入口用现有的 Radix Popover（`src/web/ui/popover.tsx`，界面标准第 11 条），不另做弹窗：换个头像开一个大弹窗太重。

## 性能

涉及记住结果的地方：

- 网页画头像：路径的形状只和造型、主形象或纸片有关，颜色只换 `fill`。`slimePaths` 按（造型，颜色，种类）记住结果，最多 20 × 24 × 2 = 960 份，每份不到 10 条路径、几百字节，合计不到 0.5 MB。数据是打包时定死的常量，不会过期。
- `resolvePmLook` 对同样的造型和颜色返回同一个对象，最多 20 × 24 = 480 个。
- 守护进程画飞书头像：一次对齐里每个用到的形象只画一次，用对齐函数里的局部 Map，对齐完就丢。`feishu_avatars` 每个形象一行，上限 480 行，实际不超过项目经理数。
- `pm_looks` 每个项目经理最多一行，项目经理删掉时跟着删。

逐条回答 `AGENTS.md` 的 4 件事：

1. 失效：像素稿和颜色跟着构建走，不会在运行中变。项目经理换形象时账本发 `pm.updated`，网页拿到新的 `avatarFruit`、`avatarColor` 重新算。飞书缓存的键里有图片内容的哈希，像素稿或颜色改了哈希就变，下一次对齐重传、原地换。上传失败不记缓存，下一次对齐重试（沿用 `createFeishuAvatarCache` 现有逻辑）。
2. 上限：上面每一项都由“造型数 × 颜色数”封顶，没有随时间增长的部分。

   | 准备加进 `src/shared/limits.ts` 的常量 | 值 | 怎么算的 |
   | --- | --- | --- |
   | 无 | | 上限由名录长度决定（20 × 24），不是可调的数；`slimes.test.ts` 遍历全部组合，加颜色时一起覆盖 |

3. 前端引用稳定：`resolvePmLook`、`slimePaths` 同样的输入返回同一个引用；`Avatar` 包 `memo`，props 只有形象对象和尺寸。
4. 验证：用 pstack 的 `benchmark-checklist` 量左栏 300 个项目经理首次渲染和切换会话的 React 提交耗时，改前（`<img>`）、改后（内联 SVG）各量 5 次取中位数写进 PR；`blast-radius` 列出改到的组件。

## 统一

- 一处定义：`src/shared/slimes.ts` 管造型、颜色、上色、光学对齐、默认形象和新建时的分配。网页头像、Piece 纸片分身、总助头像、进度图标、飞书群头像（守护进程）、应用图标（`scripts/render-icons.ts`）都从它画。
- 和厂商无关：头像不分厂商，`src/shared/vendors.ts` 不动，以后加一家厂商这里什么都不用改。
- 三个平台：网页三平台一样；飞书 PNG 用 sharp（官方预编译包覆盖 macOS、Windows、Linux）；应用图标由 `render-icons.ts` 出一张 1024 的母图，Mac 照旧由 `build-mac-app.sh` 转 icns，Windows 用 Tauri 官方的 `tauri icon` 从母图生成 `icons/` 全套，替代现在手工提交的 5 个文件。这些都不经过 `src/daemon/platform/`。
- 加一种颜色：在 `slimes.ts` 的颜色名录加一条，对比度测试自动覆盖。加一只造型：`fruits.ts` 加一个水果，`slimes.ts` 加一只像素稿和它自己的原色。

## 删掉什么

都在实现的同一个 PR 里删，新旧两套不并存。

- `src/web/components/KnifeAvatar.tsx`、`src/web/ui/knife-avatar.test.tsx`，以及现状第 4 条列的 7 处用法（换成 `RouterAvatar`、`GateMark`）。
- `src/web/components/SliceWheelIcon.tsx` 和 `src/web/task-graph-rail.test.tsx` 里切面轮的测试（换成 `TaskProgressIcon`）。`computeGraphLayers`、`computeGraphComponents` 挪进 `src/web/task-graph-layout.ts`；`fruitTrackVars` 改成按颜色取，挪进 `src/web/lib/palette.ts`。
- `scripts/render-avatars.ts`、`scripts/render-avatars.test.ts` 和 `assets/avatars/` 下 60 个文件：像素稿搬进 `src/shared/slimes.ts`。`scripts/stage-runtime-common.ts` 不再打包这个目录；`README.md` 两处说明（第 230、467 行）改成指向 `src/shared/slimes.ts`。
- `src/shared/fruits.ts` 的 `pmFruitAvatarFile`；`FRUITS` 里的 `blob`、`accent`、`accentForeground` 挪进颜色名录，`fruits.ts` 只留水果名录和 `pmFruitOf`。
- `src/web/lib/palette.ts` 的 `PALETTE` 和按编号取色的 `paletteOf(key)`、`accentStyle(key)`、`tintStyle(key)`，改成按形象取；`Avatar` 的 `colorKey` 改成 `look`；`ConversationEntry` 等处的 `avatarKey` 改成 `look`（`selectors.ts:80`、`:131`、`:873`、`:888`、`:998`、`:1019`）。
- `src/daemon/feishu/avatars.ts` 的 `FEISHU_AVATARS_DIR`、`pmFruitImagePath`、`feishuAvatarHash`，换成 `renderFeishuAvatar`；`chats.ts` 的 `fruit` 改成 `look`；`store.ts` 的 `avatarFruit` 改成按形象键记。
- `Pm.avatarFile` 字段、`rows.ts` 里它的映射和测试里的 `null`。`pms.avatar_file` 这一列留着不读不写：删列要重建 `pms`（见做法比较），不值得。
- `scripts/render-icons.ts` 里画橘瓣的 `WEDGE`、`sectorPath`、`roundedSector`、`wedge`。
- `docs/ui-standard.md` 里小刀、切面轮、门禁水果刀的说法：第 4 条“水果三元视觉与 Router 水果刀中性色规则”，第 12 条的 `SliceWheelIcon`，第 12.1 条标题里的“小切面进度轮与门禁水果刀”和“水果刀拍板焦点”，第 16 条“左栏 Router 水果刀三档置顶规则”，第 21 条 `KnifeAvatar` 一节。换成新形象的规则；第 3 条、第 16 条的左栏名字和行高照拍板改；第 17 条补上“正在进行的那一轮头像跟跳”。`docs/router-design.md`、`docs/router-workbench-v2-design.md`、`docs/orchestration-simplify-design.md` 提到小刀、切面轮的地方一起改。

## 骨架文件

- `src/shared/slimes.ts`：造型 × 颜色的类型、颜色名录的 id、上色、光学对齐、默认形象、新建时分配、飞书和图标用的位图。
- `src/shared/slimes.test.ts`：上面每条契约的 `it.todo`。
- `migrations/0038_pm_looks.sql`：`pm_looks` 表。
- `src/shared/domain.ts`：`Pm` 加可选的 `avatarFruit`、`avatarColor`（老版本设备不带）。
- `src/shared/api.ts`：`API_PATHS.pmLook`、`PmLookRequest`、`PmLookResponse`。
- `src/shared/ledger.ts`：`setPmLook` 的签名和契约；`src/daemon/ledger/ledger.ts`、`src/daemon/ui-server/fake-ledger.ts` 先放“未实现”。
- `src/web/components/RouterAvatar.tsx`：总助头像，取代 `KnifeAvatar`。
- `src/web/components/GateMark.tsx`：任务图里“等你拍板”的标记，取代小刀。
- `src/web/task-progress.ts`、`src/web/components/TaskProgressIcon.tsx`：任务进度图标的格子和组件，取代 `SliceWheelIcon`。
- `src/web/components/SlimePicker.tsx`：换形象的浮层。
- `src/web/slime-cohesion.test.tsx`：总助头像、进度图标、拍板标记、按形象画的 `Avatar`、浮层、左栏行、聊天跟跳的 `it.todo`。
- `src/daemon/feishu/avatars.ts`：`renderFeishuAvatar` 的签名；`avatars.test.ts`、`chats.test.ts` 加 `it.todo`。
- `src/daemon/ledger/ledger.test.ts`、`src/daemon/ui-server/server.test.ts`、`test/migration.test.ts`：`setPmLook`、`PUT /api/pms/:id/look`、0038 的 `it.todo`。

骨架没改已有签名（`Avatar` 的 `colorKey`、`paletteOf(key)`、`SliceWheelIcon` 等）：改了以后 30 多处调用都要先走到还没实现的 `resolvePmLook`，页面会坏。实现步骤一次改完，新签名已经写在上面的新文件里。

实现步骤另加 `migrations/0039_feishu_avatar_look.sql`：照 0037 重建 `feishu_avatars`，主键改成形象键（`lookKey`）；照 0026 的重建法把 `feishu_chats.avatar_fruit` 换成 `avatar_look`，旧值不搬（每个群下次对齐重设一次头像）。这一份要和 `store.ts` 的改动一起上，骨架里先不加。合并前确认 0038、0039 没被别的 PR 占用。

## 验收方法

- 测试：`src/shared/slimes.test.ts`、`src/web/slime-cohesion.test.tsx` 全部；`avatars.test.ts`“按形象画群头像”、`chats.test.ts`“群头像跟着项目经理的形象”、`ledger.test.ts`“项目经理的形象”、`server.test.ts`“PUT /api/pms/:id/look”、`test/migration.test.ts`“0038_pm_looks”；`src/web/lib/palette.test.ts` 改成遍历全部颜色。加上 `pnpm typecheck`。
- 截图（放 `docs/screenshots/slime-cohesion/`）：真实网页的左栏宽栏、72px 窄栏、手机列表；Router 工作台顶栏、时间流和空状态；右栏任务图的进度图标和拍板标记；资料页换形象浮层，换造型、换颜色各一张；同一个项目经理换色前后的对话页（强调色、气泡、果冻底、纸片分身一起变）。
- 录屏（mp4，H.264，50 MB 以内）：项目经理干活时消息流里正在进行的那一轮头像跟跳，这一轮结束后停下，历史轮一直不动。
- 飞书：用测试应用把一个项目经理换成天蓝狐狸，守护进程日志里出现一次上传和一次改群头像，`feishu_avatars` 多一行 `persimmon:sky`；再换回原色，不再上传（哈希命中）。
- 应用图标：`node scripts/render-icons.ts` 的输出、`tauri icon` 生成的 Windows 图标、`pnpm app:mac` 打出的 `Fusa.app` 在 Dock 里的截图。

## 附录：候选像素稿和新颜色

像素稿的写法和 `scripts/render-avatars.ts` 一样：12 行，每行 12 个字符，`.` 透明。

### A 珍珠领队

颜色：`o #45475a`（描边）、`b #fbfbfe`（身体）、`s #e2e4ee`（暗面）、`e #3a1e14`（眼睛）、`p #ffb3c0`（腮红）、`y #ffcc33`（金冠）、`Y #c08a00`（金冠描边）、`j #ff7a1a`（宝石）。

```
............
...Y.YY.Y...
...YyYYyY...
..oYyyjyYo..
.obYYYYYYbo.
obbbbbbbbbbo
obbebbbbebbo
obbebbbbebbo
obpbbeebbpbo
obbbbbbbbbso
.oossssssoo.
...oooooo...
```

拍板标记（小金冠，8×6，颜色同上）：

```
Y..YY..Y
YY.YY.YY
YyYyyYyY
YyyjjyyY
YyyyyyyY
YYYYYYYY
```

进度图标（千层果冻，10×10）：倒扣碗形的果冻模子，`#71717a` 描边，`#d4d4d8` 托盘；模子里 7 行从下往上按步骤分层，一步一层，步数多于 7 时按比例并层；同层并行的步骤左右平分。

应用图标：底色 `#ff7a1a`，地影 `#d95d08`。

### B 藤编果篮

颜色：`o #6b4423`、`h #b98a52`（提手）、`b #dcab68`、`s #b8813f`、`w #f2cf92`（编纹）、`r #ff8a2a`、`R #d0560f`（橙）、`g #8fd14f`、`G #4f9a2a`、`l #3f8a1c`（青苹和叶）、`m #ef4a6a`、`M #b51f45`（莓）。

```
...oooooo...
..oh....ho..
.oh...l..ho.
.o...ggG..o.
.o.rrgggGmo.
.orrRgggGmMo
oooooooooooo
owbwbwbwbwbo
obsbsbsbsbso
owbwbwbwbwbo
.osbsbsbsbo.
..oooooooo..
```

拍板标记（小旗，6×6）：旗杆 `o #6b4423`，旗面 `F` 用会话强调色 `--primary`。

```
oFFFF.
oFFFFF
oFFFF.
o.....
o.....
o.....
```

进度图标（浆果花环，10×10）：一圈 `#a9cf7f` 的藤，一步一颗 2×2 的浆果，从 12 点顺时针排；没轮到的是 `#e3ecd6` 的小苞。

应用图标：底色 `#cfe5a8`，地影 `#a9c97c`。干活时：篮里的果子往上探一格再缩回。

### C 嫩芽铃

颜色：`o #8a5300`、`b #ffcb3d`、`s #e9a417`、`w #fff1a8`（高光）、`e #3a1e14`、`p #ff9a7a`、`g #8ed04f`、`G #3f9a4c`（嫩芽）、`k #c98800`（铃口）、`c #ff7a1a`（铃舌）。

```
...gg..GG...
....gggG....
.....oo.....
....oooo....
...obwbbo...
..obwbbbbo..
..obebbebo..
..obebbebo..
..obpbbpso..
.obbbbbbsso.
okkkkkkkkkko
.ooooccoooo.
```

拍板标记（小铃，6×6，颜色同上）：

```
..oo..
.obbo.
.obbo.
obbbbo
oooooo
..cc..
```

进度图标（嫩芽生长，10×10）：一根茎，一步一节，叶子左右交替往上长；没长到的节只有虚线茎。

应用图标：底色 `#2f6f43`，地影 `#235634`。干活时：以提钮为轴左右各摇 14°。

### 三套共用的规则

- 进度图标的颜色看步骤状态：做完是项目经理颜色的 `blob`，在干是 `blob` 掺 55% 白，等你拍板是 `accent`，等项目经理是 `--caution`，没轮到和跳过只留轮廓。
- 应用图标的画布是 16 个单位：圆角方块 `rx 3.6` 满铺底色，像素稿放在 (2, 1.75)，脚下两条地影 (3, 13.5) 宽 10 高 1、(4, 14.5) 宽 8 高 0.5。favicon 16px、32px 时像素稿改放 (2, 1)，一格正好 1px、2px，不糊。Mac 照现在 `padded` 的规则四周留透明边。

### 跟着颜色换的字符

默认 `o` 描边、`b` 身体、`s` 暗面、`c` 浅色、`p` 腮红跟着颜色换。各造型另外的：

| 造型 | 字符 | 角色 |
| --- | --- | --- |
| 奇异果小熊 | `k`（耳朵里的果肉） | 花纹 |
| 西瓜老虎 | `k`（条纹） | 花纹 |
| 菠萝刺猬 | `k`（菱格） | 花纹 |
| 樱桃瓢虫 | `k`（斑点） | 花纹 |
| 青梨长颈鹿 | `k`（斑） | 花纹 |
| 柿子狐狸 | `k`（耳尖） | 花纹 |
| 白柚小狗 | `t`（垂耳） | 花纹 |
| 椰子奶牛 | `t`（花斑） | 花纹 |
| 粉红西柚小猪 | `n`（鼻孔） | 花纹 |
| 青椒小恐龙 | `k`（头顶的刺） | 浅色 |
| 水蜜桃小猴 | `n`（嘴） | 描边 |

眼睛 `e`、叶子 `g G`、白 `w`、喙 `f`、籽 `y`、舌头 `r`、水柱 `a`、角 `h`、口鼻 `m`，以及没列在表里的 `n`、`t`，不跟着颜色换。

20 种原色的角色色直接取各只现在的稿：没有 `c` 的，浅色取身体掺 60% 白；没有花纹字符的，花纹取身体和描边各半。实现时把算出来的值写成字面量，运行时不再混色。`blob`、`accent`、`accentForeground` 取 `FRUITS` 现在的值，满铺浅底取现在 `SPRITES` 的 `bg`。

### 4 种新颜色

| id | 名字 | 描边 | 身体 | 暗面 | 浅色 | 腮红 | 花纹 | blob | accent（对白） | 满铺浅底 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sky` | 天蓝 | `#1d5a8a` | `#86cdf5` | `#5fb3e6` | `#e6f6fe` | `#ffb3c0` | `#3489c9` | `#4fb3ea` | `#0b69a3`（5.9） | `#dcf0fc` |
| `teal` | 青碧 | `#0d5c55` | `#4cc9b9` | `#2aad9d` | `#d9f7f2` | `#ffab9a` | `#148a7d` | `#22b3a3` | `#0f766e`（5.5） | `#d5f3ee` |
| `sakura` | 樱粉 | `#a3365f` | `#ffc6da` | `#f7a6c2` | `#fff1f6` | `#ff7aa2` | `#e2799e` | `#ff9cc0` | `#b4325f`（5.9） | `#ffe8f0` |
| `graphite` | 石墨 | `#26262b` | `#8f919c` | `#73757f` | `#e6e6ea` | `#ffb3c0` | `#55575f` | `#8f919c` | `#52525b`（7.7） | `#e6e6ea` |
