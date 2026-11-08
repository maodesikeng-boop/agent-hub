# 联机方案（二）：东京当中心，设备用 SSH 连入；手机走东京公网 HTTPS

状态：方案，待拍板（第 12 节）。接着 `docs/multi-device-design.md`（下称“联机方案”），P2 配对 / 转发（`daemon/peers/`）已合。
不改的：数据不动、入口转发 `/d/<设备>/api/*`、设备令牌、每个浏览器一条会话（联机方案第 2、3 节）全部照旧；Tailscale 连法保留为可选。

## 0. 目标和不做的

- 目标：一个网页管 Mac 和东京；手机能看、能聊、能收推送。**手机、Mac 都不装 Tailscale、不占 VPN。**
- 第一期：Mac（以及以后的 Linux）用系统自带 `ssh` 主动连东京，`-R` 让东京找到它、`-L` 让它找到东京。东京不开新端口、不装新软件（只用已开的 22）。
- 第二期：东京开一个公网 HTTPS 入口给手机，只对已登录的浏览器有用。
- 不做：设备之间直接打洞；第三台设备经东京中转（第 2 节末尾，单列一块以后做）；Windows 当连入方。

## 1. 现成做法和取舍

| 做法 | 怎么回事 | 选不选 |
|---|---|---|
| 系统 OpenSSH `-N -R/-L` + `ServerAliveInterval` + `ExitOnForwardFailure` | macOS、Ubuntu 自带；东京 OpenSSH 9.6p1 支持 `restrict`、`permitlisten`、`permitopen`（sshd(8) AUTHORIZED_KEYS FILE FORMAT，<https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT>） | **选**：零安装、零新端口，密钥级权限够细 |
| autossh | 只是“ssh 死了就重启”的外壳；它的说明里也推荐 `-M 0` 改用 ssh 自己的 ServerAlive（<https://www.harding.motd.ca/autossh/>） | 不选：macOS 没自带；重启逻辑守护进程自己写几十行，还能把状态报给网页 |
| frp（<https://github.com/fatedier/frp>） | 东京跑 frps、设备跑 frpc，自有认证 | 不选：要装两端软件、东京开新端口、多一套认证要维护 |
| Cloudflare Tunnel（cloudflared） | 设备出站连 Cloudflare，公网主机名映射到本机服务（<https://developers.cloudflare.com/tunnel/>） | 不选：要 Cloudflare 账号和域名、装 cloudflared；TLS 在 Cloudflare 边缘解开，**Cloudflare 能看到明文** |
| Orca 的远程服务器（<https://www.onorca.dev/docs/remote-servers>） | 推荐 Tailscale；明说“别把端口直接开到公网，用 Tailscale / WireGuard / SSH 转发 / 带认证的隧道”；配对链接 + 每个客户端一份授权 | 思路一致（本方案的设备令牌、每浏览器会话就是这一套）；它不解决“手机不装 Tailscale” |
| Tailscale serve（现有） | 联机方案第 2 节 | 保留为可选连法 |

## 2. 总体结构

```
Mac 浏览器 ─http://127.0.0.1:4317─▶ Mac 守护进程（入口）
                                     ├─ 本机 /api/*
                                     └─ /d/<东京>/api/* ─▶ unix:run/tunnel/hub.sock ═ssh -L═▶ 东京 127.0.0.1:4319（设备入口）
东京守护进程 /d/<mac>/api/* ─▶ 127.0.0.1:4401 ═ssh -R═▶ Mac unix:run/peer.sock（设备入口）
手机（第二期）─https─▶ 东京 Caddy :443 ─▶ unix:run/public.sock（公网入口）─▶ 同一个东京守护进程
```

- 一条 ssh 连接（Mac 发起，登录东京的专用用户 `agenthub-tunnel`）同时带 `-R` 和 `-L`。
- 每台守护进程现在有一个界面端口（东京 4318、Mac 4317），只给本机浏览器。本方案再加一个**设备入口**（第 4 节），隧道只接到它；第二期再加一个**公网入口**（第 9 节）。三个入口进同一个 Fastify，按“从哪个入口进来的”决定认什么。
- 东京找 Mac 用东京本地的回环端口（每台设备一个，4401 起）；Mac 找东京用 Mac 本地的 unix socket（0600，别的本机用户抢不了）。
- 两台以内（Mac + 东京）互相直连，第一期就够。第三台 Linux 也连东京时，它和 Mac 之间没有路：Mac 网页看它要经东京中转（东京把 `/d/<第三台>` 再转一跳）。这会放开 P2 的“设备令牌不能用 `/d/`”，单列实现块 F，第一期不做；第一期内手机 / 东京当入口就能看到全部设备。

## 3. 第一期：SSH 只能转发

每台连入设备一把**专用密钥**（守护进程生成 `state/tunnel/id_ed25519`，0600，无口令，只用于这条隧道）。东京上：

1. 专用系统用户 `agenthub-tunnel`（shell 是 `/usr/sbin/nologin`、无家目录写权限）。不用 `ubuntu`：OpenSSH 的 `permitopen` / `permitlisten` 只管 TCP，管不到 unix socket 转发；换成别的用户后，即使开了 socket 转发，它也读不了 `ubuntu` 名下 0600 的 `run/hub.sock`、`run/ui.sock`。
2. 公钥一行（文件放 `/etc/ssh/agent-hub-tunnel/authorized_keys`，root 所有，隧道用户改不了）：
   ```
   restrict,port-forwarding,permitlisten="4401",permitopen="127.0.0.1:4319",command="/usr/sbin/nologin" ssh-ed25519 AAAA… agent-hub:mac
   ```
   - `restrict`：关掉所有转发、PTY、agent/X11 转发、`~/.ssh/rc`；`port-forwarding` 只把 TCP 转发加回来。
   - `permitlisten="4401"`：这把钥匙只能在东京上听 4401（每台设备一个端口），抢不到别的设备的端口。
   - `permitopen="127.0.0.1:4319"`：只能连东京的设备入口，连不到 4318（浏览器端口）、22、别的服务。
   - `command=`：就算请求 shell / exec 也只跑 nologin。
3. sshd 片段 `/etc/ssh/sshd_config.d/agent-hub-tunnel.conf`（Ubuntu 24.04 默认 Include 这个目录），第二层兜底：
   ```
   Match User agenthub-tunnel
     AuthorizedKeysFile /etc/ssh/agent-hub-tunnel/authorized_keys
     AuthenticationMethods publickey
     AllowTcpForwarding yes
     AllowStreamLocalForwarding no
     GatewayPorts no
     PermitOpen 127.0.0.1:4319
     PermitTTY no
     X11Forwarding no
     AllowAgentForwarding no
     PermitTunnel no
     PermitUserRC no
     ForceCommand /usr/sbin/nologin
     ClientAliveInterval 15
     ClientAliveCountMax 3
   ```
   `GatewayPorts no` 让 `-R` 只听回环；`ClientAlive*` 让东京 45 秒内清掉死掉的旧连接（不然 Mac 重连时 4401 还被旧连接占着）。改完 `sshd -t` 校验再 `systemctl reload ssh`。
4. 验收（实现块 D）：在一次性 Ubuntu 24.04 容器里跑 sshd，验证这把钥匙：能 `-R 4401`、`-L →4319`；`-R 4402`、`-L →4318`、`-L →22`、`-L` 到 unix socket、要 shell、要 PTY 全部失败。

## 4. 第一期：隧道请求的信任边界

问题：经隧道到达的连接，在目标机器上来源都是 127.0.0.1（东京上是 sshd 连过来的，Mac 上是 ssh 客户端连 socket）。现有界面端口靠“来自本机 + Host 是 127.0.0.1 + Origin 同源 + cookie”认浏览器（`ui-server/server.ts` 的 `HOST_HEADER`、`ORIGIN_HEADER`、`isAuthenticated`），`serverInfoForClient` 还会因为来源是本机而给出“在 Finder 中显示”。隧道要是接到界面端口，Mac 上被盗的隧道钥匙就能碰到这些。

做法：**设备入口**，比照现有 `viaServeSocket`（`listenServeSocket` 另起一个 HTTP 服务，请求记进 WeakSet，再交给同一个 Fastify）：

- 守护进程多听一个：连入方（Mac、以后的 Linux）用 unix socket `run/peer.sock`（0600）；中心（东京）用 TCP `127.0.0.1:4319`（隧道用户要能经 sshd 连到它，而它读不了 `ubuntu` 的 socket）。可调的端口放 `shared/limits.ts`。
- 从设备入口进来的请求记进 `viaPeerEntry`，onRequest 第一道就分流：
  - 不带 `Authorization` 的一律 401（只有 `POST /api/peer/pair` 例外，它凭邀请码）；**cookie 完全不看**，`/auth`、静态文件、`/d/`、`ENTRY_ONLY_API_PREFIXES`（设备管理、浏览器登录、推送订阅）一律 403。
  - 不查 Host、Origin（设备令牌不会被浏览器自动带上，和现在设备请求不查 Origin 的理由一样）。
  - `clientAddress` 当成“不是本机”（同 `tailnetRequests`），不出 Finder 按钮。
- 界面端口反过来：中心上不再接受经 ssh 转来的流量（`permitopen` 已经挡住）；Tailscale 连法照旧可以在界面端口 / serve socket 上带设备令牌。
- 测试（实现块 A）：设备入口上带 cookie 的 `/api/state` → 401；`/auth`、`/`、`/d/x/api/state`、推送订阅 → 403；设备令牌 `GET /api/state` → 200；界面端口行为不变（现有测试全过）。

## 5. 第一期：防 SSRF，设备地址由本机配置

#155 审查堵掉的是“对方自报一个回环网址，入口就往那转”。隧道连法里设备地址本来就是回环 / socket，所以规则是：**隧道设备的地址只来自本机的隧道表，永远不从对方发来的数据里取**。

- 本机隧道表 `state/tunnels.json`（0600，和 `peers.json` 一样不进 sqlite）：
  - 中心（东京）：`slots: [{ port: 4401, name: "mac", keyFingerprint, deviceId: null | "<编号>" }]`。
  - 连入方（Mac）：`hub: { host, user, sshPort: 22, hostKey, listenPort: 4401, hubEntryPort: 4319, deviceId: null | "<东京编号>" }`。
- 设备记录加 `transport: "tailscale" | "ssh-tunnel"`。`ssh-tunnel` 的设备 `url` 为空，转发时按设备编号查隧道表得到“东京：`127.0.0.1:<slot.port>`；Mac：`run/tunnel/hub.sock`”。`normalizePeerUrl` 不改：对方发来的网址仍然只认 ts.net（测试入口另认回环）。
- 配对怎么改：
  1. 东京上 `hub-device tunnel add --name mac --pubkey …`（第 7 节）分配槽位 4401，同时生成一个**绑定该槽位**的邀请码（沿用 `invites.ts`：随机 128 位、10 分钟、用一次）。
  2. Mac 拿到连接码（含邀请码）后起 ssh，经 `-L` 调东京 `POST /api/peer/pair`。东京按**邀请码**把 Mac 的设备编号写进槽位 4401，不看请求里的网址；Mac 这边把东京编号写进 `hub.deviceId`。
  3. 之后的清单同步、介绍里出现的 `ssh-tunnel` 设备：不传地址；收到的一方只有在本机隧道表里有对应槽位时才能连它，否则只显示“经中心可见”（块 F）。
- 为什么另一台已配对设备 B 冒充不了 Mac：
  - B 的钥匙 `permitlisten` 只有 4402，sshd 不让它听 4401，东京发给 Mac 的令牌到不了 B 手里。
  - B 自报“我是 Mac 的编号”去配对 → 已有编号一律 409（P2 已有）；邀请码绑槽位且只能用一次。
  - B 在清单 / 介绍里替 Mac 报地址 → 隧道设备的地址不从对方数据取；报回环网址 → `normalizePeerUrl` 拒。
  - 东京本机别的进程趁 Mac 掉线去听 4401：需要已经能在东京上跑代码，那时东京本来就失守（和 Tailscale 连法同一假设）。Mac 侧用 0600 的 socket，别的用户抢不了。

## 6. 第一期：谁保持 ssh 常连

推荐：**守护进程自己起 ssh 子进程并看着**，不用 launchd / systemd。理由：隧道离开守护进程没意义（设备入口就是守护进程开的），一起起停最简单；状态能直接进 `/api/state` 推给网页（设置 → 设备）；Mac、Linux 同一份代码，不用分别写 plist 和 unit。守护进程本身已经由 launchd / systemd 拉起。

- 命令（只读本方案生成的文件，忽略用户 `~/.ssh/config`）：
  ```
  ssh -N -T -F /dev/null -i state/tunnel/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none
      -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=state/tunnel/known_hosts
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3
      -R 4401:<run/peer.sock> -L <run/tunnel/hub.sock>:127.0.0.1:4319 agenthub-tunnel@<host>
  ```
  `-F /dev/null` 连系统 ssh_config 也不读（ssh(1)：命令行给了配置文件就不读系统那份），免得用户配置里的 ProxyCommand、ControlMaster 混进来。东京主机公钥钉死在 `state/tunnel/known_hosts`（来自连接码）。参数拼装集中在一处（`daemon/tunnel/ssh-args.ts`）。
- 退避：子进程退出就重连，1→2→4…→60 秒封顶，连上稳定 60 秒后清零。`/d/<东京>` 转发连不上时立刻提前重连一次（省得等退避）。
- 状态：`connecting | connected | retrying(下次时间) | auth_failed | hostkey_mismatch`。看 ssh 的 stderr 分类：`Permission denied` → `auth_failed`、`REMOTE HOST IDENTIFICATION HAS CHANGED` → `hostkey_mismatch`，这两种不自动重试，网页上给“重试”按钮和原因；`remote port forwarding failed`（东京旧连接还占着 4401）→ 正常退避，45 秒内东京清掉旧连接。
- 各种情况：
  - **Mac 睡眠**：TCP 断，东京 45 秒内清掉 Mac 的会话，东京网页里 Mac 显示离线（现有 WebSocket 5 秒 ping 更早发现）。醒来后 ssh 自己 45 秒内发现（或 ssh 直接因网络错误退出），守护进程重连，通常醒来几秒到一分钟恢复。
  - **东京重启**：ssh 退出，Mac 按退避重连；东京守护进程由 systemd 拉起。重启期间 Mac 网页里东京离线，不影响本机。
  - **网络切换**（Wi-Fi ↔ 热点）：老 TCP 死掉，同上；ssh 不支持连接迁移，靠重连。
- 验收（块 C）：用假 ssh（测试里的脚本按指定退出码 / stderr 退出）测退避、状态分类、停止时杀子进程；参数拼装做快照测试；手动：关 Wi-Fi 30 秒再开，一分钟内恢复。

## 7. 第一期：设置步骤

用户最少要做的（加 Mac）：

1. Mac 网页：设置 → 设备 → “连到中心（SSH）”，填东京地址 `18.179.111.112`。守护进程生成专用密钥，显示一条命令（带公钥）：
   ```
   ssh -i ~/.ssh/lightsail-tokyo.pem ubuntu@18.179.111.112 'sudo agent-hub hub-device tunnel add --name mac --pubkey "ssh-ed25519 AAAA…"'
   ```
   用户在 Mac 终端里粘贴运行（用已有的管理员密钥代装；守护进程不读、不存管理员密钥）。
2. 这条命令在东京上：第一次时建 `agenthub-tunnel` 用户、写 sshd 片段并校验重载；追加公钥行；分配槽位；输出一行**连接码**（地址、东京主机公钥指纹、槽位端口、设备入口端口、邀请码）。
3. 用户把连接码贴回 Mac 网页 → 起隧道 → 自动配对 → 设备列表出现东京。

- 以后加第三台（Linux）：同样两步，槽位 4402。东京和它直连；Mac 看它等块 F（第 2 节）。
- 移除：东京网页或 `tunnel remove --name mac`：删公钥行、槽位、设备记录，并结束那条现存的 ssh 会话（删公钥不会断已建立的连接，按槽位端口找到 sshd 进程结束它）。设备令牌同时作废，应用层也立刻拒。
- 换钥匙：连入方“重新生成密钥”→ 重做第 1–2 步（`tunnel add` 对同名槽位替换公钥行，保留端口和设备编号）。

## 8. 统一：连法定义在一处

- `shared/peer-transport.ts`：`type PeerTransport = { kind: "local" } | { kind: "tailscale"; url } | { kind: "ssh-tunnel"; role: "hub" | "spoke" }`，加每种连法的显示名、能力（能不能当入口给手机、要不要身份头）。网页只读 `/api/state` 里每台设备的 `transport` 和 `tunnelStatus` 来显示，不写死。
- `daemon/peers/transport.ts`：`resolvePeerTarget(deviceId) → { kind: "tcp", origin } | { kind: "unix", socketPath }`。`proxy.ts`（fetch 用 undici `Agent({ connect: { socketPath } })`，ws 用 `socketPath` 选项）和配对、清单同步都改用它，不再直接拿 `url` 字符串。
- 平台差异只有：ssh 路径（两边都是 PATH 里的 `ssh`）、socket 路径长度上限（macOS 104 字节，路径太长时退回 `$TMPDIR` 下短路径），放在 `daemon/platform/`。Linux、macOS 都能当连入方，也都能当中心。

## 9. 第二期：公网 HTTPS 入口（给手机）

### 9.1 域名和证书

| 选项 | 费用 | 用户要做 | TLS 在哪解开 / 谁能看到明文 | 问题 |
|---|---|---|---|---|
| Let's Encrypt IP 证书（`https://18.179.111.112`） | 免费 | Lightsail 防火墙开 443 | 东京；只有东京 | 证书只有 160 小时，只能 http-01 / tls-alpn-01（<https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability>）；**WebAuthn 的 RP ID 必须是域名，passkey 用不了**；换 IP 推送订阅、主屏 App 全作废 |
| sslip.io（`18-179-111-112.sslip.io`） | 免费 | 开 443 | 东京 | 域名的 DNS 归第三方：它改解析就能另签证书冒充（<https://sslip.io/>）；共享限额 |
| **买域名**（如 `hub.<你的域名>`） | 约 10–15 美元 / 年 | 买域名、加一条 A 记录、开 443 | 东京；只有东京 | 要买；之外最稳，passkey、推送绑自己的域名 |
| Lightsail 分发（CloudFront） | 有免费额度，超出按月计费（<https://aws.amazon.com/lightsail/pricing/>） | 建分发，源站仍要对公网开端口 | **AWS 边缘**；AWS 能看到明文 | 多一跳、多一方看明文，没换来什么 |
| 东京开 Tailscale Funnel | 免费 | 东京装登录 Tailscale，开 funnel | 东京（Funnel 中继只转加密流量）；端口只能 443/8443/10000（<https://tailscale.com/docs/features/tailscale-funnel>） | 测试版、带宽不公开；绑 Tailscale 账号；不用开 Lightsail 端口、不用买域名 |

推荐：**买域名 + 东京开 443**。不想花钱 / 不想开端口就用 Funnel（Funnel 请求不带 `Tailscale-User-Login`，走下面同一个公网入口，不走现在的 serve 身份检查）。不推荐 IP 证书（passkey 不行）和 sslip.io（DNS 在别人手里）。

### 9.2 前面放 Caddy

推荐 **Caddy**（Ubuntu 有官方 apt 源，单个程序，常驻约 30–50 MB）：自动申请 / 续期证书、HTTP/2、WebSocket 透明转发，守护进程不碰证书和私钥。Node 自己做要写 ACME、续期、热换证书，多一块安全面。Caddy 只做 TLS 和路径白名单，`reverse_proxy unix//…/run/public.sock`（socket 0660，组给 caddy）。

### 9.3 公网入口和登录加固

- **公网入口**：守护进程再听 `run/public.sock`（同 `viaServeSocket` 的写法，记 `viaPublic`）。Host 必须是配置的公网域名，改状态的请求 / WS 要 `Origin: https://<域名>`，cookie 加 `Secure`；**带 `Authorization` 的一律 403**（设备之间永远不走公网）。
- **只暴露必要路径**：Caddy 只放 `/`、静态资源、manifest、Service Worker、`/auth`、`/api/*`、`/d/*`；`/api/peer/*` 在 Caddy 和守护进程两层都拒。
- **新浏览器要已登录设备点“允许”**（推荐，必做）：公网上兑换登录链接只得到“待批准”会话；生成二维码的那个已登录浏览器（或任一已登录浏览器）弹出“允许 iPhone Safari（IP、时间）登录？”，点了才生效。登录链接泄露也没用。
- **失败限流**（必做）：`/auth` 兑换失败每 IP 每分钟 5 次、全局每小时 30 次，超了公网登录锁 15 分钟并写日志。
- **会话期限**：公网登录的会话 30 天不活动失效（本机会话不变）；“已登录的浏览器”里标出“经公网”。
- **passkey（Face ID）**（推荐，第二期后半）：首次批准后提示注册；会话过期后用 passkey 重新登录，不用再找电脑扫码。需要域名（见 9.1）。
- **一键关闭**：设置 → 设备 → “公网入口”开关：关掉时守护进程停止听 `public.sock`（Caddy 回 502）并让经公网的会话全部下线；ssh 上东京也能 `hub-device public off`。
- **推送的边界**（PR #141 / #166）：推送订阅仍是 `ENTRY_ONLY_API_PREFIXES`，只给“本机已登录浏览器”。手机经公网登录的会话就是东京本机的会话，所以手机在东京订阅、东京发推送；设备令牌碰不到推送接口，公网入口不新增身份种类。

### 9.4 Web Push 和主屏 App

iOS 16.4 起，网页推送只给“添加到主屏幕”的网页 App：要 HTTPS、manifest 里 `display: standalone`、在用户点击里请求权限（<https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>）。公网入口满足 HTTPS 和固定来源；东京出站连 Apple / Google 推送服务，不需要入站。**来源（域名）定了就别换**，换了要重新加主屏、重新订阅，这也是推荐买域名的原因。

## 10. 性能

- **长连接**：每台连入设备一条 ssh TCP 连接；所有 HTTP keep-alive 连接、WebSocket 都是里面的通道（不另建 TCP）。手机 → 东京一条 HTTPS（HTTP/2 复用）。
- **心跳**：ssh 两端 15 秒一次、3 次没回断开（每台每分钟几百字节）；转发的 WebSocket 照旧 5 秒 ping（P2）。不轮询：隧道状态来自子进程事件，变化随现有 `/api/state` 推送下发。
- **多几跳**：Mac 网页看东京：浏览器 → Mac 守护进程 → ssh → 东京 sshd → 东京设备入口，比 Tailscale 多两次本机回环、一层 ssh 加密，耗时主要是 Mac ↔ 东京的往返。手机看 Mac：手机 → Caddy → 东京守护进程 → sshd → Mac ssh → Mac 设备入口。
- **TCP 套 TCP**：一条 ssh 里大文件下载会让同一条上的 WebSocket 消息排队；20 MB 上传期间消息晚到可接受。实测有问题再给大文件单开一条 ssh。
- **2 GB 机器内存**：每台设备一个 sshd 会话约 5–10 MB；Caddy 30–50 MB；10 台设备加 Caddy 合计约 150 MB 以内，守护进程每多一条转发几十 KB，可以忽略。
- 验收：Mac 网页打开东京的对话 < 2 秒；拔网后 15 秒内显示离线、恢复后 1 分钟内自动连上。

## 11. 实现拆分

| 块 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| A 设备入口 | `server.ts` 加 `peerSocket` / `peerPort` 监听和 `viaPeerEntry` 分流（第 4 节） | 无 | 第 4 节测试；现有测试全过 |
| B 隧道表 + 传输解析 | `tunnels.json`、`transport` 字段、`resolvePeerTarget`、`proxy.ts` 走 unix socket、邀请码绑槽位、同步不传隧道地址 | A 的入口名（先约定） | 冒充测试：B 设备报 Mac 编号 409、报回环网址被拒、清单里的隧道地址被忽略；两个守护进程经 socket 互转 HTTP + WS |
| C ssh 监督 | `daemon/tunnel/`：参数拼装、子进程、退避、状态分类、进 `/api/state` | 无 | 假 ssh 脚本测退避和分类；参数快照 |
| D 东京端命令 | `hub-device tunnel add/remove`：建用户、sshd 片段、公钥行、槽位、连接码；结束旧会话 | 无 | Ubuntu 24.04 容器里第 3 节第 4 条全部通过 |
| E 网页 | 设置 → 设备：连法标签、隧道状态、“连到中心”向导（显示命令、贴连接码）、错误原因和重试 | B、C 的接口 | 按 `docs/ui-standard.md` 截图；断网 / 鉴权失败两种状态截图 |
| F 中心中转（以后） | 东京允许连入设备经它访问别的连入设备（`/d/` 一跳） | B | 三台互看；中转只到已配对设备 |
| G 公网入口 | `public.sock`、Host/Origin/Secure、拒设备令牌、待批准会话、限流、会话期限、开关 | A | 每条加固各一个测试 |
| H Caddy + 文档 | Caddyfile 模板（路径白名单）、安装步骤写进 `docs/linux.md` | G | 东京实机：手机主屏 App 登录、收推送 |
| I passkey（可选） | WebAuthn 注册 / 登录 | G、域名 | Safari 上 Face ID 登录 |

第一期 A、C、D 可以同时开工，B 接 A，E 最后；第二期 G 和 H 并行，I 在后。

## 12. 要用户拍板的事

1. **东京用专用用户 `agenthub-tunnel` + sshd 片段**（实现时要改东京 sshd 配置一次）。推荐：是。只靠 `ubuntu` 用户的 authorized_keys 挡不住 unix socket 转发。
2. **ssh 由守护进程看着**，不用 launchd / systemd。推荐：是（状态进网页、两个系统一份代码）。
3. **公钥怎么装到东京**：网页显示一条命令，用户用管理员密钥自己跑。推荐：是；守护进程不读管理员密钥。
4. **第一期只做两台直连**，第三台经中心中转（块 F）以后做。推荐：是；手机 / 东京当入口照样能看全部。
5. **第二期域名**：推荐买域名（约 10–15 美元 / 年）+ Lightsail 开 443 + Caddy；不想花钱就用东京 Tailscale Funnel。
6. **公网新浏览器要已登录设备批准 + 失败限流**：推荐必做；passkey 放第二期后半。
7. **公网会话 30 天不活动失效**：推荐 30 天。
