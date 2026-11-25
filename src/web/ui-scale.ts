export const UI_SCALES = ["sm", "md", "lg", "xl"] as const;
export type UiScale = (typeof UI_SCALES)[number];

export const UI_SCALE_LABELS: Readonly<Record<UiScale, string>> = { sm: "Compact", md: "Default", lg: "Large", xl: "XL" };

export const DEFAULT_UI_SCALE: UiScale = "md";

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

const listeners = new Set<() => void>();

export function subscribeUiScale(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === UI_SCALE_KEY) {
      applyUiScale(readUiScale());
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function saveUiScale(scale: UiScale): void {
  applyUiScale(scale);
  try {
    localStorage.setItem(UI_SCALE_KEY, scale);
  } catch {
  }
  for (const listener of listeners) listener();
}
