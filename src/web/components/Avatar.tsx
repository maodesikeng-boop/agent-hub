import { memo } from "react";
import { opticalLiftOf, SLIME_GRID, slimePaths, type SlimeLook, type SlimePath } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { Avatar as AvatarRoot } from "../ui/avatar.tsx";
import { useSyncedLoop } from "../useSyncedLoop.ts";

/** 像素稿的一组路径（shared/slimes.ts 画好的），每条一种颜色。 */
export function PixelPaths({ paths }: { paths: readonly SlimePath[] }) {
  return paths.map((p, i) => <path key={i} d={p.d} fill={p.fill} />);
}

/**
 * 头像：项目经理是它的史莱姆小动物（造型 × 颜色，shared/slimes.ts），Piece（neutral）是同色的便签小灵；内联的像素 SVG，透明底，没有圆框。
 * - size 是“标准”界面大小（根字号 16px）下的像素数，实际写成 rem，跟着设置里的界面大小一起缩放（ui-scale.ts）。
 * - 主形象按 opticalLiftOf 往上挪，身体落在框的正中，耳朵、叶子伸出框外不裁；Piece 分身本来就上下居中。
 * - working：它正在干活，隔一会儿蹦一下（styles.css 的 .slime-pet），同一页上在干活的头像同一拍跳；鼠标停在头像上也轻跳一次。
 */
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
      className={cn("overflow-visible rounded-none", className)}
      aria-hidden="true"
      data-neutral={neutral ? "true" : undefined}
      data-look={`${look.fruit}:${look.color}`}
    >
      <svg
        ref={ref}
        viewBox={`0 ${lift} ${SLIME_GRID} ${SLIME_GRID}`}
        shapeRendering="crispEdges"
        data-working={working ? "true" : undefined}
        // 蹦跳以脚底为原点：上移之后脚底在框里 (12 - lift) / 12 的高度
        style={lift === 0 ? undefined : { transformOrigin: `50% ${((SLIME_GRID - lift) / SLIME_GRID) * 100}%` }}
        className="slime-pet size-full overflow-visible select-none"
      >
        <PixelPaths paths={slimePaths(look, kind)} />
      </svg>
    </AvatarRoot>
  );
});
