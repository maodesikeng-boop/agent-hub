## what is agent-hub

给用户自己用的多 agent 系统：Router（总助）+ 每个项目一个项目经理 + Worker，每个角色可以选不同公司的 agent。先在这台 Mac 上试。

完整背景、已经定下的设计和下一步都在主文件夹的 `HANDOVER.md`，项目经理开工前先读。它被 gitignore 了，Worker 的 worktree 里没有，Worker 不用找，背景看任务说明。

## 规矩
- 开发过程中任何软件工程的工具，脚本，优先用行业推荐的
- 所有组件,代码,方案，优先看行业成熟方案，直接用标准的组件，非必要不要自己手搓
- 查问题找根源，不要打补丁
- 用中文跟用户交流。
- 设计或进度有变化，项目经理同步更新 `HANDOVER.md`。
- 代码要有合理的结构：重要的部分放一起，方便以后改。比如可调的数、提示词、`claude` 的启动参数，各自集中在一处。
- 优先用成熟的第三方库，不要自己手搓基础轮子（比如前端状态订阅用 `zustand`、按需拉取与分页缓存用 `@tanstack/react-query`、UI 原语用 `shadcn/ui` 等），不要为了追求“零依赖”手写复杂的状态机、缓存淘汰或分页拼接。
- 界面按 `docs/ui-standard.md`：间距、圆角、字号、颜色、控件尺寸、聚焦态、对齐都照它；标准没覆盖的先补进标准再改界面。
- GitHub 操作一律用 `GH_TOKEN="$(gh auth token --user maodesikeng-boop)" gh ...`（本机 gh 默认账号不是仓库协作者）。
- Mac 测试在本机跑（`pnpm typecheck`、本次改到的相关测试文件及涉及沙箱时的 `src/shared/write-scope.test.ts`），云端 CI 只跑 Ubuntu（4 路并行分片）。
- 写或审缓存、状态快照、会随时间变多的列表，必查 4 件事（守卫测试见 `src/web/selectors-cache.test.ts`、`src/daemon/store/db-cache.test.ts`、`src/web/sw-rules-cache.test.ts`）：
  1. 失效：底层文件、配置、数据变了要能感知；退出、删除要清掉；失败或空结果只短暂记（像 `FETCHED_QUOTA_RETRY_MS`），不当正常结果缓存几分钟到几小时。
  2. 上限：按跑了一个月（300 个已收工 Worker、3 万条消息、5 万步日志）算，内存里的 Map/数组、单次接口响应、给 agent 的命令输出都要有上限（数写进 `src/shared/limits.ts`），大响应要压缩。
  3. 前端引用稳定：selector、hook 输入没变就返回同一个引用（`WeakMap` 按输入对象缓存），不让 `memo` 的子组件每次都重画。
  4. 验证：用 pstack 的 `perf-issue`、`benchmark-checklist`、`blast-radius` 量出改前改后的数字，写进 PR。
- rule a:你不做事，只汇报，拆任务，派任务。 派的模型思考程度你根据任务难度来决定(除非你直接回答，做事效率更高，或者用户意图是让你回答，用户的意图永远是优先的)。耗时短、花 token 少、需要及时反馈的任务自己做；相反（耗时久、花 token 多、不需要当场秒回的）给 Worker 做。
- 整体工作流程 先讲清楚边界，tdd，测试，提pr，判断要不要审查
    -需要 审查，修改，回到判断要不要审查
    -不需要 合pr
    这是整体工作流程，你需要在rule a的规矩下完成，不同的功能，代码分别完成，整体分工你来规划，总效率达到最高


## 我们用的组件
只列 `package.json` 与 `apps/windows/Cargo.toml` 的直接依赖（macOS 用系统框架），"用在哪"都用 grep 核过。

**后端（`src/daemon`）**
- `fastify`：HTTP 服务（`agent-api/server.ts`、`ui-server/server.ts`、`peers/proxy.ts`）。
- `@fastify/websocket` + `ws`：WebSocket 服务端与客户端（`ui-server/server.ts`、`peers/routes.ts`、`peers/proxy.ts`）。
- `@fastify/static`：托管打包后的网页（`ui-server/server.ts`）。
- `@fastify/compress`：大响应压缩（`ui-server/server.ts`、`peers/proxy.ts`）。
- `zod`：校验输入（`ledger/hub-commands.ts`、`peers/service.ts`）。
- `lru-cache`：带上限的缓存（`commands-catalog.ts`、`driver/model-catalog.ts`）。
- `web-push`：手机推送（`push/sender.ts`、`push/vapid.ts`）。
- `@agentclientprotocol/sdk`：标准 ACP（Agent Client Protocol）客户端与服务端协议层（`src/vendors/_common/acp/`）。
- `jsonc-parser`：保留注释与格式的 JSON/JSONC 解析与局部补丁（`src/vendors/_common/sync/jsonc.ts`）。
- `@decimalturn/toml-patch`：保留注释与格式的 TOML 解析与局部补丁（`src/vendors/_common/sync/toml.ts`）。
- `unified` + `remark-parse` + `remark-gfm`：解析 Markdown（`sent-files.ts`）。
- 数据库用 Node 自带的 `node:sqlite`（`store/`），不是第三方库；Skill 逐项软链同步直接用 Node 自带的 `node:fs`（`src/vendors/_common/sync/skills.ts`）。

**前端（`src/web`）**
- `react` / `react-dom`：界面。`vite` + `@vitejs/plugin-react`：构建（`vite.config.ts`）。
- `zustand`：前端状态（`components/Composer.tsx`、`device-hub.ts`）。
- `@tanstack/react-query`：按需拉取、缓存（`App.tsx`、`components/BrowserSessions.tsx`、`components/PmProfile.tsx`）。
- `tailwindcss` + `@tailwindcss/vite`：样式（`styles.css`）。
- `lucide-react`：图标（`App.tsx`、`components/Attachments.tsx`）。
- `clsx` + `tailwind-merge`：合并 class，包成 `cn()`（`lib/utils.ts`）。`class-variance-authority`：按钮变体（`ui/button.tsx`）。
- `qrcode-generator`：二维码（`components/QrCode.tsx`）。
- 消息渲染：`react-markdown`、`remark-gfm`、`remark-breaks`、`remark-cjk-friendly`、`remark-cjk-friendly-gfm-strikethrough`（`components/Markdown.tsx`）。
- 代码高亮：`shiki`（`highlight.ts`）。
- 图表：`mermaid`、`vega`、`vega-lite`、`vega-embed`、`vega-interpreter`（`charts/`）；`dompurify` 清洗 mermaid 输出（`charts/mermaid-theme.ts`）。
- 拓扑布局：`@dagrejs/dagre`：任务流图自动分层布局（`task-graph-layout.ts`）。

**UI 组件（`src/web/ui/`）**
- 底层是 Radix（`@radix-ui/react-*`），样式照 shadcn/ui 的写法，但**仓库里没有 `components.json`，也没有 `@/` 别名**，所以 `shadcn add` 不能直接用（会要求先建 `components.json`）。
- 已有：`button`（slot + cva）、`input`、`dialog`（Radix Dialog）、`drawer`（底部抽屉，底层 `vaul`）、`popover`、`tabs`、`collapsible`、`avatar`、`switch`、`segmented`（Radix RadioGroup）。
- `vaul`：底部抽屉（`src/web/ui/drawer.tsx`，只有这一个文件 import 它）。它已停更（作者 2025 年起标 unmaintained，最后一版 1.1.2），以后换 Base UI 的 Drawer（`@base-ui/react`）只改这一个文件，调用方不动。
- `ModeRows.tsx` 直接用 `@radix-ui/react-radio-group`，没有单独的 `radio-group.tsx`。
- 没装：`Sheet`、`Select`、`Textarea`、`Tooltip`、`DropdownMenu`、`ScrollArea`、`Toast/Sonner` 等。`Dialog` 已装。
- 要新增一个：先 `pnpm dlx shadcn@latest view <名字>` 看官方源码（不需要 `components.json`），再手工放进 `src/web/ui/<名字>.tsx`：import 改成相对路径（`../lib/utils.ts`），新依赖（如 `vaul`）用 `pnpm add`，样式按 `docs/ui-standard.md` 改。

**桌面外壳（`apps/desktop`、`apps/macos`、`apps/windows`）**
- 共用监管约定：`apps/desktop/contract.json`（`apps/macos/DaemonSupervisor.swift`、`apps/windows/crates/fusa-supervisor/src/contract.rs`、`apps/windows/crates/fusa-desktop/src/lib.rs`）。
- macOS（`apps/macos/`）：原生 Swift，系统框架 `AppKit`、`WebKit`、`UserNotifications`（`scripts/build-mac-app.sh` 调用 `swiftc` 编译为 `Fusa.app`）。
- Windows（`apps/windows/`，Rust workspace）：`tauri` + `tauri-build`（Tauri 2 桌面窗口、WebView 与托盘，`crates/fusa-desktop/`）、`ureq`（守护进程 HTTP 探活，`crates/fusa-supervisor/src/probe.rs`）、`winreg`（读取 WSL 注册表安装路径，`crates/fusa-wsl/src/registry.rs`）、`sha2`（SHA-256 校验，`crates/fusa-wsl/src/runner.rs`）、`serde` + `serde_json`（配置与状态序列化，`fusa-wsl` / `fusa-supervisor` / `fusa-desktop`）、`thiserror`（`fusa-wsl` / `fusa-supervisor`）+ `url`（`fusa-desktop`）；Rust 测试用 `tempfile`。

**测试**
- `vitest`（`vitest.config.ts`）、`jsdom`（`src/shared/test-helpers.ts`）、`@testing-library/react`、`@testing-library/user-event`、`@testing-library/jest-dom`（`src/web/test-setup.ts`）。

**工程工具**
- `typescript`：类型检查（`pnpm typecheck`）。`knip`：死代码检查，没接脚本和 CI，需要时手动跑 `pnpm exec knip`（上次全仓清理见 PR #193）。`@types/*`（node、react、react-dom、ws、web-push）：类型。
- `oxc-parser`：把源码解析成语法树，`src/web/web-guard.test.ts` 用它按调用节点找定时器数字字面量（TS 7 是原生版，没有 `createSourceFile` 的 JS 接口；它原本只是 knip 的传递依赖）。

**使用规则**
- 要新功能，先查这一节有没有；没有再找行业成熟库；实在没有才自己写，并在 PR 里说明为什么。
- 新装或删掉依赖，同一个 PR 里更新这一节。
- 界面样式、尺寸仍以 `docs/ui-standard.md` 为准，这一节只管"用什么库"。

## pstack 技能（只本项目）

- 原版 pstack（backnotprop/pstack，MIT）@ `f104aa8`（2026-11-07 取的 main）的 `skills/` 原样放在 `.agents/skills/`，许可证在 `.agents/skills/PSTACK-LICENSE`。
- 三家共用这一份：codex 和 agy 读 `<仓库>/.agents/skills/`；claude 读 `.claude/skills`，它是指向 `../.agents/skills` 的软链接。不写任何用户目录。
- agy 里这些技能只能手打 `/技能名` 用（原版设了 disable-model-invocation，agy 不把它们列进模型的技能清单）。
- 更新：重新 clone 原版，把 `skills/` 覆盖到 `.agents/skills/`（保留 `PSTACK-LICENSE`），在这里改提交号，提 PR。
