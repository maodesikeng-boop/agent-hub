# 界面标准

agent-hub 网页的统一规则。**以左栏为准**（`src/web/components/Sidebar.tsx`），颜色取 `src/web/styles.css` 的变量。
能落到共用组件里的都已经落进去了（`src/web/ui/`、`src/web/components/SettingsList.tsx`），页面直接用组件，不要在页面里另写一套类名。
新页面或改页面时逐条对照；和这里不一样的地方，要么改页面，要么先改这份标准。

## 1. 间距档位

只用这几档（Tailwind 的 4px 单位）：

| 用在哪 | 值 | 类 |
| --- | --- | --- |
| 主区页面左右边距 | 24px | `px-6` |
| 对话列（顶栏、消息、输入框）的左边距 | 宽屏 40px、1100px 以下 24px | `--chat-inset`（`.chat-column` 自带，见第 8 条） |
| 右栏左右边距、组与组之间 | 12px / 24px | `px-3` / `gap-6` |
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

- **主色（`--primary`，樱粉）只用在**：主按钮（一屏最多一个：创建、保存、发送）、选中态（单选行的勾、开关打开）、“等你”标签、“等你确定”标签和右栏“等你确定”组标题前的小圆点（项目经理用 `hub ask` 问用户的事，比“等你”醒目：左栏标签是实心主色）、在忙的状态词（Working… 等，左栏和右栏）、Markdown 里的链接、用户自己的气泡。
- 头像底色：项目经理的团子按 key 轮着取（`Avatar.tsx`）；“我”用 `bg-me text-me-foreground`（`--me`），不写死 Tailwind 色板里的颜色。
- 其余一律中性色：
  - 页面底色 `bg-background`（白）；左栏和分组框 `bg-sidebar`；悬停 `bg-sidebar-hover`；选中、凹进去的输入框（左栏搜索）`bg-sidebar-active`。
  - 分隔线：白底上 `border-border`，浅灰框里 `divide-sidebar-active`。
  - 次要文字 `text-muted-foreground`；错误 `text-danger`；警告 `bg-warn text-warn-foreground`。
- 不能点的主按钮换成中性灰（`bg-sidebar-active text-muted-foreground`，`Button` 自带），不显示半透明的粉。
- 不用渐变、阴影（聊天输入框那一处轻阴影除外）、毛玻璃。提示条（“重连中”、健康问题）也只用底色，不加阴影和描边。

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

**工具栏和角落里的按钮只有一种样子**：`Button variant="ghost"`，平时不带底色、不带描边、不是胶囊，图标是次要色；悬停才有浅底（`hover:bg-accent`）、图标变前景色。顶栏右边（右栏开关）、顶栏左边（返回、窄屏的对话列表开关）、左栏顶部的“新建”、左栏左下角（额度、设置）都是它：纯图标用 `size="icon"`（顶栏、左栏顶部，36px）或 `size="icon-sm"`（左下角，32px）；要带字的（额度）用 `size="sm"`，同样没有底色。打开状态不靠底色表示，靠 `aria-expanded` 和图标变前景色。实心的、描边的按钮只用在弹窗、表单、资料页的操作上。

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
- 主区内容最宽 640px 居中（资料页）。
- **对话列靠左，不居中**（照 t3code）：顶栏、消息、输入框共用一条左边线，从主区左边 `--chat-inset`（宽屏 40px，1100px 以下 24px）开始，内容最宽 760px（`--chat-max`），右边至少留 24px；主区比这宽时空白都留在右边。用 `.chat-column`（`styles.css`），消息列表和输入框的外层都套它，不各写各的宽度。顶栏左边线同一条，右边的按钮离边 16px（`pr-4`）。

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

## 12. 右栏（等你确定、Worker）

对话右边的一栏（`RightRail`，`src/web/components/RightRail.tsx`），样子照 Claude desktop 的右栏：组标题加简单的行，不加框、不加阴影。

- **只放两组**：“等你确定”在上，Worker 在下；别的一律不加。两组都没有内容的组不显示。
- **推开对话，不浮在上面**：和对话（`main`）并排放在它右边，宽 320px，`border-l border-border bg-background px-3 py-4`，内部纵向滚动；对话区跟着变窄。窄屏（1100px 以下）也一样推开。
- **太窄放不下时（720px 以下）**：右栏不再并排，改成顶栏下面的一块（`border-b`，最高 `40dvh`，里面滚动），把消息往下推；不自动展开，点顶栏的开关才出来。不盖住消息和输入框。
- **展开和收起**：这个项目经理有 Worker 或有“等你确定”时自动展开，两样都没有时整栏不渲染、不占位置。顶栏右边一个开关（`PanelRight` 图标，第 6 条的 ghost 图标按钮，有内容才显示）；用户手动收起后记住（`localStorage`），之后来了新内容也不自己弹开，收着时有没回答的提问，开关右上角一个 6px 的主色圆点。资料页不显示右栏。
- **组标题**：13.5px、500、`text-muted-foreground`、`px-3`，右边是这一组的个数（12px、`tabular-nums`）；和下面的行之间 8px。“等你确定”标题前一个 6px 的主色圆点。
- **行**（第 13 条的列表行规则）：`rounded-2xl px-3 py-2`，行间 2px（`space-y-0.5`），悬停 `bg-sidebar-hover`，当前打开的 `bg-sidebar-active`。
  - “等你确定”：一个问题一行，去掉 Markdown 符号后的第一行（15px，超长 `truncate`），右边一个向右的箭头；点一下在这一行下面展开全文（Markdown），箭头转向下，同时对话滚到那条消息并高亮。用户在这个项目经理的对话里发出任何一条消息就算都回答了，守护进程标上（`meta.answered`），这一组、左栏的“等你确定”标签和标签页标题里的数字一起消失。没有“知道了”按钮。
  - Worker：第一行标题（15px、500，当前打开的 600，`truncate`）靠左，状态词（12px，英文：Working… / Stopping… / Setting up… / Idle / Ended；在忙的用主色，其余灰）靠右。第二行 12px 灰：模型名（从厂商的模型目录取显示名；目录里没有的完整模型名按 `vendors.ts` 的 `shortModelName` 缩短，如 Sonnet 5.5）、思考程度（有才显示）、token（英文单位，`tabular-nums`，`title` 放明细），之间 `gap-3`；没有数据显示“—”。收工的 `opacity-60` 且排在后面。点一行打开它的对话。

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

## 15. 外壳：左栏、顶栏、窄屏、网址

- **三栏**：左栏（300px，`bg-sidebar`）| 对话（`main`，`bg-background`）| 右栏（第 12 条）。三栏之间只用底色或 1px `border-border` 分开，不加阴影。
- **窄屏（1100px 以下）**：左栏收成抽屉，平时不占位置；顶栏最左边一个 `PanelLeft` 图标按钮（第 6 条）点开，盖在左边（`fixed`，宽 300px，遮罩 `bg-black/30`），选了对话、点遮罩、按 Esc 都收起。右栏照样推开对话（第 12 条）。
- **左栏的行**：头像 44px，第一行名字 + 右边的标注，第二行消息预览；没有消息的行第二行留空但占一样的高度，每行一样高。右边的标注只放一个，优先级：“等你确定”标签 > 在忙（Working…，12px 主色）> “等你”标签 > 时间。
- **左栏左下角**：“我”（28px 圆形头像，`bg-me`）+ 名字，右边额度和设置两个 ghost 按钮（第 6 条）。额度按钮：一个 16px 的小圆环（已用的部分画成弧，平时前景色 60%，快用完 `text-warn-foreground`、用完 `text-danger`）+“5h 37%”这样的窗口名和百分比（`tabular-nums`），用完写“额度用完”；点开浮层看每个厂商、每个窗口的明细（第 11 条）。
- **每个对话有自己的网址**：`#/c/<对话编号>`（项目经理的对话）、`#/w/<对话编号>`（Worker 的对话）、`#/pm/<项目经理编号>`（资料页）。点左栏、点 Worker、打开资料页都会改网址（能前进后退）；刷新后回到原来那个，找不到才回到第一个。
- **焦点**：打开或切换对话时，焦点放进输入框（输入框不可用时不放）。
