import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { ENV_DEV_DAEMON_PORT } from "./src/shared/limits.ts";

// 只管 src/web：守护进程只发打包好的 dist/ 静态文件。
// 开发时（pnpm dev）：先起守护进程，把它的端口设到 AGENT_HUB_DAEMON_PORT，再跑 vite；
// /api（含 WebSocket /api/ws）和 /auth 代理过去。changeOrigin 让 Host 头变成守护进程的地址，过得了它的 Host 检查。
const daemonPort = process.env[ENV_DEV_DAEMON_PORT];
const target = daemonPort ? `http://127.0.0.1:${daemonPort}` : undefined;

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
          "/api": { target, changeOrigin: true, ws: true },
          "/auth": { target, changeOrigin: true },
        }
      : undefined,
  },
});
