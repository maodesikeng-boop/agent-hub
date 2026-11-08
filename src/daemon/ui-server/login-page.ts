// 二维码登录链接的落地页（联机 P6）：链接是 `/auth#link=<码>`。码放在 # 片段里，浏览器不会把它发给服务器，
// 所以代理、访问日志、Referer 都看不到；这个页面自己读出片段，先把地址栏清掉，再 POST /auth 兑换，成功就回首页。

/** 登录链接里 # 片段的键：`#link=<码>`。 */
export const LOGIN_LINK_FRAGMENT_KEY = "link";

/** 公网扫码进入待批准（pending_approval）后，轮询 /api/auth/status 的间隔（毫秒）。 */
const AUTH_STATUS_POLL_MS = 2000;

export const LOGIN_LINK_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>登录 Agent Hub</title>
<style>
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; font: 16px/1.5 system-ui, -apple-system, sans-serif; color: #1f2328; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
</style>
</head>
<body>
<p id="msg" role="status">正在登录…</p>
<script>
(function () {
  var msg = document.getElementById("msg");
  var code = new URLSearchParams(location.hash.slice(1)).get(${JSON.stringify(LOGIN_LINK_FRAGMENT_KEY)});
  history.replaceState(null, "", location.pathname);
  if (!code) { msg.textContent = "登录链接不完整，请回电脑上重新生成二维码。"; return; }
  fetch("/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link: code }),
    credentials: "same-origin",
    referrerPolicy: "no-referrer"
  }).then(function (res) {
    if (res.status === 204) {
      location.replace("/");
    } else if (res.status === 202) {
      msg.textContent = "已扫码，请在已登录的电脑上点「允许」完成登录…";
      var timer = setInterval(function () {
        fetch("/api/auth/status", { credentials: "same-origin", referrerPolicy: "no-referrer" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data) return;
            if (data.status === "active") {
              clearInterval(timer);
              location.replace("/");
            } else if (data.status === "unauthenticated") {
              clearInterval(timer);
              msg.textContent = "登录未获批准或已超时，请回电脑上重新生成二维码。";
            }
          })
          .catch(function () {});
      }, ${AUTH_STATUS_POLL_MS});
    } else if (res.status === 429) {
      msg.textContent = "公网登录尝试过多，已锁定 15 分钟后再试。";
    } else {
      msg.textContent = "登录链接已失效或已用过，请回电脑上重新生成二维码。";
    }
  }).catch(function () {
    msg.textContent = "连不上 Agent Hub，请检查网络后重新扫码。";
  });
})();
</script>
</body>
</html>
`;
