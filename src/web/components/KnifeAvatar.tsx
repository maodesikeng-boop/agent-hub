import { useId } from "react";
import { cn } from "../lib/utils.ts";

/** 刀身：清透的钢色，往刃口方向微微变深（暖钢，跟和纸底同一个色温）。 */
const BLADE_START_COLOR = "#f7f6f3";
const BLADE_END_COLOR = "#d3d0c8";
/** 刃纹线：刀身上顺着刃口的一道细线（刃境），中灰钢色，不发光。 */
const HAMON_COLOR = "#a19d94";
/** 刀背、刀身轮廓、刀柄轮廓：深墨钢色，对和纸底和左栏各态底色都 ≥ 3:1（WCAG 1.4.11，knife-avatar.test.tsx 校验）。 */
const OUTLINE_COLOR = "#3a3935";
/** 和柄（八角柄）：浅白木，向光的一面亮、背光的一面暗一档，靠两面明暗出棱。 */
const HANDLE_LIGHT_COLOR = "#e8dcc2";
const HANDLE_SHADE_COLOR = "#d2c19e";
/** 口金（桂）：墨黑水牛角。 */
const FERRULE_COLOR = "#272623";

/*
 * 下面的路径都画在“刀水平放、刀尖朝右”的局部坐标里（刀的中线是 y = 22），整组再绕画布中心转 -45°，
 * 刀柄落在左下、刀尖指向右上。局部坐标里刀从 x = 0（柄尾）到 x = 45.5（切先），刀身比柄长。
 */
/** 和柄：直柄，柄尾两角切成八角柄的倒角，往口金方向收一点点。 */
const HANDLE_PATH = "M0 20.1L1.1 19L16 19.3L16 24.7L1.1 25L0 23.9Z";
/** 八角柄背光的下半面（和柄轮廓描边之内）。 */
const HANDLE_FACET_PATH = "M0.7 22.1L15.6 22.1L15.6 24.2L1.4 24.45L0.7 23.7Z";
/** 口金：比柄口略粗一圈的一小段方柱。 */
const FERRULE_PATH = "M15.4 18.85L20 18.85L20 25.15L15.4 25.15Z";
/** 刀身：刀背笔直、近切先处缓缓落下；刃口一道直线后微微上扬到切先；刀根处先露一小段颈（刃元）再落到刃口（アゴ）。 */
const BLADE_PATH = "M18.6 19.7L39.5 19.7Q43.2 19.9 45.5 21.3Q41.4 25.1 34.5 25.4L22.6 25.4Q21.3 25.4 21.1 23.7L18.6 23.7Z";
/** 刃纹线：离刃口一小段、跟着刃口走到切先。 */
const HAMON_PATH = "M23 23.9L34.4 23.9Q40 23.7 43.6 21.6";

/**
 * 日式和柄果物小刀（和ペティ）矢量头像（docs/router-design.md 第 4.1 节、docs/ui-standard.md 第 4、21 条）：
 * 延续水果三元视觉（PM 整果切片 slice / Piece 果瓣 wedge / Router 45° 小刀 knife）。
 * 浅白木八角直柄 + 墨黑水牛角口金 + 清透钢色刀身与一道刃纹线，没有铆钉和金属护手。
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
          {/* 局部坐标里从刀背到刃口竖着渐变（转 45° 后跟着刀身走） */}
          <linearGradient id={bladeGradientId} x1="0" y1="19.7" x2="0" y2="25.4" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={BLADE_START_COLOR} />
            <stop offset="100%" stopColor={BLADE_END_COLOR} />
          </linearGradient>
        </defs>
        <g transform="rotate(-45 22 22)" strokeLinejoin="round">
          <path data-part="blade" d={BLADE_PATH} fill={`url(#${bladeGradientId})`} stroke={OUTLINE_COLOR} strokeWidth="1.3" />
          <path data-part="hamon" d={HAMON_PATH} stroke={HAMON_COLOR} strokeWidth="0.7" strokeLinecap="round" />
          <path data-part="handle" d={HANDLE_PATH} fill={HANDLE_LIGHT_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1.2" />
          <path data-part="handle-facet" d={HANDLE_FACET_PATH} fill={HANDLE_SHADE_COLOR} />
          <path data-part="ferrule" d={FERRULE_PATH} fill={FERRULE_COLOR} stroke={OUTLINE_COLOR} strokeWidth="1.2" />
        </g>
      </svg>
    </span>
  );
}
