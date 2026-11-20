/// <reference lib="webworker" />
import { PRECACHE, SHELL_CACHE, parsePushPayload, shellRequestKind, staleAssetUrls, type OpenUrlMessage } from "./sw-rules.ts";

declare const self: ServiceWorkerGlobalScope;
declare const __PRODUCT_NAME__: string;

const ICON = "/icons/icon-192.png";
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

async function pruneStaleAssets(cache: Cache, next: Response): Promise<void> {
  const stale = staleAssetUrls((await cache.keys()).map((r) => r.url), await next.text());
  await Promise.all(stale.map((url) => cache.delete(url)));
}

async function pageNetworkFirst(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(event.request);
    if (response.ok) {
      const forPrune = response.clone();
      await cache.put(PAGE_KEY, response.clone());
      event.waitUntil(pruneStaleAssets(cache, forPrune).catch(() => {}));
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
  if (kind === "page") event.respondWith(pageNetworkFirst(event));
  else if (kind === "asset") event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request, request));
});

// iOS requires every push to show a notification.
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
