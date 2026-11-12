// 加到主屏幕（联机 P4，docs/multi-device-design.md 第 6.1 节）：manifest 的内容和图标路径。
// 打包时 vite.config.ts 用它生成 /manifest.webmanifest；图标文件在 public/icons/（scripts/render-icons.ts 从 icon.svg 画出来）。
import { PRODUCT_NAME } from "../shared/names.ts";

/** 主屏 App 的顶栏、启动画面的颜色：和页面背景一样的和纸白（styles.css 的 --background，pwa.test.ts 校验两边一致）。 */
export const THEME_COLOR = "#fcfbf9";

export const APP_ICONS = {
  /** iOS 加到主屏用的（180×180，不透明，系统自己切圆角）。 */
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
      // Android 按形状裁：图案缩在中间 80% 的安全区里
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
