import { useId } from "react";
import { cn } from "../lib/utils.ts";

const BLADE_START_COLOR = "#f4f4f6";
const BLADE_END_COLOR = "#d4d4d8";
const BLADE_HIGHLIGHT_COLOR = "#ffffff";
const SPINE_STROKE_COLOR = "#3f3f46";
const BOLSTER_FILL_COLOR = "#71717a";
const HANDLE_FILL_COLOR = "#18181b";
const RIVET_FILL_COLOR = "#d4d4d8";

/**
 * 水果刀矢量头像（docs/router-design.md 第 4.1 节、docs/ui-standard.md 第 4、21 条）：
 * 延续水果三元视觉（PM 整果切片 slice / Piece 果瓣 wedge / Router 45° 水果刀 knife）。
 * - size 是“标准”界面大小（根字号 16px）下的像素数，换算为 rem 跟随界面四档缩放（与 Avatar.tsx 完全对齐）。
 * - <linearGradient> 必须用 useId() 生成实例级唯一 ID，避免多实例同屏渲染再卸载其中一个时导致渐变引用断裂变黑。
 */
export function KnifeAvatar({ size = 44, className }: { size?: number; className?: string }) {
  const rawId = useId();
  const safeUid = rawId.replace(/[^a-zA-Z0-9_-]/g, (ch) => `_${ch.codePointAt(0)!.toString(36)}_`);
  const bladeGradientId = `knife-blade-${safeUid}`;
  const rem = `${size / 16}rem`;

  return (
    <span
      style={{ width: rem, height: rem }}
      aria-hidden="true"
      data-slot="knife-avatar"
      className={cn("inline-flex shrink-0 select-none", className)}
    >
      <svg viewBox="0 0 44 44" fill="none" className="size-full">
        <defs>
          <linearGradient id={bladeGradientId} x1="12" y1="8" x2="31" y2="27" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={BLADE_START_COLOR} />
            <stop offset="100%" stopColor={BLADE_END_COLOR} />
          </linearGradient>
        </defs>
        {/* 45° 斜置削皮水果刀刀身：右上刀尖 (36,8)，沿对角线延伸衔接护手 */}
        <path
          data-part="blade"
          d="M36 8C29 9.5 22.5 14.5 18 21L23 26C28.5 21 33.5 15 36 8Z"
          fill={`url(#${bladeGradientId})`}
          stroke={SPINE_STROKE_COLOR}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* 刀锋刃口高光棱线 */}
        <path
          data-part="blade-highlight"
          d="M34.6 9.8C32.1 15.3 28.1 20.1 23.4 24.4"
          stroke={BLADE_HIGHLIGHT_COLOR}
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        {/* 金属护手（Bolster）：与刀身根部 (18,21)-(23,26) 严密共边 */}
        <path
          data-part="bolster"
          d="M18 21L23 26L20.4 28.6L15.4 23.6Z"
          fill={BOLSTER_FILL_COLOR}
          stroke={SPINE_STROKE_COLOR}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {/* 哑光碳黑刀柄 + 双银色铆钉 */}
        <path
          data-part="handle"
          d="M15.4 23.6L20.4 28.6L12 37A3.54 3.54 0 0 1 7 32L15.4 23.6Z"
          fill={HANDLE_FILL_COLOR}
        />
        <circle cx="14.6" cy="29.4" r="1.25" fill={RIVET_FILL_COLOR} />
        <circle cx="11" cy="33" r="1.25" fill={RIVET_FILL_COLOR} />
      </svg>
    </span>
  );
}
