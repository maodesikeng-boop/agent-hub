import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa.ts";
import { queryClient } from "./query-client.ts";
import { applyUiScale, readUiScale } from "./ui-scale.ts";
import "./styles.css";

// 先定界面大小再渲染，不闪一下
applyUiScale(readUiScale());

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
registerServiceWorker();
