// Service Worker 外壳缓存不随发版无限变大（sw-rules.ts 的 staleAssetUrls）。
import { describe, expect, it } from "vitest";
import { assetPathsIn, staleAssetUrls } from "./sw-rules.ts";

const O = "https://hub.example";
const page = (...assets: string[]) =>
  `<!doctype html><html><head>${assets.map((a) => (a.endsWith(".css") ? `<link rel="stylesheet" crossorigin href="/${a}">` : `<script type="module" crossorigin src="/${a}"></script>`)).join("")}</head></html>`;

describe("assetPathsIn", () => {
  it("认出 script、modulepreload、stylesheet 里的 /assets/ 路径，去重", () => {
    const html = `${page("assets/index-A.js", "assets/index-A.css")}<link rel="modulepreload" href="/assets/runtime-B.js"><script src="/assets/index-A.js"></script>`;
    expect([...assetPathsIn(html)].sort()).toEqual(["/assets/index-A.css", "/assets/index-A.js", "/assets/runtime-B.js"]);
  });
});

describe("staleAssetUrls", () => {
  const cached = [`${O}/`, `${O}/assets/index-OLD.js`, `${O}/assets/index-OLD.css`, `${O}/assets/yaml-OLD.js`, `${O}/assets/index-NEW.js`, `${O}/icons/icon-192.png`];

  it("换了版：缓存里不在新页面引用里的 /assets/ 都要删；页面、图标不动", () => {
    expect(staleAssetUrls(cached, page("assets/index-OLD.js", "assets/index-OLD.css"), page("assets/index-NEW.js", "assets/index-NEW.css")).sort()).toEqual(
      [`${O}/assets/index-OLD.css`, `${O}/assets/index-OLD.js`, `${O}/assets/yaml-OLD.js`].sort(),
    );
  });

  it("没换版（引用的打包文件一样）：什么都不删，按需加载的块留着", () => {
    const html = page("assets/index-OLD.js", "assets/index-OLD.css");
    expect(staleAssetUrls(cached, html, html)).toEqual([]);
  });

  it("以前没缓存过页面：按新页面清一遍", () => {
    expect(staleAssetUrls(cached, null, page("assets/index-NEW.js"))).toEqual([`${O}/assets/index-OLD.js`, `${O}/assets/index-OLD.css`, `${O}/assets/yaml-OLD.js`]);
  });

  it("发了 30 版、每版攒下一批：清完只剩新页面引用的", () => {
    const urls = Array.from({ length: 30 }, (_, v) => [`${O}/assets/index-v${v}.js`, `${O}/assets/index-v${v}.css`, `${O}/assets/lang-v${v}.js`]).flat();
    const next = page("assets/index-v29.js", "assets/index-v29.css");
    const stale = new Set(staleAssetUrls(urls, page("assets/index-v28.js", "assets/index-v28.css"), next));
    expect(urls.filter((u) => !stale.has(u))).toEqual([`${O}/assets/index-v29.js`, `${O}/assets/index-v29.css`]);
  });
});
