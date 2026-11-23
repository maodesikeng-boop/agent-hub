import { useEffect } from "react";
import { SCROLLBAR_IDLE_HIDE_MS } from "../shared/limits.ts";

const SCROLLBAR_SELECTOR = ".messages, .sidebar-list, .right-rail-scroll, .router-tray-scroll, .router-timeline, .page-fade, .dialog-body-fade";

/** Reveal thin overlay-style scrollbar thumbs during active scrolling and hide them again after idle. */
export function useAutoHideScrollbars(): void {
  useEffect(() => {
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.matches(SCROLLBAR_SELECTOR)) return;
      target.toggleAttribute("data-scrolling", true);
      const prev = timers.get(target);
      if (prev !== undefined) clearTimeout(prev);
      timers.set(
        target,
        setTimeout(() => {
          timers.delete(target);
          target.removeAttribute("data-scrolling");
        }, SCROLLBAR_IDLE_HIDE_MS),
      );
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
}
