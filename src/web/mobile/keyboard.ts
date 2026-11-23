import { useEffect, useState } from "react";

const KEYBOARD_INSET_VAR = "--kb-inset";
const KEYBOARD_OPEN_THRESHOLD_PX = 100;

function writeKeyboardInset(px: number): void {
  const next = `${px}px`;
  const style = document.documentElement.style;
  if (style.getPropertyValue(KEYBOARD_INSET_VAR) === next) return;
  style.setProperty(KEYBOARD_INSET_VAR, next);
}

// iOS Safari ignores interactive-widget=resizes-content and only shrinks visualViewport, so derive the keyboard inset from it.
export function useKeyboardInset(enabled = true): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) {
      writeKeyboardInset(0);
      setOpen(false);
      return;
    }
    const vv = window.visualViewport;
    if (!vv) {
      writeKeyboardInset(0);
      setOpen(false);
      return;
    }
    const update = () => {
      const px = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      writeKeyboardInset(px);
      setOpen(px > KEYBOARD_OPEN_THRESHOLD_PX);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      writeKeyboardInset(0);
      setOpen(false);
    };
  }, [enabled]);
  return open;
}
