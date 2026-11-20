import { API_PATHS, type PushKeyResponse, type PushUnsubscribeRequest } from "../shared/index.ts";

export type PushSupport = "supported" | "needs-home-screen" | "unsupported";

const READY_TIMEOUT_MS = 10_000;

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS Safari reports itself as a Mac; detect it by touch support.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (isIos() && !isStandalone()) return "needs-home-screen";
  // Browsers hide serviceWorker on insecure origins.
  return "serviceWorker" in navigator && typeof PushManager !== "undefined" ? "supported" : "unsupported";
}

let subscribed = false;

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

// iOS requires subscribing from a user gesture.
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

// Failures count as unsubscribed: the daemon drops the subscription on its next 410.
export async function unsubscribePush(): Promise<void> {
  subscribed = false;
  if (pushSupport() !== "supported") return;
  try {
    const subscription = await (await registration()).pushManager.getSubscription();
    if (subscription === null) return;
    await postJson(API_PATHS.pushUnsubscribe, { endpoint: subscription.endpoint } satisfies PushUnsubscribeRequest).catch(() => undefined);
    await subscription.unsubscribe();
  } catch {
  }
}
