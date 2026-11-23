const UNKNOWN_BROWSER = "Unknown browser";

export function describeUserAgent(userAgent: string): string {
  // Order matters: Edge, Opera and Chrome UAs also contain "Chrome/" and "Safari/", and Chrome on iOS reports CriOS.
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

export function userAgentKind(userAgent: string): "phone" | "tablet" | "computer" {
  if (/iPad|Android(?!.*Mobile)/.test(userAgent)) return "tablet";
  if (/iPhone|Android|Mobile/.test(userAgent)) return "phone";
  return "computer";
}

export type DeviceKind = "iphone" | "android" | "macos" | "windows" | "linux" | "tablet" | "phone" | "computer";

export function userAgentDevice(userAgent: string): DeviceKind {
  if (/iPhone/.test(userAgent)) return "iphone";
  if (/iPad|Android(?!.*Mobile)/.test(userAgent)) return "tablet";
  if (/Android/.test(userAgent)) return "android";
  if (/Macintosh/.test(userAgent)) return "macos";
  if (/Windows/.test(userAgent)) return "windows";
  if (/CrOS/.test(userAgent)) return "computer";
  if (/Linux|X11/.test(userAgent)) return "linux";
  if (/Mobile/.test(userAgent)) return "phone";
  return "computer";
}

export function formatAgo(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatCountdown(leftMs: number): string {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
