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
| 资料页头部的名字（只有这一处） | 22px `text-[22px]` | 600 | 前景 |
| 正文、行的名字、控件里的字、输入框 | 15px `text-[15px]`（body 默认） | 400 | 前景 |
| 人名、对话名（左栏、修改记录里的“谁”） | 15px | 500（选中 600） | 前景 |
| 组标题、“更多设置”这类折叠开关 | 13.5px `text-[13.5px]` | 500 | `text-muted-foreground` |
| 次要文字：行下面的说明、左栏的消息预览、错误 | 13.5px | 400 | `text-muted-foreground`（错误 `text-danger`） |
| 按钮里的字 | 14px（默认）/ 13px（sm） | 500 | 按钮自带 |
| 时间、计数这类小标注；列表行的状态和第二行（模型、思考程度、token） | 12px `text-xs` | 400 | `text-muted-foreground`，数字加 `tabular-nums` |

不用 13px、14px 做正文或次要文字（上面两档按钮字除外）。

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
| 下拉 | `h-9`，宽度跟内容，最宽 260px | — | `Select` |
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
- 行：名字靠左，控件靠右，上下居中；名字下面的小字跟名字左对齐。只读的值（项目名、路径）也靠右，用次要文字色；长路径 `truncate` 截断，`title` 放全文。
- 弹窗：标题在左上，关闭按钮在右上（`top-4 right-4`，32px）；底部按钮用 `DialogFooter`，靠右，主按钮在最右。
- 页面头部（资料页）：头像（72px）、名字、项目名居中；返回按钮在左上 64px 高的顶栏里（和对话页顶栏同高）。
- 主区内容最宽 640px 居中（资料页）；聊天消息列最宽 840px（`.messages`）。

## 9. 分组列表（设置那种一行一项）

用 `SettingsGroup` + `SettingsRow`（`src/web/components/SettingsList.tsx`），工作方式这种多选一用 `ModeRows`。

- 组标题在框外：13.5px、500、`text-muted-foreground`、`px-4`，和框之间 8px。没有标题的组（弹窗里的“名字 / 主文件夹”）直接是框。
- 框：`rounded-2xl bg-sidebar`，行与行之间 1px `divide-sidebar-active`，框外不加边框和阴影。
- 行：`px-4 py-2.5`，内容最少 36px 高（`min-h-9`），所以一行是 56px；有说明小字的行跟着长高。
- 行里的控件是白底（`Input` / `Select` 自带），和浅灰框分得开。
- 多选一：一行一个选项，名字 + 一句说明，选中的那行右边一个主色的勾；整行可点，悬停 `bg-sidebar-hover`。
- 改了马上存的设置（下拉、多选一）：不放保存按钮，先显示新值，失败退回并在那一行下面写原因（`RowError`）。长文本（性格设定）改了才在组标题右边出现小号“保存”。
- 错误、空状态（“还没有修改”）也是框里的一行，`px-4`。

## 10. 弹窗

`DialogContent`（`src/web/ui/dialog.tsx`）：

- `rounded-2xl border border-border bg-background p-6`，遮罩 `bg-black/30`。
- 宽度两档：表单默认 520px；只有几个开关的简单设置 `className="max-w-[440px]"`。
- 结构从上到下：标题 → 若干分组（`gap-6`）→ 错误提示（`px-4`，`text-danger`）→ `DialogFooter`。
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

## 15. 消息流（对话里的消息列表）

组件在 `src/web/components/MessageList.tsx`、`Messages.tsx`，分组在 `selectors.ts` 的 `groupMessages`，状态词在 `step-labels.ts`，出错的说法在 `errors.ts`。思路是**把过程藏起来**：默认只显示结论和状态，过程点开才看。

- **字号只有三档**：正文 15px；名字、“Worked for”这一行、可点开的系统行 13.5px；时间、消息状态、很淡的系统行、操作明细 12px（`text-xs`）。不用 12.5px、13px。
- **一轮回复一个头像**：用户（或项目经理、Worker 汇报、到点的定时任务）说一句之后，agent 接下来的所有东西算一轮，只在开头出一次“头像 24px + 名字（13.5px、500、灰）”。头像旁不放状态、不加“·”。
  - 一轮里的工具调用、派出 / 收工 Worker、建删定时任务这些操作合成**一行**，放在名字下面：`Worked for 23s ›`（13.5px 灰，悬停变前景色，无底色、无胶囊），点开才列出每一步（12px，等宽字体，命令原样）。用时 = 这一轮最后一条的时间 − 这一轮开始的时间（触发它的那句话、和上一轮最后一条里晚的那个），都用已有的时间戳。不到 10 秒带一位小数（8.3s），之后 23s、1m 5s、1h 2m。没有操作的轮不出这一行。
  - 正在跑：这一行挪到这一轮最下面，写英文状态（`Thinking…`、`Running command…`、`Reading a.ts…`，文案见 `step-labels.ts`），省略号有淡入淡出；有操作时同样能点开看明细。跑完回到名字下面，变成 `Worked for …`。
  - 这一轮的文字按顺序排在下面（`hub ask` 问你的那条不另挂“等你确定”标签，右栏列着，点过去高亮这一条）；跑完后最下面一行是复制按钮（图标按钮 `icon-sm`，复制这一轮所有文字的 Markdown 原文，点了换成勾）和结束时间（12px 灰，`tabular-nums`）。
- **Worker 的发言**（项目经理对话里的汇报）：和 agent 一样是“头像 + 名字 + 正文”。头像统一用中性灰的团子（`Avatar` 的 `neutral`），不按 Worker 配色；名字写 Worker 的标题，后面跟状态小标注（12px：图标带颜色、字是灰的：做完了 / 有问题 / 放弃了 / 出错）；正文是汇报摘要。整条可点，悬停浅灰底，点开 Worker 的完整对话。Worker 自己的对话里它的头像同样是中性灰，项目经理说的话是项目经理的头像 + 名字。
- **系统行**：
  - 不单独显示：派出 Worker、Worker 收工、项目经理建删定时任务——它们是项目经理这一轮的操作，收在 `Worked for` 里（不在任何一轮里时才显示成很淡的一行）。
  - 很淡的一行：建项目、挂上 / 移除文件夹、改性格设定（带“撤销”）、开新会话、交接失败、定时任务没跑成、你直接对 Worker 说的话。靠左和正文对齐，12px 灰，前面一个 14px 图标，没有底色、不居中、不用胶囊；出错的图标用 `text-danger`。
  - 到点的定时任务：一行 13.5px 灰的“时钟图标 + 定时任务：名字（原定 09:00）›”，点开看任务说明；它是系统发给项目经理的，下面项目经理的回复照常另起一轮。
- **消息状态**：用户消息下面只在排队中、失败、已停止时显示一行（12px）。已送达、处理中、已回复都不显示。
- **出错**：写用户看得懂的一句话（“Claude 服务繁忙，稍后重试”“额度用完了”“网络断了，稍后重试”），原始错误放 `title`；后面跟“重试”。分类和说法只在 `src/web/errors.ts`，按通用的类型分（服务繁忙、额度用完、网络断了、没能启动、未知），厂商的错误特征在 `src/shared/vendors.ts`。
- **贴底**：打开对话、刷新、图片加载完、内容变高时，原本在底部的继续贴底（`ResizeObserver`）；往上翻了就不拉回去，底部中间出一个“回到底部”图标按钮（`secondary` 浅灰底、`icon-sm` 32px，无描边、无阴影）。内联图片固定高度占位，加载前后不跳。
- **空对话**：消息区中间是 agent 的头像（48px）、名字（17px、600）和一句“还没有消息”（13.5px 灰）。
