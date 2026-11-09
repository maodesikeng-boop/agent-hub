// Service Worker 外壳缓存不随发版无限变大，也不误删还要用的打包文件（sw-rules.ts 的 staleAssetUrls）。
import { describe, expect, it } from "vitest";
import { SHELL_ASSET_MAX, assetPathsIn, staleAssetUrls } from "./sw-rules.ts";

const O = "https://hub.example";
const url = (path: string) => `${O}/${path}`;
const page = (...assets: string[]) =>
  `<!doctype html><html><head>${assets.map((a) => (a.endsWith(".css") ? `<link rel="stylesheet" crossorigin href="/${a}">` : `<script type="module" crossorigin src="/${a}"></script>`)).join("")}</head></html>`;
/** 哈希 8 位，和 vite.config.ts 的 [name]-[hash] 打出来的一样（含 - 和 _）。 */
const NEW_PAGE = page("assets/index-NEW_ab-1.js", "assets/rolldown-runtime-NEWrt123.js", "assets/index-NEWcss01.css");

describe("assetPathsIn", () => {
  it("认出 script、modulepreload、stylesheet 里的 /assets/ 路径，去重", () => {
    const html = `${page("assets/index-A.js", "assets/index-A.css")}<link rel="modulepreload" href="/assets/runtime-B.js"><script src="/assets/index-A.js"></script>`;
    expect([...assetPathsIn(html)].sort()).toEqual(["/assets/index-A.css", "/assets/index-A.js", "/assets/runtime-B.js"]);
  });
});

describe("staleAssetUrls", () => {
  it("换版：只删和新页面引用同名、哈希不同的旧入口文件（js、css 各自配对）；页面、图标不动", () => {
    const cached = [
      url(""),
      url("assets/index-OLD_ab-1.js"),
      url("assets/index-OLDcss01.css"),
      url("assets/rolldown-runtime-OLDrt123.js"),
      url("assets/index-NEW_ab-1.js"),
      url("icons/icon-192.png"),
    ];
    expect(staleAssetUrls(cached, NEW_PAGE)).toEqual([url("assets/index-OLD_ab-1.js"), url("assets/index-OLDcss01.css"), url("assets/rolldown-runtime-OLDrt123.js")]);
  });

  it("入口 import 的块、CSS 引的字体、不带哈希的文件不在页面里，也不被换版清理误删", () => {
    const cached = [
      url("assets/index-OLD_ab-1.js"),
      url("assets/chunk-DQASFODM-BS-1yg0s.js"), // 二级块（名字里也有 -）
      url("assets/python-Cs6JJXT5.js"), // 按需加载的语言块
      url("assets/inter-latin-AbCd1234.woff2"), // CSS 引的字体
      url("assets/logo.png"), // 不带哈希
      url("assets/index.js"), // 不带哈希、和入口同名
      url("assets/index-OLD_ab-1.js.map"), // 扩展名不同
    ];
    expect(staleAssetUrls(cached, NEW_PAGE)).toEqual([url("assets/index-OLD_ab-1.js")]);
  });

  it("没换版：什么都不删", () => {
    const cached = [url("assets/index-NEW_ab-1.js"), url("assets/index-NEWcss01.css"), url("assets/python-Cs6JJXT5.js")];
    expect(staleAssetUrls(cached, NEW_PAGE)).toEqual([]);
  });

  it(`兜底上限：/assets/ 超过 ${SHELL_ASSET_MAX} 个才从最早缓存的删起，删到不超；新页面引用的排在最前也不删`, () => {
    const lazy = Array.from({ length: SHELL_ASSET_MAX + 5 }, (_, i) => url(`assets/lang${i}-${String(i).padStart(8, "0")}.js`));
    const current = url("assets/index-NEW_ab-1.js");
    const cached = [current, ...lazy];
    // 一共 SHELL_ASSET_MAX + 6 个，超 6 个：跳过新页面引用的，删最早缓存的 6 个按需块
    expect(staleAssetUrls(cached, NEW_PAGE)).toEqual(lazy.slice(0, 6));
    // 没超不删
    expect(staleAssetUrls(lazy.slice(0, SHELL_ASSET_MAX), NEW_PAGE)).toEqual([]);
  });

  it("换版删掉的旧入口也算进上限：删完不超就不再动别的", () => {
    const lazy = Array.from({ length: SHELL_ASSET_MAX - 1 }, (_, i) => url(`assets/lang${i}-${String(i).padStart(8, "0")}.js`));
    const cached = [url("assets/index-OLD_ab-1.js"), ...lazy, url("assets/index-NEW_ab-1.js")];
    expect(staleAssetUrls(cached, NEW_PAGE)).toEqual([url("assets/index-OLD_ab-1.js")]);
  });

  it("发了 30 版、每版攒下一批：旧入口全删，按需块不超上限就都留着", () => {
    const h = (v: number) => `v${String(v).padStart(7, "0")}`;
    const urls = Array.from({ length: 30 }, (_, v) => [url(`assets/index-${h(v)}.js`), url(`assets/index-${h(v)}.css`), url(`assets/lang-${h(v)}.js`)]).flat();
    const stale = new Set(staleAssetUrls(urls, page(`assets/index-${h(29)}.js`, `assets/index-${h(29)}.css`)));
    expect(urls.filter((u) => !stale.has(u))).toEqual(urls.filter((u) => u.includes("/lang-") || u.includes(h(29))));
    expect(stale.size).toBe(29 * 2);
  });
});
