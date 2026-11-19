# Mac 原生桌面应用方案

状态：用户已拍板（第 0 节），按第 5 节分块实现。
关联文档：`docs/account-mesh-design.md`（账号组网与手机飞书接入；早期手机公网入口已退役）、`docs/multi-device-design.md`（浏览器会话、PWA 与 Web Push）、`docs/ui-standard.md`（界面与安全区标准）。

---

## 0. 目标与已拍板取舍

用户要把 `agent-hub` 做成 **Mac 桌面应用（`/Applications/Agent Hub.app`）**，采用 **macOS 原生 Swift + AppKit + `WKWebView` 轻量壳**（本机 `/usr/bin/swiftc` 直接编译打包成 `< 5 MB` 的 `/Applications/Agent Hub.app`，本机 `codesign -s -` 免费签名，零 Electron 200 MB 负担）。手机接入见 `docs/account-mesh-design.md`（不再暴露公网网页入口，统一经全账号唯一的飞书机器人访问）。

### 为什么这样取舍

| 端 / 环节 | 备选方案 | 为什么不选备选 | 为什么选拍板方案 |
|---|---|---|---|
| **Mac 桌面端** | Electron / Tauri | Electron 把整套 Chromium + Node 打包进 `.app`，磁盘占用 `~220 MB`、常驻内存多出几百 MB；Tauri 需额外装 Rust 工具链且仍是一层 WebView 包装 | macOS 自带 `swiftc`、`AppKit` 和系统级 `WebKit.framework`，几百行纯 Swift 即可编译出 **< 2 MB** 的原生 `.app`，自动拉起本机已有的 Node 守护进程并自动读取 `state/ui-token` 免手输登录 |

---

## 1. 第一部分：Mac 原生桌面应用（`apps/macos/` → `/Applications/Agent Hub.app`）

### 1.1 目录结构与构建方式

源码集中放在 `apps/macos/`，采用纯 Swift 编写，只调用 macOS 系统自带框架（`AppKit`、`WebKit`、`Foundation`），**零第三方 Swift Package 依赖、零 Xcode 工程文件负担**：

```
apps/macos/
├── main.swift                  # NSApplication 入口（设置 activationPolicy = .regular 并启动 AppDelegate）
├── AppDelegate.swift           # 应用生命周期、Dock 点击重开、菜单栏快捷键（Cmd+W 隐藏、Cmd+Q 退出、Cmd+R 刷新等）
├── DaemonSupervisor.swift      # 探测本机守护进程、未运行时后台拉起 node src/daemon/main.ts、读取 state/ui-token
├── MainWindowController.swift  # 无边框透明标题栏 NSWindow、WKWebView 容器、自动登录、文件上传/下载/外链委托
└── StatusBarController.swift   # 右上角 NSStatusItem 菜单栏常驻图标、实时显示在跑 Worker / 等你数、快捷菜单
```

#### 构建与安装脚本 `scripts/build-mac-app.sh`（及 `pnpm app:mac`）

脚本在 Mac 本机一步完成前端打包、图标生成、Swift 编译、`.app` 组装与免费签名：

1. **检查并构建前端**：若 `dist/web/index.html` 不存在（或传了 `--build-web`），先跑 `pnpm build`。
2. **生成 `AppIcon.icns`**：复用 `src/web/public/icons/icon-512.png`（由 `scripts/render-icons.ts` 生成的统一品牌图标），调用 macOS 自带 `/usr/bin/sips` 缩放出标准 `AppIcon.iconset`（`icon_16x16.png`、`icon_16x16@2x.png`、`icon_32x32.png`、`icon_32x32@2x.png`、`icon_128x128.png`、`icon_128x128@2x.png`、`icon_256x256.png`、`icon_256x256@2x.png`、`icon_512x512.png`、`icon_512x512@2x.png`），再用 `/usr/bin/iconutil -c icns` 打包到 `Contents/Resources/AppIcon.icns`。
3. **编译原生可执行文件**：
   ```bash
   /usr/bin/swiftc -O \
     -target "$(uname -m)-apple-macos13.0" \
     -framework AppKit -framework WebKit \
     apps/macos/*.swift \
     -o "build/Agent Hub.app/Contents/MacOS/AgentHub"
   ```
4. **写入 `Contents/Info.plist`**：
   - `CFBundleName` / `CFBundleDisplayName`：`Agent Hub`
   - `CFBundleIdentifier`：`com.agenthub.desktop`
   - `CFBundleIconFile`：`AppIcon`
   - `LSMinimumSystemVersion`：`13.0`
   - `NSHighResolutionCapable`：`true`
   - `AgentHubRepoDir`：编译时写死当前仓库根目录绝对路径（如 `/Users/alice/agent-hub`），供 `.app` 移到 `/Applications` 后仍能准确找到 `src/daemon/main.ts`。
5. **本机免费签名与一键安装**：
   - 执行 `codesign --force --deep -s - "build/Agent Hub.app"` 完成本机 ad-hoc 免费签名（避免 macOS Gatekeeper 弹窗拦截和每次重启丢系统权限）；
   - 传入 `--install`（或默认安装）时，用 `ditto "build/Agent Hub.app" "/Applications/Agent Hub.app"` 安装到系统应用程序目录。

### 1.2 守护进程自动拉起与免手输登录

#### 1. 守护进程生命周期（`DaemonSupervisor.swift`）

- **端口与路径解析**：
  - 数据目录：默认 `~/.agent-hub`（支持 `AGENT_HUB_HOME` 环境变量覆盖，与 `src/shared/paths.ts` 的 `resolveHubPaths` 完全一致）；
  - 界面端口：默认 `4317`（支持 `AGENT_HUB_PORT` 或 `UserDefaults` 覆盖，与 `src/shared/limits.ts` 的 `DEFAULT_UI_PORT` 一致）。
- **启动探测**：
  - App 启动时向 `http://127.0.0.1:4317/api/state` 发一次轻量 HTTP 探测（超时 500 ms）；
  - 只要收到任何 HTTP 响应（如 `200` 或未带 Cookie 时的 `401`），说明本机守护进程已经在跑（可能是上次留下、终端 `pnpm start` 或 `launchd` 拉起的），**直接复用，绝不重复起第二个**（守护进程自身也有 `~/.agent-hub/state/lock` 目录锁兜底）。
- **未运行时后台自动拉起**：
  - 若连接被拒绝（`ECONNREFUSED`），`DaemonSupervisor` 自动定位仓库目录（优先读环境变量 `AGENT_HUB_REPO_DIR` / `UserDefaults`，其次读 `Info.plist` 的 `AgentHubRepoDir`）与本机 `node` 可执行文件（按顺序查找 `AGENT_HUB_NODE`、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`~/.local/share/fnm/...`、`~/.nvm/versions/node/*/bin/node`、`/usr/bin/env node`）；
  - 为子进程补齐常用 `PATH`（`/opt/homebrew/bin:/usr/local/bin:~/.local/bin:~/.npm-global/bin:/usr/bin:/bin`），工作目录设为仓库根目录，后台启动：
    ```bash
    node --experimental-strip-types src/daemon/main.ts
    ```
  - 标准输出与标准错误追加写入 `~/.agent-hub/state/logs/desktop-daemon.log`（自动创建目录）；每次拉起前超过 `SupervisorConfig.logMaxBytes`（2 MB）就改名成 `.log.1`（覆盖旧的），一次运行里写进去的也不超过它；
  - 启动子进程后每 150 ms 轮询一次 `http://127.0.0.1:4317/api/auth/status`（最多等 15 秒），一旦返回 HTTP 状态码即通知主窗口加载；若超时或进程提前退出，在原生窗口展示清晰错误提示。
- **意外退出自动重启与崩溃记录**：
  - `DaemonSupervisor` 只对**自己拉起**的后台进程监听 `Process.terminationHandler`（外部终端 `pnpm start` 已在跑的进程只复用、不接管）；
  - 用户主动点“重启后台服务”或“彻底退出 Agent Hub”导致的退出标记为主动停止，不计入崩溃；
  - 后台意外退出时，把退出原因（退出码或信号名、最后几行 `stderr`）追加写进 `~/.agent-hub/state/logs/desktop-daemon.log`，同时在菜单栏记录并展示“上次崩溃时间 + 原因”（自动重启成功后仍保留显示，不掩盖崩溃）；
  - 按指数退避（`1s → 2s → 4s → 8s…` 封顶 `30s`）自动重启；若短时间内连续崩溃达到上限（`60s` 内连续崩溃 `5` 次），停止自动重试并在菜单栏和窗口显示异常停止状态，等待用户排查后手动点“重启后台服务”（手动重启会重置连续崩溃计数）。

#### 2. 本机自动登录（零手抄链接）

核对当前 `src/daemon/ui-server/server.ts` 的 `/auth` 实现（第 748–761 行）：
- 现有 `GET /auth?token=<主钥匙>`：比对 `tokenEquals(expectedToken, token)`，通过后调用 `startSession(req, reply)` 在 `browser_sessions` 表创建一条会话、种下 `Set-Cookie: agent_hub_ui_4317=<sessionToken>; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`，并 `302` 重定向到 `/`；
- 现有 `POST /auth`：目前只消费 `{ link }` 一次性登录码，成功同样调用 `startSession(req, reply)` 并返回 `204`。

**最简单安全的做法与最小改法**：

1. **服务端最小改法（在 `src/daemon/ui-server/server.ts` 的 `POST /auth` 增补 3 行）**：
   - 在 `routes.post(API_PATHS.auth, ...)` 中，当请求来自本机回环入口（`contextOf(req)?.entry.kind === "loopback"`）且请求体带有 `{ token }` 时，直接用 `tokenEquals(expectedToken, token)` 校验主钥匙：校验通过即调用 `startSession(req, reply)` 种下会话 Cookie 并返回 `204`（非 `loopback` 入口绝不接受 `{ token }`）。
   - 为什么比跳 `GET /auth?token=...` 更好：`POST /auth { token }` 不会让主钥匙出现在 URL、不会留在 `WKWebView` 的浏览历史记录（`backForwardList`）里，地址栏/页面路径自始至终保持干净的 `http://127.0.0.1:4317/`。
2. **原生壳自动兑换流程**：
   - `Agent Hub.app` 运行在当前 macOS 登录用户下，直接读取 `~/.agent-hub/state/ui-token`（权限 `0600`）；
   - 当 `WKWebView` 首次打开或因“全部退出”落到未登录界面（`/api/state` 返回 `401`）时，原生壳（或由原生壳注入的桥接脚本）重新读取最新的 `~/.agent-hub/state/ui-token`，向 `http://127.0.0.1:4317/auth` 发送 `POST { token }`（带 `Origin: http://127.0.0.1:4317`），拿到 `Set-Cookie` 后自动刷新进入对话页，全程**零手抄链接、零终端操作**。

### 1.3 原生窗口质感（遵循 `docs/ui-standard.md`，对标 Claude Desktop / Linear）

#### 1. 无边框透明标题栏与红黄绿交通灯配置

`MainWindowController.swift` 配置 `NSWindow`：
- `styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]`
- `titlebarAppearsTransparent = true`
- `titleVisibility = .hidden`
- `isMovableByWindowBackground = false`（防止在消息列表拖拽选文字时误移窗口）
- `backgroundColor = NSColor.white`（与 `styles.css` 的 `--background: #ffffff` 一致，加载瞬间无灰底闪烁）
- 默认窗口尺寸 `1200 × 800`，最小尺寸 `480 × 560`，自动持久化窗口位置与大小（`setFrameAutosaveName("AgentHubMainWindow")`）。

#### 2. 红黄绿按钮避让与窗口拖拽区（展开左栏 vs 收起左栏绝不重叠）

macOS 标准窗口左上角的红黄绿交通灯按钮（关闭、最小化、全屏）占据距离窗口左边缘约 `14px ~ 76px`、距离窗口顶边缘约 `0px ~ 38px` 的区域。

`WKWebView` 在 `WKUserScript(..., injectionTime: .atDocumentStart, forMainFrameOnly: true)` 中注入：
```js
document.documentElement.dataset.macosApp = "true";
```

先在 `docs/ui-standard.md` 第 16 条补入 Mac 桌面应用标题栏安全距离规则，再在 `src/web/styles.css` 集中定义两个 CSS 变量：
- `--macos-traffic-lights-width: 0px`（在 `html[data-macos-app="true"]` 下设为 `72px`）
- `--macos-traffic-lights-height: 0px`（在 `html[data-macos-app="true"]` 下设为 `28px`）

两种布局状态下的精确对齐与避让关系：

```
【状态 A：宽屏展开左栏（> 1100px）】
┌─────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  (28px 顶部拖拽安全高) │               (顶栏空白处可拖拽移动窗口) │
│ [ 🔍 搜索              ] [+] │  [头像] 项目经理名字                  [◫]│
├──────────────────────────────┼──────────────────────────────────────────┤
│  项目经理列表…               │  对话消息流…                             │
└──────────────────────────────┴──────────────────────────────────────────┘

【状态 B：窄屏收起左栏（≤ 1100px，左栏为抽屉）】
┌─────────────────────────────────────────────────────────────────────────┐
│ ● ● ●   [☰] [头像] 项目经理名字                                     [◫]│
│ ◄─72px─► (顶栏左内边距自动加 72px，左上角按钮与红黄绿同一行且绝不重叠)  │
├─────────────────────────────────────────────────────────────────────────┤
│  对话消息流…                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

1. **展开左栏时（窗口宽 `> 1100px`）**：
   - 左栏 `Sidebar`（`w-[300px]`）位于窗口最左侧，顶部 `padding-top` 从 `var(--safe-top)` 变为 `calc(var(--safe-top) + var(--macos-traffic-lights-height))`（即顶部留出 `28px` 高度给红黄绿交通灯）；
   - 左栏的搜索框（`Input type="search"`）与“新建项目经理”按钮（`Plus`）自然下移 `28px`，位于红黄绿按钮正下方，**绝不与红黄绿按钮重叠**；
   - 右侧主对话区 `.chat-main` 左边已经隔着 `300px` 宽的左栏，其顶栏（`min-h-16`）保持原有的 `--header-gutter-start: 1.25rem (20px)` 不变。
2. **收起左栏时（窗口宽 `≤ 1100px`，左栏收为抽屉）**：
   - 主对话区 `.chat-main` 占满窗口全宽，此时窗口左上角就是对话顶栏（`Conversation` 的 `PanelLeft` 抽屉开关、`WorkerConversation` 的返回按钮、`PmProfile` 的返回按钮）；
   - 在 `html[data-macos-app="true"]` 且 `@media (max-width: 1100px)` 下，将 `--header-gutter-start` 设为 `calc(1.25rem + var(--macos-traffic-lights-width))`（即 `20px + 72px = 92px`），同时 `PmProfile` 顶栏与 `deviceWaiting` 顶栏左侧内边距也加上 `var(--macos-traffic-lights-width)`；
   - 这样窄屏下顶栏最左边的图标按钮（`36px` 高，在 `64px` 顶栏内垂直居中）自动向右让出 `72px`，与红黄绿按钮处在相近水平线上且**绝不重叠**；
   - 当用户在窄屏点开左栏抽屉（`drawerOpen = true`）时，抽屉盖在窗口最左侧，抽屉自身同样带有 `calc(var(--safe-top) + var(--macos-traffic-lights-height))` 的顶部内边距，搜索框依然在红黄绿下方不重叠。
3. **顶部拖拽移动窗口**：
   - 在左栏顶部 `28px` 交通灯区域、对话顶栏（`header`）及资料页顶栏上标记 `data-window-drag`；
   - `WKWebView` 注入轻量拖拽桥接：当用户在 `[data-window-drag]` 区域按下鼠标左键，且点击目标不是交互控件（`button, a, input, textarea, select, [role="button"]`）时，通过 `window.webkit.messageHandlers.windowDrag.postMessage({})` 通知原生壳调用 `nsWindow.performDrag(with: currentEvent)`（双击非控件区域调用 `nsWindow.performZoom(nil)`），手感与原生 App 标题栏 100% 一致。

#### 3. 窗口关闭与菜单栏常驻（`NSStatusItem`）

- **点红叉或 `Cmd+W` 只隐藏窗口**：
  - `NSWindowDelegate.windowShouldClose(_:)` 返回 `false`，改为调用 `window.orderOut(nil)` 隐藏窗口；后台守护进程、正在干活的 Worker、SSH 隧道和 WebSocket 全部继续运行；
  - 点 Dock 图标：在 `NSApplicationDelegate.applicationShouldHandleReopen(_:hasVisibleWindows:)` 中，若 `!hasVisibleWindows`，调用 `window.makeKeyAndOrderFront(nil)` 立即唤出主窗口。
- **右上角菜单栏常驻小图标（`StatusBarController.swift`）**：
  - 使用 `NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)` 常驻系统右上角菜单栏；
  - 状态同步：直接复用 `WKWebView` 内已有的状态（网页变化时通过 `window.webkit.messageHandlers.hubStatus.postMessage({ runningWorkers, askingCount, waitingCount })` 通知原生壳，**不在原生壳另开轮询**）；
  - 菜单栏标题：有“等你确定”或正在跑的 Worker 时，图标旁显示简短数字标注（例如有提问或 Worker 在忙时显示数字，全空闲时只显示简洁图标），同时同步更新 Dock 图标右上角红点（`NSApp.dockTile.badgeLabel`：有“等你确定”或“等你”时显示对应数量，看完清零）；
  - 下拉菜单项：
    1. 状态摘要行（禁用点击，如 `2 个 Worker 在跑，1 项等你确定`、`后台服务运行中`，或连续崩溃停止重试时的 `后台服务异常停止（连续崩溃 5 次，已停止重试）`）
    2. 上次崩溃信息行（禁用点击，未发生崩溃时隐藏；发生过崩溃后显示 `上次崩溃 HH:mm:ss，<退出码/信号及错误摘要>`（界面不用“·”拼接），悬停可看最近几行 `stderr`）
    3. 分隔线
    4. **打开主窗口**（快捷键 `⌘O`，把主窗口置前并激活应用）
    5. **重启后台服务**（向本机守护进程发 `SIGTERM` 等优雅关机后，由 `DaemonSupervisor` 重新拉起并刷新页面；主动重启不计入崩溃并重置连续崩溃计数）
    6. 分隔线
    7. **彻底退出 Agent Hub**（快捷键 `⌘Q`：退出桌面应用；若守护进程是本次由桌面应用拉起的，一并优雅发送 `SIGTERM` 关闭，避免留下孤儿进程）。

#### 4. 文件上传、下载与外链

- **聊天框上传文件/图片（`WKUIDelegate`）**：
  - macOS 的 `WKWebView` 默认点击 `<input type="file">` 不会弹窗，必须实现 `webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)`；
  - 在该委托中创建 `NSOpenPanel`，同步 `parameters.allowsMultipleSelection` 与 `parameters.allowsDirectories`，用户选完后将 `panel.urls` 传回 `completionHandler`，使网页聊天框点回形针选文件、选多张图片原生丝滑工作（拖拽文件进窗口由 `WKWebView` 原生支持，直接走现有 `FileDropZone.tsx`）。
- **文件下载（`WKDownloadDelegate`）**：
  - 在 `decidePolicyFor navigationResponse` 中识别 `Content-Disposition: attachment`（如 `/api/uploads/:id/*`、`/api/sent-files/:id/*` 下载动作），转交 `.download`；
  - `download(_:decideDestinationUsing:suggestedFilename:completionHandler:)` 将文件保存到用户 `~/Downloads` 目录（若同名文件已存在，自动加 ` (1)`、` (2)` 避免覆盖），下载完成后通过 `NSWorkspace.shared.activateFileViewerSelecting([fileURL])` 或反弹 Dock 下载栈提示用户。
- **外链用默认浏览器打开**：
  - 在 `decidePolicyFor navigationAction` 与 `createWebViewWith`（拦截 `target="_blank"`）中，凡是目标 URL 的 host 不是本机回环（`127.0.0.1` / `localhost`），一律调用 `NSWorkspace.shared.open(url)` 交由系统默认浏览器（Safari / Chrome）打开，不在 `Agent Hub.app` 窗口内跳去外部网站。

---

## 3. 性能与效率

### 3.1 Mac 桌面端（`/Applications/Agent Hub.app`）

| 指标 | 本方案（Swift + `WKWebView`） | Electron 对比 | 原因与设计保证 |
|---|---|---|---|
| **安装包体积** | **< 2 MB**（目标 `< 5 MB`） | `~220 MB` | 纯 Swift 二进制约 `200 KB` + `AppIcon.icns` 约 `300 KB`；直接调用 macOS 系统内置 `WebKit.framework`，不打包 Chromium 和 Node |
| **常驻内存占用** | 原生壳 **`~15–25 MB`** + 系统 WebKit | `~350–600 MB` | 无独立 Chromium 主进程/GPU 进程副本；守护进程复用本机唯一的 Node 进程 |
| **冷启动出窗口耗时** | **< 300 ms**（守护进程已跑时） | `1.5–3 s` | 原生 `NSWindow` 毫秒级创建；本机回环 `127.0.0.1:4317` 探测与加载静态资源均在毫秒级完成 |
| **后台 CPU 占用** | **0%（无后台轮询）** | 常有后台 timer | 守护进程就绪后停止轮询；菜单栏 `NSStatusItem` 的 Worker 计数与“等你”计数由网页已有 WebSocket 变化流经 `WKScriptMessageHandler` 推送驱动，平时零轮询 |

---

## 4. 统一与可维护性

1. **一套前端三端共用（零第二套 UI）**：
   - Mac 桌面应用（`/Applications/Agent Hub.app`）、响应式窄屏与桌面浏览器 100% 共用 `src/web/` 同一套 React 组件与 `docs/ui-standard.md` 界面标准；
   - 平台外观适配全部收敛在 `src/web/styles.css` 的 CSS 变量中：iPhone 刘海与底部横条走 `--safe-top` / `--safe-bottom`，Mac 窗口左上角红黄绿交通灯走 `html[data-macos-app="true"]` 下的 `--macos-traffic-lights-height`（`28px`）与 `--macos-traffic-lights-width`（`72px`），业务组件不写平台分支判断。
2. **所有厂商（`claude`、`agy`、`codex`）与连接器自动生效**：
   - Mac 原生桌面壳工作在 HTTP / WebSocket 界面服务层（`src/daemon/ui-server/`），完全位于账本（`ledger`）和驱动层（`driver` / `vendors`）之上；
   - 任何厂商的命令列表（`/`）、文件搜索（`@`）、模型目录、额度查询、MCP 连接器、Worktree 沙箱或后台写交接逻辑，在 Mac `.app` 与 iPhone 端天然 100% 一致生效，以后新增厂商或工具无需改动桌面壳与公网入口。

---

## 5. 实现拆分（验证单元）

| 块 | 范围 | 先写的测试（TDD） | 验收标准 |
|---|---|---|---|
| **块 M：Mac 原生桌面应用 `apps/macos/` 与标题栏安全区适配** | 1. `docs/ui-standard.md` 第 16 条补入 Mac 桌面应用红黄绿交通灯避让与顶部拖拽规则。<br>2. `src/web/styles.css`、`Sidebar.tsx`、`Conversation.tsx`、`WorkerConversation.tsx`、`PmProfile.tsx`、`App.tsx`：适配 `html[data-macos-app="true"]` 下的 `--macos-traffic-lights-height: 28px`（展开左栏时左栏顶部避让）与窄屏 `--macos-traffic-lights-width: 72px`（收起左栏时顶栏左侧按钮避让），以及顶部窗口拖拽桥接与菜单栏状态上报。<br>3. 编写 `apps/macos/*.swift`（`DaemonSupervisor` 自动探测/拉起守护进程、读取 `state/ui-token` 调 `POST /auth { token }` 免手输登录、透明标题栏 `WKWebView`、`NSStatusItem` 菜单栏常驻与 Dock 角标、文件上传 `NSOpenPanel` / 下载 `~/Downloads` / 外链默认浏览器打开）。<br>4. 编写 `scripts/build-mac-app.sh` 与 `package.json` 的 `app:mac` 脚本。 | 1. `src/web/ui/ui-standard.test.tsx` 增加 `data-macos-app="true"` 下安全区变量与顶栏避让校验；<br>2. 本机运行 `scripts/build-mac-app.sh --install` 编译打包 `/Applications/Agent Hub.app`。 | 1. `/Applications/Agent Hub.app` 体积 `< 5 MB`，`codesign -dv` 验证签名有效；<br>2. 守护进程未跑时双击打开 App 自动后台拉起并免手输登录直接进对话页；<br>3. 宽屏展开左栏与窄屏收起左栏时红黄绿按钮与搜索框/顶栏按钮零重叠；<br>4. 点红叉隐藏窗口、菜单栏图标常驻、点 Dock 重新显示窗口。 |
