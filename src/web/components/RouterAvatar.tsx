import { memo, type CSSProperties } from "react";
import { ROUTER_BELL_LIFT, ROUTER_BELL_PIVOT_ROW, routerBellPaths, SLIME_GRID } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { useSyncedLoop } from "../useSyncedLoop.ts";
import { PixelPaths } from "./Avatar.tsx";

// 提钮在框里的高度：铃身按光学对齐上移之后，第 2、3 行之间那条线离框顶的比例
const PIVOT_STYLE = { "--bell-pivot": `${((ROUTER_BELL_PIVOT_ROW - ROUTER_BELL_LIFT) / SLIME_GRID) * 100}%` } as CSSProperties;

/**
 * 总助的头像（docs/slime-cohesion-design.md）：嫩芽铃，12×12 像素形象，透明底，不套框，不设 --fruit、--jelly。
 * - size 是“标准”界面大小（根字号 16px）下的像素数，写成 rem，跟着界面大小缩放（同 Avatar）。
 * - 铃身按光学对齐上移（和项目经理的史莱姆一样，身体在框的正中），嫩芽伸出框外不裁。
 * - working 时以提钮为轴左右摇（±14°，和项目经理蹦跳同一个节奏，styles.css 的 --motion-hop-cycle），鼠标停上去摇一次；减弱动态效果时不动。
 * - 读屏不念（aria-hidden），名字由旁边的字给。
 */
export const RouterAvatar = memo(function RouterAvatar({ size = 44, working = false, className }: { size?: number; working?: boolean; className?: string }) {
  const rem = `${size / 16}rem`;
  const ref = useSyncedLoop<SVGSVGElement>(working);
  return (
    <span data-slot="router-avatar" aria-hidden="true" style={{ width: rem, height: rem }} className={cn("inline-flex shrink-0 select-none", className)}>
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
