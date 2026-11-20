import { useEffect } from "react";

const KEYBOARD_INSET_VAR = "--kb-inset";

function writeKeyboardInset(px: number): void {
  const next = `${px}px`;
  const style = document.documentElement.style;
  if (style.getPropertyValue(KEYBOARD_INSET_VAR) === next) return;
  style.setProperty(KEYBOARD_INSET_VAR, next);
}

// iOS Safari ignores interactive-widget=resizes-content and only shrinks visualViewport, so derive the keyboard inset from it.
export function useKeyboardInset(enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      writeKeyboardInset(0);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) {
      writeKeyboardInset(0);
      return;
    }
    const update = () => {
      const px = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      writeKeyboardInset(px);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      writeKeyboardInset(0);
    };
  }, [enabled]);
}
