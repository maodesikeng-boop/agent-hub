# 手机界面方案（单独的手机外壳）

用户原话：“手机页面的话刚进去就只有图一，点进去就直接是对话框，输入框放下面一点”，“手机上的界面可以单独去做吗？”

**一句话结论**：手机上换一套外壳（`src/web/mobile/`），和电脑共用同一份数据和同一批组件。刚打开只有一个整屏的项目经理列表，点一行进整屏聊天，左上角返回；Pieces 从顶栏右边的果瓣按钮拉出底部抽屉；输入框贴着底边（安全区 + 8px），不自动弹键盘。电脑外壳不变。

这份只写方案，不改代码。用户审过之后按第 10 节拆 PR 去做。

---

## 0. 现状（390×844 截图 + 代码核对）

**结论：现在手机上看到的是“电脑窗口缩窄”的样子：左边常驻一条 72px 的头像栏，聊天只剩 311px 宽；进页面就自动聚焦输入框；Pieces 是顶栏下面的一大块，会把消息往下推。**

截图在本机 `/tmp/mobile-ui/`，不进仓库。做法：假的守护进程（`/api/state` 回一份 11 个项目经理、15 个 Piece 的快照）+ vite，Playwright 用 390×844、iPhone UA、触屏模式拍；Chromium 里 `env(safe-area-inset-*)` 是 0，按 `ui-standard.md` 第 19 条把 `--safe-top` 设成 59px、`--safe-bottom` 设成 34px，模拟 iPhone 主屏 App。

| 文件 | 看到什么 |
| --- | --- |
| `01-home-narrow-rail.png` | 不带网址打开：直接落到第一个对话（网址被改成 `#/c/70`），没有列表页。左边是 72px 头像栏（“大”档实际 78.75px），聊天区宽 311px。 |
| `02-chat.png` | 聊天页。占位文字“Message 项目经理geminni…”折成两行，输入框高 79px；框的底边离屏幕底 56px（安全区 34 + 下边距 20 + 边框）。焦点已经在输入框里（`document.activeElement` 是输入框），真机上就是一进来键盘弹起。输入框字号 16.4px，够 16px。横向不溢出（`scrollWidth` = 390）。 |
| `03-chat-pieces-top.png` | 点顶栏右边的果瓣开关：Needs You / Pieces / Completed 变成顶栏下面一块，高 338px（`40dvh`），把消息推到下面，Completed 的标题被切了一半。 |
| `04-piece.png` | Piece 的对话：顶栏是返回箭头 + 果瓣头像 + 截断的标题；占位文字是完整的 Piece 标题，折成四行，输入框被撑得很高。 |
| `05-profile.png` | 资料页：返回箭头在左上，下面是分组，整页能用，只是被头像栏挤窄了。 |
| `06-settings.png` | 设置弹窗：窄屏时分类横排在顶上，“Security & Access”被右上角的关闭键压住；“This computer”一行的小字被挤成两行。 |
| `07-composer-multiline-file.png` | 输入框多行 + 一个待发文件：文件小条在最上，文字占满一行，回形针和发送键落到最下面一行，和第 7 条标准一致。 |
| `08-sim-iphone-current.png` | iOS 模拟器（iPhone 17 Pro，Safari，用户本机界面，只截图没碰）：和用户的图二是同一屏——头像栏 + 橙子“项目经理”的聊天，输入框底下留了一大截。 |

用户的图一是电脑宽栏左栏（`Sidebar` 300px 那种：Search、+、设备组头“My MacBook Pro”、每行头像 + 名字 + 时间 + 一行预览）截下来的；图二就是上面的模拟器那一屏。项目经理对两张图的理解是对的。

代码核对（以代码为准，和任务说明不一样的地方加粗）：

- 断点：`src/web/useMediaQuery.ts` 的 `NARROW_QUERY` ≤1100px（左栏变头像窄栏）、`COMPACT_QUERY` ≤719px（右栏到顶栏下面）。只看宽度，不看是不是触屏。
- 不带网址时 `App.tsx` 第 167–170 行会用 `replace` 补成第一个对话——**所以现在根本没有“列表页”这个状态**，手机外壳要把“没有网址”当成列表页。
- 自动聚焦：`Conversation.tsx` 第 168 行、`WorkerConversation.tsx` 第 129 行都写死了 `autoFocus`，`Composer.tsx` 第 151–154 行出现时聚焦一次（第 16 条“焦点”的规矩）。
- 路由：`src/web/route.ts` 用的是 hash + `history.pushState` / `replaceState`，监听 `popstate` 和 `hashchange`，**浏览器返回键、iOS 边缘右滑本来就能走**；`navigate` 里用 View Transitions，`popstate` 这条路不起动画。
- `Conversation`、`WorkerConversation` 已经有 `leading` 这个口子（顶栏最左边），现在没人传——手机的返回键可以直接放进去。
- `index.html` 已经有 `viewport-fit=cover, interactive-widget=resizes-content`；`styles.css` 已经有 `--safe-top` / `--safe-bottom`、`#root { height: 100dvh }`、触屏下输入框 16px、`.touch-target` 撑到 44px。这几条手机外壳直接用。
- 初始数据：`/api/state`（`ledger.ts` 的 `snapshot()`）**带了每个项目经理对话和每个没收工 Piece 对话的最近 100 条消息**（`MESSAGE_PAGE_SIZE`），只有收工的 Piece 不带消息、点开才拉。所以“历史消息点开才拉”只对收工的 Piece 成立；左栏的预览就是从这些消息里算的（`selectors.ts` 的 `listConversations`）。
- 打包：首屏 JS `index-*.js` 814KB，压缩后 255KB；CSS 压缩后 10KB（本次 `vite build` 量的）。Service Worker 只缓存外壳（`sw-rules.ts`），第二次打开 JS/CSS 走本地缓存，接口不缓存。
- `Sidebar` 的 `drawerOpen` / `onCloseDrawer` 两个参数已经没用了（以前左栏抽屉留下的）；`ui-standard.md` 第 19 条还写着“1100px 以下左栏抽屉”，也是旧的。

---

## 1. 断点和分流

**结论：触屏、而且屏幕短边小于 600px 才进手机外壳。** 其余（电脑、电脑把窗口拉窄、iPad 全屏）照旧是现在的电脑外壳。

媒体查询（只写在 `src/web/useMediaQuery.ts` 一处，和现在两条放一起）：

```ts
/** 手机外壳：触屏，且短边 < 600px（手机竖屏、横屏，iPad 分屏的窄窗）。 */
export const MOBILE_SHELL_QUERY = "(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 599px)";
```

| 场景 | 进哪个外壳 | 为什么 |
| --- | --- | --- |
| 手机竖屏（390×844） | 手机 | 触屏 + 窄 |
| 手机横屏（844×390） | 手机 | 短边 390 < 600。只看宽度会在横屏时跳回三栏，横屏放三栏太挤 |
| iPad 全屏（820×1180、1024×1366） | 电脑 | 短边 ≥ 600，现在的窄栏 + 右栏推开放得下 |
| iPad 分屏 / 侧拉的窄窗（320–507 宽） | 手机 | 触屏 + 窄 |
| 电脑把窗口拉窄到 390 | 电脑（现在的头像窄栏 + 顶栏下的右栏） | 鼠标是精确指针（`pointer: fine`）。电脑上要看手机外壳用开发者工具的设备模拟（会把指针模拟成 coarse） |
| 触屏笔记本（主指针是触控板） | 电脑 | `pointer` 看的是主指针 |

- 转屏、iPad 改分屏大小时会在两个外壳之间切换。网址（`#/c/…`）不变，所以停在同一个对话；草稿存在 `useDraftStore`（`App` 这一层），切外壳不丢。
- 为什么是 600：iPhone 最大的横屏短边 440，iPad 最小的竖屏短边 744（iPad mini），600 在中间、也是 Material 的“compact / medium”分界附近。只是一个数，写在上面那一处，以后要调只改它。
- 不加“强制用手机版 / 电脑版”的开关（用户没要）。

---

## 2. 三个页面和返回

**结论：列表页 = 网址为空；聊天页 = `#/c/<编号>`；Piece 页 = `#/w/<编号>`；资料页 = `#/pm/<编号>`。都是整屏，一次只显示一页。进下一页用 `pushState`（记历史），返回键优先 `history.back()`，所以 iOS 边缘右滑、浏览器返回键、页面左上角的返回键三者走同一条路。**

### 2.1 列表页（图一）

- 就是现在电脑宽栏左栏的内容铺满整屏（复用 `Sidebar`，见第 6 节）：顶上安全区下面一行 Search + “+”（新建项目经理），下面是项目经理列表（多台设备时按设备分组，“等你确定”汇总组、已归档折叠组照旧），底部一行额度按钮和设置按钮。
- 行的样子不变（44px 头像、名字、时间或绿点、一行预览），行高本来就超过 44px。**手机上不显示选中底色**（列表页和聊天页不同时出现，选中没有意义）；悬停底色在触屏上本来不生效。
- 点一行：`navigate({ view: "conversation", id })`，进聊天页。
- 不加下拉刷新：数据靠 WebSocket 推，断线有“Reconnecting”提示条（`Notices`），和电脑一样。

### 2.2 聊天页（图二）

- 顶栏（64px 高，从安全区下面开始）：左边**返回键**（`ArrowLeft`，ghost `size="icon"`，36px，带 `touch-target` 撑到 44px，`aria-label="Back"`），然后头像（34px，点开资料页）+ 名字；右边是 Pieces 开关（现在的 `RightRailToggle` 果瓣，有没回答的提问时右上角有小圆点）。返回键放进 `Conversation` 已有的 `leading` 口子。
- 消息区和电脑一样（`MessageList`、`Messages` 不改，见第 8 节）。
- 输入框贴底，见第 4 节。**进来不聚焦**，点了输入框才弹键盘。
- 不在聊天页放“左滑切换项目经理”这类手势：用户没要，返回列表再点一行就行。

### 2.3 Piece 页（点开某个 Piece）

- 就是现在的 `WorkerConversation` 整屏。顶栏的返回箭头已经有（返回到它的项目经理），手机上照用；标题截断，右边的 `PieceMeta`（模型、思考程度、对话长度）在窄屏本来就藏起来。
- 顶栏右边同样有 Pieces 开关，抽屉里能直接换到另一个 Piece。
- 收工的 Piece 没有输入框，和电脑一样。

### 2.4 资料页、设置、新建

- **资料页**：聊天页点头像进 `#/pm/<编号>`，整屏的 `PmProfile`，左上返回（它已经有返回箭头）。不改内容。
- **设置**：列表页底部的齿轮（`Sidebar` 自带）打开 `SettingsDialog`。手机上把弹窗做成整屏（`DialogContent` 在手机外壳里铺满、去圆角、上下垫安全区），分类照现在 640px 以下的横排；顺带修截图里“Security & Access”被关闭键压住的问题（横排分类的滚动容器右边让出 56px，现在 `pr-14` 只加在了内容末尾）。
- **新建项目经理**：列表页的“+”，`NewPmDialog` 同样整屏。
- 只有列表页能进设置和新建，聊天页不放（顶栏只放返回、头像名字、Pieces 开关三样，不挤）。

### 2.5 返回怎么走

- `route.ts` 已经用 history：`navigate` 是 `pushState`，`replace` 是 `replaceState`，前进后退走 `popstate`。iOS Safari 的边缘右滑和浏览器返回键会触发 `popstate`，**不用另外写手势**。
- 要补的一个小口子：页面左上角的返回键要知道“上一条历史是不是我们自己 push 的”。深链接（从推送通知、书签直接打开 `#/c/3`）时没有上一条，`history.back()` 会退出网页。做法：`route.ts` 在 `pushState` 时写 `history.state = { hub: true }`，手机外壳的返回键：
  - `history.state?.hub` 为真 → `history.back()`（和右滑一样）；
  - 否则 → `replace` 到上一级（聊天页的上一级是列表页 `#/`，Piece 页是它的项目经理对话，资料页是那个项目经理的对话），不留死循环的历史。
- 列表页没有返回键。
- WebKit 只认“用户点了之后 push 的”历史条目（右滑会跳过脚本自己 push 的，见 WebKit bug 248303 的回复）。我们的 `navigate` 都在点击里调，没问题；**不要**在 effect 里 `navigate`。
- 页面切换动画：手机外壳第一版**不加自己的滑动动画**。Safari 右滑自带一层动画；现有的 View Transitions 只在 `navigate`（点击）时播、`popstate` 不播，不会和右滑叠两层。以后要加滑动动画，`popstate` 里看 `event.hasUAVisualTransition`（Safari 18 起支持），为真就不播（出处：MDN `PopStateEvent.hasUAVisualTransition`）。
- 主屏 App（standalone）里系统边缘右滑：网上资料说法不一（2018 年的说没有，2020 年后 Ionic、W3C pointerevents#358 的讨论说有），**我没在真机上验证**；不管有没有，左上角返回键都在。

### 2.6 列表页回来时停在原来的位置

- 列表页和聊天页之间来回切，列表页不卸载，用 React 19 自带的 `<Activity mode="hidden">` 包着（仓库现在是 React 19.3.1，`Activity` 已有）：藏起来时 DOM 和滚动位置都留着，后台更新降到低优先级，回来时直接显示原来的位置（出处：react.dev/reference/react/Activity）。
- 聊天页、Piece 页、资料页离开就卸载（和电脑切对话一样，靠 `key` 重建）。

---

## 3. Pieces：底部抽屉

**结论：手机上 Pieces 是从底部拉起的抽屉，点顶栏右边的果瓣开关打开；里面就是右栏的三组（Needs You、Pieces、Completed），把右栏里画三组的那段抽成共用组件，右栏和抽屉各包一层外壳。抽屉第一版用 shadcn 的 Drawer（Radix 版，底层 `vaul`）。**

### 3.1 用什么库（要用户拍板，见第 11 节第 2 条）

- `pnpm dlx shadcn@latest view drawer` 拿到的官方源码（new-york-v4，Radix 版）底层是 `vaul@1.1.2`，`vaul` 自己依赖 `@radix-ui/react-dialog`（我们已经装了），React 19 在它的 peer 范围里。
- **要知道的事**：`vaul` 作者 2025 年在 README 写了“This repo is unmaintained”，最后一版 1.1.2 是 2024 年 12 月发的；shadcn 的 Base UI 版和 React Aria 版 Drawer 已经换成了 `@base-ui/react` 的 Drawer（出处：github.com/emilkowalski/vaul README；ui.shadcn.com/docs/components/base/drawer 的 “Migrating from Vaul”；shadcn-ui/ui#8455）。
- 我的推荐：**第一版用 `vaul`**。理由：仓库是 Radix 体系，shadcn 的 Radix 版官方就是它；抽屉里只有几行按钮，`vaul` 现存的已知问题（抽屉里选不了字、里面放输入框时位置不对）碰不到；它被包在 `src/web/ui/drawer.tsx` 一个文件里，以后换 Base UI 只改这一个文件。备选：直接上 `@base-ui/react` 的 Drawer（在维护，但仓库里会多一套和 Radix 并存的底层库）。

### 3.2 怎么放进 `src/web/ui/drawer.tsx`（照 `AGENTS.md` “要新增一个”）

1. `pnpm dlx shadcn@latest view drawer` 看源码（不需要 `components.json`，不补它）。
2. `pnpm add vaul`。
3. 新建 `src/web/ui/drawer.tsx`，复制 `Drawer`、`DrawerContent`、`DrawerTitle`、`DrawerClose` 等，`import { cn } from "../lib/utils.ts"`（相对路径，不用 `@/`），去掉 `"use client"`。
4. 样式按 `ui-standard.md` 改：
   - 遮罩 `bg-black/30`（和 `DialogContent` 一样，官方是 `/50`），去掉 `animate-in` / `fade-in` 这类类名（仓库没装 `tw-animate-css`；`vaul` 自己带进出动画）。
   - 内容 `rounded-t-2xl`（官方 `rounded-t-lg`，标准不许用 `rounded-lg`）、`border-t border-line`、底色 `bg-surface-chat`（和右栏同一个外壳底色），`max-h-[85dvh]`，底下垫 `pb-[var(--safe-bottom)]`。
   - 顶上的拖动条：官方 `h-2 w-[100px] bg-muted` 改成 `h-1 w-9 rounded-full bg-border`，上下 8px（iOS 原生 sheet 的抓手大小），纯装饰 `aria-hidden`。
   - 只留 bottom 方向的样式，别的方向删掉（用不到）。
5. `AGENTS.md` 的“我们用的组件”同一个 PR 里更新：`vaul` 用在 `ui/drawer.tsx`，“没装”那行去掉 `Drawer`。
6. `src/web/ui/ui-standard.test.tsx` 加一条：`DrawerContent` 用的是 `rounded-t-2xl`、遮罩 `bg-black/30`。

### 3.3 抽屉里放什么、怎么动

- **内容**：和电脑右栏一模一样的三组、同样的行、同样的 Show more、同样的组收起记忆（`agent-hub.rightRail.collapsed`）。读屏标题 `DrawerTitle` 写 “Pieces”，`sr-only`，界面上不另加标题（组标题就是标题）。
- **复用方式**：`RightRail.tsx` 里画三组的那段（`<div className="... divide-y divide-line ...">` 里面的三个 `section`）抽成同一个文件里导出的 `RailGroups`。`RightRail`（`aside`，并排 / 顶栏下两种）和手机的 `PiecesDrawer` 都只是外壳，里面放 `RailGroups`。不复制代码、不另写一份行组件。`usePieceMeta`、`WorkerRow`、`AskRow`、`CompletedGroup` 都不动。
- **打开**：点顶栏右边的果瓣开关。没有任何 Piece 和提问时开关不显示（和电脑一样）。
- **不自动弹**：电脑右栏有新 Piece、新提问会自己出来；手机抽屉是盖在对话上的，自己弹会打断打字，所以**不自动弹**，只在开关上亮小圆点（现有的 `attention`）。要用户拍板（第 11 节第 3 条）。
- **关闭**：往下拖、点遮罩、点一行之后。点 Piece 行 → 先关抽屉再 `navigate` 到 Piece 页；点提问 → 展开全文、关抽屉、对话滚到那条并高亮（现有的 `focus` 机制）。
- **高度**：跟内容走，最高 85dvh，里面滚。第一版不做“半屏 / 全屏”两档吸附（`snapPoints`），先最小可用。

### 3.4 `ui-standard.md` 要补的（只列条目，跟着实现的 PR 一起改，这次不改）

1. **新增第 20 条“手机外壳”**：分流条件（第 1 节那条媒体查询）、三个页面和网址、顶栏三样东西（返回、头像名字、Pieces 开关）、列表页不显示选中底色、设置和新建整屏、返回键规则（第 2.5 节）。
2. **第 12 条右栏**：加一句“手机外壳里是底部抽屉（`ui/drawer.tsx`），内容同右栏三组（`RailGroups`），不自动弹出”；“720px 以下顶栏下面一块”改成“电脑外壳窗口太窄时”。
3. **第 10 条弹窗**后面加“抽屉”：遮罩 `bg-black/30`、`rounded-t-2xl`、`bg-surface-chat`、拖动条 36×4、`max-h-[85dvh]`、底部垫安全区。
4. **第 16 条“焦点”**：改成“打开或切换对话时，**用鼠标的设备（`pointer: fine`）**把焦点放进输入框；触屏不放”。
5. **第 19 条**：删掉“1100px 以下左栏抽屉”“左栏抽屉（`fixed inset-y-0`）上下同样垫”这两处旧说法；视口一段补上“iOS 27.2 及以前不认 `interactive-widget`，键盘高度靠 `--kb-inset`（第 4 节）”；验收截图一段改成手机外壳的列表、聊天、抽屉三张，放 `docs/screenshots/mobile/`（替换现在三张旧图）。
6. **第 3 条措辞表**：加 `返回 → Back`。

---

## 4. 输入框

**结论：输入框离底边只留“安全区 + 8px”；键盘弹起时贴在键盘上面；手机上不自动聚焦；16px 字号和 44px 点击区现在已经满足，不用改。**

### 4.1 贴近底边

- 现在：输入框外层 `.chat-column` 有 `pb-5`（20px），`.chat-main` 再垫一个安全区，主屏 App 里框底离屏幕底 56px（截图 02、08）。
- 手机外壳：下边距从 20px 改成 8px，安全区照垫 → 主屏 App 里约 42px（34 + 8），Safari 里底部工具栏收起时约 8px + 安全区。
- 写法：外壳根节点挂 `data-shell="mobile"`，`styles.css` 里加一条 `[data-shell="mobile"] .composer-dock { padding-bottom: 0.5rem }`（`Conversation`、`WorkerConversation` 的输入框外层把 `pb-5` 换成 `.composer-dock` 类，电脑默认值仍是 1.25rem）。数只在 `styles.css` 一处，组件里不加参数。
- 占位文字：手机上主区变成整屏宽（390），“Message 项目经理geminni…”放得下一行；但 Piece 的长标题会折成好几行（截图 04）。建议手机上占位只写 “Message…”（名字已经在顶栏）。要用户拍板（第 11 节第 5 条）。

### 4.2 键盘弹起时贴在键盘上方

查到的做法和出处：

| 办法 | iOS Safari 现状 | 出处 |
| --- | --- | --- |
| `interactive-widget=resizes-content`（我们已经写了） | **iOS 27.2 及以前不认**，iOS 27.3 beta 才实现，而且有人报告 27.3 beta 里 `resizes-content` 仍不按预期工作 | WebKit bug 259770（2026-11-06 的回复）；Chrome 的说明 developer.chrome.com/blog/viewport-resize-behavior |
| `100dvh` | 键盘弹起时**不变**（iOS 只缩“可视视口”，布局视口不动） | 同上 Chrome 文章的分组：Safari on iOS 属于“只缩 Visual Viewport” |
| VirtualKeyboard API（`env(keyboard-inset-height)`） | Safari 没有 | MDN `VirtualKeyboard.overlaysContent`（Limited availability） |
| `visualViewport` 的 `resize` + `scroll` 算出键盘挡住的高度，写成 CSS 变量 | 能用，是现在通用的兜底 | Stack Overflow “How to polyfill interactive-widget=resizes-content on iOS Safari”（PenPage 的生产代码）；MDN Visual Viewport API |

推荐：**保留 `interactive-widget=resizes-content`（安卓和以后的 iOS 用它），再加一个 `visualViewport` 兜底**：

- `src/web/mobile/keyboard.ts` 一个小 hook `useKeyboardInset()`，只在手机外壳里挂：监听 `visualViewport` 的 `resize` 和 `scroll`（Safari 平移页面时只发 `scroll`），算 `max(0, innerHeight − visualViewport.height − visualViewport.offsetTop)`，写到 `<html>` 的 `--kb-inset`；卸载时把监听和变量都清掉。
- `styles.css`：`[data-shell="mobile"] .chat-main { padding-bottom: max(var(--safe-bottom), var(--kb-inset, 0px)) }`。键盘起来时底部横条被盖住，不再多垫一份安全区；键盘收起回到安全区。消息区是 `flex-1`，跟着变矮，已经在底部的消息继续贴底（`MessageList` 现有的 `ResizeObserver`）。
- 浏览器已经按 `resizes-content` 缩了布局视口时，算出来是 0，这条规则什么都不做，两者不打架。
- 这块没有现成的成熟库能直接用（React Aria 的 `usePreventScroll`、`vaul` 的 `repositionInputs` 都是给自己的弹层用的），所以是手写的十来行，PR 里写明原因（`AGENTS.md` 的使用规则）。以后包成 Capacitor App 时可以换成它的 Keyboard 插件，所以只放这一个文件里（第 9 节）。
- **没验证的地方**：Safari 在输入框聚焦时会把整页往上推（`offsetTop > 0`），我们的 `html, body` 是 `overflow: hidden`，推上去之后顶栏可能被推出屏幕。实现的 PR 必须在 iOS 模拟器里用软键盘（模拟器菜单 I/O → Keyboard → Toggle Software Keyboard）实测：顶栏还在、输入框贴着键盘、收起键盘后回到原位。不行再加“聚焦时 `scrollTo(0, 0)`”或按 `offsetTop` 平移外壳，先不预先加。

### 4.3 手机上不自动聚焦

- 条件：**`(pointer: fine)` 才自动聚焦**（有鼠标、触控板的设备）。手机、iPad 都是 coarse，不聚焦，不弹键盘。
- 改在一处：`Composer` 的 `autoFocus` 生效条件里加 `matchMedia("(pointer: fine)").matches`，`Conversation`、`WorkerConversation` 不用动。这样 iPad（电脑外壳）也不再一进对话就弹键盘。
- 为什么不看“是不是手机外壳”：弹键盘是触屏的问题，不是布局的问题，iPad 用电脑外壳也有同样的问题。

### 4.4 字号、点击区、多行和待发文件

- 字号：`styles.css` 第 636 行触屏下 `input, textarea, select` 已经是 `max(16px, var(--text-body))`，截图里量到 16.4px。**不用改**。
- 点击区：回形针、发送、停止都是 `Button size="icon"`（36px），`Button` 自带 `touch-target`，触屏下撑到 44px；待发文件的 × 用 `CHIP_CLOSE_CLASS`，也带 `touch-target`。**不用改**。新加的返回键用同一个 `Button`，自然满足。
- 多行、待发文件（截图 07）：沿用第 7 条的单行 / 多行网格，手机上宽了（整屏 390），一行能放更多字。输入框最高 180px（`MAX_HEIGHT_PX`），键盘起来后可视区只剩 400 多 px，180px 还行，**先不改**，实测觉得高再说。
- 发送键：手机键盘的“换行”键就是 Enter，现在 Enter 是发送、Shift+Enter 换行；手机上没有 Shift，等于**打不出换行**。建议手机上 Enter 换行、只用发送键发（iMessage、微信都是这样）。这是 `Composer` 里的一行判断（`(pointer: coarse)` 时 Enter 不拦），放在第 10 节 PR 3 里。

---

## 5. 性能（固定一项）

**结论：第一版不加后端接口、不加虚拟列表。列表页首屏用现有的 `/api/state`；切页面不重新请求；下面给出能量的数字和超过多少才动手。**

### 5.1 列表页首屏要拉多少

| 东西 | 大小（压缩后） | 第二次打开 |
| --- | --- | --- |
| `index-*.js` | 255KB（本次 `vite build` 量的） | Service Worker 缓存，不走网络 |
| `index-*.css` | 10KB | 同上 |
| `/api/state` | 约 260KB（项目经理给的数，用户本机） | 每次都拉（接口不缓存） |
| WebSocket | 之后的增量 | — |

- `/api/state` 里大头是每个项目经理对话和每个在跑 Piece 的最近 100 条消息。列表页其实只要名字和最后一条预览，但这些消息拉下来以后，点进任何一个对话都是**秒开、不再请求**。两头取舍，第一版保持现状。
- 什么时候才加接口：PR 4 用 Chrome 开发者工具 “Slow 4G” + CPU 4 倍降速量“第一次打开到列表出来”的时间。**超过 2.5 秒**才做第二步：`/api/state?preview=1`（每个对话只带最后一条可见消息和 `hasMore`），点进对话再按现有的 `/api/conversations/:id/messages` 拉一页。这一步要改状态合并（`state.ts`），单独一个方案，不在这次里。
- 别的设备（联机）的快照是各自另拉的，手机上和电脑一样，不变。

### 5.2 列表会不会卡、要不要虚拟列表

- 列表页的行数 = 没归档的项目经理数（归档的默认折起来不渲染）。按“跑了一个月”的量算，项目经理是几十个，每行一个按钮、一张头像、两行字，几十行完全不用虚拟化。
- 抽屉里：Needs You、Pieces 默认各最多 3 行（`RIGHT_RAIL_VISIBLE_ROWS`），多了 Show more；Completed 收着时不挂载（现有做法）。会变多的只有“展开 Completed”：一个月 300 个收工 Piece 会一次渲染 300 行（每行跑一次 `usePieceMeta`）。
- 什么时候才上 `@tanstack/react-virtual`：PR 4 里造 300 个收工 Piece，在 CPU 4 倍降速下量“点开 Completed 到画完”的时间。**超过 100ms**（INP 的“好”线是 200ms，留一半余量）才给 Completed 这一组上虚拟列表；电脑右栏是同一个 `RailGroups`，一起受益。没超过就不加依赖。
- 消息列表：每个对话一页 100 条、往上翻才拉更早的（现有），手机不变。

### 5.3 切页面会不会重复请求、重复渲染

- 数据在 `App` 这一层（`useDevices` + WebSocket），列表页、聊天页、抽屉都只是读它。**切页面不发 `/api/state`**，只有往上翻历史时发 `messages`。
- 列表页用 `<Activity mode="hidden">` 藏着，不卸载：回来不重建，滚动位置还在；藏着的时候 WebSocket 来的更新只低优先级更新它。
- 聊天页每次进来会重建一次（`key` 换了），重新渲染这个对话的最多 100 条消息（Markdown、代码高亮有缓存）。和电脑切对话一样，先不优化。
- 打字只重渲染输入框（`DraftComposer` 现有做法），抽屉、列表不跟着重画。

### 5.4 写进 PR 的数（PR 4 验收时量）

| 量什么 | 怎么量 | 期望 |
| --- | --- | --- |
| 首屏请求体积 | 开发者工具 Network，第一次打开 / 第二次打开 | 第一次 ≈ JS 255KB + CSS 10KB + `/api/state`；第二次只有 `/api/state` |
| 第一次打开到列表出来 | Slow 4G + CPU 4× | ≤ 2.5s，超过就做 5.1 的第二步 |
| 列表页 DOM 行数 | `document.querySelectorAll('nav[aria-label=Conversations] button').length` | = 没归档的项目经理数（+ 归档组头一行） |
| 列表 → 聊天 → 返回列表 | Network 面板 | 0 次 `/api/state` |
| 列表 → 聊天 → 返回列表 | React Profiler | 返回时列表不重新挂载（滚动位置不变） |
| 点开 Completed（300 行） | Performance 面板，CPU 4× | ≤ 100ms，超过就上虚拟列表 |

---

## 6. 统一（固定一项）：手机外壳和电脑外壳怎么共用

**结论：同一个前端项目、同一份数据、同一批组件。手机外壳只是另一种“摆法”，新代码放 `src/web/mobile/`，`App.tsx` 里只多一个分流口。为了不让两个外壳各算一遍数据，要先把 `App.tsx` 里“算数据”的那部分抽成一个 hook。**

### 6.1 要抽出来的

| 抽什么 | 从哪 | 到哪 | 为什么 |
| --- | --- | --- | --- |
| 外壳要的数据和动作（设备、当前路由对应的对话、列表、提醒、右栏的 Piece 和提问、发送、重试、停止、草稿、待发文件……App.tsx 第 74–310 行那一大段） | `App.tsx` | `src/web/shell-model.ts` 的 `useShellModel()` | 两个外壳都用；不抽的话手机外壳要复制 200 多行。纯搬家，电脑外壳的样子和行为一行不变 |
| 右栏三组 | `RightRail.tsx` 里 `aside` 里面那段 | 同文件导出 `RailGroups` | 右栏和抽屉共用 |
| 列表页 | `Sidebar` 的宽栏分支 | 不新建组件，`Sidebar` 加一个 `layout`：`"wide"`（现在的 300px）、`"rail"`（现在的 72px，替代 `narrow` 布尔值）、`"page"`（手机整屏：`w-full`、不显示选中） | 图一就是宽栏左栏，直接复用；顺手删掉没用的 `drawerOpen` / `onCloseDrawer` |

`useShellModel()` 里有一处要按外壳分开：**“网址为空时补成第一个对话”只在电脑外壳做**（手机外壳里网址为空就是列表页）。做法：hook 收一个参数 `{ autoSelect: boolean }`。

### 6.2 不动的

`Conversation`、`WorkerConversation`（只把 `pb-5` 换成 `.composer-dock`，返回键走已有的 `leading`）、`Composer`（只改自动聚焦条件和手机上 Enter 换行）、`MessageList`、`Messages`、`PmProfile`、`SettingsDialog`、`NewPmDialog`（只在手机外壳里加整屏的 `className`）、`Notices`、`state.ts`、`device-hub.ts`、`route.ts`（只加 `history.state = { hub: true }`）、后端全部。

### 6.3 新代码（都在 `src/web/mobile/`）

| 文件 | 做什么 |
| --- | --- |
| `MobileShell.tsx` | 手机外壳：根节点 `data-shell="mobile"`；按路由决定显示哪一页；列表页用 `<Activity>` 藏着；挂 `useKeyboardInset` |
| `MobileChat.tsx` | 聊天页 / Piece 页：给 `Conversation` / `WorkerConversation` 传返回键（`leading`）、Pieces 开关（`toolbar`）、`top={null}` |
| `PiecesDrawer.tsx` | `ui/drawer.tsx` + `RailGroups` |
| `back.ts` | 返回键规则（第 2.5 节）：`history.state?.hub` → `history.back()`，否则 `replace` 到上一级 |
| `keyboard.ts` | `useKeyboardInset()`（第 4.2 节） |

分流（`App.tsx` 里只多这几行）：

```tsx
const mobile = useMediaQuery(MOBILE_SHELL_QUERY);
const model = useShellModel({ autoSelect: !mobile });
// 外面的 QueryClientProvider、DeviceScope、ModelCatalogProvider、FruitTint、AccentScope 两边共用
return mobile ? <MobileShell model={model} /> : <DesktopLayout model={model} />;
```

`DesktopLayout` 就是现在 `App.tsx` 里 `return (...)` 那段 JSX，原地留在 `App.tsx`，不搬家。

### 6.4 用的库

全是 `AGENTS.md` 清单里已有的：React（`Activity`）、zustand（草稿）、react-query（资料页、浏览器会话）、Radix（Dialog）、lucide-react（`ArrowLeft`）、tailwind。新增只有 `vaul`（或备选 `@base-ui/react`）一个。不另起前端项目、不加路由库（现有 hash 路由够用）。

---

## 7. 加载中、空、出错

**结论：全部沿用现有的，手机外壳不另做。**

- 整页加载中、没登录、连不上守护进程：`App.tsx` 现有的整页提示，两个外壳共用（在分流之前）。
- 列表空：没有项目经理时，列表页中间用电脑主区现成的那句 “No conversations yet”，顶上的“+”照常能新建（`Sidebar` 自己没有空状态，这句由 `MobileShell` 放）。
- 聊天页的对话找不到（网址编号不对、刚建好还没同步）：先回列表页（`replace` 到 `#/`），不像电脑那样落到第一个对话。
- 别的设备离线、重连中：`Notices` 提示条和输入框只读，和电脑一样。

---

## 8. 不碰的边界

**结论：消息气泡（`Messages.tsx`）和 Piece 汇报的样式这次不改。** 电脑端马上要把 Piece 汇报改成“回执行卡”，会动这一块；手机外壳只换外框，消息区原样用。

手机上看到的、以后要对齐的点（只记下来，不在这份方案里改）：

1. 用户气泡在 390 宽下最宽能到多少（现在是按列宽算的百分比），整屏后会比现在宽，回执卡做完一起看。
2. Piece 汇报气泡和以后的回执卡：整个气泡是一个按钮，手机上点它进 Piece 页（走 `navigate`，能右滑返回），回执卡要保留这个行为。
3. “Worked for 23s ›”这一行的点击区（`touch-target`）在回执卡改完后再核一次 44px。
4. 代码块、表格在 390 宽下横向滚动（第 15 条现有），整屏后不变，不用动。
5. 状态栏那一条：`index.html` 的 `theme-color` 写死 `#ffffff`，模拟器截图里状态栏是一条白边，而外壳底色掺了水果色。和外壳底色对齐要动 `theme-color`，跟这次的布局无关，单独提。

---

## 9. 以后包成 Capacitor App：现在要留的口子

**结论：不设计 App，只保证这套外壳以后能原样放进 WKWebView。** 现在要做到的：

1. **不依赖地址栏**：所有页面都能用页面里的按钮到达和返回（列表、聊天、Piece、资料、设置都有入口和返回键），不靠用户改网址。hash 路由在 WKWebView 里照样能用。
2. **安全区只用变量**：组件里只写 `--safe-top` / `--safe-bottom`（来自 `env(safe-area-inset-*)`），新代码不写死刘海高度、不判断机型。Capacitor iOS 配 `contentInset: "never"` 时 `env()` 照样有值。
3. **键盘只在一个文件**：`src/web/mobile/keyboard.ts`。App 里可以换成 Capacitor 的 Keyboard 插件，别处不用改。
4. **接口地址走 `client.url`**：新代码的请求都经过 `DeviceScope` 给的 `client`，不写死 `location.origin`。最省事的包法是让 App 直接打开守护进程的网址（Capacitor 的 `server.url`），页面和接口同源，cookie 照旧。
5. **登录保活**：现在是 `HttpOnly; SameSite=Strict` 的会话 cookie，公网会话 30 天不活动才过期（`PUBLIC_SESSION_MAX_AGE_MS`）。WKWebView 默认的数据存储会把 cookie 存在磁盘上，和主屏 App 一样，**现在不用改**。要注意的只有一条：新代码别把登录相关的东西放 `sessionStorage`（App 被系统杀掉就没了）。如果以后 App 不和守护进程同源（打包在 App 里本地加载），`SameSite=Strict` 的 cookie 带不过去，那时再设计令牌，现在不动。
6. **推送**：Web Push 在 WKWebView 里不能用，以后要换原生推送插件；推送代码已经集中在 `src/web/push.ts`，不用提前改。

---

## 10. 分步计划

**结论：拆 5 个 PR。PR 1、2、3 互不碰同一个文件，可以三个 Worker 同时做；PR 4 等前三个合了再做；PR 5 最后。**

```
PR 1 抽数据 hook ─┐
PR 2 抽屉组件   ─┼─→ PR 4 手机外壳 ─→ PR 5 键盘和整屏弹窗
PR 3 共用组件小改 ┘
```

### PR 1：把 App 的数据抽成 `useShellModel`（纯搬家）

- 改：`src/web/App.tsx`、新建 `src/web/shell-model.ts`。
- 内容：第 6.1 节第一行；加 `autoSelect` 参数（这一步电脑外壳传 `true`，行为不变）。
- 验收：`pnpm typecheck`；`src/web/App.test.tsx`、`shell.test.tsx`、`right-rail.test.tsx`、`m2/m3/m4.test.tsx`、`devices.test.tsx`、`route.test.ts` 全过；电脑 1440 宽、900 宽、390 宽（鼠标）三张截图和改前一样。
- 可以和 PR 2、3 并行（只碰这两个文件）。

### PR 2：抽屉组件

- 改：新建 `src/web/ui/drawer.tsx`；`package.json`、`pnpm-lock.yaml`（`pnpm add vaul`）；`AGENTS.md` 的组件清单；`src/web/ui/ui-standard.test.tsx`；`docs/ui-standard.md` 的第 3.4 节第 3 条（抽屉样式）。
- 验收：`pnpm typecheck`；`ui-standard.test.tsx` 过；一个只在测试里用的抽屉能打开、Esc 关、点遮罩关（新加在 `ui-standard.test.tsx` 或 `src/web/ui/drawer.test.tsx`）。
- 可以并行。

### PR 3：共用组件的小改

- 改：`src/web/components/RightRail.tsx`（导出 `RailGroups`）、`Sidebar.tsx`（`layout` 三档，删 `drawerOpen` / `onCloseDrawer`）、`Composer.tsx`（`pointer: fine` 才自动聚焦；触屏 Enter 换行）、`Conversation.tsx` 和 `WorkerConversation.tsx`（输入框外层 `pb-5` → `.composer-dock`）、`src/web/styles.css`（`.composer-dock` 默认值）、`docs/ui-standard.md`（第 3.4 节第 4 条“焦点”）。
- `Sidebar` 的 `narrow` 改成 `layout` 时，`App.tsx` 里那一处调用要跟着改——**这一行和 PR 1 冲突**。办法：PR 3 先保留 `narrow` 参数，同时加 `layout`（`layout` 优先），等 PR 4 里再删 `narrow`。这样 PR 3 不碰 `App.tsx`。
- 验收：`pnpm typecheck`；`right-rail.test.tsx`、`shell.test.tsx`、`Composer.test.tsx`、`composer-wiring.test.tsx` 过；新加测试：`pointer: coarse` 时打开对话焦点不在输入框、`pointer: fine` 时在；触屏 Enter 不发送。电脑截图和改前一样。
- 可以并行。

### PR 4：手机外壳

- 改：新建 `src/web/mobile/`（第 6.3 节五个文件）、`src/web/useMediaQuery.ts`（`MOBILE_SHELL_QUERY`）、`src/web/App.tsx`（分流口，删 `Sidebar` 的 `narrow` 改用 `layout`）、`src/web/route.ts`（push 时写 `{ hub: true }`）、`src/web/styles.css`（`[data-shell="mobile"] .composer-dock` 8px）、`docs/ui-standard.md`（第 3.4 节第 1、2、5、6 条）、`docs/screenshots/mobile/`（换成新的三张）。
- 依赖：PR 1、2、3 都合了。
- 验收：
  - 新加 `src/web/mobile/mobile-shell.test.tsx`：网址为空显示列表页、不跳到第一个对话；点一行网址变 `#/c/<编号>`、显示聊天页；返回键回列表（有 `hub` 历史走 `history.back`，深链接走 `replace`）；Pieces 开关打开抽屉、点 Piece 行关抽屉并进 Piece 页；不自动聚焦。
  - `route.test.ts` 加 `history.state` 那条；`shell.test.tsx`、`App.test.tsx` 照过（电脑外壳不变）。
  - 390×844、iPhone UA、触屏：列表页、聊天页、抽屉打开、Piece 页、资料页、设置 6 张截图；844×390 横屏 1 张；电脑 1440 宽 1 张（证明没变）。
  - 第 5.4 节的数字写进 PR。
- 不能和别的并行（要等前三个）。

### PR 5：键盘和整屏弹窗

- 改：`src/web/mobile/keyboard.ts`（`useKeyboardInset`）、`src/web/styles.css`（`--kb-inset` 那条）、`src/web/components/SettingsDialog.tsx`（横排分类右边让出关闭键）、手机外壳里给 `SettingsDialog`、`NewPmDialog` 传整屏的 `className`（`src/web/mobile/` 里）、`docs/ui-standard.md`（第 19 条键盘那句）。
- 验收：`keyboard.test.ts`（假的 `visualViewport`：resize、scroll 后 `--kb-inset` 对、卸载后清掉）；**iOS 模拟器实测**（用一台测试用的模拟器，不碰用户正在看的那台）：点输入框弹软键盘，截图看顶栏在、输入框贴键盘；收起键盘回原位；设置整屏截图。
- 依赖 PR 4。

---

## 11. 要用户拍板的事

| # | 问题 | 推荐 |
| --- | --- | --- |
| 1 | 什么时候用手机外壳 | **触屏且短边 < 600px**（手机竖横屏、iPad 分屏窄窗）。电脑把窗口拉窄仍是现在的样子 |
| 2 | 抽屉用哪个库 | **先用 `vaul`**（shadcn Radix 版官方用的，和我们的 Radix 一套），包在 `ui/drawer.tsx` 一个文件里；它已停更，出问题再换 Base UI 的 Drawer，只改这一个文件 |
| 3 | 有新 Piece、新提问时抽屉自己弹出来吗 | **不弹**，只在顶栏果瓣开关上亮小圆点（自己弹会打断打字） |
| 4 | 列表页要不要和电脑宽栏完全一样（搜索、设备分组、归档、额度、设置） | **一样**，直接复用宽栏左栏（就是图一），只是铺满整屏、不显示选中 |
| 5 | 手机上输入框的占位文字 | **只写 “Message…”**（名字已在顶栏；长 Piece 标题现在会把输入框撑成四行） |
| 6 | 手机上 Enter 键 | **换行**，只用发送键发（手机键盘没有 Shift，现在打不出换行） |
| 7 | 弱网下要不要先给列表页做精简接口 | **先不做**，PR 4 量“Slow 4G 下第一次打开到列表出来”，超过 2.5s 再做 |
| 8 | 要不要自己做左缘右滑返回、页面滑动动画 | **不做**，用浏览器 / 系统自带的右滑 + 左上角返回键 |

---

## 12. 没验证、不确定的

- iOS 主屏 App（standalone）里系统的边缘右滑返回到底有没有：资料说法不一，没在真机试。
- `visualViewport` 兜底在我们“`html, body` 不滚动”的外壳里会不会被 Safari 把顶栏推出去：要 PR 5 在模拟器里实测（第 4.2 节）。
- `/api/state` 约 260KB 是项目经理给的数，我没连用户本机的守护进程量；本次截图用的是假数据。
- 600px 这个分界是按机型尺寸定的，没在 Android 平板上试。
