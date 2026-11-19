# 史莱姆视觉收口：总助嫩芽铃、便签小灵、像素图标、整体字体、果冻管道任务图、方框输入框、左栏对齐、聊天跟跳、换水果换颜色

## 给用户看

要验收的文件：

- [第三版对比大图](/tmp/fusa-slime-cohesion-v3.png)，仓库里同一张在 `docs/screenshots/slime-cohesion/candidates.png`。最上面是已定的加推荐的放进整屏（默认“大”界面、真实字号），下面五块：一、整体换字体（三款对比）；二、任务图的线加粗；三、输入框换方框；四、定案采用 C 嫩芽铃、P1 便签小灵、Geist、像素工具图标、果冻管道与方框输入框。项目经理可自由组合 20 个水果造型与 24 种颜色。左栏在标准档用 72px 行高、17px 名字和 48px 头像框。

用户追加的工具格按界面标准第 6 条实现。设置、新建、额度和开关用 30px 方格，任务图放大键用 24px 方格。模型选择用同高长槽，状态计数用静态小格。统一用嫩芽铃色系的暖黄底、琥珀 1px 描边、4px 圆角和底部 2px 托底；可点的格子按下轻沉 1px。额度槽放在对话和总助顶栏，没有对话顶栏时放在左栏。

## 用户目标

> 设置图标，额度，这些图标做成方框里放着的，像星露谷那种？

用户看完第二版对比图后的拍板和修改意见（2026-11-19，优先级最高）：

> 我喜欢这个铃铛，然后字体还是不要像素字了，可以换个别的字体，看看，整体都换了？，图标是ok的，还不错，可以把图的线粗一点？？？，不知道你明不明白我的意思，就是图就这样一根过去，有点廉价，然后输入框的像素也不要了，把圆框换成方框，输入的那一个图标也换

> 然后我喜欢那个便签的

用户看完第一版对比图后的反馈（2026-11-19）：

> 我感觉纸片分身和pm形象同质化太高了？
> 但是我们的按钮可以像素画一点，比如设置，
> 还有类似taskgraph的字以及我们的图都可以往这个方向靠一点

用户原话（2026-11-18）：

> 可以这个新风格很好👍👍👍，不过咋们整体也得往这个头像靠靠拢了，这个小刀感觉就不是很合适了，之后设计的活让 opus5.5 来吧用 max

> 我觉得有几个要改的点项目经理做事的时候聊天部分的头像要跟着跳动
> 然后所有的水果要支持换颜色，所有的项目经理要支持换水果！

> 小刀换一下？做成什么样子比较好，整体都要像素一点？然后，左侧人物框可以把 pm 的名字搞大一点，然后总感觉对齐有点小问题，因为每个 pm 的高度都不一样

> github 上面的 readme 和安装包也得更新了

此前定下的世界观：

> 我喜欢A的右边的那个小动物版本的，很可爱，用这个，还可以做动画，蹦蹦跳跳的，piece也是它不过薄一点，像纸一样，因为它的概念可能就是史莱姆，不会被切了就成片了，而是一个小生命，不然就太残忍了

我理解的目标：角色（总助、Piece 分身、拍板标记、任务进度图标、应用图标）和工具按钮的图标用和 20 只水果史莱姆同一套像素画法；字、输入框、气泡、卡片不用像素，保持清爽，整屏换一款更有个性的字体。总助是嫩芽铃，Piece 分身是便签小灵。任务图的线要有分量，不能是一根细线串几个点。输入框从胶囊圆框换成方框，图标换成线条的“+”和发送箭头。左栏每行等高、名字更大、史莱姆在框里看着居中。项目经理干活时，聊天里正在进行的那一轮的头像也跳。每个项目经理能单独换造型、单独换颜色，网页和飞书群头像一起变。README 换图和新安装包是后面的步骤，这里先把应用图标定下来。

## 现状

1. 头像是静态文件，造型和颜色绑死。`scripts/render-avatars.ts:34` 的 `SPRITES` 是 20 只的像素稿，颜色直接写在每只的稿里，脚本生成 `assets/avatars/` 下 60 个文件（主形象 SVG、纸片分身 SVG、飞书 PNG 各 20）。网页在 `src/web/lib/palette.ts:21` 按文件名引用，`Avatar`（`src/web/components/Avatar.tsx:10`）只收 `colorKey`（项目经理编号），`paletteOf`（`palette.ts:36`）按编号对 20 取余。实测：读代码，`ls assets/avatars`。
2. 项目经理身上没有存形象的地方。`Pm`（`src/shared/domain.ts:141`）只有 `avatarFile`，`pms.avatar_file` 从 0001 就有，全仓库没有写它的代码。实测：grep `avatar_file`、`avatarFile`，只有 `src/daemon/ledger/rows.ts:163` 读，其余是测试里的 `null`。
3. 改项目经理设置都走 `PUT /api/pms/:id/persona`（`src/daemon/ui-server/server.ts:1676`，调 `ledger.editPersona`），每次改都记一条性格设定的修改记录，能撤销。实测：读代码。
4. 总助是小刀，任务进度是切面轮。`KnifeAvatar` 用在 `Sidebar.tsx:78`、`:105`，`RouterWorkbench.tsx:637`，`RouterStream.tsx:271`、`:961`，拍板那一步用在 `PeelTrack.tsx:391`、`TaskGraphDialog.tsx:317`。`SliceWheelIcon` 用在 `PeelTrack.tsx:1165`、`RightRail.tsx:422`、`TaskGraphDialog.tsx:213`；同一个文件还导出 `fruitTrackVars`、`computeGraphLayers`、`computeGraphComponents`（`SliceWheelIcon.tsx:8`、`:27`、`:79`），果皮轨和放大全览在用。实测：grep。
5. 应用图标是橙底上一瓣白边橘子（`scripts/render-icons.ts:14`、`:84`），出到 `src/web/public/icons/`；Mac 的 icns 由 `scripts/build-mac-app.sh:72` 从 `icon-512.png` 转。Windows 的 `apps/windows/crates/fusa-desktop/icons/`（`tauri.conf.json:19` 列的 5 个文件）是建 Windows 外壳时手工提交的，没有脚本生成。实测：`git log` 只有 00b5c513 一次提交，仓库里没有生成它的脚本。
6. 左栏的行本来就一样高，但名字会跳。`Sidebar.tsx:156` 的行是 `py-2.5`，头像 44px（`:162`），文字块 `min-h-12`（`:164`），名字 `text-body` 15px、600（`:167`）。每行标准档 68px（默认“大”档 74px）。实测：按同样的类名在 Chromium 里渲染 7 行（有无预览、圆点、时间混排），每行一样高；没有预览的行，名字被挪到行正中，和别的行的名字不在一条线上。
7. 史莱姆在框里偏下，有耳朵的显得更高。20 只的脚都踩在画布最后一行，眼睛都在第 6、7 行；不算耳朵、叶子、触角，身体的上下中点在第 7 到 7.5 格，比画布中线低 1 到 1.5 格，在 44px 的头像里低 3.7 到 5.5px。文字块按头像框的中线居中，所以史莱姆看着比名字低；兔子、瓢虫这类有长耳朵、触角的顶到框顶，小鸡只到第 3 格，连着几行看就高低不齐。实测：脚本读 `SPRITES` 算每只的身体范围，对比图第五块的红线就是这个差。用户说的“每个 pm 的高度都不一样”我理解是这一条和上一条（推断）。
8. 只有对话顶栏的头像会跳。`working` 只在 `Conversation.tsx:153`、`:156` 和 `WorkerConversation.tsx:122` 传了；消息流里每一轮开头的头像是 `AgentHead`（`Messages.tsx:100`），`Messages.tsx:499` 已经算出这一轮在不在跑（`running`），但没传给头像。实测：grep `working={`。
9. 飞书群头像按水果认。`src/daemon/feishu/chats.ts:40` 用 `pmFruitOf(pm.id)`，`service.ts:843` 对齐时读 `assets/avatars/<水果>.png` 算哈希；`feishu_avatars`（0037）和 `feishu_chats.avatar_fruit`（0034）都按水果名存。实测：读代码。
10. 迁移要能从 `user_version = 8` 重跑（`test/migration.test.ts` 逐个版本回退重跑），`ALTER TABLE ADD COLUMN` 重跑会报重复列。实测：先给 `pms` 加列写了一版 0038，21 个迁移测试挂了；改成单独建表后全部通过。
11. Piece 分身就是项目经理那张脸抽掉几行。`scripts/render-avatars.ts:455` 的 `pieceGrid` 照 `SPRITES[水果].piece` 抽行、暗面改回身体色。它出现在 6 处：Piece 汇报行（`Messages.tsx:749`）、Piece 对话里每一轮的头像（`Messages.tsx:115`）、Piece 对话的空状态 120px（`Messages.tsx:1020`）、右栏开关（`RightRail.tsx:286`）、总助时间流的去向行（`RouterStream.tsx:178`）、Piece 对话顶栏（`WorkerConversation.tsx:122`）。实测：grep `neutral`。
12. 图标全是 lucide 线条图标。`src/web` 里 47 个文件从 `lucide-react` 引了 47 种图标，另有 `LucideIcon` 类型在 `SettingsDialog.tsx:1`、`Messages.tsx:21`。界面标准第 5 条定的是 lucide、16px、圆头线条。实测：grep `from "lucide-react"`。
13. 字体只用系统字体，不打包字体文件。`styles.css:74` 的 `--font-ui`（`-apple-system`、`SF Pro Text` 在前，苹方、微软雅黑在后），界面标准第 13 条。Mac 上是 SF Pro 加苹方，Windows 上是 Segoe UI 加微软雅黑，两边英文长得不一样。实测：读代码。
14. 字体文件大小：Geist 拉丁字母的可变字体 29 KB，Nunito 39 KB（都含全部粗细）；霞鹜文楷 Lite 按字切片，常规体全部切片 4.1 MB、粗体 4.1 MB，网页只下用到的切片，安装包要全带。实测：npm 包 `@fontsource-variable/geist@5.3.0`、`@fontsource-variable/nunito@5.3.0`、`lxgw-wenkai-lite-webfont@1.7.0` 解包量的。第二版试过的像素字（Tiny5 等）用户不要了，不再考虑。
15. 任务图全是圆滑细线。果皮轨的轨道是 3.6 单位宽的圆头线和 1.6 宽的 `2 4` 虚线，状态点是 `<circle>`（`PeelTrack.tsx:85`、`:102`），分叉汇合是弧线；放大全览的连线是 1.5px 三次贝塞尔加 3px 折角箭头（`task-graph-layout.ts:141`、`:435`），卡片 `rounded-2xl`。实测：读代码。用户说的“图就这样一根过去”就是这些细线（推断，第二版的像素细线也是一格宽）。
16. 输入框是胶囊圆框。`Composer.tsx:51` 的 `FRAME_CLASS` 是 `rounded-[26px]`，阴影和聚焦光晕在 `styles.css:325` 的 `.composer-frame`；左边回形针（`Composer.tsx:421`），右边圆形发送键里是向上箭头（`:472`）。实测：读代码。
17. pixelarticons 是 24 格画布、2 格一笔，一笔正好是图标宽的 1/12，和史莱姆一格描边占头像宽的比例一样；免费 1036 个，MIT，带 React 组件和逐个 import。默认“大”档下 1.375rem 是 24.06px，正好是它的原生尺寸。我们用的 47 种里 41 种有同名或同义的，另外 6 种用近似的（附录有对照表）。实测：读 npm 包 `pixelarticons@2.4.2`。

## 做法比较

换颜色怎么画：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| 运行时按共享的像素稿和色板画：网页内联 SVG，守护进程用 sharp 出 PNG（推荐） | 只有一份数据；加一种颜色只加一条；不用生成和打包图片文件；飞书按需画 | 每个头像在页面里多几条 path（不到 10 条），要记住算过的结果 |
| 预先生成全部组合：主形象 SVG 480 个、飞书 PNG 480 张 | 网页照旧用 `<img>` | 仓库和安装包多上千个文件；加一种颜色要重跑脚本、提交几十个文件 |
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

整体字体（用户拍板，见第一节）：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| Geist + 苹方（推荐） | 利落现代，数字好看；29 KB；Mac 和 Windows 的英文长一样 | 中文还是各平台自己的字（苹方、微软雅黑） |
| Nunito + 苹方 | 圆体，和果冻史莱姆最搭；39 KB | 正文偏软；圆的英文配方的中文 |
| 霞鹜文楷（中英一起） | 整屏都变，最暖；三个平台中文也一样 | 小字不如黑体清楚；安装包多约 8 MB（常规加粗体） |
| 不换 | 不用改 | 用户想换 |

怎么加载：用 Fontsource 的 `@fontsource-variable/geist`（或拍板的那一款），Vite 打包进 `assets/`，离线能用；`sw-rules.ts` 已经认 CSS 里引的字体文件（`sw-rules-cache.test.ts:37`）。字体栈只改 `styles.css` 的 `--font-ui` 一处：选定的英文字体排第一，苹方、冬青黑体、微软雅黑照旧排在后面接住中文（界面标准第 13 条“英文字体排在中文字体前面”）。不用 Google Fonts 的网址（离线和内网用不了）。

任务图的线（用户拍板，见第一节）：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| 果冻管道（推荐） | 有描边、有高光、有体积，和史莱姆一个画法；“灌满 / 空管子”直接说出走没走通 | 轨道槽里东西多一点，管子交叉处要按格子算好 |
| 粗实线 | 简单 | 只是变粗，还是“一根过去” |
| 第二版的一格细线 | 已经画好 | 用户嫌廉价 |

画法放在新文件 `src/web/pixel-path.ts`，只管“怎么画”，果皮轨和放大全览的排布（泳道、dagre 分层）不动：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| `pixel-path.ts` 出管道中线和珠子的路径，`PeelTrack`、`TaskGraphDialog` 只负责上色（推荐） | 画法一处定义、纯函数好测；排布算法零改动，现有的布局测试照样守着 | 放大全览的连线要先把 dagre 的折线改成正交折线 |
| 在 `PeelTrack.tsx`、`task-graph-layout.ts` 里各自改 | 少一个文件 | 两处各写一套管道和珠子，容易不一致 |

管子用三层 `stroke` 画同一条正交折线（描边色 4 格宽、芯 2 格宽、高光 1 格宽且往左上挪半格），比拼一堆小方块简单，`crispEdges` 下边缘一样是整格。

输入框（用户拍板，见第一节）：

| 做法 | 好处 | 坏处 |
| --- | --- | --- |
| 方框单行（推荐） | 空着时只占一行；单行、多行的切换规则不变（界面标准第 7 条），只改外框和按钮形状 | 多行时按钮落到下一行，和现在一样 |
| 方框两行 | 像 Claude 桌面版，工具栏位置固定 | 空着时也占两行高，对话区少一行 |

图标：左边“+”加文件，发送键里向上箭头（推荐）；纸飞机、回车可选。都是线条图标，用 lucide 的 `Plus`、`ArrowUp`，从 `src/web/ui/icons.ts` 以 `ComposerAdd`、`ComposerSend` 导出，`lucide-react` 只在这个文件里引。外框 `rounded-xl`（12px），发送键和“+”是 36px 的圆角方块，圆角 10px（界面标准第 2 条要加这一条例外）。

总助形象（用户已选 C 嫩芽铃）：

| 方案 | 好处 | 坏处 |
| --- | --- | --- |
| A 珍珠领队 | 同一物种，最统一 | 和椰子小奶牛都是浅色身体 |
| B 藤编果篮 | “大家的家”，暖 | 是个物件不是角色 |
| C 嫩芽铃（已选） | “召唤”的意思最直接；拍板标记小铃很好懂 | 黄色和柠檬小鸡、菠萝接近，靠铃形和嫩芽区分；要单独做摇摆动画 |

Piece 分身（用户已选 P1 便签小灵）：P2 果冻小水滴、P3 拼图块不做。三个都只用描边、身体、暗面、浅色和眼睛五种角色字符，按项目经理的颜色上色。

像素图标（用户已选）：pixelarticons，按钮形状不变（第二版的“档位 1”）。另一个选项 HackerNoon pixel-icon-library 是 1 格一笔、常规图标只有 248 个；自己照 12 格画 47 个违反“优先用成熟的库”。像素图标尺寸对齐到格子：`round(nearest, 1.375rem, 12px)`，默认“大”档正好 24px，四档界面大小下都是整格（第 0 条的例外，要写进界面标准）。

换形象的入口用现有的 Radix Popover（`src/web/ui/popover.tsx`，界面标准第 11 条），不另做弹窗：换个头像开一个大弹窗太重。

## 性能

涉及记住结果的地方：

- 网页画头像：路径的形状只和造型、主形象或 Piece 有关，颜色只换 `fill`。`slimePaths` 按（造型，颜色，种类）记住结果，主形象最多 20 × 24 = 480 份，Piece 和造型无关、最多 24 份，每份不到 10 条路径、几百字节，合计不到 0.3 MB。数据是打包时定死的常量，不会过期。
- `resolvePmLook` 对同样的造型和颜色返回同一个对象，最多 20 × 24 = 480 个。
- 守护进程用 `lru-cache` 记住最近 64 张压缩后的飞书群头像。`feishu_avatars` 每个形象一行，上限 480 行，实际不超过项目经理数。
- `pm_looks` 每个项目经理最多一行，项目经理删掉时跟着删。
- 任务图：`pixel-path.ts` 是纯函数，结果跟着现有的 `useMemo`（`PeelTrack.tsx:951`）和放大全览布局的 `lru-cache`（容量 64，`task-graph-layout.ts`）一起缓存，不另加缓存。一张图最多 `MAX_GRAPH_NODES` = 32 步（`limits.ts:770`），每步一颗珠子、每条边一根管子。
- 字体一个 29 KB 的 woff2（选 Geist 时）；像素图标逐个 import，只打包用到的。

逐条回答 `AGENTS.md` 的 4 件事：

1. 失效：像素稿、颜色、字体、图标都跟着构建走，不会在运行中变。项目经理换形象时账本发 `pm.updated`，网页拿到新的 `avatarFruit`、`avatarColor` 重新算。飞书缓存的键里有图片内容的哈希，像素稿或颜色改了哈希就变，下一次对齐重传、原地换。上传失败不记缓存，下一次对齐重试（沿用 `createFeishuAvatarCache` 现有逻辑）。字体文件名带内容哈希，换版后 `staleAssetUrls` 清掉旧的。
2. 上限：上面每一项都由“造型数 × 颜色数”或任务图的步数（`MAX_GRAPH_NODES`）封顶，没有随时间增长的部分。

   | 准备加进 `src/shared/limits.ts` 的常量 | 值 | 怎么算的 |
   | --- | --- | --- |
   | `FEISHU_AVATAR_RENDER_CACHE_MAX` | 64 | 近期使用的压缩 PNG，按画过的形象淘汰 |

3. 前端引用稳定：`resolvePmLook`、`slimePaths` 同样的输入返回同一个引用；`Avatar` 包 `memo`，props 只有形象对象和尺寸。图标是模块级常量组件。
4. 验证：用 pstack 的 `benchmark-checklist` 量左栏 300 个项目经理首次渲染和切换会话的 React 提交耗时，改前（`<img>`）、改后（内联 SVG）各量 5 次取中位数写进 PR；右栏 32 步任务图展开的提交耗时，改前（圆滑细线）、改后（果冻管道）各量 5 次；`blast-radius` 列出改到的组件。

## 统一

- 一处定义：
  - `src/shared/slimes.ts` 管造型、颜色、上色、Piece 分身、光学对齐、默认形象和新建时的分配。网页头像、Piece 分身、总助头像、进度图标、飞书群头像（守护进程）、应用图标（`scripts/render-icons.ts`）都从它画。
  - `src/web/ui/icons.ts` 是全站唯一的图标出口：工具按钮用像素图标，输入框用两个线条图标；换图标只改它。
  - `src/web/pixel-path.ts` 管任务图的果冻管道、珠子和箭头。
  - 字体只在 `styles.css` 的 `--font-ui` 一处。
- 和厂商无关：头像、图标、字体不分厂商，`src/shared/vendors.ts` 不动，以后加一家厂商这里什么都不用改。
- 三个平台：网页三平台一样；打包进来的英文字体在 macOS、Windows、Linux 上长一样，中文仍各用系统字（选霞鹜文楷时中文也一样）。飞书 PNG 用 sharp（官方预编译包覆盖 macOS、Windows、Linux）；应用图标由 `render-icons.ts` 出一张 1024 的母图，Mac 照旧由 `build-mac-app.sh` 转 icns，Windows 用 Tauri 官方的 `tauri icon` 从母图生成 `icons/` 全套，替代现在手工提交的 5 个文件。这些都不经过 `src/daemon/platform/`。
- 加一种颜色：在 `slimes.ts` 的颜色名录加一条，对比度测试自动覆盖。加一只造型：`fruits.ts` 加一个水果，`slimes.ts` 加一只像素稿和它自己的原色。加一个图标：`icons.ts` 加一行。

## 删掉什么

都在实现的同一个 PR 里删，新旧两套不并存。

- `src/web/components/KnifeAvatar.tsx`、`src/web/ui/knife-avatar.test.tsx`，以及现状第 4 条列的 7 处用法（换成 `RouterAvatar`、`GateMark`）。
- `src/web/components/SliceWheelIcon.tsx` 和 `src/web/task-graph-rail.test.tsx` 里切面轮的测试（换成 `TaskProgressIcon`）。`computeGraphLayers`、`computeGraphComponents` 挪进 `src/web/task-graph-layout.ts`；`fruitTrackVars` 改成按颜色取，挪进 `src/web/lib/palette.ts`。
- `scripts/render-avatars.ts`、`scripts/render-avatars.test.ts` 和 `assets/avatars/` 下 60 个文件：像素稿搬进 `src/shared/slimes.ts`，每只的 `piece` 抽行表和 `pieceGrid` 一起删（Piece 换成便签小灵）。`scripts/stage-runtime-common.ts` 不再打包这个目录；`README.md` 两处说明（第 230、467 行）改成指向 `src/shared/slimes.ts`。
- `src/shared/fruits.ts` 的 `pmFruitAvatarFile`；`FRUITS` 里的 `blob`、`accent`、`accentForeground` 挪进颜色名录，`fruits.ts` 只留水果名录和 `pmFruitOf`。
- `src/web/lib/palette.ts` 的 `PALETTE`（含 `piece`）和按编号取色的 `paletteOf(key)`、`accentStyle(key)`、`tintStyle(key)`，改成按形象取；`Avatar` 的 `colorKey` 改成 `look`；`ConversationEntry` 等处的 `avatarKey` 改成 `look`（`selectors.ts:80`、`:131`、`:873`、`:888`、`:998`、`:1019`）。
- `src/daemon/feishu/avatars.ts` 的 `FEISHU_AVATARS_DIR`、`pmFruitImagePath`、`feishuAvatarHash`，换成 `renderFeishuAvatar`；`chats.ts` 的 `fruit` 改成 `look`；`store.ts` 的 `avatarFruit` 改成按形象键记。
- `Pm.avatarFile` 字段、`rows.ts` 里它的映射和测试里的 `null`。`pms.avatar_file` 这一列留着不读不写：删列要重建 `pms`（见做法比较），不值得。
- `scripts/render-icons.ts` 里画橘瓣的 `WEDGE`、`sectorPath`、`roundedSector`、`wedge`。
- 47 个文件里的 `from "lucide-react"`，改成 `from "../ui/icons.ts"`；`LucideIcon` 类型改成 `Icon`。删除 `lucide-react`。输入框的线条图标由 `icons.ts` 定义。`Composer.tsx` 里的 `Paperclip`、`ArrowUp` 换成 `ComposerAdd`、`ComposerSend`，`icons.ts` 里没人用的导出一起删。`AGENTS.md`「我们用的组件」加上 pixelarticons 和选定的字体包，删掉 lucide 那一行。
- `Composer.tsx:51` 的 `rounded-[26px]` 和发送键的 `rounded-full`。
- `PeelTrack.tsx` 的 `TrackPath`、`TrackDot`（`:85`～`:127`）和画弧线的那段，换成 `pixel-path.ts`；`task-graph-layout.ts` 的 `buildMultiPointLrSplineAndArrow` 和另外两个出贝塞尔的函数（`:435`～`:477`），换成 `orthogonalRoute` + `tubePaths` + `pixelArrowPaths`，`LayoutEdgePath.d` 的注释改成“正交折线中线”。
- `docs/ui-standard.md`：第 4 条“水果三元视觉与 Router 水果刀中性色规则”，第 5 条（lucide），第 7 条输入框的形状，第 12 条的 `SliceWheelIcon`，第 12.1 条标题里的“小切面进度轮与门禁水果刀”和“水果刀拍板焦点”、果皮轨和放大全览的画法，第 13 条字体栈，第 16 条“左栏 Router 水果刀三档置顶规则”，第 21 条 `KnifeAvatar` 一节。换成嫩芽铃、便签小灵、像素图标（含第 0 条的尺寸例外）、新字体、果冻管道、方框输入框（第 2 条加圆角例外）的规则；第 3 条、第 16 条的左栏名字和行高照拍板改；第 17 条补上“正在进行的那一轮头像跟跳”。`docs/router-design.md`、`docs/router-workbench-v2-design.md`、`docs/orchestration-simplify-design.md` 提到小刀、切面轮、纸片分身的地方一起改。

## 骨架文件

- `src/shared/slimes.ts`：造型 × 颜色的类型、颜色名录的 id、上色、Piece 分身（和造型无关）、光学对齐、默认形象、新建时分配、飞书和图标用的位图。
- `src/shared/slimes.test.ts`：上面每条契约的 `it.todo`。
- `migrations/0038_pm_looks.sql`：`pm_looks` 表。
- `src/shared/domain.ts`：`Pm` 加可选的 `avatarFruit`、`avatarColor`（老版本设备不带）。
- `src/shared/api.ts`：`API_PATHS.pmLook`、`PmLookRequest`、`PmLookResponse`。
- `src/shared/ledger.ts`：`setPmLook` 的签名和契约；`src/daemon/ledger/ledger.ts`、`src/daemon/ui-server/fake-ledger.ts` 先放“未实现”。
- `src/web/components/RouterAvatar.tsx`：总助头像（嫩芽铃，干活时左右摇），取代 `KnifeAvatar`。
- `src/web/components/GateMark.tsx`：任务图里“等你拍板”的小铃，取代小刀。
- `src/web/task-progress.ts`、`src/web/components/TaskProgressIcon.tsx`：嫩芽生长的进度图标，取代 `SliceWheelIcon`。
- `src/web/components/SlimePicker.tsx`：换形象的浮层。
- `src/web/ui/icons.ts`、`src/web/ui/icons.test.ts`：全站图标出口，47 个像素图标沿用 lucide 的名字，加输入框的 `ComposerAdd`、`ComposerSend` 和 `Icon` 类型。
- `src/web/pixel-path.ts`、`src/web/pixel-path.test.ts`：任务图的果冻管道、正交折线、像素箭头和珠子。
- `src/web/slime-cohesion.test.tsx`：总助头像、进度图标、拍板标记、按形象画的 `Avatar`、Piece 分身、浮层、左栏行、聊天跟跳、果冻管道、输入框的 `it.todo`。
- `src/daemon/feishu/avatars.ts`：`renderFeishuAvatar` 的签名；`avatars.test.ts`、`chats.test.ts` 加 `it.todo`。
- `src/daemon/ledger/ledger.test.ts`、`src/daemon/ui-server/server.test.ts`、`test/migration.test.ts`：`setPmLook`、`PUT /api/pms/:id/look`、0038 的 `it.todo`。

骨架没改已有签名（`Avatar` 的 `colorKey`、`paletteOf(key)`、`SliceWheelIcon`、47 处 lucide import 等）：改了以后 30 多处调用都要先走到还没实现的函数，页面会坏。实现步骤一次改完，新签名已经写在上面的新文件里。

没写进骨架、等拍板或只在 CSS 里的：字体包和 `--font-ui`（要先 `pnpm add` 拍板的那一款）、像素图标的尺寸 token（`size-pixel`、`size-pixel-sm`）、输入框和发送键的圆角、管道三层的颜色变量。便签小灵、嫩芽铃的像素稿已定，在附录，实现时写进 `slimes.ts` 和 `RouterAvatar`。

实现步骤另加 `migrations/0039_feishu_avatar_look.sql`：照 0037 重建 `feishu_avatars`，主键改成形象键（`lookKey`）；`feishu_chats.avatar_fruit` 保留列名，只清空旧水果名，此后记录形象键（每个群下次对齐重设一次头像）。这一份要和 `store.ts` 的改动一起上，骨架里先不加。合并前确认 0038、0039 没被别的 PR 占用。

## 验收方法

- 测试：`src/shared/slimes.test.ts`、`src/web/slime-cohesion.test.tsx`、`src/web/pixel-path.test.ts`、`src/web/ui/icons.test.ts` 全部；`avatars.test.ts`“按形象画群头像”、`chats.test.ts`“群头像跟着项目经理的形象”、`ledger.test.ts`“项目经理的形象”、`server.test.ts`“PUT /api/pms/:id/look”、`test/migration.test.ts`“0038_pm_looks”；`src/web/lib/palette.test.ts` 改成遍历全部颜色；`ui-scale.test.tsx` 加上像素图标的尺寸例外。加上 `pnpm typecheck`。
- 截图（放 `docs/screenshots/slime-cohesion/`）：真实网页的左栏宽栏、72px 窄栏、手机列表；Router 工作台顶栏、时间流和空状态；右栏的果冻管道、进度图标和小铃；放大全览的节点卡和管道；Piece 汇报行、Piece 对话顶栏、右栏开关；左下角的像素图标（悬停、按下各一张）；输入框空着、有字、多行各一张；资料页换形象浮层，换造型、换颜色各一张；同一个项目经理换色前后的对话页（强调色、气泡、果冻底、Piece 分身一起变）；换字体前后同一页各一张，Mac 和 Windows 各一张。
- 录屏（mp4，H.264，50 MB 以内）：项目经理干活时消息流里正在进行的那一轮头像跟跳，Piece 汇报行的便签小灵跟跳，总助嫩芽铃左右摇，这一轮结束后停下，历史轮一直不动。
- 飞书：用测试应用把一个项目经理换成天蓝狐狸，守护进程日志里出现一次上传和一次改群头像，`feishu_avatars` 多一行 `persimmon:sky`；再换回原色，不再上传（哈希命中）。
- 应用图标：`node scripts/render-icons.ts /tmp/fusa-icon.png` 的输出、`tauri icon` 生成的 Windows 图标、`pnpm app:mac` 打出的 `Fusa.app` 在 Dock 里的截图。

## 附录：像素稿、管道和对照表

像素稿的写法和 `scripts/render-avatars.ts` 一样：每行一样长，`.` 透明。

### 总助：C 嫩芽铃（已选）

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

进度图标（嫩芽生长，10×10）：一根茎，一步一节，叶子左右交替往上长；没长到的节只有虚线茎。叶子的颜色看步骤状态：做完是项目经理颜色的 `blob`，在干是 `blob` 掺 55% 白，等你拍板是 `accent`，等项目经理是 `--caution`，没轮到和跳过只有茎上一个小芽。

应用图标：画布 16 个单位，圆角方块 `rx 3.6` 满铺 `#2f6f43`，像素稿放在 (2, 1.75)，脚下两条地影 `#235634`：(3, 13.5) 宽 10 高 1、(4, 14.5) 宽 8 高 0.5。favicon 16px、32px 时像素稿改放 (2, 1)，一格正好 1px、2px。Mac 照现在 `padded` 的规则四周留透明边。

干活时：以提钮（第 2、3 行中间）为轴左右各摇 14°，和项目经理蹦跳同一个节奏。

### Piece 分身：P1 便签小灵（已选）

字符：`o` 描边、`b` 身体、`s` 暗面、`c` 浅色、`e` 眼睛（`#3a1e14`），前四种跟着项目经理的颜色。在 12×12 画布里按占的行上下居中。

```
............
............
..oooooooo..
..occcccco..
..ocecceco..
..ocecceco..
..occcccco..
..occccbbo..
..occcbboo..
..oooooo....
............
............
```

干活时和项目经理一样蹦（站、蓄力、跃起、落地四帧）。

### 果冻管道和珠子

管道：同一条正交折线画三层。第一层描边色、4 格宽；第二层芯、2 格宽；第三层高光、1 格宽，折线往左上各挪半格。走通的三层依次是项目经理颜色的描边、身体、浅色；没走通的只画前两层，用 `#d4d4d8` 和 `#f1f1f3`。拐角是直角，线头是方头。果皮轨一格是 2 个画布单位（`--peel-u`），管道中心线落在泳道的 x 上；放大全览一格是 2px。

珠子（7×7 格，`O` 描边、`f` 芯、`h` 高光、`s` 暗面、`l` 白、`L` 浅色）：

```
做完               在干               没轮到、跳过        N done 折叠
.OOOOO.            .OOOOO.            .OOOOO.            .OOOOO.
OhhfffO            OllllLO            OwwwwwO            OfffffO
OhffffO            OlfffLO            OwwwwwO            .OOOOO.
OfffffO            OlfffLO            OwwwwwO            .......
OffffsO            OlfffLO            OwwwwwO            .OOOOO.
OfffssO            OLLLLLO            OwwwwwO            OfffffO
.OOOOO.            .OOOOO.            .OOOOO.            .OOOOO.
```

颜色：做完、在干、N done 用项目经理颜色的描边、身体、浅色、暗面；等项目经理是琥珀色（描边 `#9a6a00`、芯 `#dba10b`、高光 `#f6d77a`），形状同“做完”；没轮到、跳过是 `#a1a1aa` 描边、白芯；N next 同 N done 的形状，用没轮到的颜色。等你拍板那一步不画珠子，画小铃。

箭头（放大全览，9 行 5 列，尖朝右）：

```
O....
OO...
OfO..
OffO.
OfffO
OffO.
OfO..
OO...
O....
```

### 放大全览的节点卡

卡片四角切两级台阶（`clip-path`，每级 3px），1px 边框画在里面（`inset` 阴影，切角处不断）。左上角角标写两位步骤号。做完用 `backdrop` 配前景色文字，24 色对比度均须达到 4.5:1。在干用白底加 `blob` 细边，等你拍板用 `--primary` 配白字，其余用浅灰底配次要文字色。底行写 `#编号` 和状态词。画布底是 16px 一格的浅灰点阵。

### 输入框

外框 `rounded-xl`（12px），1px `border-border`，阴影和聚焦光晕照旧（`.composer-frame`）。单行时一行里依次是“+”键、文字区、发送键，整条高 48px；多行或有待发文件时，文字区占满上一行，“+”和发送键落到下一行（界面标准第 7 条现有规则）。“+”键是 36px 的 ghost 圆角方块（圆角 10px），图标 20px 灰色，悬停浅底；发送键是 36px、圆角 10px 的实心方块，没内容时中性灰、不可点，有内容时项目经理的强调色加白色箭头，“从空变有内容”那一下照旧轻轻放大回弹。停止键同一个方块，里面是实心小方块。

### 像素图标对照（lucide → pixelarticons）

| lucide | pixelarticons | lucide | pixelarticons |
| --- | --- | --- | --- |
| AlertCircle | square-alert | Laptop | laptop |
| ArrowLeft | arrow-left | Loader2 | loader（按 8 步转） |
| ArrowLeftRight | arrows-horizontal | Maximize2 | scale |
| ArrowUp | arrow-up（输入框里用线条的 ComposerSend） | MessageCircleQuestionMark | circle-question |
| Bell | bell | Monitor | monitor |
| Blocks | blocks | Paperclip | attachment（输入框里换成线条的 ComposerAdd） |
| Bot | robot | Pencil | pencil |
| Cable | plug（近似） | Play | play |
| ChartNetwork | git-branch（近似） | Plus | plus |
| Check | check | QrCode | qr-code |
| ChevronDown | chevron-down | Search | search |
| ChevronLeft | chevron-left | Send | send |
| ChevronRight | chevron-right | Server | server |
| ChevronsUpDown | chevrons-vertical | Settings | settings-cog |
| CircleAlert | square-alert | Shield | shield |
| CircleGauge | speed-medium | Smartphone | smartphone |
| Code | code | Square | stop |
| Copy | copy | Tablet | tablet |
| Download | download | Trash2 | trash |
| ExternalLink | external-link | TriangleAlert | warning-diamond（近似） |
| FileText | file-text | Type | text-cursor（近似） |
| FolderSearch | folder（近似） | WifiOff | cellular-signal-0（近似） |
| Globe | globe | X | close |
| Info | circle-info | | |

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
