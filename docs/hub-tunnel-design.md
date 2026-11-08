# 联机方案（二）：东京当中心，设备用 SSH 连入；手机走东京公网 HTTPS

状态：已定（第 12 节；第二期域名等用户定）。块 C、D 已实现（#179）。接着 `docs/multi-device-design.md`（下称“联机方案”），P2 配对 / 转发（`daemon/peers/`）已合。
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
2. 公钥一行（文件放 `/etc/ssh/agent-hub-tunnel/authorized_keys`，root 所有、0644，隧道用户改不了）。按行尾注释 `agent-hub:<设备名>` 认是哪台的；同一把钥匙、同一个端口不许给两台（sshd 用第一条对得上的行）：
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
   实际写的片段比上面多两行：`AuthorizedKeysCommand none`（主配置若给所有用户配了 AuthorizedKeysCommand，比如 EC2 Instance Connect，隧道用户不走它）、`PubkeyAuthentication yes`。
   `GatewayPorts no` 让 `-R` 只听回环；`ClientAlive*` 让东京 45 秒内清掉死掉的旧连接（不然 Mac 重连时 4401 还被旧连接占着）。
   改片段的步骤（`scripts/tunnel-sshd.sh`）：
   - 改前、改后各跑一次 `sshd -T -C user=<管理员>,host=x,addr=203.0.113.1`（管理员默认 `$SUDO_USER`，不是就 `ubuntu`），比对管理员用户的实际配置；变了就撤回片段、报错。
   - 再用同样的 `sshd -T` 看隧道用户：`forcecommand`、`authorizedkeysfile`、`permitopen`、`allowstreamlocalforwarding no`、`permittty no`、`gatewayports no` 都在，才算片段真的生效（主配置要 Include `sshd_config.d`）；不在也撤回、报错。
   - `sshd -t` 校验通过才 reload：有 systemd 用 `systemctl try-reload-or-restart ssh.service`（Ubuntu 24.04 的 ssh.service 按需起，没在跑就不用管），否则给 `/run/sshd.pid` 发 SIGHUP。
   - 重复跑收敛：用户、片段、钥匙行都按现状比对，已经对的不动（文件不重写）；写片段前留一个 `/etc/ssh/agent-hub-tunnel/.reload-pending`，reload 成功才删，所以“写了片段还没 reload”中断后再跑一次会补上 reload。
4. 验收（实现块 D）：在一次性 Ubuntu 24.04 容器里跑 sshd，验证这把钥匙：能 `-R 4401`、`-L →4319`；`-R 4402`、`-L →4318`、`-L →22`、`-L` 到 unix socket、要 shell、要 PTY 全部失败。
   脚本 `scripts/verify-tunnel-sshd.sh`（要本机 docker、node），改 sshd 配置或 ssh 参数后重跑。它还验：连入方用 `ssh-args.ts` 拼出的参数真连；改片段前后 `sshd -T` 比对；同一条加设备命令连跑两遍配置不变（文件 inode、修改时间不动）；待 reload、片段被删、钥匙行被改时再跑能补齐；主配置不 Include 时撤回；旧 `hub.sock` 留着能重连（不带 `StreamLocalBindUnlink` 会失败）；删设备断现存会话、再删不变。

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
  1. 东京上 `tunnel add --name mac --pubkey …`（第 7 节）由守护进程分配槽位 4401，同时生成一个**绑定该槽位**的邀请码（现在先出本机普通邀请码，绑槽位归块 B）（沿用 `invites.ts`：随机 128 位、10 分钟、用一次）。
  2. Mac 拿到连接码（含邀请码）后起 ssh，经 `-L` 调东京 `POST /api/peer/pair`。东京按**邀请码**把 Mac 的设备编号写进槽位 4401，不看请求里的网址；Mac 这边把东京编号写进 `hub.deviceId`。
  3. 之后的清单同步、介绍里出现的 `ssh-tunnel` 设备：不传地址；收到的一方只有在本机隧道表里有对应槽位时才能连它，否则只显示“经中心可见”（块 F）。
- 为什么另一台已配对设备 B 冒充不了 Mac：
  - B 的钥匙 `permitlisten` 只有 4402，sshd 不让它听 4401，东京发给 Mac 的令牌到不了 B 手里。
  - B 自报“我是 Mac 的编号”去配对 → 已有编号一律 409（P2 已有）；邀请码绑槽位且只能用一次。
  - B 在清单 / 介绍里替 Mac 报地址 → 隧道设备的地址不从对方数据取；报回环网址 → `normalizePeerUrl` 拒。
  - 东京本机别的进程趁 Mac 掉线去听 4401：东京往槽位端口发请求前读 `/proc/net/tcp`（及 `/proc/net/tcp6`）核对 `LISTEN`（状态 `0A`）行的 `uid` 必须是 `agenthub-tunnel`，不是则按离线拒绝，不发设备令牌。Mac 侧用 0600 的 socket，别的用户抢不了。

## 6. 第一期：谁保持 ssh 常连

推荐：**守护进程自己起 ssh 子进程并看着**，不用 launchd / systemd。理由：隧道离开守护进程没意义（设备入口就是守护进程开的），一起起停最简单；状态能直接进 `/api/state` 推给网页（设置 → 设备）；Mac、Linux 同一份代码，不用分别写 plist 和 unit。守护进程本身已经由 launchd / systemd 拉起。

- 命令（只读本方案生成的文件，忽略用户 `~/.ssh/config`）：
  ```
  ssh -N -T -F /dev/null -i state/tunnel/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none
      -o PreferredAuthentications=publickey -o BatchMode=yes
      -o StrictHostKeyChecking=yes -o UserKnownHostsFile=state/tunnel/known_hosts -o GlobalKnownHostsFile=/dev/null
      -o HostKeyAlias=agent-hub-hub -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no
      -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -o LogLevel=DEBUG1
      -p 22 -R 4401:<run/peer.sock> -L <run/tunnel/hub.sock>:127.0.0.1:4319 agenthub-tunnel@<host>
  ```
  `-F /dev/null` 连系统 ssh_config 也不读（ssh(1)：命令行给了配置文件就不读系统那份），免得用户配置里的 ProxyCommand、ControlMaster 混进来。东京主机公钥钉死在 `state/tunnel/known_hosts`（来自连接码），按固定别名 `agent-hub-hub` 记（`HostKeyAlias`），跟连的是 IP 还是域名无关。参数拼装只在一处（`daemon/tunnel/ssh-args.ts`，快照测试）。
  - `StreamLocalBindUnlink=yes`：ssh 退出时不删 `-L` 建的 `run/tunnel/hub.sock`，下次再建同一个 socket 会失败，配上 `ExitOnForwardFailure` 就一直重连失败；这个选项让 ssh 建之前先删旧的。容器验收里有这一条。
  - `LogLevel=DEBUG1`：两条转发都建好时 ssh 只在 debug1 里说 `remote forward success for: listen 4401`，靠这一行判断连上（`-R` 是最后建的）。stderr 只按行看，不存（只留最后一行非 debug 的报错当原因）。
- 退避：子进程退出就重连，1→2→4…→60 秒封顶，连上稳定 60 秒后清零。
- 提前重连：守护进程留一个入口 `TunnelService.reconnectNow()`，块 B 的转发在 `/d/<东京>` 连不上时调。**一个退避周期里最多提前一次**——退避周期从断开算起，到连上稳定 60 秒（退避清零）为止；免得每个失败的请求都触发重连。在等退避时调：取消定时器马上连；显示连着时调（比如刚睡醒，ssh 还没发现断了）：杀掉旧的马上连；正在连、`auth_failed`、`hostkey_mismatch` 时不做。
- 状态：`connecting | connected | retrying(下次时间) | auth_failed | hostkey_mismatch`，**只是内部值**，原样进 `/api/state` 的 `tunnel`（`{ state, since, retryAt, detail }`，`detail` 是 ssh 最后一行报错原文）；界面上怎么说由块 E 定。状态一变给每条 WebSocket 发 `resync`，网页重拉快照（不常变，不轮询）。看 ssh 的 stderr 分类：`Permission denied` → `auth_failed`、`REMOTE HOST IDENTIFICATION HAS CHANGED` / `Host key verification failed` → `hostkey_mismatch`，这两种不自动重试，等用户点重试（`TunnelService.retry()`）或重新连；`remote port forwarding failed`（东京旧连接还占着 4401）→ 正常退避，45 秒内东京清掉旧连接。
- 停止：SIGTERM，3 秒不退 SIGKILL。子进程号记在 `state/tunnel/ssh.pid`；守护进程被强杀留下的 ssh 还占着东京的槽位端口，下次启动时按这个文件找到（命令行里有本机钥匙路径才算）并结束它。
- 各种情况：
  - **Mac 睡眠**：TCP 断，东京 45 秒内清掉 Mac 的会话，东京网页里 Mac 显示离线（现有 WebSocket 5 秒 ping 更早发现）。醒来后 ssh 自己 45 秒内发现（或 ssh 直接因网络错误退出），守护进程重连，通常醒来几秒到一分钟恢复。
  - **东京重启**：ssh 退出，Mac 按退避重连；东京守护进程由 systemd 拉起。重启期间 Mac 网页里东京离线，不影响本机。
  - **网络切换**（Wi-Fi ↔ 热点）：老 TCP 死掉，同上；ssh 不支持连接迁移，靠重连。
- 验收（块 C）：用假 ssh（`daemon/tunnel/test-fake-ssh.mjs`，按剧本的退出码 / stderr 退出）测退避、状态分类、提前重连、停止时杀子进程；参数拼装做快照测试；容器里验旧 socket 留着也能重连；手动：关 Wi-Fi 30 秒再开，一分钟内恢复。

## 7. 第一期：设置步骤

命令分两半，分开放：

| 哪一半 | 放哪 | 做什么 |
|---|---|---|
| 要 root 的 | `scripts/tunnel-sshd.sh`（bash，东京上由下面的命令 `sudo -n` 调） | 只做三件事：建 `agenthub-tunnel` 用户、写 sshd 片段（第 3 节的比对、校验、reload）、写 / 删钥匙行。删钥匙行时顺带结束这台现存的 ssh 会话（删行不会断已建立的连接；替 `-R` 听槽位端口的是那条会话的进程，按 `ss -tlnp` 找、只杀隧道用户的；root 没有 CAP_SYS_PTRACE 看不到进程号时退回结束隧道用户的全部会话，别的设备 1 秒退避后自己连回来） |
| 守护进程的 | `daemon/tunnel/`，经本机管理 socket `run/admin.sock` | 生成专用钥匙；东京上分槽位、出邀请码（存 `state/tunnels.json`）；Mac 上收连接码、钉主机公钥、起 ssh |
| 命令本身 | `node <代码目录>/src/tunnel/main.ts <子命令>`（下称 `tunnel`） | 用户在终端里跑，把上面两半串起来；管理员 ssh 也在这里（用户终端里），守护进程不读、不存管理员钥匙 |

- 管理 socket：`run/` 0700、socket 0600，另外要带界面令牌（命令读 `state/ui-token`，所以要用跑守护进程的那个用户跑；agent 读不到 `state/`）。接口：`POST /tunnel/key`、`/tunnel/connect`、`/tunnel/slots`、`/tunnel/slots/remove`，`GET /tunnel/status`。
- **连接码**：一行，`ahtun1_` + base64url(JSON)。只有 `[A-Za-z0-9_-]`，贴进终端、网页不用加引号；`1` 是格式版本，改格式换前缀。JSON：`{ host, sshPort, user: "agenthub-tunnel", hostKey: "ssh-ed25519 …", listenPort: 4401, entryPort: 4319, invite }`。地址以 `-` 开头、主机公钥不是 ed25519 等都不认（`shared/tunnel.ts`）。

加 Mac：

1. Mac 上粘一条命令（网页向导，块 E，只显示这条命令；跑完设备自动出现）：
   ```
   node ~/agent-hub/src/tunnel/main.ts join -i ~/.ssh/lightsail-tokyo.pem ubuntu@18.179.111.112
   ```
   （`~/agent-hub` 是 Mac 上的代码目录，向导按守护进程实际位置写；`--name` 默认取本机名，`-p` 改 ssh 端口，`--remote-dir` 改东京上的代码目录，默认东京用户主目录下的 `agent-hub`。）它在本机做三件事：
   - 让本机守护进程生成专用钥匙（`state/tunnel/id_ed25519`，已有就沿用），拿回公钥；
   - 用用户自己的管理员钥匙 `ssh` 到东京，跑 `node agent-hub/src/tunnel/main.ts add --name <名> --host <地址> --ssh-port 22 --pubkey '<公钥>'`（地址、端口先用 `ssh -G` 解析，用户写的是 `~/.ssh/config` 里的别名也行）；
   - 东京那条在标准输出打的连接码，直接交给本机守护进程（`POST /tunnel/connect`）→ 钉主机公钥、记中心、起隧道 →（块 B）自动配对 → 设备列表出现东京。
2. 东京上的 `add`（用有免密 sudo 的管理员用户跑）：守护进程分槽位（同名保留端口）、出邀请码 → `sudo -n scripts/tunnel-sshd.sh add-key …` → 读 `/etc/ssh/ssh_host_ed25519_key.pub` → 标准输出只打一行连接码（进度都在标准错误）。
3. 兜底（`add` 在别的机器上跑的）：Mac 上 `tunnel key` 打印专用公钥，拿去东京跑 `add`，再把连接码交回来：`tunnel connect <连接码>`（网页向导以后也留“贴连接码”的入口，走同一个 `POST /tunnel/connect`）。

- 重复跑收敛：`join`、`add`、`remove` 跑两次结果一样；中途失败（比如东京写了片段还没 reload、sudo 失败）修好后重跑同一条命令就补齐。
- 以后加第三台（Linux）：同样一条 `join`，槽位 4402。东京和它直连；Mac 看它等块 F（第 2 节）。
- 移除：东京上 `tunnel remove --name mac`：先 `sudo` 删钥匙行、结束这台现存的 ssh 会话，再让守护进程收回槽位。设备记录、设备令牌作废归块 B（槽位的 `deviceId`）；东京网页上的移除按钮归块 E。
- 换钥匙：连入方 `tunnel key --regenerate`，再跑一次 `join`（`add` 对同名槽位替换钥匙行，保留端口和设备编号，并断掉旧钥匙的会话）。

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
- **一键关闭**：设置 → 设备 → “公网入口”开关：关掉时守护进程停止听 `public.sock`（Caddy 回 502）并让经公网的会话全部下线；ssh 上东京也能用命令关（名字到块 G 再定，可并进 `src/tunnel/` 那套命令）。
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
| C ssh 监督 | `daemon/tunnel/`：参数拼装（`ssh-args.ts`）、子进程和退避（`supervisor.ts`）、状态分类、提前重连入口、进 `/api/state` | 无 | 假 ssh 脚本测退避、分类、提前重连、停止杀子进程；参数快照；容器里旧 socket 留着也能重连 |
| D 两头的命令 | `src/tunnel/`（`join`、`key`、`connect`、`add`、`remove`）+ `scripts/tunnel-sshd.sh`（root：用户、sshd 片段、钥匙行、断旧会话）+ 守护进程的槽位、邀请码、连接码（`daemon/tunnel/service.ts`、`run/admin.sock`） | 无 | `scripts/verify-tunnel-sshd.sh`：Ubuntu 24.04 容器里第 3 节第 4 条全部通过，加 `sshd -T` 比对、重复跑收敛 |
| E 网页 | 设置 → 设备：连法标签、隧道状态、“连到中心”向导（显示命令、贴连接码）、错误原因和重试 | B、C 的接口 | 按 `docs/ui-standard.md` 截图；断网 / 鉴权失败两种状态截图 |
| F 中心中转（以后） | 东京允许连入设备经它访问别的连入设备（`/d/` 一跳） | B | 三台互看；中转只到已配对设备 |
| G 公网入口 | `public.sock`、Host/Origin/Secure、拒设备令牌、待批准会话、限流、会话期限、开关 | A | 每条加固各一个测试 |
| H Caddy + 文档 | Caddyfile 模板（路径白名单）、安装步骤写进 `docs/linux.md` | G | 东京实机：手机主屏 App 登录、收推送 |
| I passkey（可选） | WebAuthn 注册 / 登录 | G、域名 | Safari 上 Face ID 登录 |

第一期 A、C、D 可以同时开工，B 接 A，E 最后；第二期 G 和 H 并行，I 在后。

## 12. 已定

1. **东京用专用用户 `agenthub-tunnel` + sshd 片段**（实现时要改东京 sshd 配置一次）：按推荐，是。只靠 `ubuntu` 用户的 authorized_keys 挡不住 unix socket 转发。
2. **ssh 由守护进程看着**，不用 launchd / systemd：按推荐，是（状态进网页、两个系统一份代码）。
3. **公钥怎么装到东京**：按推荐，用户用管理员钥匙自己跑命令，守护进程不读管理员钥匙；改成 Mac 上只粘一条 `join` 命令（第 7 节），另留贴连接码兜底。
4. **第一期只做两台直连**，第三台经中心中转（块 F）以后做：按推荐，是。
5. **第二期域名**：**等用户定**。推荐买域名（约 10–15 美元 / 年）+ Lightsail 开 443 + Caddy；不想花钱就用东京 Tailscale Funnel。
6. **公网新浏览器要已登录设备批准 + 失败限流**：按推荐，必做；passkey 放第二期后半。
7. **公网会话 30 天不活动失效**：按推荐，30 天。
