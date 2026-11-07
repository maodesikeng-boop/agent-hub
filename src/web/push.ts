// 推送订阅（联机 P4，第 6.2 节）：通知开关打开时，在这个浏览器订阅 Web Push，交给入口的守护进程；关掉时退订。
// iPhone、iPad 要先在 Safari 里“添加到主屏幕”、从主屏图标打开，才有推送（iOS 16.4+）；Android Chrome、桌面浏览器直接可以。
import { API_PATHS, type PushKeyResponse, type PushUnsubscribeRequest } from "../shared/index.ts";

/** supported：能订阅；needs-home-screen：iPhone / iPad 的 Safari 里，要先加到主屏幕；unsupported：这个浏览器没有推送。 */
export type PushSupport = "supported" | "needs-home-screen" | "unsupported";

/** Service Worker 一直没准备好（开发模式不注册）就不等了。 */
const READY_TIMEOUT_MS = 10_000;

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 的 Safari 默认报成 Mac，靠触屏认出来
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (isIos() && !isStandalone()) return "needs-home-screen";
  // 不是 https / 本机（安全来源）时浏览器不给 serviceWorker
  return "serviceWorker" in navigator && typeof PushManager !== "undefined" ? "supported" : "unsupported";
}

let subscribed = false;

/** 这个浏览器订阅了推送：网页退到后台时由推送提醒，网页自己不再弹（notify.ts），免得同一条提醒两遍。 */
export function hasPushSubscription(): boolean {
  return subscribed;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("service worker not ready")), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** 订阅（已经订阅过就把那一条再交一次，守护进程是覆盖）。要在用户点开关之后调（iOS 要求由用户操作触发）。成功回 true。 */
export async function subscribePush(): Promise<boolean> {
  if (pushSupport() !== "supported") return false;
  try {
    const { pushManager } = await registration();
    let subscription = await pushManager.getSubscription();
    if (subscription === null) {
      const res = await fetch(API_PATHS.pushKey);
      if (!res.ok) return false;
      const { publicKey } = (await res.json()) as PushKeyResponse;
      subscription = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
    }
    await postJson(API_PATHS.pushSubscriptions, subscription.toJSON());
    subscribed = true;
    return true;
  } catch {
    return false;
  }
}

/** 退订：先告诉守护进程，再在浏览器里退。失败也当退了（守护进程推过去会收到 410，自己删）。 */
export async function unsubscribePush(): Promise<void> {
  subscribed = false;
  if (pushSupport() !== "supported") return;
  try {
    const subscription = await (await registration()).pushManager.getSubscription();
    if (subscription === null) return;
    await postJson(API_PATHS.pushUnsubscribe, { endpoint: subscription.endpoint } satisfies PushUnsubscribeRequest).catch(() => undefined);
    await subscription.unsubscribe();
  } catch {
    // 退不掉：守护进程那边已经删了，推过去会被丢掉
  }
}
