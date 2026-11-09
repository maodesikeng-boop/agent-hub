// 设置里“已登录的浏览器”要显示的文字（纯函数）。
const UNKNOWN_BROWSER = "未知浏览器";

/** 从 User-Agent 认出设备和浏览器，显示成“iPhone Safari”；只认得出一半就只写那一半，都认不出是“未知浏览器”。 */
export function describeUserAgent(userAgent: string): string {
  // 顺序有讲究：Edge、Opera、Chrome 的 UA 里也带 “Chrome/”“Safari/”，iOS 上的 Chrome 是 CriOS
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Macintosh/.test(userAgent)
          ? "Mac"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /CrOS/.test(userAgent)
              ? "ChromeOS"
              : /Linux|X11/.test(userAgent)
                ? "Linux"
                : "";
  const browser = /Edg(?:e|A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /CriOS\/|Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "";
  return [device, browser].filter(Boolean).join(" ") || UNKNOWN_BROWSER;
}

/** 浏览器在哪种设备上（行左边的图标）：iPhone、Android 手机是 phone，iPad、Android 平板是 tablet，其余算电脑。 */
export function userAgentKind(userAgent: string): "phone" | "tablet" | "computer" {
  if (/iPad|Android(?!.*Mobile)/.test(userAgent)) return "tablet";
  if (/iPhone|Android|Mobile/.test(userAgent)) return "phone";
  return "computer";
}

/** 最后活动离现在多久：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

/** 登录链接还剩多久：“4:33”（不足一秒按一秒算，到 0 才是 0:00）。 */
export function formatCountdown(leftMs: number): string {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
