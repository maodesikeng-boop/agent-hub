import { memo, type CSSProperties } from "react";
import { ROUTER_BELL_LIFT, ROUTER_BELL_PIVOT_ROW, routerBellPaths, SLIME_GRID } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { useSyncedLoop } from "../useSyncedLoop.ts";
import { PixelPaths } from "./Avatar.tsx";

const PIVOT_STYLE = { "--bell-pivot": `${((ROUTER_BELL_PIVOT_ROW - ROUTER_BELL_LIFT) / SLIME_GRID) * 100}%` } as CSSProperties;

export const RouterAvatar = memo(function RouterAvatar({ size = 44, working = false, className }: { size?: number; working?: boolean; className?: string }) {
  const rem = `${size / 16}rem`;
  const ref = useSyncedLoop<SVGSVGElement>(working);
  return (
    <span data-slot="router-avatar" aria-hidden="true" style={{ width: rem, height: rem }} className={cn("inline-flex shrink-0 select-none [contain:size_layout]", className)}>
      <svg
        ref={ref}
        viewBox={`0 ${ROUTER_BELL_LIFT} ${SLIME_GRID} ${SLIME_GRID}`}
        shapeRendering="crispEdges"
        data-working={working ? "true" : undefined}
        style={PIVOT_STYLE}
        className="bell-swing size-full overflow-visible"
      >
        <PixelPaths paths={routerBellPaths()} />
      </svg>
    </span>
  );
});
