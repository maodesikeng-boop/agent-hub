# 界面标准

agent-hub 网页的统一规则。**以左栏为准**（`src/web/components/Sidebar.tsx`），颜色取 `src/web/styles.css` 的变量。
能落到共用组件里的都已经落进去了（`src/web/ui/`、`src/web/components/SettingsList.tsx`），页面直接用组件，不要在页面里另写一套类名。
新页面或改页面时逐条对照；和这里不一样的地方，要么改页面，要么先改这份标准。

## 1. 间距档位

只用这几档（Tailwind 的 4px 单位）：

| 用在哪 | 值 | 类 |
| --- | --- | --- |
| 主区页面左右边距 | 24px | `px-6` |
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
| 按钮、图标按钮、标签（“等你”“只读”）、开关、头像 | `rounded-full`（`--radius-btn`） |
| 容器：左栏列表项、分组框、弹窗、浮层 | `rounded-2xl` |
| 输入框、多行输入、下拉、代码块 | `rounded-xl` |

不用 `rounded-lg`、`rounded-md`、`rounded-sm` 和别的圆角值。

## 3. 字号和字重

字重只用三档：400（不写）、500（`font-medium`）、600（`font-semibold`）。

| 用在哪 | 字号 | 字重 | 颜色 |
| --- | --- | --- | --- |
| 弹窗标题、对话顶栏的名字 | 17px `text-[17px]` | 600 | 前景 |
| 资料页头部的名字（只有这一处） | 22px `text-[22px]`，`tracking-tight` | 600 | 前景 |
| 正文、行的名字、控件里的字、输入框 | 15px `text-[15px]`（body 默认） | 400 | 前景 |
| 行右边的只读值（厂商只有一家时的厂商名） | 15px | 400 | `text-muted-foreground` |
| 人名、对话名（左栏、修改记录里的“谁”） | 15px | 500（选中 600） | 前景 |
| 组标题、“更多设置”这类折叠开关 | 13.5px `text-[13.5px]` | 500 | `text-muted-foreground` |
| 次要文字：行下面的说明、资料页头部的项目名、文件夹路径、左栏的消息预览、错误 | 13.5px，行下的说明 `leading-snug` | 400 | `text-muted-foreground`（错误 `text-danger`） |
| 按钮里的字 | 14px（默认）/ 13px（sm） | 500 | 按钮自带 |
| 时间、计数这类小标注；列表行的状态和第二行（模型、思考程度、token） | 12px `text-xs` | 400 | `text-muted-foreground`，数字加 `tabular-nums` |

不用 13px、14px 做正文或次要文字（上面两档按钮字除外）。

措辞（分组列表、弹窗里的字）：
- 组标题、行名用中文名词短语（“工作方式”“思考程度”），不夹英文单词（“Agent”这种），不带括号说明（“只管理（推荐用于复杂项目）”不行）。
- 行下的说明一句话说清后果，不加句号，不写“推荐”“适合……的项目”这类建议。
- 行名和它右边按钮的字不重复：行名说是什么，按钮说做什么（“开新会话”那一行的按钮是“开始…”，带“…”表示还要确认）。
- 可选的输入框不在行名上写“（可选）”，占位符写“可选”。
- 状态词用英文（Handing off…、Saving…），按钮、标题、说明还是中文。

## 4. 颜色

- **主色（`--primary`，樱粉）只用在**：主按钮（一屏最多一个：创建、保存、发送）、选中态（单选行的勾、开关打开）、“等你”标签、“等你确定”标签和对话顶部的“等你确定”条（项目经理用 `hub ask` 问用户的事，比“等你”醒目：左栏标签是实心主色，条是 `bg-primary/10`）、Markdown 里的链接、用户自己的气泡。
- 其余一律中性色：
  - 页面底色 `bg-background`（白）；左栏和分组框 `bg-sidebar`；悬停 `bg-sidebar-hover`；选中、凹进去的输入框（左栏搜索）`bg-sidebar-active`。
  - 分隔线：白底上 `border-border`，浅灰框里 `divide-sidebar-active`。
  - 次要文字 `text-muted-foreground`；错误 `text-danger`；警告 `bg-warn text-warn-foreground`。
- 不能点的主按钮换成中性灰（`bg-sidebar-active text-muted-foreground`，`Button` 自带），不显示半透明的粉。
- 不用渐变、阴影（聊天输入框那一处轻阴影除外）、毛玻璃。

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
| 开关 | `h-6 w-10` | — | `Switch` |

输入框和按钮放同一行时用同一档高度（都是 36px）。分组行里的输入框宽 240px（`w-[240px]`）。

## 7. 聚焦态

- 统一中性，**不用主色，不加彩色光圈**。`--ring` 是中性灰（`#a1a1aa`），`ring-ring` 就是它。
- 输入框、多行输入、下拉：聚焦只把边框加深到 `border-foreground/25`（和聊天输入框一样），`Input` / `Select` / `Textarea` 自带。
- 按钮、列表项、单选行、开关这类点的东西：键盘聚焦时显示 `focus-visible:ring-2 focus-visible:ring-ring/50`（单选行在框里，用 `ring-inset`）。只在键盘聚焦（`focus-visible`）时出现，鼠标点不出圈。
- 不合规的输入：`aria-invalid` 时红边框（组件自带），原因写在那一行下面。

## 8. 对齐

- **左对齐基线**：分组框里的文字都从框内 16px（`px-4`）开始；组标题、“更多设置”、框外的错误提示也用 `px-4`，和框里的字对齐成一条线。
- 行：名字靠左，控件靠右，上下居中；名字下面的小字跟名字左对齐。只读的短值（厂商名）靠右，15px 次要文字色。
- 文件夹路径不放在行右边：一个文件夹一行，名字是文件夹名（15px），下面一行是路径（13.5px 灰，用户目录写成 `~`，`truncate` 截断，`title` 放全文）；主文件夹右边写“主文件夹”（12px 灰）。
- 弹窗：标题在左上，关闭按钮在右上（`top-4 right-4`，32px）；底部按钮用 `DialogFooter`，靠右，主按钮在最右。
- 页面头部（资料页）：头像（64px）、名字（22px）、项目名（13.5px 灰，和名字隔 4px）居中，项目名只在这里出现一次，下面的分组不再重复；返回按钮在左上 64px 高的顶栏里（和对话页顶栏同高）。
- 主区内容最宽 640px 居中（资料页）；聊天消息列最宽 840px（`.messages`）。

## 9. 分组列表（设置那种一行一项）

用 `SettingsGroup` + `SettingsRow`（`src/web/components/SettingsList.tsx`），工作方式这种多选一用 `ModeRows`。

- 组标题在框外：13.5px、500、`text-muted-foreground`、`px-4`，和框之间 8px。没有标题的组直接是框（弹窗里的“名字 / 主文件夹”；资料页头部下面第一组厂商、模型、思考程度，头部就是它的标题），读屏名字用 `label`。
- 框：`rounded-2xl bg-sidebar`，行与行之间 1px `divide-sidebar-active`，框外不加边框和阴影。
- 行：`px-4 py-2`，内容最少 36px 高（`min-h-9`），所以一行是 52px；有说明小字的行 `py-3`，跟着长高。
- 输入框是白底带边框（`Input` 自带），和浅灰框分得开。
- 下拉：改了马上存的设置行用 `Select variant="plain"`：没有边框和底色，字是前景色，右边一个上下箭头（`ChevronsUpDown`，灰），悬停、聚焦 `bg-sidebar-hover`，像 macOS 系统设置的弹出菜单。表单里和输入框并排的（定时任务的“每天 / 每隔”）用默认的带边框样式，和输入框一致。
- 多选一：一行一个选项，名字 + 一句说明；右边一个 20px 的圆：没选中是 1.5px 灰边空心圆，选中是主色实心圆里一个白色粗勾（`RadioMark`）。整行可点，悬停 `bg-sidebar-hover`。
- 厂商、模型、思考程度（`AgentRows`）的选项全从模型名单拿（`useModelCatalogs`，名单的厂商名、通用思考程度、能不能自定义来自 `src/shared/vendors.ts`，模型来自厂商自己报的 `model-catalog`），页面里不写死厂商、模型名。
  - 只有一家厂商：厂商一行只显示厂商名（只读值），不放下拉。两家以上才是下拉。
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
- 宽度两档：表单默认 520px；只有几个开关的简单设置 `className="max-w-[440px]"`。
- 结构从上到下：标题 → `DialogBody`（若干分组，`gap-6`）→ 错误提示（`px-4`，`text-danger`）→ `DialogFooter`。
- **标题和底部按钮固定，只有中间滚动**：内容超过一屏（展开“更多设置”）时，`DialogBody` 自己滚，“创建”一直在视野里。表单弹窗把 `<form>` 做成 `DialogForm`（`flex min-h-0 flex-col`），里面放 `DialogBody` 和 `DialogFooter`。
- 弹窗里的行照第 9 条：输入框 240px（带按钮的，输入框 + 按钮一起不超过行宽），占位符要能完整显示。
- 不写副标题和解释性的灰字；需要的说明放在行下面的小字里。

## 11. 浮层（Popover）

`PopoverContent`：`rounded-2xl border border-border bg-background p-4`，宽 280px。里面的分块标题用组标题的样式（13.5px、500、灰），内容 15px，次要信息 13.5px 灰。

## 12. 侧边面板（Worker 面板）

对话页顶栏右边的 Worker 按钮展开的面板（`WorkerSidePanel`，`src/web/components/WorkerPanel.tsx`）：

- **推开对话，不浮在上面**：和对话（`main`）并排放在它右边，宽 320px，`border-l border-border bg-background p-3`，内部纵向滚动；展开时对话区自动变窄，收起后恢复原宽。展开状态切对话、切项目经理时保持。
- **窄屏（1100px 以下，和左栏收窄同一个断点）**：不再推开，浮在顶栏下面右边（`fixed top-16 right-3`，`rounded-2xl border`，宽 `min(320px, 100vw - 24px)`），最高 `100dvh - 16rem`，给输入框留位置；点一行打开对话时自动收起，不盖着对话。
- **按钮**：和顶栏别的图标按钮同一个样式（`Button` ghost、`size="sm"`，无边框），一个 `PanelRight` 图标 + 还没收工的个数（`tabular-nums`）；展开时 `bg-accent`。不用描边、不写“Worker”字样（名字放 `aria-label`）。
- **行**（第 13 条的列表行规则）：`rounded-2xl px-3 py-2.5`，行间 4px（`space-y-1`），当前打开的 `bg-sidebar-active`，悬停 `bg-sidebar-hover`，已收工的 `opacity-60` 且排在后面。
  - 第一行：标题（15px、500，当前打开的 600，超长 `truncate`）靠左，状态（12px，在忙用主色、其余灰）靠右。
  - 第二行：12px 灰，从左往右：模型名（只写模型；厂商只有一家时不写，以后多厂商再显示）、思考程度（有才显示）、token（英文单位，`tabular-nums`，`title` 放明细）；各项之间用 `gap-3` 隔开。没有数据显示“—”。

## 13. 字体、数字、列表行

- **字体栈只在 `styles.css` 的 `--font-ui` / `--font-code` 定义**，组件里不写 `font-family`，用 `font-sans` / `font-mono`。
  - 界面：`"Inter Variable"`（打包进程序）→ 系统英文字体（`-apple-system`、`BlinkMacSystemFont`、`"SF Pro Text"`、`"Helvetica Neue"`）→ 中文字体（`"PingFang SC"`、`"Hiragino Sans GB"`、`"Microsoft YaHei"`）→ `sans-serif`。**英文字体一律排在中文字体前面**：英文字母和数字在中文字体里有字形，排前面就会落到中文字体上，样子不一致；汉字在英文字体里没有字形，会自动落到后面的中文字体。
  - 代码：`"SF Mono"`、`ui-monospace`、`Menlo`、`Consolas`，后面补中文字体，最后 `monospace`。
- **计量用英文单位**：token、用量、文件大小这类数用 K / M（token）、KB / MB（文件大小），不用“万”“亿”。token 写“820 tokens”“291K tokens”“6.48M tokens”（1 个是“1 token”）；不到 1000 原样，之上取 3 位有效数字并去掉多余的 0，999.5K 以上进到 1M（`formatCount` / `formatTokens`，`src/web/format.ts`）。悬停明细的标签也用英文（Input、Cache read…）。没有数据（老数据没记录）显示“—”，不显示 0。
- **数字对齐**：列表、表格、行右边的数字（计数、时间、百分比、token）一律 `tabular-nums`。
- **中英文之间留一个空格**：“Worker 3”“Sonnet 5.5 的 token”“在调用 slack 的 search”。数字和中文之间也留（“3 个”）；全角标点两侧不留。
- **列表行不用“·”（中点）、“|”、“/”拼接多项信息**：用层级区分——主信息大一档（15px、500）、次要信息小一档（12px、灰），同一行的几项之间用间距（`gap-3`）隔开，不靠符号。缺的项直接不显示，不留空位也不放占位符（整个数据缺失才用“—”）。

## 14. 交互和状态

- 悬停：浅灰底（`hover:bg-sidebar-hover` / `hover:bg-accent`），不变色、不放大。
- 加载：`Loader2` 转圈 + 短句（“加载中”），居中；按钮里转圈放在字前面。
- 不能点：`disabled:opacity-50`（主按钮换中性灰，见第 4 条）。
- 文案：不加解释性的灰色小字、副标题、操作提示（见 frontend-rules）；只留内容、控件、状态和能帮用户改正的错误。
