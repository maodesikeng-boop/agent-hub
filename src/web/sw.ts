/// <reference lib="webworker" />
// Service Worker（/sw.js，范围 /；联机 P4，第 6.1、6.2 节）：缓存网页外壳、显示推送、点通知打开对话。
// 单独打包成 /sw.js（vite.config.ts），类型检查用 tsconfig.sw.json（webworker 的类型和 dom 的放不到一起）。
import { PRECACHE, SHELL_CACHE, parsePushPayload, shellRequestKind, staleAssetUrls, type OpenUrlMessage } from "./sw-rules.ts";

declare const self: ServiceWorkerGlobalScope;
/** 产品名（shared/names.ts），vite.config.ts 打包时填进来。 */
declare const __PRODUCT_NAME__: string;

const ICON = "/icons/icon-192.png";
/** 页面在缓存里的键。 */
const PAGE_KEY = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request: Request, fallback: string | Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(typeof fallback === "string" ? fallback : request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(fallback);
    if (cached) return cached;
    throw err;
  }
}

/** 删掉旧版本的打包文件（sw-rules.ts 的 staleAssetUrls）。 */
async function pruneStaleAssets(cache: Cache, previousHtml: string | null, next: Response): Promise<void> {
  const stale = staleAssetUrls((await cache.keys()).map((r) => r.url), previousHtml, await next.text());
  await Promise.all(stale.map((url) => cache.delete(url)));
}

/** 页面：先走网络，存成 /，换了版顺带清掉旧的打包文件；连不上用缓存的。 */
async function pageNetworkFirst(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(event.request);
    if (response.ok) {
      // 先读出旧页面再覆盖：被覆盖的缓存项不保证还能读
      const previousHtml = (await (await cache.match(PAGE_KEY))?.text()) ?? null;
      const forPrune = response.clone();
      await cache.put(PAGE_KEY, response.clone());
      event.waitUntil(pruneStaleAssets(cache, previousHtml, forPrune).catch(() => {}));
    }
    return response;
  } catch (err) {
    const cached = await cache.match(PAGE_KEY);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const kind = shellRequestKind(request.method, request.url, self.location.origin, request.mode);
  if (kind === null) return;
  // 页面只有一个（/），带不带查询参数都存成 /
  if (kind === "page") event.respondWith(pageNetworkFirst(event));
  else if (kind === "asset") event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request, request));
});

// 推送：只有标题（守护进程不发正文）。前台时守护进程不推，所以这里每条都显示（iOS 也要求每条都显示）
self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data?.text(), __PRODUCT_NAME__);
  event.waitUntil(self.registration.showNotification(payload.title, { tag: payload.tag, icon: ICON, badge: ICON, data: { url: payload.url } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = parsePushPayload(JSON.stringify({ title: "-", tag: "-", url: (event.notification.data as { url?: unknown } | null)?.url }), __PRODUCT_NAME__).url;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open === undefined) {
        await self.clients.openWindow(url);
        return;
      }
      await open.focus();
      open.postMessage({ type: "open", url } satisfies OpenUrlMessage);
    })(),
  );
});
