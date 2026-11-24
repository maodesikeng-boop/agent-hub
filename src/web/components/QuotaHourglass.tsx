import { useId, type CSSProperties } from "react";
import { cn } from "../lib/utils.ts";
import { HOURGLASS_GLASS_PATH } from "../ui/icons.ts";

const TOP_BULB = "M8 4C8 7 10 9.3 12 11.3 14 9.3 16 7 16 4Z";
const BOTTOM_BULB = "M8 20C8 17 10 14.7 12 12.7 14 14.7 16 17 16 20Z";
const BULB_TOP_Y = 4;
const BULB_NECK_Y = 11.3;
const BULB_SAMPLES = 64;

type HourglassTone = "normal" | "warning" | "full";

function cubic(t: number, a: number, b: number, c: number, d: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

// The left wall of the upper bulb's interior; the glass is mirror-symmetric left-right and top-bottom.
const BULB_WALL: readonly (readonly [x: number, y: number])[] = Array.from({ length: BULB_SAMPLES + 1 }, (_, i) => {
  const t = i / BULB_SAMPLES;
  return [cubic(t, 8, 8, 10, 12), cubic(t, BULB_TOP_Y, 7, 9.3, BULB_NECK_Y)] as const;
});

// Area of the upper bulb from its wide top down to each sample, so levels follow the sand's volume, not its height.
const BULB_AREA: readonly number[] = BULB_WALL.reduce<number[]>((acc, [x, y], i) => {
  if (i === 0) return [0];
  const [px, py] = BULB_WALL[i - 1]!;
  acc.push(acc[i - 1]! + ((2 * (12 - px) + 2 * (12 - x)) / 2) * (y - py));
  return acc;
}, []);

/**
 * Postcondition: returns the y (viewBox units, BULB_TOP_Y..BULB_NECK_Y) of the upper sand surface for a used percent
 * clamped to 0..100; the lower surface sits at 24 - y because the glass is symmetric, so the sand that left the top
 * bulb is exactly the sand piled in the bottom one.
 */
export function sandLevelOf(percent: number): number {
  const used = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)) / 100;
  const total = BULB_AREA.at(-1)!;
  const want = used * total;
  let i = 1;
  while (i < BULB_AREA.length - 1 && BULB_AREA[i]! < want) i++;
  const span = BULB_AREA[i]! - BULB_AREA[i - 1]!;
  const f = span > 0 ? (want - BULB_AREA[i - 1]!) / span : 0;
  const y = BULB_WALL[i - 1]![1] + f * (BULB_WALL[i]![1] - BULB_WALL[i - 1]![1]);
  return Math.round(y * 1000) / 1000;
}

/**
 * Postcondition: draws the line-art hourglass with sand that shows the used share: the lower bulb holds the used part
 * and the upper bulb the rest. Sand settles with a CSS transition when percent changes and pours once on mount; a
 * hover on an ancestor with `hourglass-trigger` tilts it once. Nothing loops and reduced motion shows the final state.
 */
export function QuotaHourglass({
  percent,
  tone,
  className,
  "data-testid": testId,
}: {
  percent: number;
  tone: HourglassTone;
  className?: string;
  "data-testid"?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const level = sandLevelOf(percent);
  const style = { "--sand-top": `${level}px`, "--sand-bottom": `${24 - level}px` } as CSSProperties;
  return (
    <svg viewBox="0 0 24 24" data-icon="line" data-tone={tone} data-testid={testId} aria-hidden="true" className={cn("hourglass", className)} style={style}>
      <defs>
        <clipPath id={`${id}-top`}>
          <path d={TOP_BULB} />
        </clipPath>
        <clipPath id={`${id}-bottom`}>
          <path d={BOTTOM_BULB} />
        </clipPath>
      </defs>
      <g className="hourglass-body">
        <line key={percent} className="hourglass-pour" x1="12" y1="11.2" x2="12" y2="20" />
        <line className="hourglass-trickle" x1="12" y1="11.2" x2="12" y2="20" />
        <g clipPath={`url(#${id}-top)`}>
          <rect className="hourglass-sand hourglass-sand-top" x="6" y="0" width="12" height="12" />
        </g>
        <g clipPath={`url(#${id}-bottom)`}>
          <path className="hourglass-sand hourglass-sand-bottom" d="M6 0.5 12 -0.5 18 0.5V12H6Z" />
        </g>
        <path className="hourglass-glass" d={HOURGLASS_GLASS_PATH} />
      </g>
    </svg>
  );
}
