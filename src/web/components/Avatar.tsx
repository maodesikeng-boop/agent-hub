import { paletteOf } from "../lib/palette.ts";
import { Avatar as AvatarRoot, AvatarFallback } from "../ui/avatar.tsx";

/** Worker 统一用的中性灰团子（docs/ui-standard.md 第 17 条），不按编号配色。 */
const NEUTRAL_COLOR = "#a1a1aa";

/** 头像：一只有两只眼睛的小团子，颜色由 colorKey 决定（颜色表在 lib/palette.ts，和强调色共用）；neutral（Worker）一律中性灰。 */
export function Avatar({ colorKey, size = 44, neutral = false }: { colorKey: number; size?: number; neutral?: boolean }) {
  const color = neutral ? NEUTRAL_COLOR : paletteOf(colorKey).blob;
  return (
    <AvatarRoot
      style={{ width: size, height: size }}
      className="overflow-visible rounded-none"
      aria-hidden="true"
      data-neutral={neutral ? "true" : undefined}
    >
      <AvatarFallback>
        <svg viewBox="0 0 40 40" className="size-full">
          <path
            d="M20 3c9.5 0 17 6.6 17 16.4C37 29.8 29.6 37 19.6 37 9.9 37 3 30.4 3 20.6 3 10.2 10.6 3 20 3Z"
            fill={color}
          />
          <ellipse cx="16" cy="18" rx="2.2" ry="3.4" fill="#fff" />
          <ellipse cx="24.5" cy="17" rx="2.2" ry="3.4" fill="#fff" />
        </svg>
      </AvatarFallback>
    </AvatarRoot>
  );
}
