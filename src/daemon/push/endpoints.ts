// 推送订阅的 endpoint 白名单（联机 P4）：守护进程会往订阅里的 endpoint 发请求，只收已知推送服务的主机，
// 否则任何能登录的页面（或被篡改的状态文件）都能让它去请求内网、本机的任意 https 地址（SSRF）。
// 出处见 PR #141 描述：FCM（Chrome / Edge / Android）、Mozilla autopush（Firefox）、Apple（Safari / 主屏网页，文档写的是 *.push.apple.com）、WNS（Windows）。
// 要加推送服务就改这一处。"*." 开头 = 任意（至少一级）子域。

export const PUSH_ENDPOINT_HOSTS: readonly string[] = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"];

const WILDCARD_PREFIX = "*.";

function hostAllowed(hostname: string): boolean {
  return PUSH_ENDPOINT_HOSTS.some((pattern) =>
    pattern.startsWith(WILDCARD_PREFIX) ? hostname.length > pattern.length - 1 && hostname.endsWith(pattern.slice(1)) : hostname === pattern,
  );
}

/** https、主机在名单里、默认端口、不带账号密码。URL 解析后再比（主机名已转小写），挡掉 fcm.googleapis.com@evil.com 之类的写法。 */
export function isAllowedPushEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "" && hostAllowed(parsed.hostname);
}
