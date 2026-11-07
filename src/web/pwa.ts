// 注册 Service Worker（/sw.js，联机 P4）：缓存网页外壳、收推送。只在打包后的网页里注册（开发模式 vite 不出 /sw.js）。
import type { OpenUrlMessage } from "./sw-rules.ts";

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // 注册不了（不是安全来源等）：网页照常用，只是没有离线外壳和推送
  });
  // 点了通知：已经开着的网页跳到那个对话（只改 # 后面的部分，不整页刷新）
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<OpenUrlMessage>) => {
    if (event.data?.type !== "open") return;
    const target = new URL(event.data.url, window.location.origin);
    if (target.origin === window.location.origin) window.location.hash = target.hash;
  });
}
