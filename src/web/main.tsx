import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa.ts";
import { queryClient } from "./query-client.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
registerServiceWorker();
