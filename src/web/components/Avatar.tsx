import { paletteOf } from "../lib/palette.ts";
import { Avatar as AvatarRoot } from "../ui/avatar.tsx";

/**
 * 头像：项目经理是完整水果横切面（slice），Worker（neutral）是对应水果切下的一瓣果肉（wedge）；配色表在 lib/palette.ts。
 * size 是“标准”界面大小（根字号 16px）下的像素数，实际写成 rem，跟着设置里的界面大小一起缩放（ui-scale.ts）。
 */
export function Avatar({ colorKey, size = 44, neutral = false }: { colorKey: number; size?: number; neutral?: boolean }) {
  const p = paletteOf(colorKey);
  const rem = `${size / 16}rem`;
  return (
    <AvatarRoot
      style={{ width: rem, height: rem }}
      className="overflow-visible rounded-none"
      aria-hidden="true"
      data-neutral={neutral ? "true" : undefined}
    >
      <img src={neutral ? p.wedge : p.slice} alt="" draggable={false} className="size-full object-contain select-none" />
    </AvatarRoot>
  );
}
