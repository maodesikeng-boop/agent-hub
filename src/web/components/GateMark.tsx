import { gateBellPaths, GATE_BELL_GRID } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { PixelPaths } from "./Avatar.tsx";

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
