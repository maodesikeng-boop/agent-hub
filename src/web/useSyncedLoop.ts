import { useLayoutEffect, useRef } from "react";

/** 干活时一直循环的动画（styles.css 的史莱姆蹦跳、嫩芽铃摇摆）。 */
const LOOP_ANIMATIONS: ReadonlySet<string> = new Set(["slime-hop-working", "bell-swing-working"]);

/**
 * 同一页上所有在干活的头像同一拍跳（docs/ui-standard.md 第 14、17 条）：active 变真时把这个元素上的循环动画的起点
 * 对齐到页面时间线的 0（Web Animations API 的 startTime），对话顶栏和消息流里正在进行那一轮的头像一起跳，不各跳各的。
 * 不支持 getAnimations 的环境（测试）什么都不做。
 */
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
