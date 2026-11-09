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

const NEVER_CACHE = [/^\/api(?:$|\/)/, /^\/auth(?:$|\/)/, /^\/d\//];

export function shellRequestKind(method: string, url: string, origin: string, mode: RequestMode): ShellRequestKind {
  if (method !== "GET") return null;
  const parsed = new URL(url);
  if (parsed.origin !== origin) return null;
  if (NEVER_CACHE.some((re) => re.test(parsed.pathname))) return null;
  if (mode === "navigate" || parsed.pathname === "/" || parsed.pathname === "/index.html") return "page";
  if (parsed.pathname.startsWith("/assets/")) return "asset";
  return "static";
}

/** 页面里引用的打包文件（/assets/…，去重）。 */
export function assetPathsIn(html: string): Set<string> {
  return new Set(Array.from(html.matchAll(/["'(]\/?(assets\/[^"'()\s?#]+)/g), (m) => `/${m[1]}`));
}

/**
 * 外壳缓存里 /assets/ 最多留这么多个（兜底）：打包出来四百来个按需加载的块（代码高亮的各语言、画图的各种图），
 * 平时只缓存用到过的几十个，留足余量，正常用不会碰到；只防几个月攒下来的旧版块无限变多。
 * 不放 shared/limits.ts：sw.js 要打包成一个文件，引了页面也引的模块会被拆成共享块。
 */
export const SHELL_ASSET_MAX = 100;

/** 带哈希的打包文件（vite.config.ts：[name]-[hash].[ext]，哈希 8 位）的“同名”键：名字 + 扩展名；不带哈希的返回 null。 */
function hashedStem(pathname: string): string | null {
  const m = /^\/assets\/(.+)-[\w-]{8}\.(\w+)$/.exec(pathname);
  return m === null ? null : `${m[1]}.${m[2]}`;
}

/**
 * 打包文件名带哈希、先用缓存，同一个缓存名下每发一版就多一批，不删会一直攒（手机上几个月能攒几十 MB）。
 * 拿到新页面时调，cachedUrls 是缓存里所有请求的完整网址（cache.keys() 的顺序，先缓存的在前）；返回要删的那些：
 * 1. 换版：新页面引用了 index-<新哈希>.js，缓存里同名同扩展名、哈希不同的 index-<旧哈希>.js 删掉（入口文件每版都换）；
 * 2. 兜底：剩下的 /assets/ 还超过 SHELL_ASSET_MAX 个，从最早缓存的删起，删到不超。
 * 新页面引用的绝不删。入口 import 的块、CSS 引的字体不在页面里，也不和页面引用的同名，只会在第 2 条里按先来后到被删；
 * 不带哈希的文件不算换版。删了的下次用到时再从网络拿。
 */
export function staleAssetUrls(cachedUrls: readonly string[], nextHtml: string, max: number = SHELL_ASSET_MAX): string[] {
  const next = assetPathsIn(nextHtml);
  const replacedStems = new Set<string>();
  for (const path of next) {
    const stem = hashedStem(path);
    if (stem !== null) replacedStems.add(stem);
  }
  const assets = cachedUrls.map((url) => ({ url, path: new URL(url).pathname })).filter((a) => a.path.startsWith("/assets/") && !next.has(a.path));
  const stale = new Set(assets.filter((a) => replacedStems.has(hashedStem(a.path) ?? "")).map((a) => a.url));
  const keptCount = cachedUrls.filter((url) => new URL(url).pathname.startsWith("/assets/")).length - stale.size;
  let over = keptCount - max;
  for (const a of assets) {
    if (over <= 0) break;
    if (stale.has(a.url)) continue;
    stale.add(a.url);
    over--;
  }
  return assets.filter((a) => stale.has(a.url)).map((a) => a.url);
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
