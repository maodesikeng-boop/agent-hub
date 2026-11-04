import { useEffect, useReducer } from "react";

/** setTimeout 的上限（约 24.8 天），再长会立刻触发；到了上限就醒一次再接着等。 */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** 比目标时间晚一点点醒，免得定时器提前几毫秒触发、醒来时还没到点。 */
const PAD_MS = 250;

/**
 * 到了 times（毫秒时间点）里下一个还没到的时间点，让组件重新渲染一次，页面不动也能跟着时间变。
 * 渲染时自己读 Date.now()；这里只负责“到点叫醒”。电脑睡眠醒来、页面从后台切回来也会重新算一次。
 */
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
    // woken：每次醒来都重新挂一个，哪怕下一个时间点没变（定时器提前触发时）
  }, [next, woken]);
}
