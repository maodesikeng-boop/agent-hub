import type { IncomingMessage } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { ENV_DEV_DAEMON_PORT } from "./src/shared/limits.ts";

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

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
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
