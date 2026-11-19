# 联机方案：一个网页管所有设备（手机可用）

> 设备之间的连接、认证与手机接入已改为账号组网与全账号一个飞书机器人，见 `docs/account-mesh-design.md`。本文只保留仍在使用的浏览器会话（第 3.4 节）、网页 `/d/<设备>` 多设备模型（第 4 节）、PWA 与 Web Push（第 6 节）和性能约束（第 7 节）。

状态：用户已拍板（第 9 节），按第 11 节分批实现。
前提：PR #112（Linux 兼容，`shared/server-info.ts` 报平台能力）已合。

## 0. 目标和不做的

- 目标：这台 Mac、东京 Lightsail（Linux），以后更多设备，各跑一个 agent-hub 守护进程；一个网页看到、操作全部设备；手机上能看、能聊、能收提醒。设备都归用户一个账号。
- 不做：设备之间同步、合并数据；跨设备派活（Mac 上的项目经理派 Worker 到东京）；多人共用。这些以后单独立项。

## 1. 现状（读代码得到的约束）

| 项 | 现在怎么做 | 出处 |
|---|---|---|
| 界面服务 | Fastify，HTTP + WebSocket，**只听 127.0.0.1**，默认端口 4317 | `daemon/ui-server/server.ts` 的 `startUiServer`；`shared/limits.ts` 的 `DEFAULT_UI_PORT` |
| 网页认证 | 每台一个 `state/ui-token`（0600）；`/auth?token=` 设 cookie（HttpOnly、SameSite=Strict，一年），`/api/*` 和 WS 一律查 cookie | `ui-server/token.ts`、`server.ts` 的 `isAuthenticated` |
| 防重绑定 / 跨站 | Host 必须是 `127.0.0.1|localhost:<端口>`；改状态的请求和 WS 握手要同源 Origin | `server.ts` 的 `HOST_HEADER`、`ORIGIN_HEADER` |
| 网页取数 | 先拉 `/api/state` 快照，再开 `/api/ws?since=<seq>` 收变化；断线 1→10 秒退避重连，补不齐推 `resync` | `web/useHub.ts`、`web/connection.ts` |
| 网址 | `#/c/<对话>`、`#/w/<Worker 对话>`、`#/pm/<项目经理>`，编号是本机自增整数 | `web/route.ts` |
| 提醒 | 全在浏览器里算（“等你”停稳 3 秒、hub ask 立即），用浏览器 Notification；网页关了就没有 | `web/notify.ts`、`web/selectors.ts` |
| agent 调 hub | Unix socket `run/hub.sock`，会话令牌 | `daemon/agent-api/server.ts` |
| 平台差异 | PR #112：`/api/state` 带 `server: { platform, folderPicker, fileActions }`，非 macOS 隐藏“选择…”和“在 Finder 中显示” | `shared/server-info.ts`（PR #112） |

直接影响方案的两点：
1. Host/Origin 只认 `127.0.0.1` 和 `localhost`；设备之间的组网入口走双向认证的 TLS 1.3（`docs/account-mesh-design.md`）。
2. 各台的编号（对话、项目经理、seq）都是本机自增，**多设备时会撞号**：网页里所有键都要带设备。

## 3. 浏览器登录

### 3.4 浏览器登录：每个浏览器一条，单独撤

- `ui-token` 只当“主钥匙”：用来生成登录链接。登录成功后发一个**随机的会话 cookie**（不再把令牌本身放进 cookie），会话存库：浏览器 UA、从哪台入口登的、最后活动时间。
- “设置 → 已登录的浏览器”：列出、单个退出；“全部退出”= 换主钥匙 + 清会话。设备丢了：这里退掉浏览器会话，并在“账号与设备”里移除该电脑。
- 手机第一次登录：电脑网页“在手机上打开”显示二维码（内容是入口的登录链接，5 分钟有效、用一次就失效），手机扫码打开即登录。不用手抄令牌。
- 会话只在入口上：浏览器从不直接拿别的设备的任何令牌。
- **已实现（P6）**：会话在库表 `browser_sessions`（只存令牌 sha256）；cookie 名 `agent_hub_ui_<网址里的端口>`（同一浏览器里 127.0.0.1 的不同端口各用各的）；退出 / 全部退出当场关掉那些浏览器的 WebSocket；全部退出换 `state/ui-token` 并作废没用掉的登录链接，新的登录链接打在守护进程日志里；登录链接 `/auth#link=<码>`（码放在 # 片段里，浏览器不发给服务器，不进代理 / 访问日志 / Referer；落地页读出后先清地址栏再 POST `/auth` 兑换；老的 `?link=` 不再认）只放内存、只存哈希；会话满 100 条挤掉最旧的，和退出一样关它的 WebSocket。老 cookie（值是令牌本身）失效，要重新点一次登录链接。

## 4. 网页

### 4.1 数据形状

- 现在的 `HubState` 不改语义，变成**每台设备一份**：`Record<DeviceId, HubState>`。`state.ts` 的 reducer 原样复用（每台各跑各的 seq、resync）。
- `client.ts`、`connection.ts` 加一个 `base`：本机是 `""`，别的设备是 `/d/<id>`。`useHub` 拆成“一台设备一个实例”，外面一层 `useDevices` 管设备清单和每台的连接状态。
- 设备清单：入口 `GET /api/devices` → `[{ id, name, platform, self, url }]`。连接状态不另开通道：由这台设备的 WebSocket 状态得出（开着 = 在线，重连中 = 重连中；入口转发连不上对方时回 `502 { code: "device_offline" }`，网页显示离线）。
- 网址加设备：`#/d/<设备>/c/<对话>`、`#/d/<设备>/w/<对话>`、`#/d/<设备>/pm/<项目经理>`。老网址 `#/c/<对话>` 当成入口本机，继续能用。
- 模型名单、`/` 命令、`@` 文件、平台能力（`server`）都是**按设备取**：东京装的 CLI 和 Mac 不一样，选模型、建项目经理时用目标设备的名单。

### 4.2 界面

- **左栏**：只有一台设备时和现在一模一样（不出现设备分组）。两台以上：按设备分组，组头一行 = 设备名 + 状态点 + 系统图标（Mac / Linux），可以折叠；组里是这台的项目经理（排序规则不变）。
- **等你**：左栏最上面和右栏的“等你确定”**跨设备汇总**，每项带设备名小标签；点进去跳到对应设备的对话。标签页标题的数字是所有设备的合计。
- **新建项目经理**：弹窗多一个“设备”选择（默认当前看的那台）；主文件夹是那台设备上的路径，能不能弹“选择…”看那台的 `server.folderPicker`。
- **设置 → 设备**：设备列表（名字、系统、在线状态、最后在线时间）、邀请、添加、改名、移除；“已登录的浏览器”。
- **“在 Finder 中显示 / 用默认程序打开”**：除了看设备的 `server.fileActions`，还要**浏览器就在那台机器上**（请求从 127.0.0.1 直连进来，入口在 `/api/state` 回 `client: { local: true }`）。手机看 Mac 的文件时点了也是在 Mac 屏幕上打开，没意义，隐藏，只留下载 / 预览。

### 4.3 设备离线怎么显示

| 状态 | 左栏组头 | 进入这台的对话 |
|---|---|---|
| 在线 | 绿色点（颜色用 ui-standard 第 4 节的成功色） | 正常 |
| 重连中（断了 <30 秒） | 黄点，“重连中” | 内容照常显示，输入框可以打字，发送按钮等连上 |
| 离线 | 灰点，“离线 · 3 分钟前” | 顶上一条提示“东京服务器离线，显示的是 3 分钟前的内容”；内容只读；输入框禁用并说明原因；不报错弹窗 |
| 从没连上过 | 灰点，“离线” | “还没连上这台设备”+ 排查提示（对方守护进程在不在） |

离线时内容来自这次打开网页期间的内存（不落盘，第一版够用）。Mac 合盖 = 离线，是正常状态，不是错误。

## 5. 统一：厂商不受影响；系统差异只在一处

- **厂商**：联机在账本、驱动层之上。每台守护进程自己管自己的 claude / codex / agy，驱动层、`daemon/vendors/*`、提示词、hub 命令**一行都不改**。网页按设备取模型名单就自然支持“东京只装了 codex”这种情况。验收：`multi-vendor.test.ts` 不改、照过；新增“两台设备名单不同，建项目经理用目标设备的名单”的网页测试。
- **系统差异**：
  - 网页只认 PR #112 的 `ServerInfo`（按设备），不看浏览器的系统。
  - 守护进程里和系统有关的事收进 `daemon/platform/`：osascript 选文件夹、`open`、Worker 沙箱、后台服务（launchd / systemd / Windows supervisor）。其他代码只调这里，不自己判断 `process.platform`。
- **agent 的 hub 命令**：仍是本机 Unix socket，不经过网络，不受影响。

## 6. 手机

### 6.1 形态：PWA（推荐）

- 加 `manifest.webmanifest`（名字、图标、`display: standalone`、主题色）+ Service Worker（`/sw.js`，范围 `/`）。Safari / Chrome “添加到主屏幕”后像 App 一样全屏打开。
- Service Worker 只缓存网页外壳（打包出来的 js、css、图标），**不缓存接口数据**。好处：断网或守护进程没开时 PWA 仍能打开，显示“连不上”，而不是白屏。
- 不做原生 App：要上架、要另一套代码，收益只有“通知更稳一点”，不值。

### 6.2 推送提醒（hub ask、Worker 汇报、“等你”）

- **用标准 Web Push**：iOS 16.4+ 要求先“添加到主屏幕”、从主屏图标打开、在页面里点按钮授权（不能页面一加载就弹）；Android Chrome 直接可以。推送走苹果 / 谷歌的推送服务，**内容端到端加密**（VAPID + aes128gcm），推送服务看不到正文。
- **谁发**：手机 PWA 装在哪个来源（建议东京），订阅就存在哪台，那台就是“提醒设备”。提醒设备对每台已配对设备**常开一条变化流**（和网页同一个 `/api/ws?since=`，用设备令牌），按规则判断要不要推。没有订阅的设备不开常驻连接。这样不需要在设备之间分发推送私钥，也不会重复推。
- **规则一处**：现在 `web/notify.ts`、`web/selectors.ts` 里“等你”“等你确定”的判断搬到 `shared/reminders.ts`，网页和提醒设备共用同一套（含停稳 3 秒、同一个项目经理只留最新一条的 tag）。
  - hub ask：一来就推，标题“<设备> · <项目经理>：等你确定”。
  - 对话停稳等你（Worker 汇报完、项目经理说完话停下）：停稳 3 秒后推。
- **别吵**：网页开着并且在前台看着的时候不推。浏览器每 30 秒在 WebSocket 上报一次“前台 / 后台 + 正在看哪个对话”，提醒设备据此跳过。（iOS 要求每条推送都必须显示出来，所以只能在服务端少发，不能在 Service Worker 里吞。）
- **只推标题**（第 9 节拍板）：只推“东京 · 项目 A：等你确定”，不带正文，也不做开关。
- **点通知**：打开 `/#/d/<设备>/c/<对话>`；连不上时显示 6.1 的提示。
- **实现**：服务端用 `web-push`（npm，新依赖）；订阅存库，推送服务回 404/410 就删订阅，临时失败（网络错误、5xx、429）隔 30 秒重试一次。提醒设备要能出公网访问 `*.push.apple.com`、`fcm.googleapis.com`（东京默认可以）。订阅的 endpoint 只收已知推送服务的主机（`daemon/push/endpoints.ts`：`fcm.googleapis.com`、`updates.push.services.mozilla.com`、`*.push.apple.com`、`*.notify.windows.com`），名单外的 400，状态文件里已存的加载时丢掉（防 SSRF）。推送接口和 WebSocket 前台上报只给入口本机已登录的浏览器，设备令牌来的一律拒。
- 备选（不推荐，列着备用）：ntfy / Bark / Telegram 机器人。好处是不用装 PWA；坏处是多一个第三方、正文过第三方。

### 6.3 小屏布局要点（按 docs/ui-standard.md，先补标准再改界面）

现在已有：1100px 以下左栏变抽屉，720px 以下右栏到顶栏下面（第 12、16 条）。这次**要补进标准**的：

1. **安全区**：`viewport-fit=cover`；顶栏加 `env(safe-area-inset-top)`，输入框底部加 `env(safe-area-inset-bottom)`（主屏 App 全屏时有刘海和底部横条）。
2. **输入框字号不小于 16px**：iOS 对小于 16px 的输入框聚焦时会自动放大页面。标准正文是 15px，只给输入框在 `(pointer: coarse)` 下改 16px。
3. **点击区域**：`(pointer: coarse)` 下图标按钮的可点范围至少 44px（视觉大小不变，用内边距撑开）。
4. **键盘**：用 `100dvh` 和 `interactive-widget=resizes-content`，键盘弹起时输入框贴在键盘上面，消息不被盖住。
5. **只靠悬停出现的操作**（消息上的复制、重试等）在触屏上要有点按的入口。
6. **设备切换**：放在左栏抽屉最上面（设备分组就是切换），顶栏标题在 720px 以下显示“设备 · 对话名”。
7. 截图验收：iPhone 宽 390、Android 宽 360 两档，浅色 / 深色，主屏模式和浏览器模式。

## 7. 性能

- **连接数**：浏览器只连一个来源。每台设备一条 WebSocket（经入口转发），3 台就是 3 条，手机也没问题。入口对每个“浏览器 × 别的设备”开一条转发；提醒设备对每台设备再常开一条。10 台设备、3 个浏览器 ≈ 40 条，内存和 CPU 都可以忽略（守护进程多一个连接只是账本多一个监听）。
- **不轮询**：全部推送；每条 WebSocket 30 秒一次 ping/pong（手机网络和中转会悄悄掉空闲连接，靠它及时发现）。
- **手机省电**：PWA 退到后台 5 分钟后，关掉“没在看的设备”的 WebSocket（提醒靠推送，不靠它）；回到前台带 `since` 补齐，现有逻辑支持。
- **多一跳的代价**：看别的设备是 浏览器 → 入口 → 那台。每条变化是几百字节，多几十毫秒感觉不到。真正大的是打开时的 `/api/state` 快照，设备多、对话多了会慢（Worker #316 起项目经理对话和在跑的 Worker 只带最近 20 条、收工的 Worker 不带消息，见 `shared/snapshot.ts`；网址里带了设备编号时，那台的快照和设备清单同时拉）：
  - 第一步：守护进程和转发都开 gzip（`@fastify/compress`）。
  - 量出来还慢再做第二步：非当前设备只拉轻量摘要（项目经理列表 + 等你计数），点进去才拉完整快照。
- **设备多了会不会变慢**：每台设备是独立的连接和独立的 reducer，一台慢或离线不拖累别的；网页只在 `useDevices` 层做汇总（等你列表、标题数字），计算量和“所有设备的对话数”成正比，几百个对话都是毫秒级。
- 验收指标（写进测试计划的手动部分）：手机 4G 上冷启动到看到对话 < 3 秒；一台设备断网后 15 秒内显示离线。

## 9. 仍在使用的历史定案

1. **提醒用 PWA + Web Push**（iOS 要先“添加到主屏幕”），推送只带标题，不带正文（`PushPayload` 没有正文字段）。
2. **浏览器登录改成“每个浏览器一条、能单独退出”**。
3. **设备互联与手机日常入口已切到 `docs/account-mesh-design.md`**（账号组网 + 全账号单飞书机器人）。

## 10. 测试计划（TDD：先写失败的测试，再写代码）

每个子任务的测试和代码放同一个 PR；本机只跑 `pnpm typecheck` 和改到的测试文件，全量交 CI（macOS + Ubuntu 矩阵）。

| 子任务 | 先写的测试 | 测试文件 |
|---|---|---|
| 浏览器会话 | 登录发随机会话 cookie 不是令牌；单个退出后该 cookie 401、别的不受影响；全部退出；二维码登录链接一次性、5 分钟过期 | `ui-server/sessions.test.ts` |
| 转发 | 方法、请求体、状态码、上传（50 MB）原样转；去掉浏览器 cookie、经组网双向 TLS 通道转发；WS 带 `since` 转发、双向关闭；对方不在 → 502 `device_offline`；未知设备 404；`/d/x/../` 之类路径拒绝 | `daemon/peers/proxy.test.ts` |
| 网页多设备 | 两台设备同一个对话编号互不串；新老网址解析；单设备时左栏和现在快照一致；离线提示 + 输入框禁用；一台重连只补那一台；建项目经理发到选中的设备、用那台的模型名单；手机看 Mac 文件时不出“在 Finder 中显示” | `web/devices.test.tsx`（新）、`web/route.test.ts` |
| 提醒规则搬家 | 现有 `notify.test.ts` 的用例搬到 `shared/reminders.test.ts` 照过（行为不变） | `shared/reminders.test.ts` |
| 推送 | hub ask 推一次；停稳 3 秒才推；同一个项目经理 tag 相同；前台在看时不推；410 删订阅；payload 没有正文；提醒设备对每台常开一条流、断了按退避重连 | `daemon/push/*.test.ts`（新，假推送服务） |
| PWA | manifest 字段、Service Worker 只缓存外壳不缓存 `/api/` | `web/pwa.test.ts`（新） |
| 小屏 | ui-standard 新条目的检查（输入框 coarse 下 16px、安全区变量、44px 点击区） | `web/ui/ui-standard.test.tsx` |
| 端到端 | 一个测试里起多台守护进程（端口 0、不同 `AGENT_HUB_HOME`），登录组网、经入口发消息到远端设备、看到回复；停掉设备 → 离线；再起来 → 自动恢复并补齐 | `test/e2e/account-mesh.test.ts` |
| 厂商不受影响 | `multi-vendor.test.ts` 不改、照过 | 现有 |

### P4 实现说明（2026-11-07）

- 规则：`shared/reminders.ts`（等你、等你确定、停稳 3 秒的 `ReminderTracker`、tag、推送标题）。网页的 `selectors.ts` / `notify.ts` 从这里取；网页的 hook（P3 改成了多设备）还是自己的定时器，以后可以换成 `ReminderTracker`。
- 守护进程：`daemon/push/`。VAPID 密钥 `state/push-vapid.json`、订阅 `state/push-subscriptions.json`（都是 0600，不进仓库）。订阅没进 sqlite：量很小，也免得和 P2 / P6 抢迁移编号。
- 前台：网页在入口那条 WebSocket 上每 30 秒（和切前后台时）报 `presence`；任何一个网页在前台（75 秒内报过 visible）就不推。订阅了推送的浏览器退到后台时网页自己不弹，由推送提醒。
- 跨设备（等 P2）：`PushService.watch(device)` 给每台已配对设备建一个 watcher，P2 用设备令牌开 `/api/state` + `/api/ws?since=`，按 `reset` / `apply` 喂进去；标题带设备名，网址带 `#/d/<设备>/`。
- 图标：`scripts/render-icons.ts` 生成 `src/web/public/icons/`；`/sw.js` 由 vite 单独打包（`tsconfig.sw.json` 单独做类型检查）。
