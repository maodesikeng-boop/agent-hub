export const SHELL_CACHE = "shell-v1";
export const PRECACHE = ["/"];

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

export function assetPathsIn(html: string): Set<string> {
  return new Set(Array.from(html.matchAll(/["'(]\/?(assets\/[^"'()\s?#]+)/g), (m) => `/${m[1]}`));
}

export const SHELL_ASSET_MAX = 100;

function hashedStem(pathname: string): string | null {
  const m = /^\/assets\/(.+)-[\w-]{8}\.(\w+)$/.exec(pathname);
  return m === null ? null : `${m[1]}.${m[2]}`;
}

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

export interface PushContent {
  title: string;
  url: string;
  tag: string;
}

// iOS requires every push to show a notification, so fall back to the product name.
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

export interface OpenUrlMessage {
  type: "open";
  url: string;
}
