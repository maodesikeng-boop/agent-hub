import { useEffect, useReducer } from "react";

const MAX_TIMER_MS = 2 ** 31 - 1;
const PAD_MS = 250;

export function useRerenderAt(times: readonly number[]): void {
  const [woken, wake] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  let next = Infinity;
  for (const t of times) if (t > now && t < next) next = t;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  useEffect(() => {
    if (next === Infinity) return;
    const timer = setTimeout(wake, Math.min(next - Date.now() + PAD_MS, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [next, woken]);
}
