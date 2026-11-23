import { memo } from "react";
import { opticalLiftOf, SLIME_GRID, slimePaths, type SlimeLook, type SlimePath } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { Avatar as AvatarRoot } from "../ui/avatar.tsx";
import { useSyncedLoop } from "../useSyncedLoop.ts";

export function PixelPaths({ paths }: { paths: readonly SlimePath[] }) {
  return paths.map((p, i) => <path key={i} d={p.d} fill={p.fill} />);
}

export const Avatar = memo(function Avatar({
  look,
  size = 44,
  neutral = false,
  working = false,
  className,
}: {
  look: SlimeLook;
  size?: number;
  neutral?: boolean;
  working?: boolean;
  className?: string;
}) {
  const kind = neutral ? "piece" : "main";
  const lift = opticalLiftOf(look.fruit, kind);
  const rem = `${size / 16}rem`;
  const ref = useSyncedLoop<SVGSVGElement>(working);
  return (
    <AvatarRoot
      style={{ width: rem, height: rem }}
      className={cn("overflow-visible [contain:size_layout]", className)}
      aria-hidden="true"
      data-neutral={neutral ? "true" : undefined}
      data-look={`${look.fruit}:${look.color}`}
    >
      <svg
        ref={ref}
        viewBox={`0 ${lift} ${SLIME_GRID} ${SLIME_GRID}`}
        shapeRendering="crispEdges"
        data-working={working ? "true" : undefined}
        style={lift === 0 ? undefined : { transformOrigin: `50% ${((SLIME_GRID - lift) / SLIME_GRID) * 100}%` }}
        className="slime-pet size-full overflow-visible select-none"
      >
        <PixelPaths paths={slimePaths(look, kind)} />
      </svg>
    </AvatarRoot>
  );
});
