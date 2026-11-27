import { useLayoutEffect, useState } from "react";

/**
 * Wall clock for a leaf that shows time relative to now. Re-reads the clock before paint whenever the component is
 * shown again (a hidden `<Activity>` keeps state but drops effects) and when the page becomes visible, ticks every
 * `tickMs` while both are visible, and stops once `until` has passed. `until: null` never ticks.
 */
export function useNow(tickMs: number, until: number | null = Infinity): number {
  const [now, setNow] = useState(Date.now);
  const live = until !== null && now < until;
  useLayoutEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), tickMs);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [live, tickMs]);
  return now;
}
