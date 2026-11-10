# Mac 原生桌面应用与 iPhone 免费公网入口方案

状态：用户已拍板（第 0 节），按第 5 节分块实现。
关联文档：`docs/multi-device-design.md`（联机、浏览器会话、PWA 与 Web Push）、`docs/hub-tunnel-design.md`（东京中心 SSH 隧道、设备入口与公网入口安全要求）、`docs/ui-standard.md`（界面与安全区标准）。

---

## 0. 目标与已拍板取舍

用户要把 `agent-hub` 做成 **Mac 桌面应用（`/Applications/Agent Hub.app`）** 和 **苹果手机 App（iPhone 端）**，并已拍板全部采用**免费方案 + 推荐路线**：

1. **Mac 桌面应用**：采用 **macOS 原生 Swift + AppKit + `WKWebView` 轻量壳**（本机 `/usr/bin/swiftc` 直接编译打包成 `< 5 MB` 的 `/Applications/Agent Hub.app`，本机 `codesign -s -` 免费签名，零 Electron 200 MB 负担）。
2. **iPhone 手机 App**：采用已实现的 **iOS 主屏全屏 Web App（PWA，添加到主屏幕）+ iOS 原生 Web Push 锁屏推送**（免费、永不过期，避开免费 Apple ID 签名 `.ipa` 每 7 天过期和无 APNs 推送的限制），两端 100% 共用现有响应式前端。
3. **iPhone 连回东京与 Mac 的公网 HTTPS 入口**：采用 **东京服务器免费的 Tailscale Funnel**（`https://<东京机器>.<tailnet>.ts.net`），不用买域名、不用开 Lightsail 防火墙端口、不用装 Caddy，且**手机和 Mac 都不需要装或开 Tailscale VPN**（东京再通过已合入的 SSH 隧道 `agenthub-tunnel` 连回 Mac）。

### 为什么这样取舍

| 端 / 环节 | 备选方案 | 为什么不选备选 | 为什么选拍板方案 |
|---|---|---|---|
| **Mac 桌面端** | Electron / Tauri | Electron 把整套 Chromium + Node 打包进 `.app`，磁盘占用 `~220 MB`、常驻内存多出几百 MB；Tauri 需额外装 Rust 工具链且仍是一层 WebView 包装 | macOS 自带 `swiftc`、`AppKit` 和系统级 `WebKit.framework`，几百行纯 Swift 即可编译出 **< 2 MB** 的原生 `.app`，自动拉起本机已有的 Node 守护进程并自动读取 `state/ui-token` 免手输登录 |
| **iPhone 手机端** | 1. 免费 Apple ID 侧载原生 `.ipa`<br>2. React Native / SwiftUI 重写原生 UI | 1. 免费 Apple ID（Personal Team）签名的 `.ipa` **每 7 天强制过期变砖**，必须连 Mac 重签；且免费账号**苹果完全不给 APNs 远程推送权限**，手机锁屏收不到任何提醒。<br>2. 重写原生 UI 等于维护两套前端，每次加功能都要双端改动 | iOS 16.4+ 官方支持主屏 Web App（`display: standalone`）与标准 **Web Push（APNs 通道）**，**完全免费、永不过期、有原生锁屏通知**，且 100% 复用 `src/web/` 现有界面 |
| **手机公网 HTTPS 入口** | 1. 手机装 Tailscale VPN<br>2. 买域名 + Lightsail 开 443 + Caddy<br>3. Let's Encrypt IP 证书 / `sslip.io` | 1. iPhone 同时只能开一个 VPN，开公司 VPN 时 Tailscale 会被顶掉，且耗电。<br>2. 买域名要花钱、要改防火墙和装 Caddy（留作以后可选升级）。<br>3. IP 证书不支持将来扩展 Passkey，换 IP 主屏 App 与推送全作废；`sslip.io` DNS 归第三方不安全 | **东京 Tailscale Funnel** 完全免费，自带自动续期的 Let's Encrypt HTTPS 证书，给固定 `<tokyo>.<tailnet>.ts.net` 域名（供 iOS 主屏 App 与 Web Push 绑定来源），TLS 在东京本机解开，**手机和 Mac 都不装 VPN** |

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
   - `AgentHubRepoDir`：编译时写死当前仓库根目录绝对路径（如 `/Users/yuxin.zhangnewsbreak.com/agent-hub`），供 `.app` 移到 `/Applications` 后仍能准确找到 `src/daemon/main.ts`。
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

## 2. 第二部分：iPhone 主屏全屏 App 与东京免费 Tailscale Funnel 公网入口

### 2.1 整体链路（手机与 Mac 均不装 VPN）

```
iPhone 主屏 Web App (5G / 任意 Wi-Fi，不装 Tailscale)
  │
  │ https://<tokyo>.<tailnet>.ts.net (TLS 1.3 直连东京，Funnel 边缘只转密文)
  ▼
东京服务器 Tailscale Funnel (tailscaled 守护进程解开 TLS)
  │
  │ unix:/home/ubuntu/.agent-hub/run/public.sock (viaPublic 公网入口)
  ▼
东京 agent-hub 守护进程 (入口 + Web Push 提醒设备)
  ├─ 东京本机项目经理与 Worker：直接处理 /api/* 与 /api/ws
  └─ Mac 项目经理与 Worker：/d/<mac-id>/api/* 与 /d/<mac-id>/api/ws
       │
       │ 127.0.0.1:4401 ═══ SSH 隧道 (agenthub-tunnel, 已合入) ═══▶ Mac run/peer.sock
       ▼
     Mac agent-hub 守护进程 (peerEntry 设备入口)
```

- **手机不装 Tailscale**：iPhone 直接用蜂窝网络（5G/4G）或任意 Wi-Fi 访问 `https://<tokyo>.<tailnet>.ts.net`，不会占用 iPhone 唯一的 VPN 槽位，不与公司 VPN 冲突，也不额外耗电。
- **Mac 不装 Tailscale**：Mac 通过已实现的系统自带 OpenSSH 隧道（`agenthub-tunnel`）主动连入东京；Mac 在家、在办公室或连手机热点都能自动重连，Mac 本地用 `/Applications/Agent Hub.app` 直连 `127.0.0.1:4317`。
- **端到端加密**：Tailscale Funnel 的中继节点只转发原始 TCP/TLS 字节流，TLS 私钥（Let's Encrypt 自动签发）保存在东京服务器的 `tailscaled` 本地，Tailscale 官方也看不到任何聊天和代码明文。

### 2.2 为什么必须走单独的 `public.sock`（`viaPublic`），不能直接复用现有的 `serve.sock`

在现有代码 `src/daemon/ui-server/server.ts`（第 570–588 行）中，`serveSocket`（`run/ui.sock` → `entry.kind = "tailnet"`）专门为 **Tailscale Serve（仅 tailnet 内部可见）** 设计：
1. `tailscale serve` 只允许同一 tailnet 内的已登录设备访问，并由 `tailscaled` 注入 `Tailscale-User-Login` 请求头；`server.ts` 强制检查该头必须等于 `self.owner`，否则返回 `403 forbidden_identity`。
2. 而 **Tailscale Funnel 面向全公网开放**：任何知道 `https://<tokyo>.<tailnet>.ts.net` 域名的人（包括公网证书透明度日志 CT log 爬虫和扫描器）都能在公网连上它，且**公网请求不经过 Tailscale 客户端认证，绝不会带 `Tailscale-User-Login` 请求头**。
3. 如果直接把 Funnel 指到 `serve.sock`，所有手机公网请求都会因没有 `Tailscale-User-Login` 头被 `403` 拦死；反过来如果把 `serve.sock` 的身份头检查关掉，又会破坏 tailnet 内部入口的“人”这一层防线，且让设备配对接口 `/api/peer/*` 暴露到公网。

因此，必须严格按 `docs/hub-tunnel-design.md` 第 9.3 节，在守护进程中实现独立的**公网入口 `run/public.sock`（`Listener = "publicSocket"`，`Entry = { kind: "public"; hostname: string }`）**及以下 4 道公网安全防线：

#### 防线 1：Host / Origin、路径白名单与 Cookie 加固

在 `src/daemon/ui-server/server.ts` 的 `entryRules` 中新增 `public` 规则：

| 检查项 | `public` 入口规则（`run/public.sock`） | 说明 |
|---|---|---|
| `listeners` | `["publicSocket"]` | 只认从 `run/public.sock` 进来的流量；公网开关关闭时根本不监听该 socket |
| `host` | 必须严格等于配置的 `publicHostname`（或带 `:443`） | 其它任何 Host 一律 `403 forbidden_host` |
| `origin` | `origin.toLowerCase() === "https://" + entry.hostname` | 所有改状态的请求（POST/PUT/PATCH/DELETE）与 WebSocket 握手必须带同源 HTTPS Origin |
| `identities` | `["cookie"]`（**不含 `deviceToken` 和 `invite`**） | 公网入口**一律拒绝任何 `Authorization` 头与 `/api/peer/*`（直接回 `403 forbidden_peer`）**，设备之间永远不走公网 |
| `sameMachine` | `false` | 不出“在 Finder 中显示 / 用默认程序打开”和选文件夹按钮，`requireLocal` 严拒 |
| `browserPaths` | `true`（仅开放网页静态文件、`/auth`、`/api/*` 浏览器接口、`/d/*`） | `/api/peer/*` 在 `onRequest` 钩子第一道即回 `403` |
| `secureCookie` | `true` | 种下的会话 Cookie 强制带 `Secure; HttpOnly; SameSite=Strict; Path=/` |

#### 防线 2：新浏览器扫码后须已登录设备点“允许”（待批准会话 `pending_approval`）

公网暴露面下，万一一次性登录链接 `/auth#link=<码>` 被截屏或剪贴板泄露，单靠链接本身不够安全。加上**已登录设备二次批准**：

1. **数据库表扩展（迁移 `0017_public_entry.sql`）**：
   新建附属表 `browser_session_public`（采用 `CREATE TABLE IF NOT EXISTS` 保证迁移重跑幂等）：
   ```sql
   CREATE TABLE IF NOT EXISTS browser_session_public (
     session_id TEXT PRIMARY KEY REFERENCES browser_sessions (id) ON DELETE CASCADE,
     status     TEXT NOT NULL,
     client_ip  TEXT NOT NULL
   ) STRICT;
   ```
   - 凡在 `browser_session_public` 中有记录的会话即为 `viaPublic = true`，其 `status` 为 `'pending_approval' | 'active'`；不在该表中的会话即普通本机/tailnet 会话（`viaPublic = false, status = 'active'`）。
2. **兑换与拦截流程**：
   - 本机 `loopback` 或 `tailnet` 入口兑换登录链接：直接创建 `status = 'active'` 会话（保持现有体验不变）；
   - **公网 `public` 入口**调用 `POST /auth { link }` 兑换一次性链接（注：公网入口**禁止** `GET /auth?token=` 主钥匙直登，只允许一次性 `#link=`）：
     - 创建一条 `status = 'pending_approval'`、`via_public = 1` 的会话并种下 Cookie，返回 `202 { status: "pending_approval" }`；
     - `sessions.authenticate(token)` 查库时返回 `{ id, status, viaPublic }`；
     - 在 `server.ts` 的 `onRequest` 认证钩子中：若会话 `status === "pending_approval"`，除 `GET /api/auth/status`（返回 `{ status: "pending_approval" }` 供手机端等待页轮询）和退出自身会话外，**访问 `/api/state`、`/api/ws`、`/d/*` 等一切接口均返回 `403 { code: "session_pending_approval", error: "等待已登录设备批准登录" }`**，拿不到任何项目或消息数据。
   - **手机端等待界面**：`/auth` 落地页收到 `202`（或首页收到 `session_pending_approval`）时显示：“已扫码，请在已登录的电脑上点「允许」完成登录…”，每 2 秒查一次 `GET /api/auth/status`，一旦变成 `active` 立即进入首页 `/`；若被拒绝或 10 分钟未批准（自动清除），提示“登录未获批准或已超时，请重新扫码”。
   - **已登录电脑端弹出批准提示**：
     - 当有新的 `pending_approval` 会话产生时，守护进程向所有已登录（`active`）的 WebSocket 发送 `{ type: "resync" }`（并在 `/api/sessions` 或 `/api/state` 中包含待批准列表）；
     - 已登录的电脑端（Mac `.app` 或浏览器）在“设置 → 已登录的浏览器”顶部以及主界面顶部提示条醒目展示：
       > **允许 iPhone Safari（经公网 · 刚刚）登录？**  `[拒绝]` `[允许]`
     - 点“允许”调用 `POST /api/sessions/:id/approve`（将该会话 `status` 改为 `'active'`），手机端 2 秒内自动进入对话主界面；点“拒绝”调用 `DELETE /api/sessions/:id` 直接删除。

#### 防线 3：公网 `/auth` 失败限流

防止公网扫描器对 `/auth` 进行高频猜测或资源消耗，新建 `src/daemon/ui-server/public-rate-limit.ts`，只对 `entry.kind === "public"` 的 `/auth` 请求生效：

- **双层限流阈值**（常数定义在 `src/shared/limits.ts`）：
  - **单来源桶**：每分钟最多失败 **5 次**（`PUBLIC_AUTH_IP_MAX_FAILURES = 5`，窗口 `60_000 ms`）；
  - **全局公网桶**：每小时最多失败 **30 次**（`PUBLIC_AUTH_GLOBAL_MAX_FAILURES = 30`，窗口 `3_600_000 ms`）；
  - **锁定时长**：任一阈值触发后，公网入口的 `/auth` 登录锁定 **15 分钟**（`PUBLIC_AUTH_LOCKOUT_MS = 15 * 60_000`），并向守护进程日志打印一条警告。
- **锁定期间行为**：
  - 公网入口上的 `POST /auth`（及带参数的 `GET /auth`）直接返回 `429 { code: "busy", error: "公网登录尝试过多，已锁定 15 分钟后再试" }`，不查 `loginLinks`；
  - **不影响**已经登录（`active`）的手机正常收发消息，也**不影响**本机 `loopback` 和 `tailnet` 入口登录。

#### 防线 4：公网会话 30 天不活动过期 + 一键开关与 Funnel 开启说明

1. **公网会话 30 天不活动过期**：
   - 在 `src/shared/limits.ts` 定义 `PUBLIC_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000`（30 天），待批准会话超时 `PENDING_SESSION_TTL_MS = 10 * 60 * 1000`（10 分钟）；
   - `sessions.authenticate` 校验时：
     - 若 `status === 'pending_approval'` 且 `now - created_at > PENDING_SESSION_TTL_MS`：当场删除并返回 `null`；
     - 若 `via_public === 1` 且 `now - last_seen_at > PUBLIC_SESSION_MAX_AGE_MS`：当场删除并返回 `null`（本机与 tailnet 会话仍为 `SESSION_MAX_AGE_MS = 365 天`）；
   - `GET /api/sessions` 返回的 `BrowserSessionInfo` 增加 `status: "active" | "pending_approval"` 与 `viaPublic: boolean`，“设置 → 已登录的浏览器”中对 `viaPublic: true` 的行显示 `经公网 · 3 分钟前`。
2. **设置页“公网入口”一键开关与东京 Funnel 命令**：
   - 配置文件 `~/.agent-hub/state/public-entry.json`（权限 `0600`）：`{ enabled: boolean, hostname: string | null }`。开启时若用户未填自定义域名，默认取 `tailnet.current()?.dnsName`（即 `<tokyo>.<tailnet>.ts.net`）；
   - 接口：`PUT /api/devices/public-entry`（请求体 `{ enabled: boolean, hostname?: string }`），状态随 `/api/state` 的 `publicEntry: { enabled: boolean, hostname: string | null, funnelCommand: string }` 下发；
   - **打开开关时**：守护进程立即调用 `listenSide(app, "publicSocket", { socket: paths.publicSock })` 监听 `~/.agent-hub/run/public.sock`（权限 `0600`，root 跑的 `tailscaled` 可直接连接），界面下方给出可一键复制的东京终端命令：
     ```bash
     sudo tailscale funnel --bg unix:/home/ubuntu/.agent-hub/run/public.sock
     ```
   - **关闭开关时**：
     1. 守护进程立即关闭 `publicSocket` 监听并删除 `run/public.sock`（外部 Funnel 请求立刻收到 502，无法再触达守护进程）；
     2. 调用 `sessions.revokePublic()` **删除所有 `via_public = 1` 的会话（含待批准和已批准），并当场调用 `closeSockets(id)` 断开这些公网会话正在连接的全部 WebSocket**；
     3. 同时在 `src/tunnel/main.ts`（或管理 socket `run/admin.sock`）提供 `public off` 命令，方便用户在 SSH 终端里一键关闭公网入口。
3. **二维码自动切公网地址**：
   - 在 `server.ts` 的 `POST /api/login-links`（第 788–796 行）中：当本机开启了公网入口且有 `publicHostname` 时，生成的二维码链接优先使用 `https://${publicHostname}/auth#link=${code}`。

### 2.3 iPhone 端安装与推送完整体验

首次配置只需 1 分钟，之后永久免折腾：

1. **东京开一次 Funnel**：在东京服务器上跑一次守护进程提示的命令：
   ```bash
   sudo tailscale funnel --bg unix:/home/ubuntu/.agent-hub/run/public.sock
   ```
   （若 Tailscale 后台首次使用 Funnel，点一下命令输出的授权链接开启 Funnel ACL 即可。）
2. **电脑端生成二维码**：在电脑（或已连上东京的页面）打开“设置 → 设备”确认“公网入口”已打开，到“设置 → 登录 → 在手机上登录”点“显示二维码”。
3. **iPhone 扫码与电脑点“允许”**：
   - iPhone（无需安装 Tailscale，直接用 5G 或普通 Wi-Fi）用系统相机扫码，自动在 Safari 打开 `https://<tokyo>.<tailnet>.ts.net/auth#link=...`；
   - 手机屏幕显示“等待已登录设备批准…”；
   - 电脑端弹出“允许 iPhone Safari（经公网）登录？”，点**“允许”**，手机立即进入对话列表，同时看到东京和 Mac 两台设备上的所有项目经理。
4. **添加到主屏幕（变成全屏 App）**：
   - 在 iPhone Safari 底部点“分享”按钮 → 选**“添加到主屏幕”** → 点“添加”；
   - 桌面生成 `Agent Hub` 图标（复用已有的 `apple-touch-icon.png` 与 `manifest.webmanifest` 的 `display: standalone`），从主屏幕点开即全屏运行，无 Safari 地址栏与底部工具栏，完美适配 iPhone 灵动岛/刘海（`--safe-top`）与底部横条（`--safe-bottom`）。
5. **开启锁屏推送**：
   - 在主屏打开的 `Agent Hub` 中点左下角“设置” → 打开**“通知”**开关，弹出 iOS 系统原生通知授权框点“允许”；
   - 推送订阅保存在东京服务器的 `state/push-subscriptions.json`；东京作为常开的提醒设备，一方面监听东京本机账本，另一方面经 `agenthub-tunnel` SSH 隧道常开一条到 Mac 的 `/api/ws` 变化流（`PushService.watch`）；
   - 无论东京还是 Mac 上的项目经理调用 `hub ask`（“等你确定”）或回复完停稳 3 秒（“等你”），iPhone 锁屏都会立刻收到端到端加密的 APNs Web Push 通知（如 `Mac · 项目经理：等你确定`），点通知直接跳进对应对话。

---

## 3. 性能与效率

### 3.1 Mac 桌面端（`/Applications/Agent Hub.app`）

| 指标 | 本方案（Swift + `WKWebView`） | Electron 对比 | 原因与设计保证 |
|---|---|---|---|
| **安装包体积** | **< 2 MB**（目标 `< 5 MB`） | `~220 MB` | 纯 Swift 二进制约 `200 KB` + `AppIcon.icns` 约 `300 KB`；直接调用 macOS 系统内置 `WebKit.framework`，不打包 Chromium 和 Node |
| **常驻内存占用** | 原生壳 **`~15–25 MB`** + 系统 WebKit | `~350–600 MB` | 无独立 Chromium 主进程/GPU 进程副本；守护进程复用本机唯一的 Node 进程 |
| **冷启动出窗口耗时** | **< 300 ms**（守护进程已跑时） | `1.5–3 s` | 原生 `NSWindow` 毫秒级创建；本机回环 `127.0.0.1:4317` 探测与加载静态资源均在毫秒级完成 |
| **后台 CPU 占用** | **0%（无后台轮询）** | 常有后台 timer | 守护进程就绪后停止轮询；菜单栏 `NSStatusItem` 的 Worker 计数与“等你”计数由网页已有 WebSocket 变化流经 `WKScriptMessageHandler` 推送驱动，平时零轮询 |

### 3.2 公网入口与手机端

- **限流器固定内存上限（防公网扫描撑爆内存）**：
  - 公网 `/auth` 限流器的按 IP 计数桶采用 `Map<string, { count: number; resetAt: number }>`，严格限制最多保存 **`MAX_PUBLIC_AUTH_IP_BUCKETS = 1000` 个 IP 桶**；新增桶时若超过上限，先清理已过期桶，仍满则按插入顺序淘汰最旧的桶（`O(1)`），内存占用恒定在几十 KB 以内。
- **待批准会话清理与防挤占**：
  - `pending_approval` 会话 10 分钟不批准即自动过期删除；且在 `browser_sessions` 满 `MAX_BROWSER_SESSIONS = 100` 淘汰旧会话时，**优先淘汰 `pending_approval` 会话**，保证公网恶意扫码即使拿到链接也绝不可能把用户已登录的正式会话（`active`）挤下线。
- **东京 2 GB 内存零额外负担**：
  - Tailscale Funnel 直接由东京已常驻的 `tailscaled` 转发到 `unix:run/public.sock`，无需額外安装或运行 Caddy（省下 `30–50 MB` 常驻内存），守护进程内仅多听一个 Unix domain socket，额外内存开销 `< 100 KB`。

---

## 4. 统一与可维护性

1. **一套前端三端共用（零第二套 UI）**：
   - Mac 桌面应用（`/Applications/Agent Hub.app`）、iPhone 主屏全屏 App、桌面浏览器 100% 共用 `src/web/` 同一套 React 组件与 `docs/ui-standard.md` 界面标准；
   - 平台外观适配全部收敛在 `src/web/styles.css` 的 CSS 变量中：iPhone 刘海与底部横条走 `--safe-top` / `--safe-bottom`，Mac 窗口左上角红黄绿交通灯走 `html[data-macos-app="true"]` 下的 `--macos-traffic-lights-height`（`28px`）与 `--macos-traffic-lights-width`（`72px`），业务组件不写平台分支判断。
2. **公网入口与以后买域名 + Caddy 100% 兼容**：
   - 守护进程只认“从 `run/public.sock`（`viaPublic`）进来的请求”以及配置的 `publicHostname`；
   - 今天免费期用 Tailscale Funnel，只需把 `publicHostname` 设为 `<tokyo>.<tailnet>.ts.net` 并跑 `sudo tailscale funnel --bg unix:.../run/public.sock`；
   - 以后如果用户买了自己的域名（如 `hub.example.com`）并装了 Caddy，只需把 Caddyfile 配成 `reverse_proxy unix//.../run/public.sock`、设置里把公网域名改成 `hub.example.com`，**守护进程代码、认证限流逻辑和前端代码一行不用改**。
3. **所有厂商（`claude`、`agy`、`codex`）与连接器自动生效**：
   - Mac 原生桌面壳与 `public.sock` 公网入口都工作在 HTTP / WebSocket 界面服务层（`src/daemon/ui-server/`），完全位于账本（`ledger`）和驱动层（`driver` / `vendors`）之上；
   - 任何厂商的命令列表（`/`）、文件搜索（`@`）、模型目录、额度查询、MCP 连接器、Worktree 沙箱或后台写交接逻辑，在 Mac `.app` 与 iPhone 端天然 100% 一致生效，以后新增厂商或工具无需改动桌面壳与公网入口。

---

## 5. 实现拆分（验证单元）

按互不冲突、可独立验证、遵循 TDD 的原则拆分为 3 个实现块（PR）：

| 块 | 范围 | 先写的测试（TDD） | 验收标准 |
|---|---|---|---|
| **块 G1：公网入口 `public.sock` 与登录防线后端** | 1. `src/shared/paths.ts` 新增 `publicSock`（`run/public.sock`）与 `publicEntryFile`（`state/public-entry.json`）；`src/shared/limits.ts` 新增公网限流与 30 天过期常数；`src/shared/api.ts` 新增公网入口状态、会话批准接口与类型。<br>2. 数据库迁移 `0017_public_entry.sql`（`browser_sessions` 加 `status`、`via_public`、`client_ip`）与 `ui-server/sessions.ts` 改造（支持 `pending_approval`、批准、30 天过期、10 分钟待批准超时、优先淘汰待批准、一键清公网会话）。<br>3. `ui-server/public-rate-limit.ts`（每 IP 5 次/分钟、全局 30 次/小时、锁 15 分钟、固定桶上限）。<br>4. `ui-server/server.ts`：新增 `publicSocket` 监听与 `entryRules.public`（Host/Origin/Secure Cookie、拒设备令牌与 `/api/peer/*`）；公网 `POST /auth { link }` 创建待批准会话；`GET /api/auth/status` 与 `POST /api/sessions/:id/approve`；`PUT /api/devices/public-entry` 动态启停 `public.sock` 并在关闭时断开全部公网会话；`POST /api/login-links` 在公网开启时优先用公网域名；`loopback` 入口下 `POST /auth` 支持 `{ token }` 直接兑换 Cookie。 | `src/daemon/ui-server/public-entry.test.ts`：<br>1. `public.sock` 上 Host/Origin 不匹配 → 403；Cookie 带 `Secure`；<br>2. 带 `Authorization` 设备令牌或访问 `/api/peer/*` → 403；<br>3. 公网 `GET /auth?token=` → 401/403（禁止主钥匙在公网直登）；<br>4. 公网 `POST /auth { link }` 生成 `pending_approval` 会话，未批准前读 `/api/state` → 403 `session_pending_approval`；已登录会话调 `approve` 后读 `/api/state` → 200；<br>5. 单 IP 连续 5 次失败或全局 30 次失败 → 锁定 15 分钟回 429，且不影响本机 `loopback` 登录；<br>6. 公网会话 30 天不活动过期，本机会话 30 天仍有效；<br>7. 关闭公网开关当场停止 `public.sock`、撤销所有公网会话并关闭其 WebSocket；<br>8. `loopback` 下 `POST /auth { token }` 成功种 Cookie。 | `pnpm typecheck` 与 `public-entry.test.ts`、`server.test.ts`、`sessions.test.ts` 全绿 |
| **块 G2：网页端公网入口开关、登录批准提示与 Funnel 说明** | 1. `src/web/components/DeviceSettings.tsx` 新增“公网入口”分组/开关行，开启时展示公网域名与东京一键开启命令 `sudo tailscale funnel --bg unix:...`（支持一键复制）。<br>2. `src/web/components/BrowserSessions.tsx` 与顶部提醒：展示 `pending_approval` 待批准浏览器的“允许 / 拒绝”按钮；已登录浏览器列表对 `viaPublic` 标出“经公网”。<br>3. `src/daemon/ui-server/login-page.ts` 与前端登录等待态：公网扫码返回 `pending_approval` 时展示“等待已登录设备批准…”并自动轮询 `GET /api/auth/status`，批准后自动跳入首页。<br>4. 更新 `docs/linux.md` 补充东京开启 Tailscale Funnel 与 iPhone 添加到主屏幕步骤。 | `src/web/public-entry.test.tsx`（或扩展 `devices.test.tsx` / `sessions` 测试）：<br>1. 设置页切换公网入口开关、显示 Funnel 命令；<br>2. 出现 `pending_approval` 会话时显示“允许 / 拒绝”按钮，点允许调 `POST /api/sessions/:id/approve`；<br>3. 列表正确渲染“经公网”标注。 | `pnpm typecheck` 与前端单测全绿，符合 `docs/ui-standard.md` |
| **块 M：Mac 原生桌面应用 `apps/macos/` 与标题栏安全区适配** | 1. `docs/ui-standard.md` 第 16 条补入 Mac 桌面应用红黄绿交通灯避让与顶部拖拽规则。<br>2. `src/web/styles.css`、`Sidebar.tsx`、`Conversation.tsx`、`WorkerConversation.tsx`、`PmProfile.tsx`、`App.tsx`：适配 `html[data-macos-app="true"]` 下的 `--macos-traffic-lights-height: 28px`（展开左栏时左栏顶部避让）与窄屏 `--macos-traffic-lights-width: 72px`（收起左栏时顶栏左侧按钮避让），以及顶部窗口拖拽桥接与菜单栏状态上报。<br>3. 编写 `apps/macos/*.swift`（`DaemonSupervisor` 自动探测/拉起守护进程、读取 `state/ui-token` 调 `POST /auth { token }` 免手输登录、透明标题栏 `WKWebView`、`NSStatusItem` 菜单栏常驻与 Dock 角标、文件上传 `NSOpenPanel` / 下载 `~/Downloads` / 外链默认浏览器打开）。<br>4. 编写 `scripts/build-mac-app.sh` 与 `package.json` 的 `app:mac` 脚本。 | 1. `src/web/ui/ui-standard.test.tsx` 增加 `data-macos-app="true"` 下安全区变量与顶栏避让校验；<br>2. 本机运行 `scripts/build-mac-app.sh --install` 编译打包 `/Applications/Agent Hub.app`。 | 1. `/Applications/Agent Hub.app` 体积 `< 5 MB`，`codesign -dv` 验证签名有效；<br>2. 守护进程未跑时双击打开 App 自动后台拉起并免手输登录直接进对话页；<br>3. 宽屏展开左栏与窄屏收起左栏时红黄绿按钮与搜索框/顶栏按钮零重叠；<br>4. 点红叉隐藏窗口、菜单栏图标常驻、点 Dock 重新显示窗口。 |
