// Service Worker 的规则（联机 P4，第 6.1、6.2 节），sw.ts 用，单独放出来好测。
// 只缓存网页外壳（页面、打包出来的 js / css、图标）：Tailscale 没开时主屏 App 仍能打开，显示“连不上”，而不是白屏。
// 接口数据一律不缓存（/api/、/auth、别的设备的 /d/…）。
// 不引别的模块：sw.js 要打包成一个文件（普通 Service Worker 不能 import 别的 chunk），产品名由 sw.ts 传进来。

/** 外壳缓存的名字（缓存是按来源分开的，不用带产品名）：改了缓存方式就换个版本号，旧的在 activate 时删掉。 */
export const SHELL_CACHE = "shell-v1";
/** 装上时先缓存的：页面本身（打包出来的 js、css 在第一次打开时缓存）。 */
export const PRECACHE = ["/"];

/** page：先走网络，连不上用缓存的页面；asset：文件名带哈希，先用缓存；static：先走网络，连不上用缓存；null：不管。 */
export type ShellRequestKind = "page" | "asset" | "static" | null;

const NEVER_CACHE = [/^\/api\//, /^\/auth(?:$|\/)/, /^\/d\//];

export function shellRequestKind(method: string, url: string, origin: string, mode: RequestMode): ShellRequestKind {
  if (method !== "GET") return null;
  const parsed = new URL(url);
  if (parsed.origin !== origin) return null;
  if (NEVER_CACHE.some((re) => re.test(parsed.pathname))) return null;
  if (mode === "navigate" || parsed.pathname === "/" || parsed.pathname === "/index.html") return "page";
  if (parsed.pathname.startsWith("/assets/")) return "asset";
  return "static";
}

/**
 * 推送内容，和 shared/api.ts 的 PushPayload 一样（pwa.test.ts 核对）。这里不引 api.ts：Service Worker 单独做类型检查，
 * 没有 node 和 dom 的类型，api.ts 牵出来的文件过不了。
 */
export interface PushContent {
  title: string;
  url: string;
  tag: string;
}

/** 收到的推送：只认标题、网址、tag（守护进程只发这三个）；网址只能是本站的路径。坏的用产品名兜底（iOS 要求每条都显示）。 */
export function parsePushPayload(text: string | undefined, productName: string): PushContent {
  const fallback: PushContent = { title: productName, url: "/", tag: productName };
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    return fallback;
  }
  if (typeof value !== "object" || value === null) return fallback;
  const { title, url, tag } = value as Record<string, unknown>;
  return {
    title: typeof title === "string" && title !== "" ? title : fallback.title,
    url: typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : fallback.url,
    tag: typeof tag === "string" && tag !== "" ? tag : fallback.tag,
  };
}

/** Service Worker → 页面：点了通知，打开这个网址（页面改 # 后面的部分，不整页刷新）。 */
export interface OpenUrlMessage {
  type: "open";
  url: string;
}
