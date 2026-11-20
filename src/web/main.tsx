import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa.ts";
import { queryClient } from "./query-client.ts";
import { applyUiScale, readUiScale } from "./ui-scale.ts";
import "./styles.css";

// Apply the UI scale before the first render to avoid a flash.
applyUiScale(readUiScale());

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
registerServiceWorker();
