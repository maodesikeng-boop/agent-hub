import type { ReactNode } from "react";

/**
 * 任务图里“等你拍板”那一步的标记（docs/slime-cohesion-design.md）：一枚像素小铃（6×6 格），放在果皮轨和放大全览里这一步的管道上；对白底和果冻底的图形对比度 ≥ 3:1（WCAG 1.4.11）。
 * size 是标准档像素数，写成 rem；读屏不念（aria-hidden），这一行的字已经写了 Waiting on you。
 */
export function GateMark({ size = 16, className }: { size?: number; className?: string }): ReactNode {
  throw new Error("未实现");
}
