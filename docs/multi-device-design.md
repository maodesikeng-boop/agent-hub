# 联机方案：一个网页管所有设备（手机可用）

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
1. Host/Origin 只认 127.0.0.1，PR #112 的 `docs/linux.md` 明说“不能用 `tailscale serve` 反代”。要用 serve 就得把 tailnet 域名加进白名单（第 3.3 节）。
2. 各台的编号（对话、项目经理、seq）都是本机自增，**多设备时会撞号**：网页里所有键都要带设备。

## 2. 总体结构（推荐：Tailscale + 无主入口转发）

```
手机(PWA, 装 Tailscale) ──https──▶ 东京 tailscale serve ──▶ 东京守护进程（入口）
                                                          ├─ 本机 /api/*
                                                          └─ /d/<mac>/api/* ──tailnet https──▶ Mac tailscale serve ──▶ Mac 守护进程
Mac 浏览器 ──http://127.0.0.1:4317──▶ Mac 守护进程（入口）── /d/<tokyo>/api/* ──▶ 东京
```

- **数据不动**：每台的项目、Worker、会话、消息、文件都只在本机 sqlite 和数据目录里，别的设备不存副本。
- **没有固定的主**：每台守护进程都能当入口。浏览器打开哪台的网页，哪台就是入口：本机的接口自己回，别的设备的接口按 `/d/<设备编号>/...` 原样转发过去（HTTP 和 WebSocket 都转）。入口挂了，换一台的网址打开，网页一样。
- **为什么不让浏览器直连每台**：直连就是多个来源（`mac.xxx.ts.net`、`tokyo.xxx.ts.net`），要开 CORS、cookie 变第三方（Safari 默认拦）、令牌只能放 localStorage；手机 PWA 和推送订阅都绑一个来源，多来源基本做不成。入口转发后浏览器只面对一个来源，现有的 cookie、Origin 检查、PWA、Service Worker、推送都照旧成立。代价是看别的设备多一跳（tailnet 内，消息体小，可接受，见第 7 节）。
- **手机的入口建议固定成东京**（常开）；Mac 合盖睡了就显示离线，不影响看东京。

## 3. 认证

### 3.1 三层

| 层 | 防什么 | 怎么做 |
|---|---|---|
| 网络 | 公网扫描、陌生人 | 守护进程照旧只听本机；对外只经 `tailscale serve`（**不用 Funnel**），只有用户 tailnet 里的设备能连。不在安全组 / 防火墙开端口；东京公网 22 也可以关，改用 `tailscale ssh`。 |
| 人 | tailnet 里别的人（以后共享设备给朋友） | serve 会把请求者的 `Tailscale-User-Login` 放进请求头，并且**删掉客户端自己带的同名头**（官方文档 Identity headers 一节）。守护进程只放行等于“设备主人”的登录名（配对时记下）。 |
| 浏览器 / 设备 | 拿到 tailnet 访问的进程、丢了的手机 | 浏览器：沿用 cookie，但改成**每个浏览器一条登录记录**（3.4）。设备之间：配对时互发的“设备令牌”（3.2）。 |

只有经 serve 进来的请求才带身份头；本机 127.0.0.1 直连（Mac 上自己打开网页）不带，照旧只看 cookie。身份头不单独作为登录凭据（本机别的进程能直连端口伪造它），只做“必须是主人”的附加条件。Linux 上 serve 可以转发到 Unix socket（`unix:/path`，serve 源码支持），守护进程另听一个 0600 的 socket 专收 serve 流量，伪造面更小；macOS 的 Tailscale 客户端有沙箱，统一走 127.0.0.1 端口。这一处差异放在平台模块里（第 5 节）。

### 3.2 设备之间：配对、发令牌、撤销

- **设备身份**：每台第一次启动生成 `state/device.json`：`{ id: <随机 UUID>, name: <主机名，可改> }`。
- **配对**（一次性，约 1 分钟）：
  1. 新设备上：网页“设置 → 设备 → 邀请别的设备”或命令 `hub-device invite`，给出一个邀请码（随机 128 位、10 分钟内、只能用一次）和本机的 tailnet 网址。
  2. 已有设备上：“添加设备”，填网址 + 邀请码。它带着自己的 id、名字、网址去新设备 `POST /api/peer/pair`。
  3. 双方各给对方发一个长期设备令牌（32 字节随机），**存对方令牌的 sha256**，自己要用的那份明文存 `state/peers.json`（0600）。同时记下对方 serve 带来的 `Tailscale-User-Login`，必须和本机主人一致，否则拒绝配对（防把别人的设备加进来）。
  4. 已配对的设备之间互相同步设备清单（只同步“谁是谁、网址”，不同步令牌），第三台配一次就全通。
- **转发时**：入口去掉浏览器的 cookie 和所有 `Tailscale-*` 头，加 `Authorization: Bearer <设备令牌>`、`X-Agent-Hub-Device: <入口 id>`。对方查令牌 + serve 给的身份头。
- **撤销**：“设置 → 设备 → 移除”：删本机记录，并通知对方删它那边（对方离线就只删本机，对方上线后令牌被拒会自己标成“已移除”）。紧急情况（设备丢了、被入侵）：在 Tailscale 后台把设备踢出 tailnet，网络层立刻断，比改令牌快。
- **Tailscale 侧的设置**（写进 docs/linux.md 和新文档）：所有设备用用户本人账号登录（**别用 tag**：tag 设备发出的请求不带身份头）；服务器关掉 key 过期（默认 180 天，过期就掉线）；身份提供方（Google / GitHub / Apple）开两步验证；可选 Tailnet Lock。

### 3.3 Host / Origin 校验怎么改

- 白名单从“127.0.0.1、localhost”扩成“再加本机的 tailnet 名字”（`<机器>.<tailnet>.ts.net`）。名字启动时问 `tailscale status --json` 的 `Self.DNSName`，也可以用环境变量写死；问不到就只认本机，和现在一样。
- Origin 同理：`https://<tailnet 名字>` 算同源。别的 `*.ts.net` 一律 403。
- https 来源的 cookie 加 `Secure`。

### 3.4 浏览器登录：每个浏览器一条，单独撤

- `ui-token` 只当“主钥匙”：用来生成登录链接。登录成功后发一个**随机的会话 cookie**（不再把令牌本身放进 cookie），会话存库：浏览器 UA、从哪台入口登的、最后活动时间。
- “设置 → 已登录的浏览器”：列出、单个退出；“全部退出”= 换主钥匙 + 清会话。手机丢了：这里退掉它 + Tailscale 后台踢掉手机。
- 手机第一次登录：电脑网页“在手机上打开”显示二维码（内容是入口的登录链接，5 分钟有效、用一次就失效），手机扫码打开即登录。不用手抄令牌。
- 会话只在入口上：浏览器从不直接拿别的设备的任何令牌。
- **已实现（P6）**：会话在库表 `browser_sessions`（只存令牌 sha256）；cookie 名 `agent_hub_ui_<网址里的端口>`（同一浏览器里 127.0.0.1 的不同端口各用各的，`ssh -L` 转来的东京不会顶掉本机）；退出 / 全部退出当场关掉那些浏览器的 WebSocket；全部退出换 `state/ui-token` 并作废没用掉的登录链接，新的登录链接打在守护进程日志里；登录链接 `/auth?link=<码>` 只放内存、只存哈希。老 cookie（值是令牌本身）失效，要重新点一次登录链接。

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
| 从没连上过 | 灰点，“离线” | “还没连上这台设备”+ 排查提示（Tailscale 开了没、对方守护进程在不在） |

离线时内容来自这次打开网页期间的内存（不落盘，第一版够用）。Mac 合盖 = 离线，是正常状态，不是错误。

## 5. 统一：厂商不受影响；系统差异只在一处

- **厂商**：联机在账本、驱动层之上。每台守护进程自己管自己的 claude / codex / agy，驱动层、`daemon/vendors/*`、提示词、hub 命令**一行都不改**。网页按设备取模型名单就自然支持“东京只装了 codex”这种情况。验收：`multi-vendor.test.ts` 不改、照过；新增“两台设备名单不同，建项目经理用目标设备的名单”的网页测试。
- **系统差异**：
  - 网页只认 PR #112 的 `ServerInfo`（按设备），不看浏览器的系统。这次往里加的字段：`serveTarget: "unix" | "tcp"`（只给设置页展示）。
  - 守护进程里和系统有关的事收进 `daemon/platform/`：osascript 选文件夹、`open`、Worker 沙箱（已有）、**新增** tailscale 命令在哪（macOS 是 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，Linux 是 `tailscale`）、serve 转发目标（Linux socket / macOS 端口）、后台服务（launchd / systemd 的说明）。其他代码只调这里，不自己判断 `process.platform`。
- **agent 的 hub 命令**：仍是本机 Unix socket，不经过网络，不受影响。

## 6. 手机

### 6.1 形态：PWA（推荐）

- 加 `manifest.webmanifest`（名字、图标、`display: standalone`、主题色）+ Service Worker（`/sw.js`，范围 `/`）。Safari / Chrome “添加到主屏幕”后像 App 一样全屏打开。
- Service Worker 只缓存网页外壳（打包出来的 js、css、图标），**不缓存接口数据**。好处：Tailscale 没开时 PWA 仍能打开，显示“连不上：请打开 Tailscale”，而不是白屏。
- 不做原生 App：要上架、要另一套代码，收益只有“通知更稳一点”，不值。

### 6.2 推送提醒（hub ask、Worker 汇报、“等你”）

- **用标准 Web Push**：iOS 16.4+ 要求先“添加到主屏幕”、从主屏图标打开、在页面里点按钮授权（不能页面一加载就弹）；Android Chrome 直接可以。推送走苹果 / 谷歌的推送服务，**内容端到端加密**（VAPID + aes128gcm），推送服务看不到正文。
- **谁发**：手机 PWA 装在哪个来源（建议东京），订阅就存在哪台，那台就是“提醒设备”。提醒设备对每台已配对设备**常开一条变化流**（和网页同一个 `/api/ws?since=`，用设备令牌），按规则判断要不要推。没有订阅的设备不开常驻连接。这样不需要在设备之间分发推送私钥，也不会重复推。
- **规则一处**：现在 `web/notify.ts`、`web/selectors.ts` 里“等你”“等你确定”的判断搬到 `shared/reminders.ts`，网页和提醒设备共用同一套（含停稳 3 秒、同一个项目经理只留最新一条的 tag）。
  - hub ask：一来就推，标题“<设备> · <项目经理>：等你确定”。
  - 对话停稳等你（Worker 汇报完、项目经理说完话停下）：停稳 3 秒后推。
- **别吵**：网页开着并且在前台看着的时候不推。浏览器每 30 秒在 WebSocket 上报一次“前台 / 后台 + 正在看哪个对话”，提醒设备据此跳过。（iOS 要求每条推送都必须显示出来，所以只能在服务端少发，不能在 Service Worker 里吞。）
- **只推标题**（第 9 节拍板）：只推“东京 · 项目 A：等你确定”，不带正文，也不做开关。
- **点通知**：打开 `/#/d/<设备>/c/<对话>`；Tailscale 没连上时显示 6.1 的提示。iOS 的 Tailscale 可以开“按需连接”，基本不用手动开。
- **实现**：服务端用 `web-push`（npm，新依赖）；订阅存库，推送服务回 404/410 就删订阅。提醒设备要能出公网访问 `*.push.apple.com`、`fcm.googleapis.com`（东京默认可以）。
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
- **多一跳的代价**：看别的设备是 浏览器 → 入口 → 那台。每条变化是几百字节，多几十毫秒感觉不到。真正大的是打开时的 `/api/state` 快照（每个对话最近 100 条消息），设备多、对话多了会慢：
  - 第一步：守护进程和转发都开 gzip（`@fastify/compress`）。
  - 量出来还慢再做第二步：非当前设备只拉轻量摘要（项目经理列表 + 等你计数），点进去才拉完整快照。
- **设备多了会不会变慢**：每台设备是独立的连接和独立的 reducer，一台慢或离线不拖累别的；网页只在 `useDevices` 层做汇总（等你列表、标题数字），计算量和“所有设备的对话数”成正比，几百个对话都是毫秒级。
- 验收指标（写进测试计划的手动部分）：手机 4G 上冷启动到看到对话 < 3 秒；一台设备断网后 15 秒内显示离线。

## 8. 三个方案对比

| | **Tailscale（推荐）** | 自建中转服务器 | Cloudflare Tunnel + Access |
|---|---|---|---|
| 怎么连 | 各设备、手机进同一个 tailnet；`tailscale serve` 给每台一个 https 地址，只有 tailnet 能访问 | 公网一台服务器（可以就是东京），各设备主动连它，网页也连它 | 各设备跑 `cloudflared`，在用户自己的域名下出一个公网地址，Access 在前面挡一道登录 |
| 安全 | 没有公网入口；WireGuard 端到端加密，Tailscale 也看不到内容；身份 = 用户的 Google/GitHub/Apple 登录 + 设备密钥。风险点：Tailscale 账号被盗（开两步验证、可选 Tailnet Lock） | **攻击面最大**：自己写的认证、TLS、限流直接面对公网，出漏洞就是全部设备的 shell 级权限；中转上能看到明文，除非再做端到端加密 | 地址在公网上，但先过 Access（SSO / 邮箱验证码）；**Cloudflare 终止 TLS，能看到所有聊天和代码内容**；agent-hub 自己的登录仍要留着 |
| 手机体验 | 要装 Tailscale App 并保持连接（可设按需连接）。**iPhone 同时只能开一个 VPN**：开着公司 VPN 时 Tailscale 会被顶掉 | 只要浏览器，最好 | 只要浏览器 + 登录，最好 |
| 推送 | Web Push，三者一样（都有 https） | 同左 | 同左 |
| 成本 | 免费（Personal 方案，个人非商用，6 个用户、用户设备不限） | 服务器（可复用东京，0 元起）+ 域名 + 证书，主要成本是开发时间 | Zero Trust 免费档（50 人内）+ 一个托管在 Cloudflare 的域名（约 10 美元/年） |
| 维护量 | 小：每台装一次、`tailscale serve --bg` 一条命令、证书自动续；关掉服务器的 key 过期 | **大**：认证、配对、重连、证书、升级、安全补丁都是我们的 | 中：每台一个 cloudflared + DNS + Access 规则；地址多了要管多条 |
| 对代码的改动 | 第 2–7 节全部 | 第 2–7 节 + 中转服务本身（新服务、协议、部署） | 和 Tailscale 差不多；身份头换成 `Cf-Access-Jwt-Assertion`（要验 JWT 签名） |

结论：个人使用、设备都在自己手上，Tailscale 安全最好、维护最少、免费；唯一硬伤是手机要装 App、和公司 VPN 互斥。第 2–7 节的入口转发、设备配对、网页、PWA、推送**和用哪种网络无关**，以后要换 Cloudflare，只换第 3.1 节的“人”那一层（身份头 → Access JWT）和部署文档。

## 9. 用户已拍板（2026-11-07）

1. **网络用 Tailscale**。
2. **手机入口和提醒设备定成东京**（常开）。Mac 合盖会离线，只影响看 Mac 上的东西。
3. **提醒用 PWA + Web Push**（iOS 要先“添加到主屏幕”）。
4. **推送只带标题，不带正文**（第 6.2 节的“隐私开关”不做，`PushPayload` 没有正文字段）。
5. **登录改成“每个浏览器一条、能单独退出”**（老的 cookie 会失效一次，要重新点一次登录链接）。

## 10. 测试计划（TDD：先写失败的测试，再写代码）

每个子任务的测试和代码放同一个 PR；本机只跑 `pnpm typecheck` 和改到的测试文件，全量交 CI（macOS + Ubuntu 矩阵）。

| 子任务 | 先写的测试 | 测试文件 |
|---|---|---|
| Host/Origin 白名单 | tailnet 名字的 Host、`https://` Origin 放行；别的 `*.ts.net`、端口不对 403；没配 tailnet 名字时行为和现在完全一样；https 来源 cookie 带 Secure | `ui-server/server.test.ts` |
| 身份头 | 经 serve 来、登录名不是主人 → 403；本机直连不带头 → 只看 cookie；身份头单独不能登录 | `ui-server/server.test.ts` |
| 浏览器会话 | 登录发随机会话 cookie 不是令牌；单个退出后该 cookie 401、别的不受影响；全部退出；二维码登录链接一次性、5 分钟过期 | `ui-server/sessions.test.ts`（新） |
| 设备身份、配对 | `device.json` 首次生成后不变；邀请码一次性、10 分钟过期、错 5 次锁定；令牌只存 hash；主人登录名不一致拒绝配对；移除后对方令牌 401；设备清单同步不带令牌 | `daemon/peers/*.test.ts`（新） |
| 转发 | 方法、请求体、状态码、上传（20 MB）原样转；去掉 cookie 和 `Tailscale-*` 头、加设备令牌；WS 带 `since` 转发、双向关闭；对方不在 → 502 `device_offline`；未知设备 404；`/d/x/../` 之类路径拒绝；只能转到已配对设备的网址（防 SSRF） | `daemon/peers/proxy.test.ts`（新） |
| 网页多设备 | 两台设备同一个对话编号互不串；新老网址解析；单设备时左栏和现在快照一致；离线提示 + 输入框禁用；一台重连只补那一台；建项目经理发到选中的设备、用那台的模型名单；手机看 Mac 文件时不出“在 Finder 中显示” | `web/devices.test.tsx`（新）、`web/route.test.ts` |
| 提醒规则搬家 | 现有 `notify.test.ts` 的用例搬到 `shared/reminders.test.ts` 照过（行为不变） | `shared/reminders.test.ts` |
| 推送 | hub ask 推一次；停稳 3 秒才推；同一个项目经理 tag 相同；前台在看时不推；410 删订阅；payload 没有正文；提醒设备对每台常开一条流、断了按退避重连 | `daemon/push/*.test.ts`（新，假推送服务） |
| PWA | manifest 字段、Service Worker 只缓存外壳不缓存 `/api/` | `web/pwa.test.ts`（新） |
| 小屏 | ui-standard 新条目的检查（输入框 coarse 下 16px、安全区变量、44px 点击区） | `web/ui/ui-standard.test.tsx` |
| 端到端 | 一个测试里起两个守护进程（端口 0、不同 `AGENT_HUB_HOME`），配对、经入口发消息到第二台、看到回复；停掉第二台 → 离线；再起来 → 自动恢复并补齐 | `test/e2e/multi-device.test.ts`（新） |
| 厂商不受影响 | `multi-vendor.test.ts` 不改、照过 | 现有 |

手动验收（真机，测试跑不到的）：Mac + 东京真配对；iPhone 添加到主屏、授权、收到 hub ask 推送、点开跳到对话；关 Tailscale 时 PWA 的提示；合上 Mac 看离线显示；4G 冷启动时间。

## 11. 实现拆分（标出能并行的）

```
P0 接口约定（小，先合）
 ├─ P1 守护进程底座 ──┐
 ├─ P3 网页多设备 ────┤（用假设备先做，P2 合了再接真的）
 ├─ P5 小屏布局 ──────┤（独立）
 └─ P6 浏览器会话 ────┤（独立）
      P2 配对 + 转发 ◀┘（依赖 P1）
      P4 PWA + 推送  ◀── 本机推送可和 P2 并行；跨设备推送依赖 P2
      P7 文档 + 真机验收（最后）
```

| 编号 | 内容 | 依赖 | 难度 |
|---|---|---|---|
| P0 | `shared/api.ts` 加类型和路径：`DeviceInfo`、`/api/devices`、`/d/:id/*`、`/api/peer/*`、`/api/push/*`、`device_offline` 错误码；网址格式。只有类型和注释 | PR #112 | 低 |
| P1 | `device.json`；`daemon/platform/`（tailscale 命令路径、serve 目标、tailnet 名字探测）；Host/Origin 白名单；Secure cookie；身份头校验 | P0 | 中 |
| P2 | `daemon/peers/`：配对、设备令牌、设备清单同步、移除；HTTP + WS 转发（可评估 `@fastify/http-proxy`） | P1 | 高 |
| P3 | 网页：`client` 带 base、`useDevices`、按设备的 state、网址、左栏分组、跨设备“等你”、离线显示、新建项目经理选设备、设置 → 设备 | P0（用假数据），接真的要 P2 | 高 |
| P4 | manifest、Service Worker、图标；`shared/reminders.ts` 搬家；订阅接口、`web-push`、前台上报、提醒设备的常驻流 | P0；跨设备部分要 P2 | 中高 |
| P5 | ui-standard 补第 6.3 节的条目 + 样式改动 + 截图 | 无 | 低中 |
| P6 | 浏览器会话表、登录 / 退出 / 全部退出、二维码登录链接 | P0 | 中 |
| P7 | `docs/linux.md` 更新（删掉“不能用 serve”）、新增“联机设置”文档（Tailscale 设置、key 过期、配对步骤）、`HANDOVER.md`；真机验收 | 全部 | 低 |

第一批可以同时派 4 个 Worker：P1、P3、P5、P6（P0 很小，可以由派 P1 的 Worker 先做完合掉，其他人基于它开工）。第二批 P2、P4。
