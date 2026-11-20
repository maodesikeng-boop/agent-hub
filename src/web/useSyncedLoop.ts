import { useLayoutEffect, useRef } from "react";

const LOOP_ANIMATIONS: ReadonlySet<string> = new Set(["slime-hop-working", "bell-swing-working"]);

// Align the animation startTime to the document timeline so every active avatar bounces in sync.
export function useSyncedLoop<T extends Element>(active: boolean) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null || typeof el.getAnimations !== "function") return;
    for (const animation of el.getAnimations()) {
      if ("animationName" in animation && LOOP_ANIMATIONS.has(String(animation.animationName))) animation.startTime = 0;
    }
  }, [active]);
  return ref;
}
