import { PRODUCT_NAME } from "../shared/names.ts";

export const THEME_COLOR = "#ffffff";

export const APP_ICONS = {
  appleTouch: "/icons/apple-touch-icon.png",
  favicon: "/icons/favicon.svg",
} as const;

export interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: "maskable" }[];
}

export function webManifest(): WebManifest {
  return {
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: THEME_COLOR,
    background_color: THEME_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
