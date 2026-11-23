import { useLayoutEffect, useRef } from "react";

const LOOP_ANIMATIONS: ReadonlySet<string> = new Set(["slime-hop-working", "bell-swing-working"]);
const pendingElements = new Set<Element>();
let syncRaf: number | undefined;

function flushSyncedElements(): void {
  syncRaf = undefined;
  const batch = [...pendingElements];
  pendingElements.clear();
  for (const el of batch) {
    if (!el.isConnected || typeof el.getAnimations !== "function") continue;
    for (const animation of el.getAnimations()) {
      if ("animationName" in animation && LOOP_ANIMATIONS.has(String(animation.animationName))) animation.startTime = 0;
    }
  }
}

// Align animation startTime once per frame in a shared batch so mounting sprites never flushes layout synchronously.
export function useSyncedLoop<T extends Element>(active: boolean) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null || typeof el.getAnimations !== "function") return;
    if (typeof requestAnimationFrame !== "function") {
      for (const animation of el.getAnimations()) {
        if ("animationName" in animation && LOOP_ANIMATIONS.has(String(animation.animationName))) animation.startTime = 0;
      }
      return;
    }
    pendingElements.add(el);
    if (syncRaf === undefined) syncRaf = requestAnimationFrame(flushSyncedElements);
    return () => {
      pendingElements.delete(el);
      if (pendingElements.size === 0 && syncRaf !== undefined) {
        cancelAnimationFrame(syncRaf);
        syncRaf = undefined;
      }
    };
  }, [active]);
  return ref;
}
