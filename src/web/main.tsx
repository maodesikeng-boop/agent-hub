import "@fontsource-variable/inter";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");
createRoot(root).render(<App />);
