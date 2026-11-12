我已经把 `pi-bridge` 和 OpenRouter 插件装好，PKCE 登录也已发起，现在等用户本人在浏览器里点同意授权。本地网关服务还没启动。

**pi-bridge**
- 版本 `0.4.2`。命令行装在 `~/.local/bin/pi-bridge`，配置目录在 `~/.config/pi-bridge`。
- 安装前先把 `install.sh` 下载到临时目录核读完再执行：脚本只下载 `pi-bridge-darwin-arm64.tar.gz`、核对 SHA-256 校验和，把二进制放到 `~/.local/bin/pi-bridge`，没有碰 `~/.pi/agent` 或其他任何配置。
- 本地监听默认地址是 `127.0.0.1:18080`，目前没起，`pi-bridge status` 显示未运行。我没装开机常驻服务（`pi-bridge daemon install`），要不要常驻请你定。插件安装和授权登录都不需要常驻服务先跑起来。

**插件**
- 插件 id：`openrouter`
- 包：`@pi-bridge/provider-openrouter`，版本 `0.2.4`
- 状态：已启用，未登录

**登录：要用户做的**
后台进程 `pi-bridge plugin login openrouter` 正在等回调，本机 `127.0.0.1:18900` 在监听。

1. 在这台机器上用浏览器打开下面这个授权链接（回调地址是 `localhost:18900`）。完整链接也存在 `/tmp/pi-bridge-setup/login-url.txt`。
   https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A18900%2Fcallback&code_challenge=EVAL-REDACTED（评测回放：一次性参数已去掉）
2. 登录 OpenRouter 账号并点 Authorize。
3. 浏览器跳回 localhost 后，`pi-bridge` 会自动保存凭证。

**这个链接约 10 分钟后过期。** 过期后重新发起：
`nohup ~/.local/bin/pi-bridge plugin login openrouter > /tmp/pi-bridge-setup/login.log 2>&1 &`

登录完成后可以用 `pi-bridge plugin list` 确认，`openrouter` 那一行不再显示 `not signed in` 就说明成功。

[login-url.txt](/tmp/pi-bridge-setup/login-url.txt)

=== 汇报 ===
状态: 做完了
摘要: pi-bridge 0.4.2 已装（~/.local/bin/pi-bridge，SHA-256 已验），插件 @pi-bridge/provider-openrouter 0.2.4 已装；浏览器 PKCE 授权在后台等用户确认。install.sh 没碰任何 agent 配置。
提交: 无（未改动仓库文件；仅安装本机 ~/.local/bin/pi-bridge、~/.config/pi-bridge 及临时目录 /tmp/pi-bridge-setup）
测试: pi-bridge --version 输出 0.4.2；pi-bridge status 显示服务未运行；plugin list 显示 openrouter 插件 0.2.4 已启用、未登录；18900 端口在监听授权回调
问题: 1) 请用户在这台机器浏览器里打开链接完成 OpenRouter 授权。2) 本地服务还没起，接 Pi 前需要定：装常驻服务（pi-bridge daemon install），还是临时用 pi-bridge serve 跑。
=== 汇报结束 ===
