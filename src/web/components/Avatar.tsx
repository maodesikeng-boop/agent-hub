import { paletteOf } from "../lib/palette.ts";
import { cn } from "../lib/utils.ts";
import { Avatar as AvatarRoot } from "../ui/avatar.tsx";

/**
 * 头像：项目经理是一只水果史莱姆小动物（main），Piece（neutral）是同一只小动物压薄的纸片分身（piece）；透明底，没有圆框，配色表在 lib/palette.ts。
 * size 是“标准”界面大小（根字号 16px）下的像素数，实际写成 rem，跟着设置里的界面大小一起缩放（ui-scale.ts）。
 * working：它正在干活，头像隔一会儿蹦一下（styles.css 的 .slime-pet）；鼠标停在头像上也轻跳一次。
 */
export function Avatar({
  colorKey,
  size = 44,
  neutral = false,
  working = false,
  className,
}: {
  colorKey: number;
  size?: number;
  neutral?: boolean;
  working?: boolean;
  className?: string;
}) {
  const p = paletteOf(colorKey);
  const rem = `${size / 16}rem`;
  return (
    <AvatarRoot
      style={{ width: rem, height: rem }}
      className={cn("overflow-visible rounded-none", className)}
      aria-hidden="true"
      data-neutral={neutral ? "true" : undefined}
    >
      <img
        src={neutral ? p.piece : p.main}
        alt=""
        draggable={false}
        data-working={working ? "true" : undefined}
        className="slime-pet size-full object-contain select-none"
      />
    </AvatarRoot>
  );
}
