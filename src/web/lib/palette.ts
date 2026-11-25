import type { CSSProperties } from "react";
import { JELLY_COLOR_IDS, jellyColorOf, type JellyColorId } from "../../shared/slimes.ts";

export { contrastRatio } from "../../shared/slimes.ts";

function cachedBy<T>(build: (id: JellyColorId) => T): (id: JellyColorId) => T {
  const table = new Map<JellyColorId, T>(JELLY_COLOR_IDS.map((id) => [id, build(id)]));
  return (id) => table.get(id)!;
}

export const accentStyleOf = cachedBy((id): CSSProperties => {
  const { accent, accentForeground } = jellyColorOf(id);
  return { "--primary": accent, "--primary-foreground": accentForeground } as CSSProperties;
});

type FruitTrackVars = CSSProperties & Record<"--tube-line" | "--tube-core" | "--tube-glint" | "--tube-shade" | "--peel" | "--step-done-bg", string>;

export const fruitTrackVars = cachedBy((id): FruitTrackVars => {
  const { roles, blob, backdrop } = jellyColorOf(id);
  return {
    "--tube-line": roles.outline,
    "--tube-core": roles.body,
    "--tube-glint": roles.light,
    "--tube-shade": roles.shade,
    "--peel": blob,
    "--step-done-bg": backdrop,
  };
});

const AVATAR_TILE_LIGHTNESS = 0.85;
const AVATAR_TILE_CHROMA = 0.12;

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function oklchOf(hex: string): { chroma: number; hue: number } {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { chroma: Math.hypot(a, bb), hue: Math.atan2(bb, a) };
}

function linearRgbOf(lightness: number, chroma: number, hue: number): number[] {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

// One OKLCH lightness for every color, about 0.04 below `--list`, so no PM's tile reads weaker than another's on the honey list.
export const avatarTileFillOf = cachedBy((id): string => {
  const { blob, backdrop } = jellyColorOf(id);
  const { hue } = oklchOf(backdrop);
  let chroma = Math.min(AVATAR_TILE_CHROMA, oklchOf(blob).chroma);
  let rgb = linearRgbOf(AVATAR_TILE_LIGHTNESS, chroma, hue);
  while (rgb.some((v) => v < 0 || v > 1)) {
    chroma -= 0.002;
    rgb = linearRgbOf(AVATAR_TILE_LIGHTNESS, chroma, hue);
  }
  return `#${rgb.map((v) => Math.round(toGamma(v) * 255).toString(16).padStart(2, "0")).join("")}`;
});

const CHART_ORDER: readonly JellyColorId[] = ["grapefruit", "lime", "orange", "kiwi", "strawberry", "lemon"];
export const CHART_CATEGORY_COLORS: readonly string[] = CHART_ORDER.map((id) => jellyColorOf(id).accent);
