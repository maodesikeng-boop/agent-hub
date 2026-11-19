# 账号组网：登录同一账号自动连齐所有电脑，全账号一个飞书机器人

## 给用户看

### 要验收的文件

- 本文 `docs/account-mesh-design.md`：怎么登录，电脑之间怎么连（同一 Wi-Fi 直连，不在一起时经中继，中继看不到内容），中继怎么防刷、花多少钱，全账号一个飞书机器人怎么选中心、掉线怎么接管，要删掉哪些旧代码。
- 代码骨架（只有类型、函数签名和待写的测试，现有功能一行不变）：
  - `src/shared/mesh.ts`：账号、设备指纹、连法、中心顺序、核对码。
  - `src/relay/`：中继。`protocol.ts` 是设备和中继之间的消息格式，`core.ts` 是一份共用的中继逻辑，`node/server.ts` 是自建版，`cloudflare/worker.ts` 是 Cloudflare 版。
  - `src/daemon/mesh/`：守护进程这一侧。设备身份、GitHub 登录、信任表、连中继、拨号、中心租约。
  - `src/daemon/feishu/account-bot.ts`：中心把飞书消息按群转给项目所在的电脑。
  - `src/mesh/cli.ts`：服务器上用的终端命令（登录、核对、排中心顺序）。
  - `migrations/0041_feishu_offline_inbox.sql`：电脑离线时暂存飞书消息的表。
  - `src/shared/limits.ts`：新加的上限和时间常量。

### 要你拍板的事

先用三句话说这套东西怎么跑，下面五件事都基于它：

- 每台跑 Fusa 的电脑登录同一个 GitHub 账号，就出现在彼此的设备列表里。数据还在各自电脑上，不同步。
- 两台在同一个 Wi-Fi 时直接连。不在一起时，两台都主动连一个“中继”，中继只转发加密后的字节。电脑不需要公网 IP，不用装 Tailscale，不用配 SSH。
- 手机不再打开 Fusa 网页，只用飞书。全账号只有一个飞书机器人：你排一个中心顺序，排最前且在线的那台挂飞书长连接，收到消息按群转给项目所在的电脑。它掉线后，下一台约 20 秒内接上。

**1. 用什么账号登录。**

- A. GitHub（推荐）。电脑上显示一个 8 位码，你在手机或电脑浏览器打开 `github.com/login/device` 输进去就登上了。东京这种没有浏览器的服务器也能用。代码里只放公开的 Client ID，不放任何密钥。
- B. Google。用的人更多，但 Google 的设备码登录要在代码里放一串 client secret，国内打开还要梯子。
- C. 邮箱验证码。中继要接发信服务、存发信密钥，还得防人拿它刷邮件，成本和风险最大。

推荐 A。以后想加 Google，只是多一种登录方式，设备、信任、中继都不用改。

**2. 新电脑登录后，要不要旧电脑点一下“允许”。**

- A. 要（推荐）。新电脑登录后先“等批准”。你在任意一台已经在用的电脑上点“核对”（网页设置里，或飞书里机器人发来的卡片），两边屏幕会显示同一个 6 位数，两边都点“一致”才加入。账号里第一台不用批准。
- B. 不要，登录同一个 GitHub 就自动加入。少一步。代价是 GitHub 账号被盗或中继被人控制时，对方能把自己的“电脑”加进来，拿到在你所有电脑上跑 agent 的权限，等于能在你电脑上执行命令。

推荐 A：每加一台多看一眼数字，换来中继和 GitHub 都不能单独把陌生电脑塞进你的账号。

**3. 项目所在的电脑离线（关机、合盖）时，飞书群里发的话怎么办。**

- A. 立刻回一句“「Mac」现在离线，这句先存着，Mac 上线后自动交给项目经理”。存 24 小时，每台最多 50 条。Mac 上线后按顺序交过去，正文前标上原来的发送时间（推荐）。
- B. 只回一句“「Mac」现在离线，上线后再发”，不存。

两种都会立刻回复，不会没反应。拍板卡上的按钮离线时都只提示“离线，上线后再点”，不存。推荐 A：你在手机上随手吩咐的事不会丢，过时的话靠 24 小时过期挡住。

**4. 默认用谁的中继。**

- A. 项目自带一个公共中继，跑在 Cloudflare 免费档上（用维护者的 Cloudflare 账号），开源代码里写着它的网址。设置里也能填自建中继的网址（推荐）。
- B. 不提供公共中继，每个用户自己一键部署到自己的 Cloudflare 账号（免费）或自己的服务器。

花钱：Cloudflare 免费档每天 10 万次请求，超了当天剩下的请求直接失败，不会扣钱。按本文的心跳频率估算，一个 3 台电脑的账号空闲时每天约 2,600 次，重度使用约 6,000 次（第「性能」节）。所以 A 对个人和十几个重度用户都免费；用户多到超额时升级 Workers 付费版，5 美元/月起，之后每 100 万次 0.15 美元。B 维护者一分钱不花，但每个用户多一步部署。

安全：中继网址本来就是公开的，Syncthing 的公共中继也是这样。仓库里没有服务端密钥：GitHub 设备码登录不需要 secret，中继验身份用的是你自己登录拿到的 token。设备之间的内容端到端加密，中继拿到也解不开。防刷靠每个账号的设备数、并发通道数、每天流量的上限。

推荐 A：开箱即用；自建入口留给不放心公共中继的人。

**5. 旧东西怎么退役。**

- A. 一步到位（推荐）。impl-mesh 合并前，你在东京和 Mac 上各登录一次同一个 GitHub 账号，在 Mac 上点“允许”；确认东京出现在 Mac 的设备列表里，再在东京上跑一次清理命令（「删掉什么」节末尾），删掉 `agenthub-tunnel` 用户和 sshd 片段。同一个 PR 删掉 SSH 隧道、Tailscale 连法和手机公网入口的代码。飞书保留中心顺序排第一那台（东京）的机器人当全账号机器人；Mac 的旧机器人在它的每个项目群里发一句“已搬到新群”后解散旧群，Mac 的项目经理由全账号机器人重新建群。旧应用之后可以在飞书开发者后台删掉。
- B. SSH 隧道和 Tailscale 再留一个版本当备用，下个版本再删。两种连法并存，代码和测试都要双份。

推荐 A。

## 用户目标

用户原话（完整上下文见 `/tmp/chat-transcript-2026-11-19-multi-device-account-mesh.md`，以原话为最高准则）：

1. 「我觉得我们的多设备管理还是做的不好，你看需要运行进程的设备需要互联对吧，不运行进程的设备，手机，只需要接收网页就行了？你先回答我说的对不对」
2. 「然后多设备的感觉我们这里比较奇怪？比如我想再加一台 Windows 设备可以吗？感觉这个多设备完全就是为我做的？」
3. 「可以做成账号形式的吗？需要登录登录后就可以看到自己的所有设备？」
4. 「中心入口可以自己选，中心入口不在线就去调在线的，中心节点网址是什么？手机能打开吗」
5. 「好吧，那在手机上就不用这个网页了，就直接用飞书，slack 这种可以直接连的」
6. 「我懂了，那能实现只有一个机器人了」
7. 「我希望没有公网的用户也是正常使用的！」
8. 「那这个中继需要付费吗」「那我中继不是要写在代码里面吗，那我如果开源不会不安全吗」
9. 「先去做我们的方案吧」

我理解的目标：任何人在几台 Mac / Windows / Linux 上装好 Fusa，登录同一个账号，这几台就自动互通，不需要公网 IP、服务器、Tailscale 或 SSH。手机只用飞书，全账号一个机器人，由用户排好的中心电脑挂着，中心掉线由下一台接上。中继代码和网址可以开源，开源了也不泄密、不怕被刷。

## 现状

**设备互联**

- 实测（读代码）：设备之间只有两种连法。Tailscale：设备网址只认 `https://<机器>.<tailnet>.ts.net`（`src/daemon/peers/url.ts:14`）。SSH 隧道：地址只从本机隧道表取，中心的槽位端口还要读 `/proc/net/tcp` 核对监听者 UID（`src/daemon/peers/transport.ts:101`、`:157`）。没有 Tailscale，又没有一台带公网 SSH 的服务器，就连不起来。
- 实测（读代码）：Windows 上不起隧道，也不开设备入口（`src/daemon/daemon.ts:818`、`:946`）；隧道方案写明“不做 Windows 当连入方”（`docs/hub-tunnel-design.md:11`）。所以现在“再加一台 Windows”只能走 Tailscale。
- 实测（读代码）：设备令牌不能用 `/d/` 去第三台（`src/shared/api.ts:676-679`）。隧道方案里第三台连入设备和 Mac 之间没有路，要等“中心中转”（`docs/hub-tunnel-design.md:37`）。
- 实测（读代码）：配对靠邀请码，配好后互发长期 Bearer 令牌，存在 `state/peers.json`（`src/daemon/peers/service.ts:1-11`、`src/daemon/peers/store.ts:31-39`）。没有账号概念，每加一台要手动抄网址和邀请码。
- 实测（读代码）：界面服务按“请求从哪个入口进来”定规则，现在有本机回环、tailnet、设备入口、公网入口四种（`src/daemon/ui-server/server.ts:300`、`:303-312`），加一种入口就是在 `Entry` 加一种、规则表加一行。
- 实测（读代码）：网页已经是“一台设备一个 DeviceHub”，别的设备的接口走 `/d/<设备>/api/*`（`src/web/device-hub.ts:1-3`、`src/shared/api.ts:659-665`）。总助跨设备派活也经 `peers` 发出（`src/daemon/router/target-port.ts:1-4`、`:555-558`）。这两层只关心“能不能把请求送到那台”，换底层连法时它们不用改。

**飞书**

- 实测（读代码）：现在每台电脑各接各的飞书应用。当时的理由是长连接是集群模式，两台连同一个应用会被随机分走消息（`docs/feishu-design.md:22`、`:85`）。飞书服务有凭证就连长连接（`src/daemon/feishu/service.ts:2103-2115`）。
- 实测（读代码）：项目群的群说明里带 `fusa:<设备编号>:pm:<编号>` 标记（`src/daemon/feishu/chats.ts:39`、`:46-49`），重启认回群时只认本机设备编号的标记（`chats.ts:101-103`）。所以收到某个群的消息，读群说明就知道它属于哪台电脑的哪个项目经理；各台用同一个机器人建群也不会互相认错。
- 实测（读代码）：卡片点击的处理函数是同步返回 toast（`src/daemon/feishu/transport.ts:121-124`），但 `sdk.ts` 交给官方 SDK 的回调本身是异步的（`src/daemon/feishu/sdk.ts:256`）。把它改成可以等一个有上限的异步结果，只改接口类型和这一处。

**安全和成本（查文档，2026-11-19）**

- 实测（查文档）：Cloudflare Durable Objects 免费档每天 10 万次请求、13,000 GB-s 时长；收到的 WebSocket 消息按 20 条算 1 次请求，发出去的消息和协议层 ping 不算钱；超过免费额度时当天剩下的操作直接报错，不扣钱（developers.cloudflare.com/durable-objects/platform/pricing）。单条收到的 WebSocket 消息最大 32 MiB（…/platform/limits）。用休眠 API 接的 WebSocket，空闲时不计时长。付费版 5 美元/月起，含每月 100 万次请求，超出每 100 万次 0.15 美元。
- 实测（查文档）：GitHub 设备码登录只要 `client_id`，不要 `client_secret`，要在应用设置里打开 Device Flow（docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow）。认人用 `GET /user` 返回的数字 `id`，不用会变的用户名。
- 实测（查文档）：Syncthing 用的就是这套做法。设备编号是自签证书的 SHA-256；直连和经中继都跑同一条双向认证的 TLS，中继只转发密文；局域网里靠 UDP 广播发现（docs.syncthing.net 的 users/security、specs/relay-v1、specs/localdisco-v4）。
- 实测（读代码）：只读 Worker 禁读的令牌文件只有 `ui-token`、`provider-secrets.json`、`feishu-secrets.json`（`src/shared/readonly-policy.ts:53`）。新的设备私钥要加进这张表。
- 推断：Fusa 离开外网本来就没法用（agent 要连 claude、codex 的云端接口），所以“同一 Wi-Fi 但没有外网”不是要支持的场景。局域网直连的地址可以经中继交换，不另做 mDNS / UDP 广播发现。

## 做法比较

### 电脑之间怎么连

| 做法 | 没公网能用吗 | 中继看得到内容吗 | 每台要装什么 | Windows | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. 账号 + 局域网直连 + 自带的端到端加密中继（Syncthing 的做法：TLS 1.3 双向认证，证书指纹钉死） | 能 | 看不到 | 什么都不装（Node 自带 `tls`） | 能 | 推荐 |
| B. 继续 Tailscale | 能（它自己有 DERP 中继） | 看不到 | Tailscale App 并登录；手机上和公司 VPN 互斥 | 能 | 用户要告别 Tailscale 依赖 |
| C. 现在的 SSH 隧道 | 要一台有公网 IP 的服务器 | 不经第三方 | 服务器改 sshd | 不能 | 退役 |
| D. 嵌 libp2p / Iroh 这类点对点库（打洞 + 中继） | 能 | 看不到 | 不用装，但依赖重：libp2p 的 JS 包很大，Iroh 是 Rust 要原生绑定 | 要逐平台打包 | 不选：打洞只省中继流量，个人用的流量很小 |
| E. Cloudflare Tunnel / frp | 能 | Cloudflare Tunnel 在边缘解开 TLS，看得到明文 | cloudflared / frpc | 能 | 不选 |

### 加密层用什么

| 做法 | 结论 |
| --- | --- |
| A. TLS 1.3 双向认证（`node:tls`），自签证书，对方证书的 SHA-256 必须在本机信任表里 | 推荐。HTTP 和 WebSocket 原样跑在里面，现有 Fastify、转发、WebSocket 都不用改。Node 不能生成证书，加一个依赖 `@peculiar/x509`（PeculiarVentures 维护，纯 JS，基于 WebCrypto）在首次登录时生成一次 |
| B. Noise 协议（`noise-handshake` + libsodium） | 不选：要原生 sodium，三平台打包麻烦；HTTP 还得自己套在上面 |
| C. 应用层逐条加密（libsodium box） | 不选：转发和 WebSocket 流都要重写 |

### 中继跑在哪

| 做法 | 结论 |
| --- | --- |
| A. 一份核心逻辑（只用 Web 标准 API），两个外壳：Cloudflare Workers + 每账号一个 Durable Object；自建 Node | 推荐。默认用 Cloudflare（免费、全球边缘、不用管机器），想自己跑的人用 Node 版 |
| B. 只做 Node 版 | 没公网服务器的用户就用不了，违背原话 7 |
| C. 只做 Cloudflare 版 | 不信 Cloudflare 的人没得选 |

### 登录

| 做法 | 服务器上能用吗 | 代码里要放密钥吗 | 结论 |
| --- | --- | --- | --- |
| A. GitHub 设备码 | 能 | 不要 | 推荐（拍板 1） |
| B. Google 设备码 | 能 | 要放 client secret | 备选 |
| C. 邮箱验证码 | 能 | 中继要存发信密钥 | 不选 |
| D. 不要第三方账号，只用配对码 | 能 | 不要 | 不选：没有“登录后看到自己所有设备”，违背原话 3 |

### 新设备怎么获得信任

| 做法 | 结论 |
| --- | --- |
| A. 登录 + 已有设备核对 6 位数，两边都点“一致”（蓝牙数字比较配对、Signal 安全码同一思路） | 推荐（拍板 2）。中继和 GitHub 都不能单独塞进陌生设备 |
| B. 登录即信任 | 省一步；中继或 GitHub 账号被攻破就等于所有电脑被攻破 |
| C. 登录 + 在新设备上抄一段已有设备显示的配对码 | 和 A 一样安全，但要抄 13 位以上的码（短了中继能离线穷举），比看一眼数字麻烦 |

### 全账号一个飞书机器人

| 做法 | 结论 |
| --- | --- |
| A. 中心租约：排最前且在线的那台挂长连接，收到消息按群转给归属电脑；每台自己往飞书发自己项目群的消息 | 推荐。出站不绕路，流式卡片照旧本机直发；只有入站多一跳 |
| B. 所有电脑都连同一个应用，靠飞书集群模式随机分，收到的那台转给归属电脑 | 不要租约也能跑，但总助单聊的话会随机落到不同电脑的总助上，对话接不上；也不符合原话 4“中心入口可以自己选” |
| C. 中心替所有电脑发消息（订阅每台的账本变化再投影） | 不选：远端的流式卡片要多跳；飞书服务里直接读写本机账本和库的地方都要改成远程调用，改动最大 |

### 租约谁来裁决

| 做法 | 结论 |
| --- | --- |
| A. 中继的账号 Durable Object | 推荐。一个账号一个对象、单线程处理，没有并发竞争；设备本来就连着它 |
| B. 设备之间自己选主（Raft 之类） | 不选：两台电脑凑不出多数派 |
| C. 让飞书裁决 | 飞书没有这种接口 |

### 推荐做法的细节

#### 拓扑

```
                 中继（Cloudflare Worker + 每账号一个 Durable Object；或自建 Node）
                 控制连接：在线、局域网地址、拨号、中心租约、中心顺序 | 数据通道：只转发 TLS 密文
                    ▲ wss 主动连出            ▲ wss                     ▲ wss
                    │                         │                          │
         东京（Linux）守护进程          Mac 守护进程  ◀═ 同一 Wi-Fi 直连 TLS ═▶  家里 Windows 守护进程
         持有中心租约 ── wss ──▶ 飞书长连接（只有中心连）
                                        各台自己 https 调飞书接口，发自己项目群的消息
手机飞书 ◀──────────────────────── 飞书
```

- 任意两台之间都是直接的一条：同局域网走直连，否则经中继。不存在“经第三台中转”，所以原来卡在“第三台没路”的问题没有了。
- 数据不动：项目、工作树、SQLite、文件都留在各自电脑上。别的电脑看它，照旧走 `/d/<设备>/api/*` 转发。

#### 账号与登录

- 不登录：和现在一样单机用，不连中继，飞书照旧本机一个应用，不需要租约。
- 登录：网页“设置 → 账号与设备”点“用 GitHub 登录”，或在终端跑 `node src/mesh/main.ts login`（服务器上用）。步骤：
  1. 守护进程向 GitHub 要设备码，显示 8 位码和 `github.com/login/device`，按 GitHub 给的间隔轮询，拿到 access token（scope 为空，只能读公开资料）。
  2. 连同本机设备证书、设备编号、名字、系统，发给中继 `POST /v1/register`。
  3. 中继调 GitHub `GET /user` 拿数字 id，算出账号编号 `acct_` + SHA-256(`github:<id>`) 的前 26 位 base32，把这台记进账号：账号里第一台直接“可用”，之后的“等批准”。中继用完就丢掉 GitHub token，不存。
  4. 守护进程也不存 GitHub token，只存 `state/account.json`（0600）：中继网址、账号编号、登录名和数字 id、本机在账号里的状态。
- 之后连中继：中继发一个随机数，设备用设备私钥签名，中继按账号里登记的证书验。不再用 GitHub。
- 退出：本机删 `state/account.json`，断开中继。在别的设备上“移除这台”效果一样。

#### 设备身份与信任

- 设备编号不变，还是 `state/device.json` 里的 UUID；网址 `/d/<编号>`、飞书群标记都继续用它。
- 首次登录时生成设备密钥：Ed25519 私钥和自签证书，证书的 CN 写设备编号。存 `state/mesh/key.pem`（0600，加进 `READONLY_SECRET_STATE_FILES`）和 `state/mesh/cert.pem`。设备指纹是证书 DER 的 SHA-256。
- 信任表：`state/peers.json` 升到 v2，每台记 `{ id, name, platform, certPem, fingerprint, approvedBy, since }`。去掉 `url`、`transport`、两把令牌和 `pending`。TLS 握手时对方证书的指纹要在表里，且证书 CN 等于表里记的设备编号，否则断开。读到老的 v1 文件时备份成 `peers.v1.json`，从只有本机的表开始，老设备重新登录批准一次。
- 批准（拍板 2 选 A）：
  1. 新设备 N 登录后，在中继里是“等批准”：只能和账号里“可用”的设备互发批准用的小消息（`signal`，单条最多 4 KB），不能被拨号。
  2. 中继通知账号里在线的设备“N 想加入”。每台的网页设置里出一条请求；中心那台同时往总助单聊发一张“新电脑请求加入”卡。
  3. 你在某台 A 上点“核对”。A 和 N 经中继交换随机数：先发随机数的哈希，等对方的到了再亮出原数，中继没法凑出想要的结果。两边各算核对码 = SHA-256(两个指纹 + 两个随机数) 取 6 位十进制，A 和 N 的屏幕（网页、终端或飞书卡片）同时显示。
  4. 两边都点“一致”：A 把 N 写进信任表，用 A 的私钥签一份“A 批准 N”发给其他可信设备，它们核对签名人在自己的信任表里才收下；A 经 TLS 把整张信任表发给 N；A 告诉中继把 N 改成“可用”。任一边点“不一致”或 10 分钟没点完，这次作废。
  - 为什么两边都要点：中继转发所有消息，它能同时冒充双方。只有两块屏幕上的数字一样，才说明双方拿到的都是对方真实的证书。
- 移除：任一台可信设备上点“移除”：本机删掉，签一份“撤销 N”发给其他可信设备，再告诉中继删掉 N，中继立刻不再给它转发。被移除的设备下次连中继收到 `removed`，自己清空账号状态。设备丢了，在任一台点移除即可；局域网直连也握不过手，因为别的设备都删了它的指纹。

#### 连法：局域网直连优先，中继兜底

- 每台守护进程多听一个 TCP 端口（`MESH_LISTEN_PORT`，默认 4320，IPv4 和 IPv6 的所有地址），只说 TLS 1.3，要求对方出示证书，ALPN 是 `fusa-mesh/1`。握手后查对方指纹在不在信任表里，不在就断。这个端口暴露在局域网里是安全的，没有可信证书什么也做不了（同 Syncthing 的 22000 端口）。
- 每台连上中继后报自己的局域网候选地址：`os.networkInterfaces()` 里的私有 IPv4、ULA 和链路本地 IPv6，加上端口，最多 8 个。每 30 秒比一次，变了再报。中继只转给同账号的设备。
- 拨号 `dial(设备)`：先对候选地址并发做 TCP + TLS，直连先跑 250 毫秒；没成就同时经中继拨，谁先握手成功用谁，另一条关掉。直连失败的设备 60 秒内不再试直连。
- 经中继拨号：A 在控制连接上发 `dial { to: N, channel }`，channel 是 A 生成的 128 位随机数；中继给 N 推 `incoming { from: A, channel }`；A、N 各开一条 WebSocket 连 `/v1/accounts/<账号>/channels/<channel>`；中继把两条配成一对，之后收到的二进制帧原样转给对面（单帧最多 64 KB）。A 在这条字节流上当 TLS 客户端，N 当 TLS 服务端，和直连一样。
- TLS 里面跑 HTTP/1.1。守护进程把握手成功的连接交给一个专给组网用的 `http.Server`（照 `listenSide` 的写法，`src/daemon/ui-server/server.ts:2098`），请求记成 `meshEntry` 入口并带上对方设备编号，再交给同一个 Fastify。现有的 `/api/*`、WebSocket、`/api/peer/*` 原样可用。
- 发起方：`/d/<设备>/api/*` 转发、总助跨设备派活、飞书转发都用一个 `node:http` 的 `Agent`，重写它的 `createConnection`（Node 支持回调形式，可以异步）从 `dial()` 拿连接，按设备复用 keep-alive；ws 客户端传同一个 `agent`。现在 unix socket 那条路就是这么用 `http.Agent` 的（`src/daemon/peers/transport.ts:208`）。
- 规则照旧：从组网入口进来的请求不能再用 `/d/` 去第三台，也不能碰 `ENTRY_ONLY_API_PREFIXES`。

#### 中继

- 两个外壳共用 `src/relay/core.ts`，核心只用 WebCrypto、`fetch` 这类 Web 标准 API：
  - Cloudflare：Worker 处理 `/v1/register`（验 GitHub），再按账号编号把连接交给该账号的 Durable Object。每账号一个 DO，用 SQLite 存储（免费档只开放这种），WebSocket 用休眠 API 接，协议层 ping 用 `setWebSocketAutoResponse` 自动回，不唤醒 DO、不计费。
  - 自建 Node：`node src/relay/node/main.ts --port <端口>`，用已有的 `ws` 和 `node:sqlite`，可以放在 Caddy / nginx 后面加 TLS。
- 账号 DO 落盘的只有设备表（编号、名字、系统、证书、状态、加入时间）和中心顺序。在线状态、候选地址、租约都放在内存和 WebSocket 的 attachment 里，不写盘（Cloudflare 按写入行数计费，休眠醒来从 attachment 恢复）。
- 中继看得到的：GitHub 数字 id 和登录名，设备编号、名字、系统、证书，在线状态，局域网地址，谁拨了谁、流量多大，中心顺序，谁持有租约。看不到的：对话、代码、文件、飞书凭证、设备之间任何 HTTP 的内容。
- 防刷（数都写在 `src/shared/limits.ts`，见「性能」节）：
  - 注册：每个 IP 每分钟 10 次；每个账号最多 20 台设备；等批准的设备 10 分钟没批就删掉。
  - 控制消息：单条最多 16 KB，`signal` 最多 4 KB；每台每秒最多 20 条，超了断开。
  - 数据通道：每台同时最多 32 条；单帧最多 64 KB；每个账号每天最多 4 GB，超了当天拒绝新通道；通道 5 分钟没有数据就关。
  - 只有同账号、状态“可用”的设备之间能拨号、发 `signal`。等批准的设备只能和可用设备互发批准消息。
  - 账号编号不当秘密。连控制连接必须用账号里登记过的设备私钥签名。
- 开源和密钥：仓库里只有中继网址和 GitHub OAuth App 的 Client ID，都是公开值。中继没有服务端密钥。Cloudflare 部署凭证在维护者本机的 `wrangler login` 里，不进仓库。
- 自建：设置里填中继网址，或设环境变量 `FUSA_RELAY_URL`。同一账号的所有设备要用同一个中继，换中继要重新登录。

#### 中心顺序与租约

- 中心顺序是账号级设置，一个设备编号列表，存在中继的账号 DO 里。网页“设置 → 账号与设备”里用上移、下移排序；没服务器的用户就只排两台家用电脑。新登录的设备默认排最后。不在列表里的设备从不挂飞书长连接。
- 租约由账号 DO 裁决，租约名是 `feishu`（以后接 Slack 用另一个名字，各管各的）：
  - 有飞书凭证、且在中心顺序里的设备是候选。候选每 `MESH_LEASE_RENEW_MS`（5 秒）发一次 `lease.claim`，持有者发的 claim 就是续约。
  - DO 每收到一条消息先看租约：持有者超过 `MESH_LEASE_TTL_MS`（15 秒）没续约就作废。没人持有时，授予“中心顺序里排最前、15 秒内 claim 过的候选”，推给它 `lease { holder, epoch }`，`epoch` 每次授予加 1。
  - 排得更靠前的候选回来了：DO 给现持有者推 `lease.yield`，它关掉飞书长连接后回 `lease.release`，DO 马上授予排前的那台。现持有者 5 秒内没回，就等它的租约到期再授予。
  - 持有者的控制连接正常关闭（守护进程退出、`hub self-reload`）：DO 在 `webSocketClose` 里马上改授下一台。
- 持有者自己掐断：持有者用单调时钟记最后一次收到续约回执的时刻，超过 `MESH_LEASE_TTL_MS - MESH_LEASE_FENCE_MARGIN_MS`（10 秒）没收到，就先关飞书长连接，再接着 claim。DO 那边要满 15 秒才改授，所以正常情况下两台不会同时连着。
- 接管时间：守护进程退出这类正常断开，下一台 1 到 2 秒内连上飞书；合盖、断网这类不声不响的断开，最长约 20 秒（15 秒租约 + 最多 5 秒等下一次 claim）。
- 短暂双连也不出错：飞书长连接是集群模式，每个事件只投给其中一条连接（`docs/feishu-design.md:85`）；收到的那台照样按群转给归属电脑，归属电脑按 `feishu:<message_id>` 只记一次。双连唯一的影响是总助单聊的话可能落到两台的总助上。所以租约的作用是“谁当中心由你定、可预测”，不是正确性的唯一防线。
- 中继连不上时：持有者 10 秒后掐断。中继连不上超过 `MESH_LEASE_ORPHAN_MS`（60 秒）时，中心顺序排第一的那台自己挂上长连接（降级），中继恢复后照租约来；这期间转给别的电脑的消息走局域网直连，走不通就按离线处理。网页和本机 agent 不受影响。

#### 飞书：一个机器人，按群转给归属电脑

- 凭证：全账号一份 App ID / App Secret。在任一台扫码接入后，经组网推给所有可信设备，各自写 `state/feishu-secrets.json`（0600）和 `feishu_app` 一行（同一个机器人，同一个主人 open_id）。中继看不到。新批准的设备由批准它的那台推一份。在任一台点“断开飞书”，也推给所有设备。
- 出站不变：每台照现在的飞书服务，自己建自己项目经理的群（群说明带本机设备编号），自己把账本变化投影成卡片、流式回复、文件，直接调飞书接口，不经中心和中继。
  - 共用配额：飞书“流式更新文本”接口按应用每秒 50 次。现在每台用 `FEISHU_CARDKIT_BUDGET_PER_SECOND`（40 次），改成按“接着飞书的设备数”平分，每台最少 5 次（`feishuCardkitBudgetShare`）。一个群只属于一台电脑，“每个群每秒 5 条”不用改。
- 入站只有中心收。中心收到一个事件：
  - 总助单聊：交给本机总助，总助派活本来就能派到任何设备。只有中心把自己的总助对话投影到单聊，非中心的总助对话不往单聊发。中心换了，单聊里回话的就是新中心的总助；各台网页上的总助记录各自保留。
  - 项目群：先查群归属。查法依次是：内存缓存（`lru-cache`，最多 `FEISHU_CHAT_CACHE_MAX` 个），各台对齐群后经组网广播的 `{ 群 → 设备, 项目经理 }`，都没有就调 `chat.get` 读群说明里的标记。
    - 归属是本机：照现在处理。
    - 归属电脑在线：经组网 `POST /api/peer/feishu/inbound` 把原始事件转过去，那台当成自己长连接收到的事件处理，附件由它自己用凭证下载。转发失败按离线处理。
    - 归属电脑离线：在群里回一句，按拍板 3 决定存不存。
    - 认不出（不是 Fusa 建的群）：不处理，和现在一样。
  - 卡片点击（拍板、停止、访客档位）：同样按群转。卡片回调要 3 秒内回 toast：中心转过去后最多等 `FEISHU_FORWARD_CARD_TIMEOUT_MS`（1.5 秒）拿归属电脑算出的 toast，超时回“已收到，正在处理”；归属电脑离线回“「Mac」离线，上线后再点”。
  - 成员进出、群解散、机器人被移出：按群转给归属电脑；离线就丢掉，它上线后对齐时会重新对账。
- 暂存（拍板 3 选 A）：中心把要转给离线电脑的消息存进 `feishu_offline_inbox`（每台最多 `FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE` 条，存 `FEISHU_OFFLINE_INBOX_TTL_MS`）。归属电脑上线（中继推在线状态）后，中心按收到的顺序转过去，事件带上原来的接收时间，归属电脑在正文前加“（离线期间 11-19 14:02 发的）”。过期的删掉，并在群里回一句“这几句过了 24 小时没送到”。中心换了，新中心不接手旧中心的暂存，旧中心上线后自己接着送。选 B 时不建这张表。

#### 网页

- “设置 → 设备”改成“账号与设备”：登录（显示 GitHub 码）、设备列表（名字、系统、在线、连法“局域网 / 中继”、最后在线）、等批准的请求（核对码，一致 / 不一致）、中心顺序（上移、下移排序，标出当前中心）、移除、退出、中继网址（高级）。
- `GET /api/devices` 每台多 `online`、`link`、`fingerprint`；去掉 `url`、`transport`。
- 删掉：邀请码、按网址添加设备、隧道向导、公网入口页。手机不再有网页入口，手机用飞书。

#### 实现时要改的已有签名

骨架没有改现有签名（改了要连带改运行时行为），下面这些由实现步骤改，调用方一起改：

- `src/daemon/peers/store.ts:31` `PeerRecord`：换成信任表记录（见上）。`PeersOptions`（`service.ts:143`）去掉 `selfUrl`、`allowLoopback`、`tunnelsFile`、`hubSocket`、`reconnectTunnel`、`procNet`，加 `mesh: MeshDialer`、`trust: MeshTrust`。
- `src/daemon/peers/proxy.ts:52` `ProxyTarget`：去掉 `url`、`token`、`resolve`、`unixPool`，改成 `{ name, agent }`，`agent` 是 `MeshDialer.agentFor(设备)`；`router/target-port.ts:555` 同改。
- `src/shared/api.ts` `DeviceInfo`：见上节。
- `src/daemon/ui-server/server.ts:300` `Listener`、`Entry`：只剩 `uiPort` / `loopback` 和新的 `meshEntry` / `mesh`；`Identity` 的 `deviceToken`、`invite` 换成 `meshDevice`（来自 TLS 证书）。
- `src/daemon/feishu/transport.ts:123` `onCardAction` 的返回值改成 `FeishuCardActionResponse | Promise<FeishuCardActionResponse>`。
- `src/daemon/feishu/service.ts:152` `FeishuService` 多实现 `account-bot.ts` 的 `FeishuLocalInbound`（本机处理事件和点击、往群里说一句、读群说明），再加 `useAccountBot(bot)`：接上后长连接收到的事件交给 bot 分流。`FeishuServiceOptions`（`:130`）加 `lease?: CenterLease`，有它时 `start()` 只在持有租约时连长连接，非中心不把总助对话投影到单聊。

## 性能

1. **失效。**
   - 在线状态和候选地址：中继在设备上下线、候选变化时推送；守护进程不轮询。控制连接断了，本机把所有远端标成“不确定”，重连拿到新的在线表再刷新。
   - 直连失败只记 `MESH_DIRECT_RETRY_MS`（60 秒），之后重试直连；网络变化（候选地址变了）时清掉。
   - 拨号缓存的 keep-alive 连接：对方被移除、指纹变了、对方下线时关掉。
   - 信任表：只由本机写；收到别的设备的批准、撤销时改文件并清相关连接。
   - 群归属缓存：收到归属广播、租约换手、归属电脑重启（广播里带启动编号）时更新；`chat.get` 失败只记 `FEISHU_MEMBERS_RETRY_MS`。
   - 中继 DO：在线、租约放内存，DO 休眠醒来从 WebSocket attachment 恢复；设备表、中心顺序落盘，改了就推给账号里的在线设备。
2. **上限。** 准备加进 `src/shared/limits.ts` 的常量（骨架已加）：

| 常量 | 值 | 怎么算的 |
| --- | --- | --- |
| `MESH_LISTEN_PORT` | 4320 | 现有 4317 界面、4319 设备入口之后的空号；4319 随隧道一起删 |
| `MESH_MAX_DEVICES_PER_ACCOUNT` | 20 | 个人几台到十来台，留一倍；和中继防刷共用 |
| `MESH_CANDIDATES_MAX` | 8 | 一台电脑常见 1 到 3 块网卡，每块 IPv4 + 1 到 2 个 IPv6 |
| `MESH_CANDIDATES_REFRESH_MS` | 30 秒 | 换 Wi-Fi 后半分钟内重报，平时每台每分钟两次比对，不发消息 |
| `MESH_DIRECT_HEAD_START_MS` | 250 | 局域网 TLS 握手通常几毫秒到几十毫秒；超过 250 毫秒多半不在一个网 |
| `MESH_DIRECT_RETRY_MS` | 60 秒 | 直连失败不反复试，网络变了立刻清 |
| `MESH_DIAL_TIMEOUT_MS` | 10 秒 | 同 `PEER_WS_CONNECT_TIMEOUT_MS` |
| `MESH_RELAY_BACKOFF_MIN_MS` / `MESH_RELAY_BACKOFF_MAX_MS` | 1 秒 / 60 秒 | 同隧道退避 |
| `MESH_LEASE_TTL_MS` / `MESH_LEASE_RENEW_MS` / `MESH_LEASE_FENCE_MARGIN_MS` | 15 秒 / 5 秒 / 5 秒 | 接管最长约 20 秒；每台候选每天 17,280 条 claim，按 20:1 计 864 次请求 |
| `MESH_LEASE_ORPHAN_MS` | 60 秒 | 中继真挂了才降级，网络抖一下不降级 |
| `MESH_APPROVAL_TTL_MS` | 10 分钟 | 同现在的邀请码 |
| `MESH_SAS_DIGITS` / `MESH_SAS_NONCE_BYTES` | 6 / 32 | 中继凑中的概率百万分之一；随机数 256 位，猜不到 |
| `RELAY_MAX_CONTROL_FRAME_BYTES` / `RELAY_MAX_SIGNAL_BYTES` | 16 KB / 4 KB | 设备表 20 台约 20 × 700 字节（证书）；批准消息几百字节 |
| `RELAY_MAX_DATA_FRAME_BYTES` | 64 KB | 一个 TLS 记录最大 16 KB，攒几个再发；远低于 32 MiB 上限 |
| `RELAY_CONTROL_FRAMES_PER_SECOND` | 20 | 正常每秒不到 1 条 |
| `RELAY_MAX_CHANNELS_PER_DEVICE` | 32 | 浏览器看 3 台 × 每台约 6 条 keep-alive + WebSocket，留余量 |
| `RELAY_ACCOUNT_DAILY_BYTES` | 4 GB | 每天传 100 个 20 MB 附件 + 全天看远端网页也不到 1 GB |
| `RELAY_CHANNEL_IDLE_MS` | 5 分钟 | keep-alive 空闲连接本来几十秒就关 |
| `RELAY_CHANNEL_ACCEPT_TIMEOUT_MS` | 10 秒 | 同 `MESH_DIAL_TIMEOUT_MS` |
| `RELAY_REGISTER_PER_IP_PER_MINUTE` | 10 | 正常一次登录 1 次 |
| `RELAY_PENDING_DEVICE_TTL_MS` | 10 分钟 | 同批准时限 |
| `FEISHU_FORWARD_CARD_TIMEOUT_MS` | 1.5 秒 | 卡片回调 3 秒内必须回，`FEISHU_CARD_ACTION_DEADLINE_MS` 2.5 秒里留 1 秒给中心自己 |
| `FEISHU_FORWARD_TIMEOUT_MS` | 10 秒 | 普通事件转发，超时按离线 |
| `FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE` / `FEISHU_OFFLINE_INBOX_TTL_MS` | 50 / 24 小时 | 一晚上随手吩咐几句到几十句 |
| `FEISHU_CARDKIT_MIN_SHARE_PER_SECOND` | 5 | 平分后每台至少每秒 5 次，单个对话 300 毫秒一推够用 |

   其他会变多的：信任表最多 `MESH_MAX_DEVICES_PER_ACCOUNT` 行；中继 DO 的内存在线表同上限；拨号连接池按设备数封顶；`feishu_offline_inbox` 最多 20 × 50 = 1,000 行，过期由现有保留清理删；`GET /api/devices` 最多 20 台，不需要压缩。中继请求量估算：空闲时每台候选每天 864 次，3 台约 2,600 次；重度使用（网页全天看远端设备，转发 WebSocket 5 秒一次 ping，约 1,700 次；每天 1 小时流式回复约 1,800 次）合计约 6,000 次。走局域网直连的流量不经中继，不计。
3. **前端引用稳定。** “账号与设备”的数据用 `@tanstack/react-query` 拉 `GET /api/account`，中继推变化时由现有 `/api/ws` 推 `account.updated` 让查询失效，不轮询。设备列表的 selector 按输入数组用 `WeakMap` 缓存（照 `src/web/selectors-cache.test.ts`）。`DevicesStore` 只在 `online`、`link` 真变了时换新对象。
4. **验证。** 实现步骤用 pstack 的 `benchmark-checklist` 量，数字写进 PR：同一局域网直连和经中继打开远端 `/api/state` 的耗时；远端流式回复每段的额外延迟；拔掉中心网线到飞书单聊有回复的秒数；Cloudflare 后台 24 小时空闲的请求数和 DO 时长；守护进程开组网前后的 RSS。`blast-radius` 列出 `PeerRecord`、`ProxyTarget`、`DeviceInfo`、`onCardAction` 的调用方。

## 统一

- **厂商。** 组网在账本和驱动之下，只搬字节；飞书路由只看群和设备。`src/shared/vendors.ts` 里的所有厂商都一样走。以后加一家新厂商，组网、中继、飞书路由都不用改文件。
- **三个平台。** 用到的只有 Node 自带的 `tls`、`net`、`os.networkInterfaces()`，加已有的 `ws`，macOS、Windows、Linux 一样。Windows 从此和 Mac、Linux 一样能加入（原来卡在 ssh 和 unix socket）。平台差异只有一处，放在 `src/daemon/platform/`：首次监听局域网端口时系统防火墙会问（Windows Defender 防火墙、macOS 应用防火墙）。Windows 安装包里给 `fusa` 的 node 加一条“专用网络”入站规则；没放行时直连失败，自动走中继，功能不缺。`platform/tailscale.ts`、`platform/tailnet.ts` 删掉。
- **一处定义。** 设备和中继之间的消息只在 `src/relay/protocol.ts`，守护进程和中继共用；选中心只在 `pickCenter`（`src/shared/mesh.ts`），中继裁决和网页显示都用它；核对码只在 `meshSasCode`；可调的数只在 `src/shared/limits.ts`；证书库只在 `src/daemon/mesh/identity.ts` 里引；飞书按群分流只在 `routeAccountInbound`。
- **以后接 Slack。** 租约按名字分，Slack 用自己的租约名，中心顺序共用。按群转给归属设备这件事和聊天软件无关；真接 Slack 时再把 `routeAccountInbound`、`FeishuForwardedEvent` 抽成与平台无关的一份。现在只有飞书，不提前抽。

## 删掉什么

impl-mesh 的 PR 里删（新旧不并存）：

- **SSH 隧道。** `src/daemon/tunnel/` 整个目录（`ssh-args.ts`、`supervisor.ts`、`service.ts`、`table.ts`、`test-fake-ssh.mjs` 和测试）。其中 `admin.ts` 的管理 socket 和 `/feishu/*` 路由搬到 `src/daemon/admin/socket.ts`，`/tunnel/*` 路由删掉。`src/tunnel/`（`cli.ts`、`main.ts`、`cli.test.ts`），其中 `admin-client.ts` 搬到 `src/admin/client.ts` 给飞书命令用。`src/shared/tunnel.ts`、`scripts/tunnel-sshd.sh`、`scripts/verify-tunnel-sshd.sh`，`scripts/stage-runtime-common.ts` 里打包它们的条目，`src/shared/limits.ts` 的 `TUNNEL_*` 和 `DEFAULT_PEER_ENTRY_PORT`，`src/shared/paths.ts` 的 `tunnelDir`、`tunnelsFile`、`tunnelHubSock`、`peerSock`，`src/daemon/peers/transport.ts`、`src/daemon/peers/tunnel-peers.test.ts`，界面服务的 `peerEntry` 入口和 `src/daemon/ui-server/peer-entry.test.ts`。
- **Tailscale。** `src/daemon/platform/tailscale.ts`、`tailnet.ts`，`daemon.ts:763-765`、`:958-965` 的 tailnet 探测和 serve 提示，界面服务的 `tailnet` 入口和 `serveSocket`，`TAILSCALE_USER_LOGIN_HEADER`，`src/daemon/peers/url.ts`，`ENV_TAILNET_OWNER`。
- **手机公网入口。** `src/daemon/ui-server/public-entry.ts`，界面服务的 `public` 入口和 `publicSock`，`PublicEntryStatus`、`SetPublicEntryRequest`，浏览器会话里的 `viaPublic` 和公网待批准逻辑（`src/daemon/ui-server/sessions.ts`），`src/web/mobile/settings/PublicAccessPage.tsx`。
- **旧配对。** `src/daemon/peers/invites.ts`、`tokens.ts`；`PeerRecord` 的令牌和 `pending`；`AddDeviceRequest`、`DeviceInviteResponse`、`PeerPairResponse`、`PeerIntroductionResponse`；`POST /api/peer/pair`、`/api/peer/introductions`、`/api/peer/invites`；`PEER_INVITE_*`、`PEER_TOKEN_BYTES`、`PEER_PENDING_TTL_MS`。`src/shared/peer-transport.ts` 整个换成 `src/shared/mesh.ts` 的 `MeshLinkKind`。
- **网页。** `src/web/components/DeviceSettings.tsx` 里的邀请、按网址添加、隧道向导、公网入口；`src/web/mobile/settings/ComputersPage.tsx` 里的同类部分。
- **测试。** `test/e2e/multi-device.test.ts`（邀请码配对的端到端，由 `test/e2e/account-mesh.test.ts` 取代），`test/e2e/loopback-daemon.ts` 和 `DaemonOptions.allowLoopbackPeers`，`src/daemon/peers/pairing.test.ts` 里邀请码和令牌的用例。
- **文档。** 删 `docs/hub-tunnel-design.md`；`docs/multi-device-design.md` 删第 2、3.1–3.3、8 节（Tailscale），开头指向本文；`docs/linux.md` 删 tailscale serve 部分；`docs/mac-app-and-mobile-design.md` 的公网入口一节删掉；`docs/feishu-design.md:22`“每台各扫一次码”改成指向本文。`AGENTS.md`「我们用的组件」加 `@peculiar/x509`（守护进程）、`wrangler`（开发依赖，部署中继）。

impl-feishu 的 PR 里改：`docs/feishu-design.md` 的“断线与补发”“总助”两段补上中心和非中心的区别。

东京上的旧配置不在仓库里，迁移时手动清（拍板 5 选 A；确认东京已经在新组网里之后再跑）：

```
node ~/agent-hub/src/tunnel/main.ts remove --name mac   # 用旧代码先收回槽位、断开会话
sudo rm -f /etc/ssh/sshd_config.d/agent-hub-tunnel.conf
sudo rm -rf /etc/ssh/agent-hub-tunnel
sudo userdel agenthub-tunnel
sudo sshd -t && sudo systemctl try-reload-or-restart ssh.service
rm -f ~/.agent-hub/state/tunnels.json && rm -rf ~/.agent-hub/state/tunnel
```

Mac 上删 `~/.agent-hub/state/tunnels.json` 和 `state/tunnel/`。

## 骨架文件

- `src/shared/mesh.ts`：账号编号、设备指纹的品牌类型和解析；连法 `MeshLinkKind`；账号状态接口的形状；`pickCenter`（选中心）；`meshSasCode`（核对码）。
- `src/relay/protocol.ts`：设备和中继之间的控制消息、数据通道路径、编解码。
- `src/relay/auth.ts`：中继验 GitHub token、算账号编号、验设备签名。
- `src/relay/core.ts`：一个账号的中继逻辑（注册、登入、在线、拨号配对、`signal` 转发、中心顺序、租约裁决、限流），外壳只负责收发。
- `src/relay/node/server.ts`、`src/relay/node/main.ts`：自建版外壳和它的命令。
- `src/relay/cloudflare/worker.ts`：Cloudflare Worker + 账号 Durable Object 外壳（实现时加 `wrangler.toml` 和 Workers 的类型包，这个文件从根 `tsconfig.json` 挪到自己的 tsconfig）。
- `src/daemon/mesh/identity.ts`：设备私钥和自签证书，指纹。
- `src/daemon/mesh/account.ts`：GitHub 设备码登录、`state/account.json`、退出。
- `src/daemon/mesh/trust.ts`：信任表、批准仪式、签名的批准和撤销。
- `src/daemon/mesh/relay-client.ts`：守护进程到中继的控制连接和中继数据通道。
- `src/daemon/mesh/dialer.ts`：局域网优先、中继兜底的拨号，TLS 钉指纹，组网入口的监听。
- `src/daemon/mesh/lease.ts`：中心租约在设备这一侧的状态机（持有、让出、自己掐断、降级）。
- `src/daemon/mesh/index.ts`：对外导出，`Mesh` 是守护进程其余部分唯一要认的组网接口。
- `src/mesh/cli.ts`：服务器上用的终端命令（`login`、`status`、`approve`、`priority`、`remove`、`logout`），实现时照 `src/feishu/main.ts` 加 `src/mesh/main.ts`。
- `src/daemon/feishu/account-bot.ts`：群归属、入站分流 `routeAccountInbound`、转发事件的形状、离线提示、暂存箱、配额平分。
- `migrations/0041_feishu_offline_inbox.sql`：暂存箱表（拍板 3 选 B 时实现步骤删掉这个迁移和暂存箱）。
- `src/shared/limits.ts`：上表的常量。
- `src/shared/index.ts`：导出 `mesh.ts`。
- `vitest.config.ts`：node 项目的 include 加 `src/relay/**`、`src/mesh/**`（不加这两行，这两个目录的测试不会跑）。`src/relay/cloudflare/worker.test.ts` 实现时挪到 Workers 运行时里跑（Cloudflare 官方的 vitest 集成，单独一个 vitest 项目）。
- 测试骨架：`src/shared/mesh.test.ts`、`src/relay/protocol.test.ts`、`src/relay/auth.test.ts`、`src/relay/core.test.ts`、`src/daemon/mesh/identity.test.ts`、`account.test.ts`、`trust.test.ts`、`relay-client.test.ts`、`dialer.test.ts`、`lease.test.ts`、`mesh.test.ts`、`src/daemon/feishu/account-bot.test.ts`、`src/mesh/cli.test.ts`，以及端到端 `test/e2e/account-mesh.test.ts`。

## 验收方法

- **单元测试。** 每个 `it.todo` 改成真断言后全绿。重点：`pickCenter` 和中继租约裁决（排前的回来要让、持有者掉线 15 秒后改授、正常关闭立刻改授、同一时刻只授一台）；`stepCenterLease` 的自己掐断时刻；`meshSasCode` 换顺序结果相同、任一输入变了结果变；批准仪式里中继替换任一方证书时两边核对码不同；信任表拒绝 CN 和编号对不上的证书；`routeAccountInbound` 的本机、转发、离线、认不出四种；中继拒绝跨账号拨号、等批准设备被拨号、超限的帧和通道。
- **端到端。** `test/e2e/account-mesh.test.ts`：起一个本机 Node 中继和三个守护进程（端口 0、各自数据目录、假的 GitHub 接口），三台登录同一账号并完成批准；从第一台的网页经 `/d/` 打开另外两台的对话、发消息、收到回复；回环地址当局域网候选时连法显示 `lan`，屏蔽候选后显示 `relay`；停掉一台，另两台 15 秒内显示离线；用假飞书传输层：消息发到第二台的项目群，第二台账本里出现这条；停掉持有者，20 秒内下一台持有并接着收；第二台离线时发的话进暂存箱，第二台上线后送达。
- **真机。** Mac + 东京 + 一台 Windows（没有就用 Windows 虚拟机），证据贴进 PR：
  1. Windows 登录、在 Mac 上核对 6 位数、Windows 出现在三台的设备列表里（录屏 mp4）。
  2. Mac 和 Windows 在同一 Wi-Fi 时连法显示“局域网”，Mac 和东京显示“中继”（截图 `docs/screenshots/account-mesh/`）。
  3. 自建 Node 中继打开调试日志，打印每条数据帧前 8 个字节，全是 TLS 应用数据记录（首字节 `0x17`），搜不到明文（日志片段）。
  4. 中心顺序“东京 → Mac”：停掉东京守护进程，飞书单聊发一句，记从停掉到 Mac 回复的秒数；再合上 Mac 盖子（东京已恢复）重复一次（守护进程日志，两次都不超过 25 秒）。
  5. Mac 合盖时在 Mac 的项目群里说一句：立刻收到离线提示；开盖后项目经理收到这句并回复（录屏）。
  6. Cloudflare 后台 24 小时空闲的请求数和 DO 时长（截图），和「性能」节的估算比对。
  7. 只读 Worker 里 `cat state/mesh/key.pem` 被拒（命令和输出）。
