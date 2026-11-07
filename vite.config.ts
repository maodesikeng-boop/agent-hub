import type { IncomingMessage } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { ENV_DEV_DAEMON_PORT } from "./src/shared/limits.ts";
import { PRODUCT_NAME } from "./src/shared/names.ts";
import { webManifest } from "./src/web/pwa-manifest.ts";

// 只管 src/web：守护进程只发打包好的 dist/ 静态文件。
// 开发时（pnpm dev）：先起守护进程，把它的端口设到 AGENT_HUB_DAEMON_PORT，再跑 vite；
// /api/（含 WebSocket /api/ws）和 /auth 代理过去。守护进程要求 Host 是它自己的地址、POST 和 WebSocket 握手的
// Origin 和它同源，否则回 403：changeOrigin 改 Host；Origin 只在请求确实来自 vite 这个页面时才改成守护进程的地址，
// 别的来源原样转过去，照样被拒。
const daemonPort = process.env[ENV_DEV_DAEMON_PORT];
const target = daemonPort ? `http://127.0.0.1:${daemonPort}` : undefined;

/** 来自 vite 自己页面的请求：Origin 就是 http://<vite 的 Host>。 */
function rewriteOwnOrigin(proxyReq: { setHeader(name: string, value: string): void }, req: IncomingMessage, to: string): void {
  if (req.headers.origin !== undefined && req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader("origin", to);
}

function proxyTo(to: string, ws: boolean): ProxyOptions {
  return {
    target: to,
    changeOrigin: true,
    ws,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => rewriteOwnOrigin(proxyReq, req, to));
      proxy.on("proxyReqWs", (proxyReq, req) => rewriteOwnOrigin(proxyReq, req, to));
    },
  };
}

/** index.html 里的 %PRODUCT_NAME% 换成产品名（names.ts），改名只改那一处。 */
const productName: Plugin = {
  name: "product-name",
  transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", PRODUCT_NAME),
};

/**
 * 加到主屏幕、推送（联机 P4）：/manifest.webmanifest 由 pwa-manifest.ts 生成（名字跟着 names.ts）；Service Worker（sw.ts）
 * 单独打包成根目录的 /sw.js（范围要是 /，文件名不能带哈希）。开发模式只出 manifest，不注册 Service Worker（pwa.ts）。
 */
const MANIFEST_FILE = "manifest.webmanifest";
const pwa: Plugin = {
  name: "pwa",
  configureServer(server) {
    server.middlewares.use(`/${MANIFEST_FILE}`, (_req, res) => {
      res.setHeader("content-type", "application/manifest+json");
      res.end(JSON.stringify(webManifest()));
    });
  },
  generateBundle() {
    this.emitFile({ type: "asset", fileName: MANIFEST_FILE, source: `${JSON.stringify(webManifest(), null, 2)}\n` });
  },
};

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss(), productName, pwa],
  // Service Worker（sw.ts）不引 names.ts（会被拆成共享的 chunk，普通 Service Worker 不能 import），产品名从这里填
  define: { __PRODUCT_NAME__: JSON.stringify(PRODUCT_NAME) },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: "src/web/index.html", sw: "src/web/sw.ts" },
      output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
  server: {
    proxy: target
      ? {
          // 带斜杠：不然 /apifoo 这种路径也会被转过去
          "/api/": proxyTo(target, true),
          "/auth": proxyTo(target, false),
        }
      : undefined,
  },
});
