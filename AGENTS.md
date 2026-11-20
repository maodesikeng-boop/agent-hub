## Bellwood

跨端（macOS / Windows / Linux）多 Agent 协同工作台：Router（总助）汇总跨项目待办与验收，每个项目由独立的项目经理调度子 Worker（`Pieces`），支持混用多家模型 CLI 与免公网飞书入口（底层数据目录与内部包名保留 `agent-hub` / `hub`）。

### 目录结构
- `src/daemon/`：本地守护进程（SQLite 账本、任务图调度、HTTP/WebSocket 接口、飞书长连接、系统沙箱、配置同步）。
- `src/vendors/`：各家模型 CLI 驱动、协议适配、模型目录与配置同步。
- `src/web/`：React 前端工作台与组件库（`src/web/ui/`）。
- `src/hub/`、`src/feishu/`：Agent 调用的 `hub` 命令入口与终端工具。
- `src/mesh/`：账号登录与设备管理的终端工具。`src/daemon/mesh/` 管理设备信任、连接与飞书租约，`src/relay/` 提供 Node 与 Cloudflare 中继。
- `src/shared/`：前后端共用的类型、上限常量（`limits.ts`）、像素资产与纯函数。
- `apps/`：桌面端监管契约（`desktop/`）、macOS Swift 原生壳（`macos/`）与 Windows Rust/Tauri 原生壳及沙箱辅助程序（`windows/`）。
- `migrations/`：SQLite 顺序迁移脚本。

## 工程规范
- **修根因，不打补丁**：定位问题最初出错的边界修复，同一 PR 内删掉被替代的旧代码与旧说明，不留新旧两套并存。
- **同类逻辑集中维护**：可调阈值与上限集中在 `src/shared/limits.ts`，提示词集中在 `src/daemon/prompt.ts`，各厂商启动参数集中在 `src/vendors/<vendor>/`。
- **优先成熟库与标准方案**：状态订阅用 `zustand`、请求与缓存用 `@tanstack/react-query`、UI 原语用 Radix / `shadcn/ui`、容量缓存用 `lru-cache`，不手搓基础状态机、缓存淘汰或分页拼接。
- **界面遵循统一标准**：间距、圆角、字号、配色、控件尺寸、聚焦态与对齐一律对照 `docs/ui-standard.md`；标准未覆盖的先补入文档再改界面。
- **默认中文沟通**：对话、代码注释（仅写代码本身看不出的原因）与提交正文默认使用中文。

## 缓存与状态上限
编写或审查缓存、状态快照与随时间增长的列表时，必须满足以下 4 条（守卫测试见 `src/web/selectors-cache.test.ts`、`src/daemon/store/db-cache.test.ts`、`src/web/sw-rules-cache.test.ts`）：
1. **失效**：底层文件、配置或账本数据变更时及时失效；会话退出或删除时清理；失败或空结果只做短暂退避（如 `FETCHED_QUOTA_RETRY_MS`），不当作正常结果长期缓存。
2. **上限**：按连续运行一个月（300 个已收工 Worker、3 万条消息、5 万步日志）核算，内存集合、单次接口响应与命令输出均须设上限（常量写入 `src/shared/limits.ts`），大响应开启压缩。
3. **前端引用稳定**：selector 与 hook 在输入未变时返回同一引用（如按输入对象 `WeakMap` 缓存），避免击穿子组件 `memo`。
4. **实测验证**：涉及性能或影响面的改动，按 `.agents/skills/benchmark-checklist/SKILL.md` 与 `blast-radius` 实测改前改后数据并写入 PR。

## 测试与合并策略
- **本机按需验证**：开发与独立审查阶段只跑 `pnpm typecheck`、本次改动涉及的测试文件（改动沙箱或写范围时必跑 `src/shared/write-scope.test.ts`）和 `pnpm verify` 端到端冒烟（`.agents/skills/verify/SKILL.md`），不在本机跑全量 `vitest`，也不阻塞等待桌面安装包编译或云端 CI 排队；不用 `gh run rerun` 掩盖抖动测试。
- **两层审查**：独立审查先过 `src/shared/review.ts` 的通用清单，再按改动路径核对主干上根目录 `REVIEW.md` 里 `Trigger:` 命中的条目；发现分 `[Important]`、`[Nit]`、`[Pre-existing]` 三档，只有 `[Important]` 挡合并。
- **云端分层检查**：PR 默认运行 4 路并行 Ubuntu 分片；改动平台层、驱动层、进程/管道/git/同步、`apps/windows/**` 或 `test/windows/**` 时自动触发 `.github/workflows/windows.yml`；仅改动 `apps/**`、打包脚本或锁文件时触发桌面安装包工作流。
- **合并时机**：本机可实测的常规改动在单测与必要审查通过后直接合入 `main`，由 `main` 异步运行全量回归与桌面包自检；本机无法实测的 Linux `bwrap` 沙箱或 Windows 底层/打包改动，须等对应云端检查通过后再合并。

## 方案、提交与 PR
- **方案先行**：需要写方案的任务按 `docs/plan-standard.md` 交付方案文档与代码骨架（类型、函数签名、契约与 `it.todo`）；后续实现步骤在同一骨架上填充逻辑。
- **提交与 PR 规范**：项目经理按 `.agents/skills/poteto-mode/SKILL.md` 调度；Worker 不加载 `poteto-mode`，直接按任务说明与本节执行：
  - 提交拆分与 PR 结构遵循 `.agents/skills/poteto-mode/playbooks/opening-a-pr.md`，`## Why` 首句写明用户目标，`##` 二级标题保留英文原名，正文用中文。
  - 提交前通读自身 diff，对照 `.agents/skills/unslop/SKILL.md` 去除 AI 套话，对照 `.agents/skills/no-comments/references/comment-sicko.md` 删掉复述代码逻辑的冗余注释（不起子代理）。
  - 行文遵循 `.agents/skills/technical-writing/SKILL.md`；PR 直接开为可审查状态（不开草稿），任务说明要求等待 CI 时再等检查完结。

## 直接依赖清单
仅列 `package.json` 与 `apps/windows/Cargo.toml` 的直接依赖（macOS 使用系统原生框架）。新增功能先查本清单，确需增删依赖时在同一 PR 同步更新本节。

**后端（`src/daemon`）**
- `fastify`：HTTP 服务（`agent-api/server.ts`、`ui-server/server.ts`、`peers/proxy.ts`）。
- `@fastify/websocket` + `ws`：WebSocket 服务端与客户端（`ui-server/server.ts`、`peers/routes.ts`、`peers/proxy.ts`）。
- `@fastify/static`：托管打包后的网页（`ui-server/server.ts`）。
- `@fastify/compress`：大响应压缩（`ui-server/server.ts`、`peers/proxy.ts`）。
- `zod`：校验输入（`ledger/hub-commands.ts`、`peers/service.ts`）。
- `lru-cache`：带上限的缓存（`commands-catalog.ts`、`driver/model-catalog.ts`、`shared/paths.ts`、`platform/win32/`、`skill-files.ts`、`ledger/loaded-skills.ts`、`daemon/feishu/service.ts`、`src/relay/node/server.ts`）。
- `web-push`：Web Push 推送（`push/sender.ts`、`push/vapid.ts`）。
- `@peculiar/x509`：生成设备的 Ed25519 自签证书。`reflect-metadata` 提供该库初始化所需的元数据接口（`src/daemon/mesh/identity.ts`）。
- `@agentclientprotocol/sdk`：标准 ACP（Agent Client Protocol）客户端与服务端协议层（`src/vendors/_common/acp/`）。
- `jsonc-parser`：保留注释与格式的 JSON/JSONC 解析与局部补丁（`src/vendors/_common/sync/jsonc.ts`）。
- `@decimalturn/toml-patch`：保留注释与格式的 TOML 解析与局部补丁（`src/vendors/_common/sync/toml.ts`）。
- `write-file-atomic`：同目录临时文件 + fsync + rename 原子替换用户配置，目标是软链时替换真实文件并沿用原权限属主（`daemon/vendor-sync/backup.ts`）。
- `@microsoft/mxc-sdk`：Windows 11 24H2+ 只读 Worker 的 MXC ProcessContainer 探测与只读容器执行，低版本 Windows 自动回退写受限令牌（`daemon/platform/win32/mxc-readonly.ts`、`daemon/platform/win32/mxc-runner.ts`）。
- `@larksuiteoapi/node-sdk`：飞书开放接口、长连接事件与卡片回调、扫码建应用 `registerApp` 与消息 `normalize`；全仓仅 `daemon/feishu/sdk.ts` 直接引用，其余模块只依赖 `daemon/feishu/transport.ts`（`docs/feishu-design.md`）。
- `sharp`：飞书发大图前在临时目录缩放转码（原图不动，按需动态加载，`daemon/feishu/files.ts`），以及按共享像素稿动态渲染飞书群头像（`daemon/feishu/avatars.ts`）。
- `p-limit`：飞书附件预传与重连补拉的并发上限控制（`daemon/feishu/service.ts`）。
- `unified` + `remark-parse` + `remark-gfm`：解析 Markdown（`sent-files.ts`）。
- 数据库使用 Node 内置 `node:sqlite`（`store/`），Skill 软链同步使用 `node:fs`（`src/vendors/_common/sync/skills.ts`）。

**前端（`src/web`）**
- `react` / `react-dom`：界面。`vite` + `@vitejs/plugin-react`：构建（`vite.config.ts`）。
- `zustand`：前端状态（`components/Composer.tsx`、`device-hub.ts`）。
- `@tanstack/react-query`：按需拉取、缓存（`App.tsx`、`components/BrowserSessions.tsx`、`components/PmProfile.tsx`）。
- `tailwindcss` + `@tailwindcss/vite`：样式（`styles.css`）。
- `pixelarticons`：像素工具图标。`src/web/ui/icons.ts` 统一导出，也定义输入框内的线条图标。
- `@fontsource-variable/geist`：本地打包的 Geist 可变字体（`src/web/styles.css`）。
- `clsx` + `tailwind-merge`：合并 class，包成 `cn()`（`lib/utils.ts`）。`class-variance-authority`：按钮变体（`ui/button.tsx`）。
- `qrcode-generator`：二维码（`components/QrCode.tsx`；飞书终端命令 `src/feishu/main.ts` 在终端里画扫码二维码）。
- 消息渲染：`react-markdown`、`remark-gfm`、`remark-breaks`、`remark-cjk-friendly`、`remark-cjk-friendly-gfm-strikethrough`（`components/Markdown.tsx`）。
- 代码高亮：`shiki`（`highlight.ts`）。
- 图表：`mermaid`、`vega`、`vega-lite`、`vega-embed`、`vega-interpreter`（`charts/`）；`dompurify` 清洗 mermaid 输出（`charts/mermaid-theme.ts`）。
- 拓扑布局：`@dagrejs/dagre`：任务流图自动分层布局（`task-graph-layout.ts`）。

**UI 组件（`src/web/ui/`）**
- 底层是 Radix（`@radix-ui/react-*`），样式照 shadcn/ui 的写法，但**仓库里没有 `components.json`，也没有 `@/` 别名**，所以 `shadcn add` 不能直接用（会要求先建 `components.json`）。
- 已有：`button`（slot + cva）、`input`、`dialog`（Radix Dialog）、`drawer`（底部抽屉，底层 `vaul`）、`popover`、`tabs`、`collapsible`、`avatar`、`switch`、`segmented`（Radix RadioGroup）。
- `vaul`：底部抽屉，仅 `src/web/ui/drawer.tsx` 一处封装引用，后续替换底层实现时调用方无需改动。
- `ModeRows.tsx` 直接用 `@radix-ui/react-radio-group`，没有单独的 `radio-group.tsx`。
- 没装：`Sheet`、`Select`、`Textarea`、`Tooltip`、`DropdownMenu`、`ScrollArea`、`Toast/Sonner` 等。`Dialog` 已装。
- 要新增一个：先 `pnpm dlx shadcn@latest view <名字>` 看官方源码（不需要 `components.json`），再手工放进 `src/web/ui/<名字>.tsx`：import 改成相对路径（`../lib/utils.ts`），新依赖（如 `vaul`）用 `pnpm add`，样式按 `docs/ui-standard.md` 改。

**桌面外壳（`apps/desktop`、`apps/macos`、`apps/windows`）**
- 共用监管约定：`apps/desktop/contract.json`（`apps/macos/DaemonSupervisor.swift`、`apps/windows/crates/fusa-supervisor/src/contract.rs`、`apps/windows/crates/fusa-desktop/src/lib.rs`）。
- macOS（`apps/macos/`）：原生 Swift（`AppKit`、`WebKit`、`UserNotifications`），由 `scripts/build-mac-app.sh` 编译打包；`--dist` 分发模式随包内置官方 Node 与守护进程（`scripts/stage-mac-runtime.ts`，与 Windows 共用 `scripts/stage-runtime-common.ts`），用系统 `codesign`、`hdiutil` 签名打 DMG（`docs/mac-distribution-design.md`）。
- Windows（`apps/windows/`，Rust workspace，含 `fusa-win-helper`、`fusa-supervisor`、`fusa-desktop`）：`windows-sys`（Win32 Job Object、写受限令牌、NTFS ACL、Restart Manager、防睡眠与命名管道）、`tauri` + `tauri-build` + `tauri-plugin-single-instance` + `tauri-plugin-dialog` + `tauri-plugin-opener`（Tauri 2 桌面窗口、单实例聚焦、目录选择、外部链接与托盘）、`ureq`（守护进程回环 HTTP 探活与鉴权）、`winreg`（读取系统与用户注册表 `Path`）、`sha2`（运行时清单 SHA-256 校验与管道哈希）、`serde` + `serde_json`、`thiserror`、`url`；Rust 测试用 `tempfile`。

**测试**
- `vitest`（`vitest.config.ts`）、`jsdom`（`src/shared/test-helpers.ts`）、`@testing-library/react`、`@testing-library/user-event`、`@testing-library/jest-dom`（`src/web/test-setup.ts`）。
- `playwright`：驱动无头 Chromium 渲染真实界面截图与交互验证（`test/ui-polish/capture.ts`、`test/ui-polish/patches.ts`、`scripts/verify-smoke.ts`），仅作为库调用，不用 Playwright Test 运行器（首次需 `pnpm exec playwright install chromium`）。
- `@axe-core/playwright`：界面对比度与无障碍自动检测（`test/ui-polish/checks.ts`）。

**工程工具**
- `typescript`：类型检查（`pnpm typecheck`）。`knip`：死代码扫描（按需运行 `pnpm exec knip`）。`@types/*`（node、react、react-dom、ws、web-push、write-file-atomic）：类型定义。
- `oxc-parser`：AST 语法树解析，供 `src/web/web-guard.test.ts` 静态检查定时器调用。
- `wrangler`：部署 Cloudflare Workers 中继（`wrangler.toml`），并启动本地运行时做集成测试（`src/relay/cloudflare/worker.test.ts`）。`@cloudflare/workers-types` 为中继及其 SQLite Durable Object 提供类型（`src/relay/cloudflare/tsconfig.json`）。

## 项目内技能（pstack）

- 原版 `backnotprop/pstack`（MIT，`@ f104aa8`）的 `skills/` 放在 `.agents/skills/`，许可证见 `.agents/skills/PSTACK-LICENSE`。
- `.agents/skills/verify/` 是本仓自有技能（不属于 pstack），更新 pstack 时保留。
- `<仓库>/.agents/skills/` 为唯一真实目录（`.claude/skills` 为指向 `../.agents/skills` 的软链接），各接入厂商统一从仓库内加载，不写用户主目录。
- 更新方式：拉取新版 `skills/` 覆盖 `.agents/skills/`（保留 `PSTACK-LICENSE`），同步更新上方提交号并提 PR。
