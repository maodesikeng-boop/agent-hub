import { gateBellPaths, GATE_BELL_GRID } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { PixelPaths } from "./Avatar.tsx";

/**
 * 任务图里“等你拍板”那一步的标记（docs/slime-cohesion-design.md）：一枚像素小铃（6×6 格），放在果皮轨和放大全览里这一步的管道上；
 * 描边和铃舌对白底和果冻底的图形对比度 ≥ 3:1（WCAG 1.4.11）。读屏不念（aria-hidden），这一行的字已经写了 Waiting on you。
 * - 单独用：size 是标准档像素数，写成 rem。
 * - at 给了：画在外层 <svg> 里（果皮轨的轨道槽），中心落在 at，size 是外层画布的单位。
 */
export function GateMark({ size = 16, at, className }: { size?: number; at?: { x: number; y: number }; className?: string }) {
  const box = `0 0 ${GATE_BELL_GRID} ${GATE_BELL_GRID}`;
  if (at !== undefined) {
    return (
      <svg data-slot="gate-mark" aria-hidden="true" x={at.x - size / 2} y={at.y - size / 2} width={size} height={size} viewBox={box} shapeRendering="crispEdges">
        <PixelPaths paths={gateBellPaths()} />
      </svg>
    );
  }
  const rem = `${size / 16}rem`;
  return (
    <svg data-slot="gate-mark" aria-hidden="true" viewBox={box} shapeRendering="crispEdges" style={{ width: rem, height: rem }} className={cn("shrink-0", className)}>
      <PixelPaths paths={gateBellPaths()} />
    </svg>
  );
}
