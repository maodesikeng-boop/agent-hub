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
| 时间、计数这类小标注 | 12px `text-xs` | 400 | `text-muted-foreground`，数字加 `tabular-nums` |

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

列表型浮层（对话页顶栏的 Worker 面板）：宽 360px、窄屏最宽 `100vw - 24px`、最高 `min(70vh, 480px)` 内部滚动；里面放一个 `SettingsGroup`（第 9 条），一行一项、整行可点。
行第一行：名字（15px、500，当前打开的 600）靠左，状态（13.5px，在忙用主色、其余灰）靠右；第二行：13.5px 灰，左边说明（超长 `truncate`），右边数字（`tabular-nums`，`title` 放明细）。
当前打开的行 `bg-sidebar-active`，悬停 `bg-sidebar-hover`，已结束的 `opacity-60`。点浮层外面、按 Esc、再点触发按钮都收起。

## 12. 交互和状态

- 悬停：浅灰底（`hover:bg-sidebar-hover` / `hover:bg-accent`），不变色、不放大。
- 加载：`Loader2` 转圈 + 短句（“加载中”），居中；按钮里转圈放在字前面。
- 不能点：`disabled:opacity-50`（主按钮换中性灰，见第 4 条）。
- 文案：不加解释性的灰色小字、副标题、操作提示（见 frontend-rules）；只留内容、控件、状态和能帮用户改正的错误。
