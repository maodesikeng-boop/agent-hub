import type { CSSProperties } from "react";
import { contrastRatio, JELLY_COLOR_IDS, jellyColorOf, ROUTER_BELL_BODY, type JellyColorId } from "../../shared/slimes.ts";

export { contrastRatio };

function cachedBy<T>(build: (id: JellyColorId) => T): (id: JellyColorId) => T {
  const table = new Map<JellyColorId, T>(JELLY_COLOR_IDS.map((id) => [id, build(id)]));
  return (id) => table.get(id)!;
}

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

const AVATAR_TILE_LIGHTNESS = 0.8;
const AVATAR_TILE_CHROMA = 0.1;

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

// Lowers chroma until the color fits sRGB, so a hue keeps its lightness instead of clipping toward another hue.
function fitHex(lightness: number, chroma: number, hue: number): string {
  let c = chroma;
  let rgb = linearRgbOf(lightness, c, hue);
  while (c > 0 && rgb.some((v) => v < -1e-4 || v > 1 + 1e-4)) {
    c = Math.max(0, c - 0.002);
    rgb = linearRgbOf(lightness, c, hue);
  }
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGamma(v))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

// One OKLCH lightness for every color, well above the year rings and below the cream selected band, so no PM's tile reads
// weaker than another's on the wood list.
export const avatarTileFillOf = cachedBy((id): string => {
  const { blob, backdrop } = jellyColorOf(id);
  return fitHex(AVATAR_TILE_LIGHTNESS, Math.min(AVATAR_TILE_CHROMA, oklchOf(blob).chroma), oklchOf(backdrop).hue);
});

export interface SendColors {
  rest: string;
  hover: string;
  press: string;
  ink: string;
}

const SEND_LIGHTNESS = 0.845;
const SEND_CHROMA = 0.083;
// Yellows and yellow-greens read as mustard or olive at the common lightness, so they sit lighter and a little stronger.
const SEND_YELLOW_HUES = [70, 130] as const;
const SEND_YELLOW_LIFT = { lightness: 0.05, chroma: 0.03 } as const;
const SEND_INK_CHROMA = 0.09;
const SEND_INK_CONTRAST = 7;

/**
 * The pastel send button for a conversation color: the PM color's hue, light and soft, darkening a step on hover and on
 * press; the icon is a dark shade of the same hue with at least 7:1 against the pressed fill.
 */
export function pastelSendColors(hueDegrees: number, chromaCap: number): SendColors {
  const hue = (hueDegrees * Math.PI) / 180;
  const yellow = hueDegrees > SEND_YELLOW_HUES[0] && hueDegrees < SEND_YELLOW_HUES[1];
  const lightness = SEND_LIGHTNESS + (yellow ? SEND_YELLOW_LIFT.lightness : 0);
  const chroma = Math.min(SEND_CHROMA + (yellow ? SEND_YELLOW_LIFT.chroma : 0), chromaCap);
  const press = fitHex(lightness - 0.065, chroma * 1.15, hue);
  const inkChroma = Math.min(SEND_INK_CHROMA, chromaCap);
  let ink = fitHex(0.15, inkChroma, hue);
  for (let l = 0.45; l > 0.12; l -= 0.01) {
    const candidate = fitHex(l, inkChroma, hue);
    if (contrastRatio(candidate, press) >= SEND_INK_CONTRAST) {
      ink = candidate;
      break;
    }
  }
  return { rest: fitHex(lightness, chroma, hue), hover: fitHex(lightness - 0.035, chroma * 1.1, hue), press, ink };
}

export const sendColorsOf = cachedBy((id): SendColors => {
  const { blob, backdrop } = jellyColorOf(id);
  return pastelSendColors((oklchOf(backdrop).hue * 180) / Math.PI, oklchOf(blob).chroma);
});

/** Outside a PM the send button takes the Router bell's honey; styles.css keeps these values on `:root`. */
export const ROUTER_SEND_COLORS: SendColors = pastelSendColors((oklchOf(ROUTER_BELL_BODY).hue * 180) / Math.PI, oklchOf(ROUTER_BELL_BODY).chroma);

export const accentStyleOf = cachedBy((id): CSSProperties => {
  const { accent, accentForeground } = jellyColorOf(id);
  const send = sendColorsOf(id);
  return {
    "--primary": accent,
    "--primary-foreground": accentForeground,
    "--send": send.rest,
    "--send-hover": send.hover,
    "--send-press": send.press,
    "--send-ink": send.ink,
  } as CSSProperties;
});


const CHART_ORDER: readonly JellyColorId[] = ["grapefruit", "lime", "orange", "kiwi", "strawberry", "lemon"];
export const CHART_CATEGORY_COLORS: readonly string[] = CHART_ORDER.map((id) => jellyColorOf(id).accent);
