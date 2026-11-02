import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 只管 src/web：守护进程只发打包好的 dist/ 静态文件。
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
