# 界面标准

agent-hub 网页的统一规则。**以左栏为准**（`src/web/components/Sidebar.tsx`），颜色取 `src/web/styles.css` 的变量。
能落到共用组件里的都已经落进去了（`src/web/ui/`、`src/web/components/SettingsList.tsx`），页面直接用组件，不要在页面里另写一套类名。
新页面或改页面时逐条对照；和这里不一样的地方，要么改页面，要么先改这份标准。

## 0. 界面大小（设置里能调）

- Settings → General → Appearance → “Interface scale”：Compact / Default / Large / XL（下文仍按中文叫紧凑 / 标准 / 大 / 特大），分段选择（第 9 条），点了马上整页跟着变，记在这台浏览器的 `localStorage`（`agent-hub.uiScale`，`src/web/ui-scale.ts`）。**默认“大”（Large）**。
- 做法：只改 `<html data-ui-scale>`，各档的根字号只在 `styles.css` 一处（百分比，括号里是浏览器默认 16px 时）：紧凑 90.625%（14.5px）、标准 100%（16px）、大 109.375%（17.5px）、特大 118.75%（19px）。字号（`--text-*` token）、头像（`Avatar` 把 `size` 换成 rem）、间距和控件（Tailwind 的 `--spacing` 本来就是 rem）都是 rem，一起按比例缩放。
- **这份标准里写的 px 都是“标准”档（根字号 16px）下的值**；默认的“大”档实际是它的 1.09 倍（左栏头像 44 → 48px、正文 15 → 16.4px、顶栏名字 17 → 18.6px）。
- 组件里不写死像素的字号、宽高（`text-[15px]`、`w-[240px]`）：字号用第 3 条的 token，宽高用 Tailwind 的数字档（`w-60`、`max-w-110`）。圆角、1px 边框、窗口断点（`max-[1100px]`）、Mac 交通灯避让照旧用 px。`ui-scale.test.tsx` 守着。

## 1. 间距档位

只用这几档（Tailwind 的 4px 单位）：

| 用在哪 | 值 | 类 |
| --- | --- | --- |
| 主区页面左右边距 | 24px | `px-6` |
| 对话列（消息、输入框）两边的最小边距 | 主区 640px 以下 12px，之上 48px，列在主区里居中 | `--chat-gutter`（`.chat-column` 自带，见第 8 条） |
| 对话顶栏两边 | 左 20px、右 12px | `--header-gutter-start` / `--header-gutter-end`（见第 8 条） |
| 右栏左右边距、组内上下 | 20px / 12px（组之间一条分隔线，见第 12 条） | `px-5` / `py-3` |
| 左栏左右边距、左栏列表项之间 | 12px / 4px | `px-3` / `space-y-1` |
| 组与组之间、弹窗里各块之间 | 24px | `gap-6` |
| 组标题和它的框之间 | 8px | `gap-2` |
| 框内一行的内边距 | 左右 16px、上下 10px | `px-4 py-2.5` |
| 行里名字和控件之间 | 16px | `gap-4` |
| 控件和控件之间（输入框 + 按钮、按钮 + 按钮） | 8px | `gap-2` |
| 名字和它下面的小字之间 | 0～2px | 不加或 `mt-0.5` |
| 弹窗内边距 | 24px | `p-6`（`DialogContent` 自带） |
| 浮层内边距 | 16px | `p-4`（`PopoverContent` 自带） |

## 2. 圆角档位

| 用在哪 | 类 |
| --- | --- |
| 按钮、图标按钮、标签（“只读”）、开关、头像 | `rounded-full`（`--radius-btn`） |
| 容器：左栏列表项、分组框、弹窗、浮层 | `rounded-2xl` |
| 输入框、多行输入、下拉、代码块、设置弹窗左栏的分类项（36px 高） | `rounded-xl` |

不用 `rounded-lg`、`rounded-md`、`rounded-sm` 和别的圆角值。

## 3. 字号和字重

字重只用三档：400（不写）、500（`font-medium`）、600（`font-semibold`）。

**界面字号只有 4 档**，左栏、对话区、右栏、弹窗同一套，哪一栏都不单独小一档（rem，跟着界面大小缩放；表里的 px 是标准档）：

| 档 | 类 | 标准档 px |
| --- | --- | --- |
| 小标注、组标题 | `text-xs`（Tailwind 自带） | 12 |
| 次要文字、按钮和分段选择里的字 | `text-minor` | 13.5 |
| 正文、行的名字 | `text-body` | 15 |
| 标题（对话顶栏、弹窗） | `text-title` | 17 |

唯一的例外是资料页头部的名字 `text-display` 22px。定义只在 `styles.css` 的 `@theme`；没有 14px（原来的 `text-label` 已删）、13px：旧名 `text-small` 现在等于 13.5px，只剩输入框一处在用（另一任务改完后删）。名字登记在 `lib/utils.ts` 的 `FONT_SIZE_TOKENS`，`cn()` 才不会把它们当成颜色合并掉。Markdown 正文里的标题（第 15 条）、代码块的字号另算。

| 用在哪 | 字号 | 字重 | 颜色 |
| --- | --- | --- | --- |
| 弹窗标题、对话顶栏的名字 | 17px `text-title` | 600 | 前景 |
| 资料页头部的名字（只有这一处） | 22px `text-display`，`tracking-tight` | 600 | 前景 |
| 正文、行的名字、控件里的字、输入框 | 15px `text-body`（body 默认） | 400 | 前景 |
| 行右边的只读值（厂商只有一家时的厂商名） | 15px | 400 | `text-muted-foreground` |
| 左栏的项目经理名字 | 15px | 600（选中也是 600，只靠底色表示） | 前景 |
| 人名、对话名（修改记录里的“谁”） | 15px | 500 | 前景 |
| 左栏、右栏的组标题（设备组、Needs You、Pieces、Completed、已归档） | 12px `text-xs` | 500 | `text-muted-foreground` |
| 分组框外的组标题、“更多设置”这类折叠开关 | 13.5px `text-minor` | 500 | `text-muted-foreground` |
| 次要文字：行下面的说明、资料页头部的项目名、文件夹路径、左栏的消息预览、错误 | 13.5px，行下的说明 `leading-snug` | 400 | `text-muted-foreground`（错误 `text-danger`） |
| 按钮里的字 | 13.5px（默认和 sm 一样） | 500 | 按钮自带 |
| 时间、计数这类小标注 | 12px `text-xs` | 400 | `text-muted-foreground`，数字加 `tabular-nums` |
| 右栏（第 12 条，和左栏、对话区同一套） | 组标题 12px；行的名字 15px（只有一行）；Show more 13.5px | 组标题 500，其余 400 | 组标题、Show more `text-muted-foreground`，名字前景色 |

不用 13px、14px。

措辞（界面外壳的字一律用简洁地道的英文）：
- **外壳用英文**：`src/web/` 里写死的界面字——组标题、行名、按钮、占位符、空状态、状态词、读屏名字（`aria-label`）、悬停提示——都用英文，句首大写、其余小写（sentence case：“New session”“Interface scale”），专有的组名例外（“Needs You”）。**不改的**：聊天内容（用户、agent 写的字）、Piece 标题和项目经理名字这类用户数据；接口和本地出错的说法（`src/shared/errors.ts` 的 `humanize`、`describeFailure`，上传失败、发不出去这类错误提示）；`src/shared/`、`src/daemon/` 里给命令行和提示词用的中文（如 `PM_MODE_LABELS`、`scheduleLabel`，界面另有英文版 `MODE_LABELS`、`formatSchedule`，在 `src/web/format.ts`）。
- 组标题、行名用名词短语（“Mode”“Effort”），不带括号说明（“Orchestrate (recommended for complex projects)”不行）。
- 行下的说明一句话说清后果，结尾不加句号，不写“recommended”“best for…”这类建议。
- 行名和它右边按钮的字不重复：行名说是什么，按钮说做什么（“New session”那一行的按钮是“Start…”，带“…”表示还要确认）。
- 可选的输入框不在行名上写“(optional)”，占位符写“Optional”。
- 状态词照旧英文（Handing off…、Saving…、Working…），时间写“3m ago”“just now”，剩余天数写“Deletes in 7d”，计数只写数字（不写“4 个”；右栏的组标题不带数字）。
- 下文引号里的中文界面词是旧叫法，对应的英文以下表为准；新加界面词先补进这张表：

| 中文旧称 | 界面上的英文 |
| --- | --- |
| 等你确定 / 等你 | Needs You / Your turn |
| 已收工（右栏） | Completed |
| 已归档 / 恢复 / 归档… | Archived / Restore / Archive… |
| 搜索 / 设置 / 新建项目经理 | Search / Settings / New project manager |
| 离线 / 重连中 / 在线 / 本机 | Offline / Reconnecting / Online / This computer |
| 给 X 发消息 | Message X… |
| 停止 / 发送 / 复制 / 已复制 / 撤销 | Stop / Send / Copy / Copied / Undo |
| 通用 / 电脑 / 登录与安全 / 外观 / 通知 | General / Computers / Security & Access / Appearance / Notifications |
| 界面大小：紧凑 / 标准 / 大 / 特大 | Interface scale: Compact / Default / Large / XL |
| 工作方式：只管理 / 自己也干活 | Mode: Orchestrate / Hands-on |
| 厂商 / 模型 / 思考程度 / 性格设定 / 修改记录 | Provider / Model / Effort / Persona / History |
| 会话 / 开新会话 / 定时任务 / 文件夹 | Session / New session / Schedules / Folders |
| 额度 / 5 小时 / 7 天 / 30 天 / 重置 | Usage / 5h / 7d / 30d / Resets |
| 取消 / 保存 / 创建 / 重试 / 加载中 | Cancel / Save / Create / Retry / Loading… |

## 4. 颜色

- **强调色（`--primary` / `--primary-foreground`）跟着当前会话的项目经理走，没有固定的粉色。**
  - **来源**：`src/web/lib/palette.ts` 的 `PALETTE`（8 种水果配色）一处，项目经理的完整水果横切面头像（`slice`）、Worker 的自然果瓣头像（`wedge`）、水果主色（`blob`）和强调色（`accent` + 文字色 `accentForeground`）共用这一份，按项目经理的编号（头像的 `colorKey`）轮着取。别处不写颜色值。
  - **谁在里面**：项目经理的对话、它的 Worker 的对话、它的资料页、右栏，外面包一层 `AccentScope`（`lib/accent-scope.tsx`，`display: contents`），在这层上设好 `--primary` 和 `--primary-foreground`，里面的组件照常写 `bg-primary text-primary-foreground`，不自己算颜色。会话里打开的弹窗（如资料页的“开新会话？”）也渲染进这层，颜色跟着。**左栏、设置弹窗、新建项目经理弹窗、加载页不在里面**，`:root` 里的 `--primary` 是中性的前景色 `#18181b`，所以不用单独处理。
  - **用在哪（实心强调色只用在这几处）**：主按钮（一屏最多一个：创建、保存、发送、停止；悬停用 `hover:brightness-90` 变深，不用透明度，对比度只升不降）、选中态（单选行的勾、开关打开）、右栏“等你确定”组标题前的小圆点和收起时右栏开关上的圆点、拖文件进输入框时的虚线框。对话里就是**发送键和小圆点**。
  - **用户自己的气泡是浅果冻底**（`bg-bubble-me text-bubble-me-foreground`）：底色是当前强调色掺白 `color-mix(in srgb, var(--primary) var(--mix-bubble-me), #ffffff)`（12%），字是前景色（深色），不是白字压实心强调色；8 种水果的气泡底配前景色字对比度都 ≥ 4.5:1（`lib/palette.test.ts` 按 `--mix-bubble-me` 逐色校验）。气泡的形状、圆角、内边距不变（第 17 条）。
  - **不用强调色的**：灰色的文字按钮（系统行里的“撤销”这类行内小操作）：`text-muted-foreground`，悬停 `text-foreground`。没有彩色底的提示条、没有彩色边框（拖文件的虚线框除外）。
  - **左栏的标注使用清爽的绿色提醒**：“等你确定”与“等你”均统一为绿色（`bg-status-active` / `text-status-active`）。在 72px 窄栏收紧态下，头像右下角用绿色小圆点（`size-2 rounded-full bg-status-active ring-2 ring-sidebar`）；在展开态左栏下，“等你确定”和“等你”都只是一颗绿色小圆点（`size-2 shrink-0 rounded-full bg-status-active`），**不写“等你”两个字**，名字只放在圆点的 `aria-label` / `title` 上给读屏和悬停用，干净克制，不用原来的深色胶囊样式。
  - **对比度**：强调色同时当“白字的底色”和“白底上的文字色”，所以每种颜色对白色的对比度都要 ≥ 4.5:1，按 WCAG 2.x 1.4.3（AA，普通文字，https://www.w3.org/TR/WCAG21/#contrast-minimum ，公式 https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio ）。水果主色 `blob` 是明亮的原色（不放文字），`accent` 是与水果同色系深一档（黄、橙、绿原色配白字不到 3:1，所以必须深一档）。新加颜色必须过 `lib/palette.test.ts` 的对比度校验（含悬停变深之后）。
- **水果果冻底（列表项的选中、悬停）**：左栏的项目经理行（宽栏的行和 72px 窄栏的头像方块）、右栏的行（Piece、Needs You 的提问），选中是 `bg-jelly`、悬停是 `hover:bg-jelly-hover`——水果强调色掺透明的极淡底（选中 10%、悬停 5%，`color-mix(in srgb, <accent> 10%, transparent)`），和头像、右上角果瓣同一色系，清透不抢字。
  - **颜色从哪来**：浓度和写法只在 `styles.css` 的 `--color-jelly` / `--color-jelly-hover` 一处；颜色取行上的 `--jelly`，没设就用 `--primary`。右栏在 `AccentScope` 里，不用设，跟着当前项目经理；左栏不在任何会话里，每行用 `style` 设 `--jelly` 为这个项目经理的 `paletteOf(avatarKey).accent`（`Sidebar.tsx` 的 `jellyOf`）。
  - 只用在“一行代表一个项目经理 / Piece / 提问”的列表项上；设置弹窗的分类、分组框里的行、下拉、分段选择、组标题和 Show more 这类控件照旧中性灰（`bg-sidebar-hover` / `bg-sidebar-active`）。选中只靠底色，字重不变。
- **外壳底色掺一点水果色**：对话区（`main`，含资料页）和右栏、左栏的底色、三栏之间和右栏组之间的分割线，掺**当前打开的项目经理**的水果强调色，切换项目经理时 300ms 淡变；没有打开的项目经理时是原来的中性色。
  - **变量**（只在 `styles.css` 改）：浓度在 `:root` 的 `--mix-*`：`--mix-chat` 2.5%（对话区、右栏）、`--mix-sidebar` 4%（左栏）、`--mix-line` 8%（分割线）、`--mix-bubble-me` 12%（用户气泡）。上限：底色 5%、分割线 10%，再多界面就发黄发粉（`palette.test.ts` 守着）。颜色是 `@theme` 的 `--color-surface-chat` / `--color-surface-sidebar` / `--color-line`（`color-mix(in srgb, var(--fruit) <比例>, <原来的中性色>)`），组件里写 `bg-surface-chat`、`bg-surface-sidebar`、`border-line` / `divide-line`，不各写各的 `color-mix`，也不在 React 里算颜色。
  - **谁设 `--fruit`**：`lib/accent-scope.tsx` 的 `FruitTint`，包住整个外壳（左栏也在里面，`display: contents`），只设 `--fruit`，不动 `--primary`（左栏的强调色照旧中性）。
  - **淡变**：只有这几个容器（左栏、`main`、右栏和它的几组）带 `.tint-fade`（`background-color`、`border-color` 300ms，`--motion-tint`），不写 `* { transition }`；减弱动态效果时没有过渡。
- 头像（`Avatar.tsx`）：项目经理用完整水果横切面（`PALETTE.slice`），它派出的 Worker 用从这片水果上顺着果络剥下的一瓣（`PALETTE.wedge`，`neutral` 为 `true`，`colorKey` 传所属项目经理的 `avatarKey`）。
- 其余一律中性色：
  - 页面底色 `bg-background`（白，外壳的对话区和右栏是上面的 `bg-surface-chat`）；左栏 `bg-surface-sidebar`，设置弹窗的分类栏 `bg-sidebar`；分组框白底 + 1px `border-border`（第 9 条）；悬停 `bg-sidebar-hover`；选中、凹进去的输入框（左栏搜索）`bg-sidebar-active`（左栏、右栏的列表项除外，用上面的果冻底）。
  - 分隔线：一律 1px `border-border` / `divide-border`（分组框里行与行之间也是它）。
  - 次要文字 `text-muted-foreground`；错误 `text-danger`；警告 `bg-warn text-warn-foreground`。
  - 状态色（Worker 汇报头像右下角的小圆点，第 17 条）：做完了 `--success`、有问题 `--caution`、放弃了和出错 `--danger`，不用主色。
- 不能点的主按钮换成中性灰（`bg-sidebar-active text-muted-foreground`，`Button` 自带），不显示半透明的强调色。
- 不用渐变、阴影（聊天输入框那一处轻阴影除外）、毛玻璃。在忙状态词、右栏在跑的 Piece 名字的流光（第 14 条）是同一颜色深浅扫过，不算渐变文字。提示条（“重连中”、健康问题）也只用底色，不加阴影和描边。

## 5. 图标

lucide-react，默认 16px（`size-4`，按钮里自动）；聊天输入框的按钮 20px。颜色跟文字走，次要图标 `text-muted-foreground`。不用 emoji 当图标。

## 6. 控件尺寸

两档高度，**默认 36px**，小号 32px 只用在列表行里的次要操作（撤销、组标题右边的保存）和左下角的小按钮。

| 控件 | 默认 | 小号 | 组件 |
| --- | --- | --- | --- |
| 按钮 | `h-9 px-4` | `h-8 px-3`（`size="sm"`） | `Button` |
| 图标按钮 | `size-9`（`size="icon"`） | `size-8`（`size="icon-sm"`） | `Button` |
| 输入框 | `h-9 px-3` | — | `Input` |
| 下拉 | `h-9`，宽度跟内容，最宽 260px；分组行里改了马上存的用 `variant="plain"`（见第 9 条） | — | `Select` |
| 多行输入 | 最少 `min-h-24`，在分组框里时去掉边框、跟着内容长高 | — | `Textarea` |
| 开关 | `h-5 w-9`（滑块 `size-4`） | — | `Switch` |

输入框和按钮放同一行时用同一档高度（都是 36px）。分组行里的输入框宽 240px（`w-60`）。

**工具栏和角落里的按钮只有一种样子**：`Button variant="ghost"`，平时不带底色、不带描边、不是胶囊，图标是次要色；悬停才有浅底（`hover:bg-accent`）、图标变前景色。右栏顶部和顶栏右边（右栏开关）、顶栏左边（返回）、左栏顶部的“新建”、左栏左下角（额度、设置）都是它：纯图标用 `size="icon"`（顶栏、左栏顶部，36px）或 `size="icon-sm"`（左下角，32px）；要带字的（额度）用 `size="sm"`，同样没有底色。打开状态不靠底色表示，靠 `aria-expanded` 和图标变前景色。实心的、描边的按钮只用在弹窗、表单、资料页的操作上。

## 7. 聚焦态

- 统一中性，**不用主色，不加彩色光圈**。`--ring` 是中性灰（`#a1a1aa`），`ring-ring` 就是它。
- 文字输入（聊天输入框、`Input`、`Textarea`、`Select` 的带边框样式）：**聚焦时样子不变**——边框颜色、粗细、阴影都不变，靠光标闪表示（照 Claude desktop、t3code）；组件里不写任何 `focus` 样式。
- 按钮、列表项、单选行、开关这类点的东西：键盘聚焦时显示 `focus-visible:ring-2 focus-visible:ring-ring/50`（单选行在框里，用 `ring-inset`）。只在键盘聚焦（`focus-visible`）时出现，鼠标点不出圈。
- 不合规的输入：`aria-invalid` 时红边框（组件自带），原因写在那一行下面。

## 8. 对齐

- **左对齐基线**：分组框里的文字都从框内 16px（`px-4`）开始；组标题、“更多设置”、框外的错误提示也用 `px-4`，和框里的字对齐成一条线。
- 行：名字靠左，控件靠右，上下居中；名字下面的小字跟名字左对齐。只读的短值（厂商名）靠右，15px 次要文字色。
- 文件夹路径不放在行右边：一个文件夹一行，名字是文件夹名（15px），下面一行是路径（13.5px 灰，用户目录写成 `~`，`truncate` 截断，`title` 放全文）；主文件夹右边写“主文件夹”（12px 灰）。
- 弹窗：标题在左上，关闭按钮在右上（`top-4 right-4`，32px）；底部按钮用 `DialogFooter`，靠右，主按钮在最右。
- **对话顶栏左上角只有头像（34px）和名字**（17px、600，垂直居中），名字下面不放文件夹、路径；文件夹只在资料页的“文件夹”一组里看和管。点头像打开资料页。Piece 的对话顶栏右边、右栏开关左边多一行 12px 灰字：模型、思考程度、对话长度（第 12 条的 `PieceMeta`）。
- 页面头部（资料页）：头像（64px）、名字（22px）、项目名（13.5px 灰，和名字隔 4px）居中，项目名只在这里出现一次，下面的分组不再重复；返回按钮在左上 64px 高的顶栏里（和对话页顶栏同高）。
- 主区内容最宽 640px 居中（资料页）。
- **对话列照 t3code：有最大宽度，在“左栏和右栏之间剩下的区域”（主区 `main.chat-main`）里居中**，右栏展开、收起、窗口宽窄都一样自然，不会有哪一边空出一大块（右栏展开时主区窄，列差不多占满；收起时列居中，两边留白一样多）。出处：t3code `apps/web/src/index.css` 的 `--chat-content-max-width: 46rem`、`.chat-composer-lane`（两边内边距 0.75rem，sm 以上 3rem）、`.chat-content-lane`（`margin-inline: auto` + `max-width`），`ChatView.tsx`、`ChatComposer.tsx`、`MessagesTimeline.tsx` 里消息和输入框都套它。
  - **宽度不写死像素**：全部数字只在 `styles.css` 一处，单位 rem（用户放大网页、调字号会跟着变）。`.chat-main` 是容器（`container: chat / inline-size`），按**主区宽度**（不是窗口宽度）分档：默认最宽 46rem（t3code 的默认值）；主区 ≥ 64rem 时 52rem；≥ 80rem 时 58rem；≥ 112rem 时 64rem（再宽就留白，免得一行太长）。分档的做法照 ChatGPT（`--thread-content-max-width` 随容器宽度变宽，档位由我按中文 15px 的舒适行长调整），t3code 自己只有一档（另有“宽”72rem / “满”设置）。
  - **居中的写法**：`.chat-column` 和 `.messages`（消息列表）都是 `padding-inline: max(var(--chat-gutter), calc((100% - var(--chat-max)) / 2))`，两边一样宽；`--chat-gutter` 主区 40rem 以下 0.75rem，之上 3rem。输入框外层、消息列表、提示条（Notices）都套 `.chat-column` / `.messages`，不各写各的宽度。
  - **顶栏不跟着列居中**（照 t3code `ChatView.tsx` 的 header，两边是 `--workspace-gutter`）：标题在左上、按钮在右上，左边距 `--header-gutter-start`（20px）、右边距 `--header-gutter-end`（12px）。右栏开关也在右上角：右栏展开时在右栏最上面一行，收起时在顶栏最右边。

## 9. 分组列表（设置那种一行一项）

用 `SettingsGroup` + `SettingsRow`（`src/web/components/SettingsList.tsx`），能收起的组用 `CollapsibleGroup`，工作方式这种多选一用 `ModeRows`。资料页、新建项目经理、设置弹窗全用这一套，**照 Grok Bot 的设置页：框外小灰字组标题 + 白底细框**。

- 组标题在框外：13.5px、500、`text-muted-foreground`、`px-4`，和框之间 8px。没有标题的组直接是框（弹窗里的“名字 / 主文件夹”；资料页头部下面第一组厂商、模型、思考程度，头部就是它的标题；设置“登录与安全”里的“在手机上登录”），读屏名字用 `label`。
- 框：白底、1px 浅边框、圆角，`rounded-2xl border border-border bg-background`，行与行之间 1px `divide-border`；不用灰底色块（`bg-sidebar`、`bg-neutral-50`），不加阴影。样子只写在 `SettingsList.tsx` 的 `GROUP_BOX` 一处。
- 行：`px-4 py-2`，内容最少 36px 高（`min-h-9`），所以一行是 52px；有说明小字的行 `py-3`，跟着长高。
- **带图标的行**（设备、浏览器，照 Grok Bot 的“管理设备”）：`SettingsRow` 的 `icon`，名字左边一个 16px 线条图标（`stroke-[1.5]`，`text-muted-foreground`），和名字隔 12px（`gap-3`）。电脑按系统（Mac `Laptop`、Linux `Server`、别的 `Monitor`），浏览器按 User-Agent（电脑 `Monitor`、手机 `Smartphone`、平板 `Tablet`）。在线状态是小字最前面的 8px 圆点（在线 `bg-success`，重连中 `bg-caution`，其余 `bg-muted-foreground/40`），和后面的字隔 8px，各项之间 `gap-3`，不用“·”。
- **能收起的组（`CollapsibleGroup`）**：低频、会越攒越多的组（已登录的浏览器、公网入口、资料页的修改记录）默认收起，**收起时只剩框里一行**：标题（15px，前景色）靠左，右边是摘要（13.5px 灰，`tabular-nums`：个数写“4 个”“12 条”，开关类写英文状态词 On / Off）和一个 16px 的 `ChevronDown`（灰，展开时转 180°）；这一行和普通行一样 52px 高，整行是按钮（放在 `h2` 里，`aria-expanded`，悬停 `bg-sidebar-hover`，键盘聚焦 `ring-inset`）。点开后下面的行接在同一个框里，同样用细线隔开。框外不再写组标题（标题就在框里第一行）。
  - 默认开不开看数据：有要处理的才自己展开（有待批准的浏览器、列表读不出来；公网入口开着或填过域名）；之后数据变了不自己收起，用户收起的也不再自己弹开。
- 输入框是白底带边框（`Input` 自带）。
- 下拉：改了马上存的设置行用 `Select variant="plain"`：没有边框和底色，字是前景色，右边一个上下箭头（`ChevronsUpDown`，灰），悬停、聚焦 `bg-sidebar-hover`，像 macOS 系统设置的弹出菜单。表单里和输入框并排的（定时任务的“每天 / 每隔”）用默认的带边框样式，和输入框一致。
- 分段选择（`ui/segmented.tsx`，Radix RadioGroup）：只有几个短选项、不用说明的多选一（界面大小），放在行右边。白底 1px `border-border` 的胶囊（`h-9 rounded-full p-0.5`），每段 `px-3`、13px、500、灰字，选中的那段 `bg-sidebar-active` + 前景色字，不用强调色；方向键切换。
- 多选一：一行一个选项，名字 + 一句说明；右边一个 20px 的圆：没选中是 1.5px 灰边空心圆，选中是强调色实心圆里一个白色粗勾（`RadioMark`）。整行可点，悬停 `bg-sidebar-hover`。
- 厂商、模型、思考程度（`AgentRows`）的选项全从模型名单拿（`useModelCatalogs`，名单的厂商名、通用思考程度、能不能自定义来自 `src/shared/vendors.ts`，模型来自厂商自己报的 `model-catalog`），页面里不写死厂商、模型名。
  - 只有一家厂商：厂商一行只显示厂商名（只读值），不放下拉。两家以上才是下拉。
  - 这台设备上的状态（`docs/vendor-availability-design.md`）：没装的不列；没登录的照列，原生 `option` 设 `disabled`（系统灰掉），文字是“厂商名 (英文状态词)”，如 `Codex (Not signed in)`、`Claude Code (Not installed)`（原生选项不能分样式，括号是唯一能用的写法）。现在选着的那家总在，哪怕没装（换了设备也不悄悄换掉），这时“创建”是灰的，不加说明文字。打开下拉不等任何请求，没登录的那几家在后台重问，回来了再更新。截图见 `docs/screenshots/vendor-availability/`。
  - 思考程度只有一档（或这个模型没有档位）时，这一行整个不显示。Antigravity 照它软件的做法：模型下拉只列不带档位的模型（Gemini 4 Argon、Claude Opus 5.5……），档位（low、medium、high）在思考程度下拉里，存的时候拼回完整模型 ID（`docs/model-catalog.md` 的 agy 一节）；老数据里存的完整 ID 显示成“模型 + 档位”。
  - 模型选“默认”时显示实际用的模型：“Opus 5.5（默认）”（名单里报了默认是哪个时）；不知道才只写“默认”。
- 改了马上存的设置（下拉、多选一）：不放保存按钮，先显示新值，失败退回并在那一行下面写原因（`RowError`）。长文本（性格设定）改了才在组标题右边出现小号“保存”。
- 错误、空状态（“还没有修改”）也是框里的一行，`px-4`。
- 多行输入在框里时是框的一整行：去掉边框、底色和拖拽角（`resize-none`），跟着内容长高（`field-sizing-content`），`px-4 py-3`；名字放占位符和 `aria-label`，不另起一行写名字。

### 表单校验（新建项目经理、新建定时任务，以后的表单都照这个）

- **必填项空着**：主按钮灰（不能点），不报错——空着不是错。
- **填了但不对**（超长、格式不对、带不能用的字）：边输入边在**那一行下面**写原因（`SettingsRow` 的 `error`），输入框红边（`aria-invalid`），主按钮灰。一条原因只说一件事：“名字最多 40 个字”和“名字不能是空的”是两种情况，不写在一句里。
- 主按钮能点就一定能交上去：前端能查出来的错都在点之前显示在行下，不在点了之后才报。
- **后台拒绝**：能对上行的写在那一行下面；对不上的写在底部按钮上面（`px-4`，`text-danger`）。表单保留用户填的内容。
- 提交中：主按钮转圈、不能点，其余输入框不动。
- 数量满了这类不是哪一行的错（定时任务满 20 个）：入口（“新建”）直接不能点，旁边写状态（“已满 20 个”），不让用户填完才知道。

## 10. 弹窗

`DialogContent`（`src/web/ui/dialog.tsx`）：

- `rounded-2xl border border-border bg-background p-6`，遮罩 `bg-black/30`。
- 宽度三档：默认 520px（新建项目经理）；二次确认等窄弹窗 `className="max-w-110"`；全局设置是双栏的 780px（见下面）。
- **全局设置（`SettingsDialog`，照 Grok Bot / Claude desktop 的双栏设置页）**：`max-w-195`，高度固定 `h-[min(35rem,calc(100%-3rem))]`（切分类时弹窗不跳），弹窗自己 `p-0 gap-0`，标题“设置”只给读屏（`titleClassName="sr-only"`）。
  - 左栏分类（Radix Tabs，`orientation="vertical"`）：宽 192px（`w-48`），`bg-sidebar`，右边 1px `border-border`，`px-3 py-4`；分类项 `h-9 rounded-xl px-3 gap-3`，16px 线条图标（`stroke-[1.5]`）+ 15px 名字，悬停 `bg-sidebar-hover`，选中 `bg-sidebar-active`（只靠底色）。分类和顺序在 `SettingsDialog.tsx` 的 `SECTIONS` 一处：通用（`Settings`：通知）、电脑（`Monitor`：你的电脑、已连上的电脑；守护进程支持联机才有，有就默认选它，没有默认通用）、登录与安全（`Shield`：在手机上登录、已登录的浏览器、公网入口）。
  - 右栏：`p-6`，自己纵向滚动；最上面是分类名（17px、600，和下面的组隔 24px），下面若干分组（第 9 条），组之间 24px。关闭按钮照常在右上角。
  - 窄屏（640px 以下）：左栏变成顶上一排横着的分类（只有字、不放图标，`border-b`，横向能滚，右边 `pr-14` 让出关闭按钮），右栏在下面占满。
  - 分类名固定在右栏顶上（右边 `pr-14` 让出关闭按钮），只有下面的分组滚动。
- 结构从上到下：标题 → `DialogBody`（若干分组，`gap-6`）→ 错误提示（`px-4`，`text-danger`）→ `DialogFooter`。
- **标题和底部按钮固定，只有中间滚动**：内容超过一屏（展开“更多设置”）时，`DialogBody` 自己滚，“创建”一直在视野里。表单弹窗把 `<form>` 做成 `DialogForm`（`flex min-h-0 flex-col`），里面放 `DialogBody` 和 `DialogFooter`。
- 弹窗里的行照第 9 条：输入框 240px（带按钮的，输入框 + 按钮一起不超过行宽），占位符要能完整显示。
- 不写副标题和解释性的灰字；需要的说明放在行下面的小字里。

## 11. 浮层（Popover）

`PopoverContent`：`rounded-2xl border border-border bg-background p-4`，宽 280px。里面的分块标题用组标题的样式（13.5px、500、灰），内容 15px，次要信息 13.5px 灰。

## 12. 右栏（Needs You、Pieces）

对话右边的一栏（`RightRail`，`src/web/components/RightRail.tsx`），**照 Claude desktop 的右栏**：组标题加单行的列表，一组一组用细线隔开，只列几条，不加框、不加阴影，**不密密麻麻**：每行只有一行字，行与行留出呼吸感。界面展示文案统一使用 `Piece` / `Pieces`，组名是 “Needs You”“Pieces”“Completed”。

- **只放三组**：“等你确定”在上，Pieces（没收工的）在中，Completed（收工的）在下；别的一律不加。没有内容的组不显示。
- **推开对话，不浮在上面**：和对话（`main`）并排放在它右边，宽 320px，`border-l border-line bg-surface-chat`（第 4 条的外壳底色），左右 20px（`px-5`），内部纵向滚动；对话区跟着变窄。窄屏（1100px 以下）也一样推开。
- **太窄放不下时（720px 以下）**：右栏不再并排，改成顶栏下面的一块（`border-b`，最高 `40dvh`，里面滚动），把消息往下推；不自动展开，点顶栏的开关才出来。不盖住消息和输入框。
- **展开和收起**：只在有要关心的事时自动出来：有没收工的 Piece（在干活、等验收）或有“等你确定”。**只有收工的 Piece、或什么都没有时，整栏不渲染、不占位置**，对话照常居中；只有收工的时候开关还在，点开关手动打开看“已收工”（这次打开期间一直开着，不记成“收起”），再点收起。有了新的没收工的 Piece 或新的提问，再自动出来。开关是当前项目经理对应水果切出的 Worker 果瓣头像（`Avatar` `colorKey={avatarKey}` `size={26}` `neutral`，整个右栏只有这一颗果瓣，第 6 条的 ghost 图标按钮，有 Piece 或提问就显示，收工的也算），跟着右栏走：并排的右栏展开时，**和第一组的标题在同一行、靠右**（不单独占一行，右栏顶上不留空；第一组 `py-3` 加上 36px 高的开关，标题和对话顶栏的头像、标题大致在一条线上；图标离右边 12px，和收起时在顶栏的位置一样，点的时候不跳）；收起时在顶栏最右边（窗口右上角）；太窄、右栏在顶栏下面时，开关留在顶栏右边。用户手动收起后记住（`localStorage`），之后来了新内容也不自己弹开，收着时有没回答的提问，开关右上角一个 6px 的强调色圆点。资料页不显示右栏。
- **组**：组和组之间一条 1px 细线（`divide-y divide-line`，线和字对齐在同一条线上，不顶到栏边），每组上下各 12px（`py-3`）。**三组的标题一模一样**：12px（`text-xs`）、500、`text-muted-foreground`，高 32px（`h-8`），**不带数字**（收起、展开都不带）；“等你确定”标题前一个 6px 的强调色圆点；标题前不放头像，标题直接是字 + 果瓣箭头。标题下面直接是行，不留空。
- **每一组都能收起**（和整栏的开关是两回事，两个都要有）：组标题整行是一个按钮（`aria-expanded`、`aria-controls`，Enter 和空格都能按，键盘聚焦有圈，悬停 `bg-sidebar-hover`），点一下收起或展开，标题后面一个**小果瓣箭头**（`RightRail.tsx` 的 `WedgeArrow`，三组共用）：当前项目经理那一瓣的现有素材（`Avatar neutral`，14px，和右上角开关同一张图，不加新图），素材里果瓣尖朝左下，**展开转 -45° 朝下、收起转 -135° 朝右**，转向 200ms（`motion-reduce` 时直接换）。
  - 收起后只剩标题这一行，不写个数。
  - 内容用网格行高度过渡（`grid-rows-[1fr]` ↔ `grid-rows-[0fr]`，150ms，`motion-reduce` 时关掉），不跳；收起后内容 `inert` + `aria-hidden`，键盘和读屏都够不着。
  - **每组各自记住**：`localStorage` 的 `agent-hub.rightRail.collapsed`（`{ asks?: true, workers?: true }`，没写的是展开），刷新、切对话都保持，不分项目经理；值坏了当都展开。收起的组里来了新内容不自动展开。Completed 默认收着、不记住，正开着的是收工的 Piece 时自动展开。
- **行**：
  - “等你确定”：左边一个 16px 线条问号图标（`size-4`，`strokeWidth` 1.5，`text-muted-foreground`），中间名字（去掉 Markdown 符号后的第一行，14px，前景色，400，超长 `truncate`），右边一个向右的小箭头；点一下在这一行下面展开全文（13px Markdown，`bg-sidebar`），箭头转向下，同时对话滚到那条消息并高亮。用户在这个项目经理的对话里发出任何一条消息就算都回答了，守护进程标上（`meta.answered`），这一组、左栏的“等你确定”标签和标签页标题里的数字一起消失。没有“知道了”按钮。
  - **行的尺寸**：`py-2 px-2.5 rounded-xl`（`-mx-2.5`，字和组标题对齐），单行 36px；选中、悬停是水果果冻底（第 4 条，`bg-jelly` / `hover:bg-jelly-hover`）。
  - Piece 行：**只有一行**，左侧不放机器人图标，**只有标题**（15px 前景色，`truncate`），**右边不写状态词**（Working…、Thinking…、Idle 都不写）。**正在跑的 Piece（干活、准备中、等后台命令，`RightRail.tsx` 的 `isBusy`）标题字本身带流光** `.status-shimmer`（第 14 条，同一套，不另造），只挂在这几行上；空闲、停止中、收工的标题静态。**不显示第二行**：模型名、思考程度、对话长度（“158K context”）不常驻，收进整行的悬停提示（`title`，第一行是完整标题，后面每项一行，没有的项不写）；点进 Piece 的对话，顶栏右边一行 12px 灰字写模型、思考程度、对话长度（`PieceMeta`，`gap-3`，context 悬停看累计明细；720px 以下藏起来）。
  - **标题去掉机械前缀**：列表里显示的标题去掉开头的分类前缀（“界面：”“修复：”“功能：”……，`format.ts` 的 `cleanPieceTitle`，前缀表只在那一处），直接露出任务名；读屏名字（`aria-label`）和悬停提示保留完整标题。
  - 收工的行标题字 `opacity-60`（只淡字，选中时果冻底不跟着淡），**右边不写 Ended**（整组就叫 Completed，每行再写一遍是噪音），只有标题。点一行打开它的对话。
- **只列几条**（`RIGHT_RAIL_VISIBLE_ROWS` = 3）：
  - Pieces：没收工的最多列 3 条，**在忙的排前面**（其余按派出的顺序）；多了，下面一行灰色的 **Show more**（13.5px、`text-muted-foreground`，没有底色和胶囊，悬停变前景色、`bg-sidebar-hover`），点开展开全部，同一处变成 Show less。正开着的 Piece 在被收起的那几条里时自动展开。
  - “等你确定”：同样最多 3 条，多了 Show more。
  - 收工的 Piece 在 Completed 组里，标题和另两组一样（不带数字），默认收着，点开才列出（行同上，`opacity-60`，全部列出）。没有收工的就没有这一组。只有收工的、手动打开右栏时只有这一组，整栏的开关放在它那一行。
  - 所有字都用英文（Needs You、Pieces、Completed、Show more，第 3 条措辞）。

## 13. 字体、数字、列表行

- **字体栈只在 `styles.css` 的 `--font-ui` / `--font-code` 定义**，组件里不写 `font-family`，用 `font-sans` / `font-mono`。
  - 界面：**系统字体**（照 Claude desktop 和 t3code，不打包字体）：`-apple-system`、`BlinkMacSystemFont`、`"SF Pro Text"`、`"Helvetica Neue"` → 中文字体（`"PingFang SC"`、`"Hiragino Sans GB"`、`"Microsoft YaHei"`）→ `sans-serif`。**英文字体一律排在中文字体前面**：英文字母和数字在中文字体里有字形，排前面就会落到中文字体上，样子不一致；汉字在英文字体里没有字形，会自动落到后面的中文字体。
  - 代码：`"SF Mono"`、`ui-monospace`、`Menlo`、`Consolas`，后面补中文字体，最后 `monospace`。
- **计量用英文单位**：token、用量、文件大小这类数用 K / M（token）、KB / MB（文件大小），不用“万”“亿”。token 写“820 tokens”“291K tokens”“6.48M tokens”（1 个是“1 token”）；Worker 行里的对话长度写“158K context”（`formatContext`，数字同样用 K / M）；不到 1000 原样，之上取 3 位有效数字并去掉多余的 0，999.5K 以上进到 1M（`formatCount` / `formatTokens`，`src/web/format.ts`）。悬停明细的标签也用英文（Input、Cache read…）。没有数据（老数据没记录）显示“—”，不显示 0。
- **数字对齐**：列表、表格、行右边的数字（计数、时间、百分比、token）一律 `tabular-nums`。
- **中英文之间留一个空格**：“Worker 3”“Sonnet 5.5 的 token”“在调用 slack 的 search”。数字和中文之间也留（“3 个”）；全角标点两侧不留。
- **列表行不用“·”（中点）、“|”、“/”拼接多项信息**：用层级区分——主信息大一档（15px、500）、次要信息小一档（12px、灰），同一行的几项之间用间距（`gap-3`）隔开，不靠符号。缺的项直接不显示，不留空位也不放占位符（整个数据缺失才用“—”）。

## 14. 交互和状态

- 悬停：浅灰底（`hover:bg-sidebar-hover` / `hover:bg-accent`），不变色、不放大。
- 加载：`Loader2` 转圈 + 短句（“加载中”），居中；按钮里转圈放在字前面。
- **在忙的流光**（消息流底部的 Working… / Thinking… / Reading App.tsx… 等 `AgentStatus`、右栏正在跑的 Piece 的名字）：加 `styles.css` 的 `.status-shimmer`，照 Claude desktop 的 “Thinking” 流光：一道变淡的光（字色 35%，比字色浅，深色字上看得出）从左往右扫过字，2.2s `ease-in-out` 循环。只用字本身的颜色（`currentColor`，右栏名字是前景色、消息流是灰），不引入别的颜色；省略号是静态的“...”，不再一个点一个点闪。等额度这类不在忙的状态不加。`prefers-reduced-motion: reduce` 时不动、显示原色字。时长、光带只在 `.status-shimmer` 一处改。
- **动效规矩**：动效只在状态变化时触发一次，不超过 400ms，不循环（上面的流光是唯一例外），`prefers-reduced-motion: reduce` 时全部关掉。时长只在 `styles.css` 的 `--motion-*` 改。现有的只有这几处：
  - 换项目经理时外壳底色、分割线淡变 300ms（`--motion-tint`，第 4 条）；右栏组的收起展开 150ms、果瓣箭头转向 200ms（第 12 条）。
  - **新来的消息**淡入并上移 4px，120ms（`--motion-enter`，`.message-enter`）：只对对话打开之后新出现在末尾的消息播（`useMessageEnter.ts`：每次提交只比对末尾 12 项的身份，和历史多长无关；播完摘掉类）；打开时的历史、加载更早的、待发消息被确认换成真消息、重新渲染都不播。
  - **切换对话**（左栏点项目经理、点开 Piece、从 Piece 返回）用浏览器原生 View Transitions（`view-transition.ts`，在 `route.ts` 的 `navigate` 里调）：只有顶栏的头像和标题起 `view-transition-name`（`.vt-chat-avatar` / `.vt-chat-title`，`:root` 设成 `none`），消息列表不截快照、直接换；200ms（`--motion-switch`）。浏览器不支持、打开资料页、刚打开时补默认对话都直接换，没有动画。
- 不能点：`disabled:opacity-50`（主按钮换中性灰，见第 4 条）。
- 文案：不加解释性的灰色小字、副标题、操作提示（见 frontend-rules）；只留内容、控件、状态和能帮用户改正的错误。

## 15. Markdown 排版（agent 消息、预览窗里的 .md）

`src/web/components/Markdown.tsx` + `styles.css` 的 `.markdown`。正文 15px、行高 1.65，段落间 12px 左右；字体走第 13 条的栈。

- **中文旁边的加粗、斜体、删除线**：用 `remark-cjk-friendly` 和 `remark-cjk-friendly-gfm-strikethrough`（`parseOnly` 入口，顺序在 `remark-gfm` 之后）。CommonMark 规定收尾的 `**` 前面是标点（。）、后面紧跟汉字时不算收尾，`**中文。**中文` 会把 `**` 原样露出来；装了之后 `**中文。**中文`、`**中文**中文`、`中文**加粗**中文`、`*斜体*`、`~~删除~~` 都正常，英文照旧。
- **换行**：单个换行保留（照 GitHub 评论区，`remark-breaks`），两个换行分段。代码块、表格单元格、列表里的结构不受影响。
- **标题**：只用 600 一档字重，层级靠字号。h1 20px、h2 17px、h3 15px、h4 到 h6 15px 灰（`--muted-foreground`）500；上方留 1.4～1.1 倍字高，下方 0.4 倍，贴着自己的内容；消息开头的标题不留上边距。
- **列表**：缩进 1.5em，圆点 / 序号用灰色，条之间 4px，嵌套列表上下 4px；任务列表（`- [ ]`）去掉圆点，勾选框和文字之间 8px。
- **行内代码**：`--font-code`，0.875em，`--muted` 底、6px 圆角、内边距 `0.12em 0.4em`，不加粗不换色。
- **链接**：蓝色链接字（`--link: #2563eb`，取 `palette.ts` 中“蓝”的 `accent`，对白底对比度 ≥ 4.5:1），下划线用半透明蓝色（`color-mix(in srgb, var(--link) 40%, transparent)`），悬停变实；长链接、长路径在任意位置换行，不撑破消息列；链接内包裹的行内代码（`code`）文字颜色继承链接蓝色（`color: inherit`）。
- **引用块**：左边 3px 灰竖线（`#d4d4d8`），文字比正文淡一档，不加底色。分隔线 1px `--border`，上下各 1.5em。
- **代码块**：容器 `rounded-xl`、`--muted` 底、1px 内描边；右上角一行：语言名（12px 灰，原样显示作者写的名字）靠右、紧挨着一个复制图标按钮（`size-7`，无底色，悬停 `bg-accent`），不写语言的只有复制按钮；代码 13.5px 等宽、行高 1.6、横向滚动不换行、内边距 `px-4 pb-3`。
  - **高亮**：复用 `src/web/highlight.ts`（Shiki，`github-light`），打开消息时按需加载，不阻塞渲染。先显示纯文本，加载好再换成上色的；Shiki 不认识的语言一直是纯文本，不报错、不提示。
  - **流式输出**：代码块没闭合时照常显示已收到的部分；每次来新内容停 120ms 才重新上色，等的时候保留上一版的颜色、新来的尾巴先用纯文本接在后面，不闪回灰色。
  - **复制**：拿到的是代码原文（不带行号、语言名、末尾多出来的换行）；点了图标换成勾 1.5 秒，`aria-label` 是“复制代码”/“已复制”。
- **表格**：外面套一个横向滚动的容器，表格宽度跟内容走，最宽不超过消息列，超出时容器内横向滚动、不撑破消息列；单元格最宽 28rem，超出换行。
  - 对齐照 Markdown 语法（`:--` 左、`:-:` 中、`--:` 右），**表头和同一列的内容用同一个对齐**；没写对齐的一律靠左（表头不再默认居中）。
  - 数字 `tabular-nums`（第 13 条）；表头 13.5px、500、灰，下面一条 1px 线；行之间 1px `--border` 细线，没有竖线和斑马纹；单元格内边距 `px-3 py-2`，第一列左边不留缩进（`pl-0`），最后一列右边同理。
- **内联图片与文件链接**：`![]()` 写的、存了副本的图片继续内联显示：固定 240px 高、最宽 320px（`h-60 w-auto max-w-xs`，`object-contain` 靠左），加载前后高度不变，消息流不跳（第 17 条）；`rounded-xl`，鼠标是放大镜，点开预览窗看大图；文件过期换成“文件已过期”卡片。普通链接 `[文字](路径)` 写的本机文件不再渲染成文件卡片，而是保留链接原本写的文字、以行内蓝色链接样式（`[data-file-link]`）嵌在正文中，点开预览窗（`FilePreview`）；没存下副本（如指向文件夹 `not_file`、没找到文件 `missing` 等）的不渲染卡片、不显示失败原因，直接显示链接原本的文字。
- **图表**（```` ```mermaid ````、```` ```vega-lite ```` / ```` ```vegalite ````，闭合后才渲染；`ChartBlock.tsx`、`src/web/charts/`，方案见 `docs/charts-diagrams-design.md`）：
  - **外壳**同代码块（`.md-code`：`rounded-xl`、`--muted` 底、1px 内描边、右上角工具条）；图区是白底（`--background`），四周 12px 内边距，没有自己的描边。工具条从左到右：语言名（12px 灰）、源码/图切换（`Code` / `ChartNetwork` 图标，`aria-pressed`）、放大（`Maximize2`）、复制（复制源码）；按钮都是第 6 条的图标按钮（`size-7`，悬停 `bg-accent`）。
  - **尺寸**：宽跟消息列走，不撑破；加载中最小高 160px（`CHART_MIN_HEIGHT`），图最高 480px（`CHART_MAX_INLINE_HEIGHT`），更高的等比缩到这个高度，点放大看原尺寸。
  - **渲染中**：占位里一个居中的 `Loader2` 转圈，不写字；离视口 600px 以内才开始渲染，缓存里有的同步出图。
  - **看源码**：点切换，图区藏起来、换成上色的源码，再点回图（不重画）；状态只在这一块里，不记住。
  - **失败**（源码有错、源码超过 5 万字、图表组件没加载下来）：显示成普通代码块，上面一行 `AlertCircle`（14px）+ 错误第一行（13.5px、`text-danger`、`truncate`），完整错误放 `title`；不弹 toast，源码不吞。没闭合的（流式中）照常是代码块，不报错。
  - **放大窗**：`Dialog`（`w-[min(96vw,1400px)] h-[90dvh]`），里面是原尺寸的图，两个方向滚动；先不缩放、不拖动。点图本身也能放大（Mermaid）；Vega-Lite 有悬停提示，点图不放大，只有按钮。
  - **颜色**：只用 CSS 变量（`--foreground`、`--muted-foreground`、`--border`、`--muted`、`--background`）和 `palette.ts` 的 `CHART_CATEGORY_COLORS`（颜色表 accent 里的 6 种，对白底 ≥ 3:1），不用库默认的紫色。
  - **字**：图里 13.5px、坐标轴 12px，字体 `--font-ui`。
- 不靠 emoji、粗体全大写之类撑层次。

## 16. 外壳：左栏、顶栏、窄屏、网址

- **三栏**：左栏（300px，`bg-surface-sidebar`）| 对话（`main`，`bg-surface-chat`）| 右栏（第 12 条）。底色掺当前项目经理的水果色（第 4 条）。对话列的宽度和空白怎么放见第 8 条。三栏之间只用底色或 1px `border-line` 分开，不加阴影。
- **窄屏（1100px 以下）**：左栏不再隐藏成抽屉（去掉顶栏左边的 `PanelLeft` 抽屉按钮），而是收紧为常驻在左侧的 **72px 宽垂直头像窄栏**（`w-18 border-r border-line bg-surface-sidebar`）：
  - 顶部留出红黄绿交通灯安全距离（`pt-[calc(var(--safe-top)+var(--macos-traffic-lights-height))]` + `h-3` 拖拽区 `data-window-drag`），隐藏搜索框行；
  - 对话列表（`<nav aria-label="Conversations">`）居中列出各项目经理的圆角方块头像按钮（`size-13 rounded-2xl`，内含 `40px` `<Avatar colorKey={entry.avatarKey} size={40} />`，选中、悬停是这个项目经理的水果果冻底（第 4 条），带 `title={entry.name}` 和 `<span className="sr-only">{entry.name}</span>` 保持可访问性；有 `asking`“等你确定”或 `waiting`“等你”时在头像右下角显示小圆点角标）；
  - 窄栏底部纵向居中排列 3 个 `icon-sm` ghost 图标按钮：`新建项目经理`（`Plus`）、`QuotaPopover`、`设置`（`Settings`）。
  - 因为左栏 `72px` 常驻在窗口最左侧（正好覆盖 `--macos-traffic-lights-width: 72px`），去掉 `styles.css` 中 `@media (max-width: 1100px)` 下给 `.chat-main` 额外加的 `--macos-traffic-lights-width` 偏移以及 `PmProfile.tsx` / `App.tsx` 顶栏的多余窄屏左内边距。右栏照样推开对话（第 12 条）。
- **左栏的行**：选中、悬停是这个项目经理的水果果冻底（第 4 条），头像 44px，第一行名字 + 右边的标注（两侧 `items-center justify-between gap-2`，左侧标题区 `min-w-0 flex-1 overflow-hidden` 绝不溢出遮挡右侧标注），第二行消息预览；没有消息的行第二行留空但占一样的高度，每行一样高。右边的标注只放一个，优先级：“等你确定”圆点（8px `size-2 rounded-full bg-status-active`，无文字，`aria-label` / `title` 为“等你确定”） > “等你”圆点（同样 8px 绿点，无文字，`aria-label` / `title` 为“等你”） > 时间。项目经理在忙不另加标记，照旧显示时间。
- **已归档项目经理**：左栏每个设备组内（或单设备列表底部）将已归档项目经理收进默认折叠的“已归档”分组（样式同设备组头，右侧标数量；搜索中或当前选中已归档对话时自动展开），行右侧标剩余删除天数（`Deletes in 7d`，`tabular-nums`，不标“等你”或“等你确定”）。聊天页底部输入框换成归档状态条（`rounded-2xl bg-sidebar px-4 py-3`：左侧“已归档”与剩余天数用 `gap-3` 分开，右侧 `outline` `sm`“恢复”按钮，进行中显示 `Restoring…`）。资料页在会话组提供“归档…”及二次确认弹窗（`max-w-110`）；已归档时顶部第一组显示归档状态与“恢复”按钮，隐藏会话组。
- **左栏左下角**：左栏底部栏左侧放额度按钮（若有），右侧放设置 ghost 按钮（`ml-auto` 固定靠右，第 6 条）。左栏对话列表（`<nav aria-label="对话列表">`）带 `.sidebar-list` 边缘渐变遮罩（顶部 `8px`、底部 `20px` 渐隐：`mask-image: linear-gradient(to bottom, transparent, #000 8px, #000 calc(100% - 20px), transparent)`）与底部内边距 `pb-3`，使列表滚动经过底部栏和顶部搜索栏时柔和过渡、不硬切头像，滚到底部时最后一项完整显示在渐变区上方。额度按钮：一个 16px 的小圆环（已用的部分画成弧，平时前景色 60%，快用完 `text-warn-foreground`、用完 `text-danger`）+“5h 37%”这样的窗口名和百分比（`tabular-nums`），用完写“额度用完”；点开浮层看每个厂商、每个窗口的明细（第 11 条）。agy 的额度事件里没有，点开时才向服务端要一次（缓存 5 分钟，`quota.fetched`），按组（Gemini、Claude 和 GPT）各一块，标题“厂商名 · 组名”；没装或查失败就没有这几块。
- **每个对话有自己的网址**：`#/c/<对话编号>`（项目经理的对话）、`#/w/<对话编号>`（Worker 的对话）、`#/pm/<项目经理编号>`（资料页）。点左栏、点 Worker、打开资料页都会改网址（能前进后退）；刷新后回到原来那个，找不到才回到第一个。
- **焦点**：打开或切换对话时，焦点放进输入框（输入框不可用时不放）。
- **多台设备（联机，`docs/multi-device-design.md` 第 4 节）**：只有一台时左栏、网址、弹窗和没有联机时一模一样。两台以上：
  - 左栏按设备分组。组头 32px 高、`px-3`、`rounded-2xl`，左边设备名（12px、500、灰，第 3 条组标题）+ 折叠箭头（`ChevronRight` 14px，展开转 90°），右边状态词（12px 灰：重连中；离线 + 多久以前，两项之间 `gap-2`，不用“·”）、状态点（8px 圆：在线 `--success`、重连中 `--caution`、其余 `bg-muted-foreground/40`）、系统图标（14px：Mac `Laptop`、Linux `Server`）。组之间 8px（`pt-2`）。离线、没连上过的整组 `opacity-60`。
  - 最上面一组“等你确定”（标题样式同组头的字）汇总所有设备没回答的提问，每行名字后面隔 8px 写设备名（12px 灰，不用“·”；主名字 `max-w-[70%] shrink-0 truncate` 优先完整显示，设备名 `min-w-0 truncate` 超长截断并带 `title`，防止长设备名把主名字挤没或溢出遮挡右侧圆点），那台离线、没连上过时这一行也 `opacity-60`；“等你”只在各组里标。标签页标题的数字是所有设备的合计。
  - 别的设备离线：对话顶上一条提示（同“重连中”的灰底胶囊，`WifiOff` 图标）“东京离线，显示的是 3 分钟前的内容”；输入框整个不可用，占位写“东京离线，暂时不能发消息”。重连中（断了不到 30 秒）照常能打字，发送按钮等连上。从没连上过：主区居中“还没连上这台设备”+ 一行排查提示（13.5px 灰）。
  - 新建项目经理弹窗第一行“设备”（`Select plain`，默认当前看的那台，离线的不能选）；设置弹窗多一个“电脑”分类（第 10 条）：“你的电脑”一组是本机一行和中心隧道状态行，组标题右边“连到中心”；“已连上的电脑”一组是别的设备（没有就一行“还没有别的电脑”），组标题右边“邀请”“添加”。这些按钮是 ghost `sm`，`-mr-3 gap-1`，展开态 `aria-expanded:bg-accent aria-expanded:text-foreground`，向导（白底细框分组）出现在对应组下面 12px。每台一行（第 9 条带图标的行）：系统图标，名字，下面状态点 + 系统、连法、本机 / 状态，右边改名、移除图标按钮，移除要二次确认。网址前面加 `#/d/<设备编号>`，入口本机不加。
  - **公网入口与待批准浏览器会话（`docs/mac-app-and-mobile-design.md` 第 2.2 节）**：都在设置的“登录与安全”分类里。“公网入口”是能收起的组（第 9 条，摘要 On / Off；没开也没填过域名时收起），里面“公网域名”输入框（`w-60`，占位 `如 tokyo.tailnet.ts.net`）与同高（36px）的 `outline`“开启 / 关闭”按钮；开启时在行下显示当前生效的 `https://<公网域名>`，并展示“Funnel 命令”行（等宽代码块 + `outline` `sm`“复制命令”按钮）。“在手机上登录”单独一个框（不收起），二维码在同一个框里的下一行居中。“已登录的浏览器”是能收起的组（摘要“N 个”，有待批准的自己展开），`pending_approval` 待批准会话排在最前，行下用 `gap-3` 分开显示“待批准”“经公网”与时间（不用“·”拼接），右侧提供 `ghost` `sm`“拒绝”与“允许”按钮；已批准的公网会话行下保留“经公网”标注；最后一行“所有浏览器”（全部退出）。
- **Mac 原生桌面应用（`html[data-macos-app="true"]`，`docs/mac-app-and-mobile-design.md` 第 1.3 节）**：无边框透明标题栏下，窗口左上角红黄绿交通灯占宽 `72px`、高 `28px`，只在 `styles.css` 定义 `--macos-traffic-lights-width`（默认 `0px`，`html[data-macos-app="true"]` 下 `72px`）和 `--macos-traffic-lights-height`（默认 `0px`，`html[data-macos-app="true"]` 下 `28px`）。
  - 左栏（宽屏 300px 或窄屏 72px）始终常驻在窗口最左侧，左栏顶部内边距为 `calc(var(--safe-top) + var(--macos-traffic-lights-height))`，避开红黄绿交通灯；窄屏 72px 宽度正好覆盖红黄绿宽度，顶栏与对话区无需额外让出 72px；
  - 左栏顶部搜索行及上方安全区、各页面顶栏（`Conversation`、`WorkerConversation`、`PmProfile`、`deviceWaiting`）标记 `data-window-drag`，非交互控件区域按住左键拖拽移动窗口、双击缩放窗口。

## 17. 消息流（对话里的消息列表）

组件在 `src/web/components/MessageList.tsx`、`Messages.tsx`，分组在 `selectors.ts` 的 `groupMessages`，状态词在 `step-labels.ts`，出错的说法在 `src/shared/errors.ts`。思路是**把过程藏起来**：默认只显示结论和状态，过程点开才看。

- **字号只有三档**：正文 15px；名字、“Worked for”这一行、可点开的系统行 13.5px；时间、消息状态、很淡的系统行、操作明细 12px（`text-xs`）。不用 12.5px、13px。
- **一轮回复一个头像**：用户（或项目经理、Worker 汇报、到点的定时任务）说一句之后，agent 接下来的所有东西算一轮，只在开头出一次“头像 26px + 名字（13.5px、500、灰）”。头像旁不放状态、不加“·”。
  - 一轮里的工具调用、派出 / 收工 Worker、建删定时任务这些操作合成**一行**，放在名字下面：`Worked for 23s ›`（13.5px 灰，悬停变前景色，无底色、无胶囊），点开才列出每一步（12px，等宽字体，命令原样）。用时 = 这一轮最后一条的时间 − 这一轮开始的时间（触发它的那句话、和上一轮最后一条里晚的那个），都用已有的时间戳。不到 10 秒带一位小数（8.3s），之后 23s、1m 5s、1h 2m。没有操作的轮不出这一行。
  - 正在跑：这一行挪到这一轮最下面，写英文状态（`Thinking…`、`Running command…`、`Reading a.ts…`，文案见 `step-labels.ts`），省略号有淡入淡出；有操作时同样能点开看明细。跑完回到名字下面，变成 `Worked for …`。
  - 这一轮的文字按顺序排在下面（`hub ask` 问你的那条不另挂“等你确定”标签，右栏列着，点过去高亮这一条）；跑完后最下面一行是复制按钮（图标按钮 `icon-sm`，复制这一轮所有文字的 Markdown 原文，点了换成勾）和结束时间（12px 灰，`tabular-nums`）。
  - **`hub ask` 选项卡片**：当 `hub ask` 带选项（显式传 `--option` 或正文末尾紧接 2～10 行、每行都以顺序字母 `A. `/`B. ` 开头的选项；普通 `- xxx` 列表不算，按普通 Markdown 显示）时，在对话流中渲染为圆角边框卡片（`rounded-2xl border border-border bg-background p-4`），顶部为问题标题（15px、`font-medium`），下方为 A/B/C/D 选项行（左 `size-6 rounded-xl border border-border bg-sidebar` 字母徽标 + 右 15px 文字（行内 Markdown 渲染），整行 `rounded-xl`，悬停 `hover:bg-sidebar-hover`）；未回答时点击任一选项行直接将该选项作为用户消息发出，已回答后变只读并高亮所选项（`bg-sidebar-active`）。
- **Worker 的发言**（项目经理对话里的汇报、这一轮没做完、建 worktree 失败）：是一个靠左的**消息气泡**，头像和名字在气泡上面（和 agent 一样一个 26px 所属项目经理对应水果切出的果瓣头像 `Avatar neutral` + 名字 13.5px、500、灰，名字是 Worker 的标题），气泡里是汇报摘要。`WorkerSpeech`（`Messages.tsx`），状态和颜色的对应在 `worker-status.ts`。
  - **气泡**：圆角、内边距和用户气泡同一套（`BUBBLE`：`rounded-[22px] px-4 py-2.5`，15px），底色永远是中性浅灰 `--bubble-agent`，和项目经理自己的正文（没有气泡）、用户的浅果冻气泡一眼分得开。整个气泡是一个按钮，点开 Worker 的完整对话；悬停底色加深一点点（掺 5% 前景色），键盘聚焦有中性的圈。
  - **状态用小色点，不写字**：头像右下角一个 10px 的圆点（白色 2px 描边，`bg-success` / `bg-caution` / `bg-danger`，不写死色值）：做完了绿、有问题黄、放弃了和出错红；没按格式的、没有状态的没有点。“做完了 / 有问题 / 放弃了 / 出错”这几个字不显示，放在气泡的 `title`，`aria-label` 是“标题，状态：摘要”。状态和颜色的对应在 `worker-status.ts` 的 `workerStatusOf`。
  - Worker 自己的对话里它的顶栏与消息头像同样是所属项目经理对应水果的一瓣，项目经理说的话是项目经理的完整水果横切面头像 + 名字。右栏 Worker 行只用名字流光表示在跑（第 12 条），不是汇报的结果，不用这套颜色。
- **系统行**：
  - 不单独显示：派出 Worker、Worker 收工、项目经理建删定时任务——它们是项目经理这一轮的操作，收在 `Worked for` 里（不在任何一轮里时才显示成很淡的一行）。
  - 很淡的一行：建项目、挂上 / 移除文件夹、改性格设定（带“撤销”）、交接失败、定时任务没跑成、你直接对 Worker 说的话。靠左和正文对齐，12px 灰，前面一个 14px 图标，没有底色、不居中、不用胶囊；出错的图标用 `text-danger`。
  - 换新会话（用户点的“开新会话”和对话太长时自动换，`ledger/handover.ts`）：用户看来是同一个对话，**聊天里只多一条很淡的分隔线**。写交接的请求、写交接那一轮的话和操作都不显示、不算未读、不进左栏预览、不改排序、不弹通知；写交接时状态行和停止键也不出现（那期间有交给项目经理的话在等就显示 `Thinking…`，用户的话不显示“排队中”）。分隔线：`RefreshCw` 14px 图标 + `Handed off to a new session`（12px 灰，英文状态词，不用“·”拼接）+ `›`，后面一条 1px `bg-border` 细线占满剩下的宽度；放在写交接开始的地方，换代期间来的话（包括交接请求排队时就来了、压到换代才交给新会话的）排在它下面，和实际处理它的会话对上。点开看交接全文（Markdown，13.5px 灰，左边一条竖线，同定时任务的说明）。
  - 到点的定时任务：一行 13.5px 灰的“时钟图标 + 定时任务：名字（原定 09:00）›”，点开看任务说明；它是系统发给项目经理的，下面项目经理的回复照常另起一轮。
- **消息状态（照微信）**：用户消息下面**不写任何状态字**：排队中、已送达、处理中、已回复、已停止、已取消都不显示（已取消的气泡整体变淡 `opacity-60`，agent 没看到过这句，不自动重发；字照样能选中，想再发自己复制）。
  - **只有“没发出去”一种标记**：服务端标了失败的消息、网页发送失败的待发消息，在**气泡左边、垂直居中**放一个红色圆圈白色感叹号（`size-5 rounded-full bg-danger text-white`，12px 粗体“!”，和气泡隔 8px）。能重发的是按钮（`aria-label`“没发出去，点击重发”，悬停 `brightness-90`，键盘聚焦中性圈，触屏点击区域撑到 44px），点了直接重发，重发中变淡、不能点。
  - 原因（“网络断了，稍后重试”、被拦的原因、“文件已不在，请重新添加”）不另起一行，放在感叹号的 `title` 和读屏名字里（“没发出去：网络断了，稍后重试，点击重发”）。重发也没用的（被拦、文件没了）感叹号只是标记（`role="img"`），不能点。
- **出错**：写用户看得懂的中文，说清“出了什么事”和“该怎么办”（“连不上守护进程，看守护进程有没有在跑”“Claude 服务繁忙，稍后重试”），原始错误放 `title`（悬停才看得到）；后面跟“重试”。**错误码与文案统一定义在 `src/shared/errors.ts`**（`API_ERRORS`、`LOCAL_ERRORS`、`describeFailure`）：接口出错网页一律经 `humanize`（`format.ts` 的 `errorText`、`errorLine`、`errorTitle` 包了一层）显示，text 后面接 hint，raw 放 `title`，不显示英文码、`err.message`、浏览器的 “Failed to fetch”；任何接口回 401 直接切到登录界面，不弹报错。厂商运行失败的分类和说法经 `describeFailure` 按通用的类型分（服务繁忙、额度用完、网络断了、没能启动、未知），厂商的错误特征在 `src/shared/vendors.ts`。
- **贴底**：打开对话、刷新、图片加载完、内容变高时，原本在底部的继续贴底（`ResizeObserver`）；往上翻了就不拉回去。底部输入框外层 `.chat-column` 向上叠盖 `26px`（`-mt-6.5 relative z-10 pointer-events-none`，内部控件 `*:pointer-events-auto`），与输入框 `rounded-[26px]` 顶部圆角半径对齐，使消息滚过输入框顶部时圆角外侧不被水平硬切，同时 `y = 26px` 以下输入框已占满列宽、下方不漏字；消息内容底部留白 `pb-12`，高度不随“回到底部”出现和消失而变，文字正常滚动，没有渐隐、没有硬切的一条。
  - **“回到底部”**：只在往上翻了（离底部 80px 以上）时出现，一个图标按钮（`secondary` 浅灰底、`icon-sm` 32px，无描边、无阴影、不带字），浮在输入框上方一点（`bottom-9`）、消息列的水平正中（照 t3code 的 Scroll to end）；外层 `pointer-events-none`，只有按钮能点。回到底部这一条就收起。内联图片固定 240px 高占位（第 15 条），加载前后不跳。
- **空对话**：消息区中间是 agent 的头像（120px，现有 256px 素材，不加新图）、名字（17px、600）和一句“还没有消息”（13.5px 灰）。

## 18. 输入框弹出列表

聊天输入框里打 “/”（整条消息开头）或 “@”（开头或空白后）时弹出的列表（`ComposerMenu`，`src/web/components/ComposerMenu.tsx`；触发规则在 `src/web/composer-trigger.ts`，状态在 `src/web/composer-suggest.ts`）：

- **位置**：输入框正上方，和输入框同宽，在布局里占位（把对话往上顶），不浮在对话正文上面，不盖住任何内容；和输入框之间 8px（`mb-2`）。
- **外框**：`rounded-2xl border border-border bg-background p-1.5`，不加阴影。最多 8 行（`max-h-[calc(8*2.25rem)]`），更多的纵向滚动。
- **行**：`h-9 rounded-xl px-3`，一行 36px，行里各项之间 `gap-3`；高亮只有一行（键盘和鼠标共用），`bg-sidebar-active`，不用主色。
  - 命令：名字（15px、500，带 `/`）加一句说明（13.5px 灰），说明超长 `truncate`。
  - 文件：`FileText` 图标（`size-4`，灰）、文件名（15px、500）、父目录（13.5px 灰，`truncate`）；多个根目录时不显示根。
  - 各项之间用间距隔开，不用 “·”“-”“/” 拼接。
- **没有匹配**：一行 13.5px 灰字，“没有匹配的命令”“没有匹配的文件”，也是 `h-9 px-3`。
- **加载中、拿不到列表**：不显示任何东西（不放转圈、不报错），输入框照常能发。
- **键盘**：↑↓ 循环选；Enter 或 Tab 确定（列表里有行时 Enter 不发送；没有匹配时 Enter 照常发送）；Esc 关闭，文字不动；输入法选字时的按键不算。鼠标按下时 `preventDefault`，焦点不离开输入框。
- **选中后**：把触发的那一段换成后台给的文字（命令 `/名字`、文件 `insert` 字段，网页不自己拼 `@`），后面带一个空格，光标停在空格后；纯文本，不做小标签。
- **文件搜索**：接着打字等 120ms 没再打才发请求，旧请求作废，后发先回时旧结果不显示。
- **发送被拦**：后台给的原因显示在输入框上方（和上传失败同一处，`text-danger`），用户原文留在输入框里。

## 19. 手机和小屏（触屏）

手机装到主屏当 App 用（`display: standalone`，全屏、有刘海和底部横条）。小屏的断点还是第 12、16 条那两档（1100px 以下左栏抽屉，720px 以下右栏到顶栏下面）；这一条补**触屏**的几条硬规则，数字只在 `src/web/styles.css` 和 `src/web/index.html` 一处。

- **视口**：`<meta name="viewport">` 带 `viewport-fit=cover`（内容铺到刘海和横条底下）和 `interactive-widget=resizes-content`（键盘弹起时网页变矮，输入框贴在键盘上面，消息不被盖住）。整页高度用 `100dvh`（`#root`），不用 `100vh`（手机上它包含收起来的地址栏，底部会被挤出屏幕）。`html, body, #root` 设为 `overflow: hidden; overscroll-behavior: none;` 锁定应用外壳不随手势整页晃动；各内部纵向滚动区（消息区、左栏、右栏、资料页、弹窗）统一带 `overflow-x: hidden` 与 `overscroll-behavior-y: contain`，防止手指纵向滑动时左右晃动或滚动穿透。
- **安全区**：`:root` 里 `--safe-top` / `--safe-bottom` 取 `env(safe-area-inset-top / bottom, 0px)`，不在组件里直接写 `env()`。
  - 主区 `.chat-main` 上下各垫一份：顶栏（对话、Worker、资料页）从刘海下面开始，输入框在横条上面。
  - 左栏抽屉（`fixed inset-y-0`）上下同样垫：顶上搜索行、底下“我”那一行都不压在刘海和横条上。
  - 底色继续是页面和左栏自己的底色，刘海和横条那一片不留白条。电脑上两个变量都是 0，什么都不变。
- **输入框字号不小于 16px**：iOS 对小于 16px 的输入框聚焦时会自动放大页面。标准正文是 15px，所以只在 `(pointer: coarse)`（触屏）下，所有 `input`、`textarea`、`select`（聊天输入框、`Input`、`Textarea`、`Select`）一律 16px，写成 `styles.css` 里一条规则，组件里不各写各的。电脑上仍是 15px。
- **点击区域不小于 44px**：触屏下，每个能点的东西可点范围至少 44 × 44px（Apple HIG）；视觉大小不变（图标按钮仍是 36 / 32px）。
  - 按钮（`Button`，含图标按钮）、输入框里待发文件的“去掉”、“Worked for ›”这类文字按钮带 `touch-target` 类：`(pointer: coarse)` 下用 `::after` 把可点范围撑到 44px，不改版面。
  - 一行挨一行的列表（右栏的行）不能用撑开的办法（相邻的会盖住彼此）：触屏下行本身 `min-h-11`（44px）。左栏的行本来就高过 44px。
  - 电脑（`pointer: fine`）上不变。
- **不靠悬停**：触屏没有悬停。任何操作（复制、重试、展开）平时就看得见、点得到，不做“悬停才出现”的按钮；悬停只用来换底色这种锦上添花的反馈（Tailwind 的 `hover:` 只在真能悬停的设备上生效）。
- **不出横向滚动条**：390px 宽下页面不能比屏幕宽（长标题、路径、代码块在自己里面截断或横向滚动，第 15 条）。
- **验收截图**：手机宽度 390px（iPhone）下聊天页、左栏抽屉、输入框，放 `docs/screenshots/mobile/`；顶栏和输入框要能看出安全区的留白（浏览器里模拟时给 `--safe-top` / `--safe-bottom` 一个值）。
