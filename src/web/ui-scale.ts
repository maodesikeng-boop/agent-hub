// 界面大小（设置 → 通用 → 界面大小）：只改 <html data-ui-scale>，各档的根字号在 styles.css 一处；字号、头像、间距都是 rem，跟着一起缩放。
// 档位和名字只在这里改；存在 localStorage，读坏了、没存过都按默认档。

export const UI_SCALES = ["sm", "md", "lg", "xl"] as const;
export type UiScale = (typeof UI_SCALES)[number];

export const UI_SCALE_LABELS: Readonly<Record<UiScale, string>> = { sm: "Compact", md: "Default", lg: "Large", xl: "XL" };

/** 默认“大”：用户要整体再大一点。 */
export const DEFAULT_UI_SCALE: UiScale = "lg";

export const UI_SCALE_KEY = "agent-hub.uiScale";

const isUiScale = (value: unknown): value is UiScale => typeof value === "string" && (UI_SCALES as readonly string[]).includes(value);

export function readUiScale(): UiScale {
  try {
    const stored = localStorage.getItem(UI_SCALE_KEY);
    return isUiScale(stored) ? stored : DEFAULT_UI_SCALE;
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

export function applyUiScale(scale: UiScale): void {
  document.documentElement.dataset.uiScale = scale;
}

/** 换档：马上生效并记住（存不下也照样生效）。 */
export function saveUiScale(scale: UiScale): void {
  applyUiScale(scale);
  try {
    localStorage.setItem(UI_SCALE_KEY, scale);
  } catch {
    // 隐私模式等存不了：这次照样生效
  }
}
