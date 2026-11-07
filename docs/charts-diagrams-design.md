# 聊天里显示流程图和数据图表（方案）

目标：agent 回复里写 ```` ```mermaid ```` 渲染成流程图、时序图等；写 ```` ```vega-lite ```` 渲染成柱状、折线等数据图表。所有厂商、所有显示 Markdown 的地方走同一套。

## 1. 现在怎么渲染

- 唯一的 Markdown 组件：`src/web/components/Markdown.tsx` 的 `Markdown`（react-markdown 10 + remark-gfm / remark-cjk-friendly / remark-breaks + 本项目的 `remarkSentFiles`）。不加 rehype-raw，原始 HTML 当文字显示；链接由 react-markdown 默认过滤。
- 代码块：`COMPONENTS.pre = CodeBlock`（`Markdown.tsx:238`），模块级、引用不变，流式重渲染不卸载；语言取自 `language-xxx`（`languageOf`），右上角语言名 + 复制按钮，`useHighlightedHtml` 用 Shiki 按需上色（`src/web/highlight.ts`，动态 `import("shiki")`，主题 `github-light`），流式时停 120ms 再上色。
- 用到它的地方：
  - agent 消息：`src/web/components/Messages.tsx:120`（`AgentText`，所有厂商的回复都走这里）；
  - 交接全文：`Messages.tsx:339`；
  - 右栏“等你确定”展开：`src/web/components/RightRail.tsx:144`；
  - 预览窗里的 .md 文件：`src/web/components/FilePreview.tsx:187`。
- 流式：守护进程推 `message.updated`，`src/web/state.ts:140` 整条替换 `text`，`Markdown` 重新解析；没闭合的代码块照常显示已收到的部分（ui-standard 第 15 条）。
- 排版标准：`docs/ui-standard.md` 第 15 条（代码块 `rounded-xl`、`--muted` 底、语言名 + 复制）、第 17 条（贴底、内联图片固定高度不跳）。
- 页面只有浅色（`styles.css` 里没有暗色变量，ui-standard 没有暗色），Shiki 也只用浅色主题。

## 2. 选型

### 2.1 候选

| | 写法 | agent 会不会写 | 体积（gzip，估算，实现第一步用 `vite build` 实测） | 安全 | 主题 |
| --- | --- | --- | --- | --- | --- |
| **Mermaid** 12.x | ```` ```mermaid ```` 文本 DSL | 会，GitHub / GitLab / Obsidian / Notion 都渲染，各家模型默认就写 | 核心约 500–700KB，每种图再按需拆块 | `securityLevel: "strict"`（默认）：标签过 DOMPurify、禁点击回调；`secure` 列表里的配置（含 securityLevel）不能被图里的 `%%{init}%%` 改 | `theme: "base"` + `themeVariables` 可配字体、颜色 |
| **Vega-Lite** 6.x（+ vega 6、vega-embed） | ```` ```vega-lite ```` JSON | 会，Altair / Jupyter / Observable 生态，模型很熟；纯 JSON，没有函数 | vega + vega-lite 约 300–400KB | 表达式默认用 `new Function` 编译 → 用 `ast: true` + `vega-interpreter` 改为解释执行；`data.url` 会发请求 → 自定义 loader 一律拒绝；`href` 通道 → loader `sanitize` 拒绝 | `config` 一个对象配字体、颜色、坐标轴 |
| ECharts 6.x | 没有通用的代码块约定（JS option） | agent 常写成带 `formatter: function` 的 JS，JSON 放不下 | 全量约 350KB，可按需引 | 字符串模板、tooltip 是 HTML，要自己转义 | 主题对象 |
| Chart.js 4.x | 没有通用约定，配置里常有回调函数 | 同上 | 约 70KB | 同上 | 手配 |
| Mermaid `xychart-beta` / `pie` | ```` ```mermaid ```` | 会，但少写 | 包在 Mermaid 里，不另加 | 同 Mermaid | 同 Mermaid |

### 2.2 推荐

- **流程图 / 时序图 / 状态图 / 甘特图 / 类图 / ER 图：Mermaid。** 事实标准，agent 本来就写，GitHub 也是这么显示的，用户在别处看到的样子一致。
- **数据图表：Vega-Lite。** 声明式 JSON（agent 写的内容只是数据，没有可执行代码）、模型熟、坐标轴/图例/配色一处 `config` 统一；ECharts、Chart.js 没有 agent 惯用的 Markdown 写法，配置里还常带 JS 函数，不选。
- 只认 fence 上明确写的语言：`mermaid`；`vega-lite`、`vegalite`。不认 `vega`（完整 Vega 能写信号、事件、数据请求，面太大），不猜 `json` 代码块是不是图表。
- 先不做：数学公式（KaTeX）、PlantUML / Graphviz（要服务端或大 wasm）、HTML 图表。以后要加，按第 5 节的“渲染器表”加一行。

### 2.3 安全（agent 写的内容不能执行脚本、不能发请求）

- Mermaid：`initialize({ startOnLoad: false, securityLevel: "strict", ... })` 只调一次；`mermaid.render()` 出 SVG 字符串后再过一遍 DOMPurify（`USE_PROFILES: { svg: true, svgFilters: true }`，Mermaid 自带 dompurify 依赖，不新增），再插入。`click`、`href` 在 strict 下不生效。
- Vega-Lite：`vega-embed` 传 `ast: true, expr: expressionInterpreter`（不用 `new Function`）、`loader` 自定义（`load` 和 `sanitize` 一律抛错：不许 `data.url`、不许 `href` 链接、不许图片 mark 拉外部图）、`actions: false`（不要导出/编辑菜单，那个菜单会把规格发到 vega 在线编辑器）、tooltip 用 vega-embed 自带的（会转义）。数据只能写在 `values` 里。
- 两个渲染器都跑在页面里（不用 iframe）：页面本身没有 CSP（`src/daemon/ui-server/server.ts` 只给存的文件加了沙箱 CSP），所以靠上面两条保证不执行脚本、不发请求；测试里用带 `<script>`、`onload=`、`javascript:`、`data.url` 的输入逐条验证（第 7 节）。
- 规格大小上限：源码超过 `CHART_MAX_SOURCE_CHARS`（如 50,000 字）不渲染，当普通代码块 + 一行错误；Mermaid 的 `maxTextSize`、`maxEdges` 同步设成这一档。防止一条消息把页面卡死。

### 2.4 主题（只有浅色，跟 ui-standard 走）

- 先补 `docs/ui-standard.md` 第 15 条“图表”小节（规矩：标准没覆盖的先补进标准）：容器、字号、颜色、交互都写进去，再实现。
- 颜色**不新造**：
  - 字、线、边框、底色取 `styles.css` 的变量（`--foreground`、`--muted-foreground`、`--border`、`--muted`、`--background`），渲染前 `getComputedStyle` 读出来传给 Mermaid `themeVariables` / Vega `config`；字体取 `--font-ui`。
  - 数据系列的分类色：取 `src/web/lib/palette.ts` 的 `PALETTE`（`accent` 那一组，已经过对比度校验），不另起一套；放进 palette.ts 一个导出 `CHART_CATEGORY_COLORS`，加进 `palette.test.ts` 的校验（对白底 ≥ 3:1，图形元素按 WCAG 1.4.11）。
  - Mermaid 节点：白底（`--background`）、1px `--border` 描边、前景色字，连线 `--muted-foreground`；不用 Mermaid 默认的紫色（违反“禁止紫色”）。
- 字号：图里的字 13.5px（和次要文字一档），坐标轴标签 12px。
- 将来加暗色：主题对象由一个函数 `chartTheme()` 从 CSS 变量生成，暗色时变量变了重新渲染即可，不改渲染器。

## 3. 交互

图表块和代码块是同一个外壳（`.md-code`：`rounded-xl`、`--muted` 底、1px 内描边、右上角工具条），只是正文换成图；图本身放在白底（`--background`）区域里，四周 12px 内边距。

- **工具条**（右上角，和代码块一致）：语言名（12px 灰）→ “源码 / 图”切换（`Code` / `ChartNetwork` 图标按钮 `size-7`，`aria-pressed`）→ 放大（`Maximize2`）→ 复制（复制源码，和代码块一样）。图标按钮样式照第 15 条的复制按钮。
- **看源码**：点“源码”整块换成现有 `CodeBlock` 的样子（Shiki 上色），再点回图。状态只在这一块里，不记住。
- **渲染中**：块先占位，最小高 160px，中间 `Loader2` 转圈（不写字，块很小，转圈就够），加载好换成图；高度变化由已有的贴底逻辑（`ResizeObserver`，第 17 条）处理，往上翻了不拉回。
- **渲染失败**：显示成普通代码块（源码、上色、复制都在），代码块上方一行错误：`AlertCircle` 14px + 错误第一行（13.5px，`text-danger`，最多一行，`truncate`，完整错误放 `title`）。不弹 toast，不吞掉源码。库加载失败（断网、chunk 404）也走这条，错误写“图表组件加载失败”。
- **流式输出**：
  - 代码块**没闭合**：照现在的代码块显示（已收到的源码），不尝试渲染（半截 Mermaid 必然报错，会闪红）。
  - **闭合了**才渲染：闭合判断放在 remark 插件里（`remarkChartBlocks`）：取这个 `code` 节点在原文里的片段，最后一行是和开头同样的 fence（```` ``` ```` / `~~~`，长度 ≥ 开头）才标 `data-chart-closed`。
  - 闭合后内容不会再变；同一条消息后面继续流式追加文字，这个块因为源码不变直接用缓存（第 5 节），不重画、不闪。
- **大图**：
  - 宽：图按消息列宽缩放（Mermaid `useMaxWidth: true`；Vega `autosize: fit-x`、`width: "container"`），不撑破消息列。
  - 高：图块内最高 480px（`CHART_MAX_INLINE_HEIGHT`），更高的等比缩到这个高度（很长的时序图会变小），点放大看原尺寸。
  - 放大：用现有 `Dialog`（`src/web/ui/`）开一个接近全屏的窗（`w-[min(96vw,1400px)] h-[90dvh]`），里面原尺寸图，可两个方向滚动（**不做缩放、拖动平移**，见第 9 节）。Esc 关闭。
  - 点击图本身也打开放大（光标 `cursor-zoom-in`，和内联图片一致）。Vega 有 tooltip，悬停照常显示；点击不触发放大以免和图表交互冲突——Vega 图只有放大按钮。
- **复制成图片**：先不做（以后在放大窗加“下载 SVG/PNG”）。

## 4. 统一

- **所有厂商**：Claude、Codex、agy 等的回复都是 `message.text`，统一经 `Messages.tsx` → `Markdown` → `COMPONENTS.pre`。只在 `Markdown.tsx` 的 `pre` 组件里分流：语言在渲染器表里且已闭合 → `ChartBlock`，否则 `CodeBlock`。不按厂商分支，右栏提问、交接全文、预览窗 .md 自动也能显示图。
- **提示词**：不改（第 9 节已拍板：不告诉 agent 能画图，`prompt.ts` 不动）。
- 不改守护进程、不改存储：图表只是 Markdown 的一种显示方式，消息原文不变，复制这一轮拿到的仍是 Markdown 原文。

## 5. 结构和性能

### 5.1 文件

```
src/web/charts/
  registry.ts        渲染器表：语言名 → { load: () => import(...), render(source, theme, el) }；可调的数（最大源码长度、最大内联高度、缓存条数）集中在这里
  mermaid.ts         动态 import("mermaid")，initialize 一次，串行队列 render，DOMPurify 再洗一遍
  vega-lite.ts       动态 import("vega-embed" + "vega-interpreter")，安全 loader，config
  theme.ts           chartTheme()：从 CSS 变量 + PALETTE 生成两个库的主题
  cache.ts           结果缓存（LRU）
  remark-chart-blocks.ts  remark 插件：标记闭合的图表代码块
src/web/components/ChartBlock.tsx  外壳、工具条、加载/失败/源码切换、放大窗
```

### 5.2 只在需要时加载

- `registry.ts` 里只有 `() => import("mermaid")` 这种函数，**主包不静态引用任何图表库**；vite 自动拆块。没有图表代码块的对话不会下载一个字节。
- 两个库互不牵连：只有 Mermaid 的对话不下载 Vega。
- Mermaid 每种图（flowchart、sequence…）本身再按需拆块。
- 加载 promise 模块级缓存，多张图并发只加载一次；加载失败的 promise 清掉，下次（重新打开对话）可重试。

### 5.3 长对话、很多图

- **进视口才渲染**：`ChartBlock` 用 `IntersectionObserver`（`rootMargin: 600px`）快进视口才排队渲染；没渲染的先占 160px 位。打开一个有 50 张图的老对话，只画底部能看到的几张。
- **串行**：Mermaid 渲染要往 DOM 里放临时节点量尺寸，同时渲染多张会互相干扰，所以一个队列一次一张（Vega 也进同一个队列，避免主线程一次卡太久）。
- **不重复渲染**：
  - 缓存键 `语言 + 源码 + 主题版本`，值是洗过的 SVG 字符串（Mermaid）/ Vega 规格编译结果 + 上次的 SVG 快照；LRU 200 条（`CHART_CACHE_SIZE`）。组件卸载再挂上（切对话再切回来、流式重渲染）直接取缓存，同步出图，不闪转圈。
  - `ChartBlock` 是模块级组件、`React.memo` 按 `source` 比较；外面 `Markdown` 重新解析不改源码就不动。
  - 失败也缓存（同样的源码不反复报错重试）。
- **释放**：Vega 的 `view.finalize()` 在卸载时调用；Mermaid 只是 SVG 字符串，无需释放。
- **DOM 量**：Mermaid 一张图几百个 SVG 节点，几十张没问题；Vega 用 `renderer: "svg"`（清晰、截图稳定），数据量大（> 5,000 个点）时自动改 `canvas`。消息列表没有虚拟化，这不在本方案范围；若以后长对话本身卡，再整体做虚拟化或 `content-visibility: auto`。

## 6. ui-standard 要补的内容（第 15 条加“图表”小节）

- 图表块：外壳同代码块；图区白底、12px 内边距；最小 160px（加载中）、最高 480px（超出等比缩）。
- 工具条顺序：语言名、源码/图切换、放大、复制。
- 失败：代码块 + 上方一行 `text-danger` 13.5px 错误。
- 颜色：只用 CSS 变量和 `PALETTE`；分类色 `CHART_CATEGORY_COLORS`。
- 图里字 13.5px，坐标轴 12px，字体 `--font-ui`。
- 放大窗：Dialog，原尺寸，可滚动（不缩放）。

## 7. 测试计划（TDD：先写失败的测试）

jsdom 里 Mermaid 量不了尺寸（没有 `getBBox`），Vega 也画不出真东西，所以**单元测试把 `registry` 的 `load` 换成假渲染器**，验证分流、状态、缓存；**真库的效果和安全用浏览器跑**。

### 7.1 单元测试（vitest + jsdom，`src/web/charts.test.tsx`）

1. ```` ```mermaid ```` 闭合 → 出现 `data-chart` 块，不再是 `data-md-code`；语言名、复制、源码切换、放大按钮都在（按 `aria-label` 找）。
2. 没闭合（流式中）→ 仍是普通代码块，不调用渲染器；补上收尾 fence 后调用一次。
3. 流式在图后面继续追加文字 → 渲染器只被调用一次（缓存 + memo）。
4. 渲染器抛错 → 显示代码块原文 + `text-danger` 错误一行，`title` 是完整错误。
5. 库加载失败（`load` reject）→ 同上，错误“图表组件加载失败”。
6. 源码超过上限 → 不调用渲染器，代码块 + 错误。
7. `vega`、`json`、`text` 代码块 → 普通代码块；`vegalite` 和 `vega-lite` 都认。
8. 不在视口（IntersectionObserver 假实现不触发）→ 不渲染，占位 160px。
9. 切换源码 → 显示 Shiki 代码块；再切回 → 不重新渲染。
10. 复制 → 剪贴板是源码原文。
11. 卸载再挂载同一源码 → 同步出图，不出现转圈。
12. 主包不含图表库：测试读 `Markdown.tsx`、`ChartBlock.tsx`、`registry.ts` 的源码，断言没有静态 `import ... from "mermaid" / "vega*"`（只允许 `import(`）。实现末尾再跑一次 `vite build`，看入口 chunk 里没有 mermaid / vega（写进 PR 说明）。
13. `palette.test.ts`：`CHART_CATEGORY_COLORS` 每个色对白底 ≥ 3:1。
14. ~~`prompt.test.ts`~~：不做（提示词不改）。

### 7.2 安全测试（真库，浏览器里跑；放进 `test/smoke/charts.ts` 或用 vitest browser 模式，二选一由实现时定）

- Mermaid：标签里 `<img src=x onerror=alert(1)>`、`<script>`、`click A call alert()`、`click A href "javascript:alert(1)"`、`%%{init: {"securityLevel":"loose"}}%%` → 页面不弹窗、SVG 里没有 `<script>` / `on*` 属性 / `javascript:` 链接。
- Vega-Lite：`data.url: "http://127.0.0.1:…/x"` → 没有发出请求（看网络记录）、显示失败；`href` 通道 → 没有可点的链接；表达式 `"calculate": "..."` 正常算出（证明 interpreter 生效），页面没有 `new Function` 调用（打补丁计数）。

### 7.3 截图验证（chrome-devtools，起 `pnpm dev` + 假 agent 消息）

逐张截图，放 `docs/screenshots/charts/`，自己看一遍对照 ui-standard：

1. 流程图（flowchart，含中文节点）。
2. 时序图（长，超过 480px 高 → 缩放）。
3. 柱状图、折线图（vega-lite，多系列，看分类色和坐标轴字号）。
4. 渲染失败（错误一行 + 代码块）。
5. 流式中没闭合的 mermaid 块（代码块样子）。
6. 放大窗（原尺寸、可滚动）。
7. 窄屏（< 640px 主区）下图不撑破消息列。
8. 右栏“等你确定”里的图（右栏窄，看缩放）。

检查点：和代码块的圆角、底色、工具条位置一致；没有紫色；字体与正文一致；加载前后不跳（贴底时）。

## 8. 实现拆分（建议派 3 个 Worker，前两个可并行）

1. **标准 + 基础设施**（小）：补 ui-standard 第 15 条“图表”小节；`palette.ts` 加 `CHART_CATEGORY_COLORS` + 校验；`remark-chart-blocks.ts`（闭合判断）；`registry.ts` / `cache.ts` / `ChartBlock.tsx`（外壳、工具条、加载/失败/源码切换、视口、缓存）+ 7.1 的 1–12 条测试，渲染器先用假的。
2. **Mermaid 渲染器**（中，依赖 1 的接口，可先按约定接口并行写）：`mermaid.ts`、`theme.ts` 的 Mermaid 部分、安全测试、截图 1、2、4–8。
3. **Vega-Lite 渲染器**（中）：`vega-lite.ts`、`theme.ts` 的 Vega 部分、安全 loader 和 interpreter、截图 3；更新 `HANDOVER.md`（提示词不改）。

## 9. 已拍板

1. **数据图表上 Vega-Lite**（不只靠 Mermaid 的 `pie` / `xychart-beta`）。
2. **提示词里不告诉 agent 能画图**：`RICH_BLOCKS_NOTE`、`prompt.ts` 的改动、7.1 第 14 条测试、第 4 节“提示词”一条全部不做；agent 自己写 ```` ```mermaid ```` / ```` ```vega-lite ```` 时网页照样显示。
3. **放大窗先只做原尺寸滚动查看**：不做滚轮缩放、拖动平移、`+` `-` `1:1` 按钮（第 3 节“放大”一条里这几项不做，以后再加）。
