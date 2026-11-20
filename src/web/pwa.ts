import type { OpenUrlMessage } from "./sw-rules.ts";

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
  });
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<OpenUrlMessage>) => {
    if (event.data?.type !== "open") return;
    const target = new URL(event.data.url, window.location.origin);
    if (target.origin === window.location.origin) window.location.hash = target.hash;
  });
}
