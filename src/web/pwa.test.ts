// 联机 P4：加到主屏（manifest、图标）、Service Worker 只缓存外壳、推送订阅、前台上报（docs/multi-device-design.md 第 6.1、6.2 节）。
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { API_PATHS, PRESENCE_REPORT_MS, PRODUCT_NAME, type PresenceMessage, type PushPayload } from "../shared/index.ts";
import { APP_ICONS, THEME_COLOR, webManifest } from "./pwa-manifest.ts";
import { presenceMessage, startPresence } from "./presence.ts";
import { hasPushSubscription, pushSupport, subscribePush, unsubscribePush } from "./push.ts";
import { parsePushPayload, shellRequestKind, type PushContent } from "./sw-rules.ts";
import { setForeground } from "./test-utils.ts";

const ORIGIN = "https://tokyo.tail1234.ts.net";

describe("manifest", () => {
  it("主屏 App：名字、从 / 打开、全屏（standalone）、主题色、192 和 512 的图标（含 maskable）", () => {
    const m = webManifest();
    expect(m).toMatchObject({ name: PRODUCT_NAME, short_name: PRODUCT_NAME, start_url: "/", scope: "/", display: "standalone", theme_color: THEME_COLOR });
    const sizes = m.icons.map((i) => `${i.sizes} ${i.purpose ?? "any"}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192 any", "512x512 any", "512x512 maskable"]));
    for (const icon of m.icons) expect(icon.type).toBe("image/png");
  });

  it("图标文件都在 public/ 里", () => {
    for (const icon of [...webManifest().icons.map((i) => i.src), APP_ICONS.appleTouch, APP_ICONS.favicon]) {
      expect(() => readFileSync(`src/web/public${icon}`)).not.toThrow();
    }
  });

  it("index.html 挂上 manifest、apple-touch-icon、主题色", () => {
    const html = readFileSync("src/web/index.html", "utf8");
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain(`<link rel="apple-touch-icon" href="${APP_ICONS.appleTouch}" />`);
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLOR}" />`);
  });

  it("主题色和页面底色（styles.css 的 --background，和纸白）是同一个色，主屏 App 顶栏不露一条冷白边", () => {
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(/--background: (#[0-9a-f]{6});/.exec(css)?.[1]).toBe(THEME_COLOR);
  });
});

describe("Service Worker：只缓存网页外壳，不缓存接口", () => {
  const kind = (path: string, over: { method?: string; mode?: RequestMode; origin?: string } = {}) =>
    shellRequestKind(over.method ?? "GET", `${over.origin ?? ORIGIN}${path}`, ORIGIN, over.mode ?? "cors");

  it("接口、登录、别的设备的转发、WebSocket：不管（不缓存）", () => {
    for (const path of ["/api", "/api/", API_PATHS.state, `${API_PATHS.ws}?since=3`, API_PATHS.pushKey, "/auth?token=x", "/d/0f0e0d0c-0b0a-4908-8706-050403020100/api/state"]) {
      expect(kind(path), path).toBeNull();
    }
  });

  it("不是 GET、别的来源：不管", () => {
    expect(kind("/", { method: "POST", mode: "navigate" })).toBeNull();
    expect(kind("/assets/index-abc.js", { origin: "https://cdn.example.com" })).toBeNull();
  });

  it("打开页面：先走网络，连不上用缓存的页面；打包出来的 js、css：带哈希，先用缓存；图标、manifest：先走网络", () => {
    expect(kind("/", { mode: "navigate" })).toBe("page");
    expect(kind("/?x=1", { mode: "navigate" })).toBe("page");
    expect(kind("/assets/index-abc123.js")).toBe("asset");
    expect(kind("/assets/index-abc123.css")).toBe("asset");
    expect(kind("/icons/icon-192.png")).toBe("static");
    expect(kind("/manifest.webmanifest")).toBe("static");
  });

  it("推送内容：只认标题、网址、tag（和守护进程发的 PushPayload 同形）；网址只能是本站的路径", () => {
    expectTypeOf<PushContent>().toEqualTypeOf<PushPayload>();
    expect(parsePushPayload(JSON.stringify({ title: "东京 · 小林：等你", url: "/#/c/1", tag: "d:pm-1", body: "不该有" }), PRODUCT_NAME)).toEqual({
      title: "东京 · 小林：等你",
      url: "/#/c/1",
      tag: "d:pm-1",
    });
    expect(parsePushPayload(JSON.stringify({ title: "x", url: "https://evil.com/", tag: "t" }), PRODUCT_NAME).url).toBe("/");
    expect(parsePushPayload(JSON.stringify({ title: "x", url: "//evil.com/", tag: "t" }), PRODUCT_NAME).url).toBe("/");
    expect(parsePushPayload("坏的", PRODUCT_NAME)).toEqual({ title: PRODUCT_NAME, url: "/", tag: PRODUCT_NAME });
    expect(parsePushPayload(undefined, PRODUCT_NAME).title).toBe(PRODUCT_NAME);
  });
});

// ---- 推送订阅（浏览器这边） ----

class FakePushSubscription {
  unsubscribed = false;
  readonly endpoint: string;
  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }
  toJSON() {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: "P", auth: "A" } };
  }
  async unsubscribe() {
    this.unsubscribed = true;
    return true;
  }
}

function installPushBrowser(over: { userAgent?: string; standalone?: boolean; pushManager?: boolean } = {}) {
  let current: FakePushSubscription | null = null;
  const subscribe = vi.fn(async (_options: PushSubscriptionOptionsInit) => (current = new FakePushSubscription("https://web.push.apple.com/abc")));
  const registration = { pushManager: { getSubscription: async () => current, subscribe } };
  vi.stubGlobal("navigator", {
    ...navigator,
    userAgent: over.userAgent ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    maxTouchPoints: over.userAgent?.includes("iPhone") ? 5 : 0,
    standalone: over.standalone,
    serviceWorker: { ready: Promise.resolve(registration) },
  });
  if (over.pushManager === false) vi.stubGlobal("PushManager", undefined);
  else vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("standalone") && over.standalone === true }));
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === API_PATHS.pushKey) return new Response(JSON.stringify({ publicKey: "BPublicKey_-" }), { status: 200 });
    return new Response(null, { status: 204, statusText: String(init?.method) });
  });
  vi.stubGlobal("fetch", fetch);
  return { subscribe, fetch, current: () => current };
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("推送订阅", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("iPhone 的 Safari 里（没加到主屏）：要先加到主屏幕；从主屏打开就能推", () => {
    installPushBrowser({ userAgent: IPHONE, standalone: false, pushManager: false });
    expect(pushSupport()).toBe("needs-home-screen");
    installPushBrowser({ userAgent: IPHONE, standalone: true });
    expect(pushSupport()).toBe("supported");
  });

  it("桌面浏览器有 PushManager 就能推；没有就不推（照旧只有网页开着时的通知）", () => {
    installPushBrowser();
    expect(pushSupport()).toBe("supported");
    installPushBrowser({ pushManager: false });
    expect(pushSupport()).toBe("unsupported");
  });

  it("订阅：拿公钥 → 浏览器订阅（userVisibleOnly）→ 交给守护进程；退订：先告诉守护进程再退", async () => {
    const browser = installPushBrowser();
    expect(await subscribePush()).toBe(true);
    expect(browser.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const posted = browser.fetch.mock.calls.find(([path]) => path === API_PATHS.pushSubscriptions);
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ endpoint: "https://web.push.apple.com/abc", expirationTime: null, keys: { p256dh: "P", auth: "A" } });
    expect(hasPushSubscription()).toBe(true);

    const sub = browser.current()!;
    await unsubscribePush();
    const un = browser.fetch.mock.calls.find(([path]) => path === API_PATHS.pushUnsubscribe);
    expect(JSON.parse(String(un?.[1]?.body))).toEqual({ endpoint: "https://web.push.apple.com/abc" });
    expect(sub.unsubscribed).toBe(true);
    expect(hasPushSubscription()).toBe(false);
  });

  it("不支持推送：订阅直接返回 false，不发请求", async () => {
    const browser = installPushBrowser({ pushManager: false });
    expect(await subscribePush()).toBe(false);
    expect(browser.fetch).not.toHaveBeenCalled();
  });
});

describe("前台上报", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("在不在前台、正看着哪个对话（网址里的）；别的设备的对话带设备编号", () => {
    setForeground(true);
    window.history.replaceState(null, "", "/#/c/7");
    expect(presenceMessage()).toEqual({ type: "presence", visible: true, deviceId: null, conversationId: 7 });
    window.history.replaceState(null, "", "/#/d/0f0e0d0c-0b0a-4908-8706-050403020100/c/9");
    expect(presenceMessage()).toEqual({ type: "presence", visible: true, deviceId: "0f0e0d0c-0b0a-4908-8706-050403020100", conversationId: 9 });
    window.history.replaceState(null, "", "/#/pm/2");
    setForeground(false);
    expect(presenceMessage()).toEqual({ type: "presence", visible: false, deviceId: null, conversationId: null });
  });

  it("一开始报一次，之后每 30 秒一次，切前台 / 后台、换对话马上报；停了就不报", () => {
    setForeground(true);
    const sent: PresenceMessage[] = [];
    const stop = startPresence((m) => sent.push(m));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(PRESENCE_REPORT_MS);
    expect(sent).toHaveLength(2);
    setForeground(false);
    expect(sent.at(-1)?.visible).toBe(false);
    window.history.replaceState(null, "", "/#/c/3");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(sent.at(-1)?.conversationId).toBe(3);
    const count = sent.length;
    stop();
    vi.advanceTimersByTime(PRESENCE_REPORT_MS * 3);
    setForeground(true);
    expect(sent).toHaveLength(count);
  });
});
