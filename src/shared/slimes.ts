import { isOneOf, type Pm, type PmId } from "./domain.ts";
import { PM_FRUITS, pmFruitOf, type PmFruit } from "./fruits.ts";

export const SLIME_GRID = 12;

export const EXTRA_JELLY_COLOR_IDS = ["sky", "teal", "sakura", "graphite"] as const;
export type ExtraJellyColorId = (typeof EXTRA_JELLY_COLOR_IDS)[number];
export type JellyColorId = PmFruit | ExtraJellyColorId;

export const JELLY_COLOR_IDS: readonly JellyColorId[] = [...PM_FRUITS, ...EXTRA_JELLY_COLOR_IDS];

export type SlimeRole = "outline" | "body" | "shade" | "light" | "blush" | "mark";

export interface JellyColor {
  id: JellyColorId;
  label: string;
  roles: Readonly<Record<SlimeRole, string>>;
  blob: string;
  accent: string;
  accentForeground: string;
  backdrop: string;
}

export interface SlimeLook {
  fruit: PmFruit;
  color: JellyColorId;
}

export interface PmLookSetting {
  fruit: PmFruit | null;
  color: JellyColorId | null;
}

export type SlimeKind = "main" | "piece";

export interface SlimePath {
  fill: string;
  d: string;
}

const EYE = "#3a1e14";
const LEAF = "#8ed04f";
const LEAF_DARK = "#3f9a4c";
const WHITE = "#ffffff";

type ColorEntry = Omit<JellyColor, "id" | "accentForeground" | "roles"> & SlimeRoleColors;
type SlimeRoleColors = Readonly<Record<SlimeRole, string>>;

const COLOR_TABLE: Readonly<Record<JellyColorId, ColorEntry>> = {
  grapefruit: { label: "Grapefruit", outline: "#a3342e", body: "#ff8f80", shade: "#f06e62", light: "#ffc7ba", blush: "#f4567a", mark: "#b0403a", blob: "#ff6b57", accent: "#c83220", backdrop: "#ffe1da" },
  orange: { label: "Orange", outline: "#9c3d0c", body: "#ff9a2e", shade: "#ec7420", light: "#ffd7ab", blush: "#ff7f6e", mark: "#ce6c1d", blob: "#ff7a1a", accent: "#c2410c", backdrop: "#ffe6c4" },
  kiwi: { label: "Kiwi", outline: "#4a2a16", body: "#a97b4e", shade: "#86593a", light: "#f1e6c4", blush: "#e98a78", mark: "#a6d340", blob: "#5fb327", accent: "#3b6e14", backdrop: "#e2efc2" },
  strawberry: { label: "Strawberry", outline: "#8a1230", body: "#f24a4a", shade: "#cc2f45", light: "#fab7b7", blush: "#ffb4b4", mark: "#be2e3d", blob: "#e6392e", accent: "#b91c1c", backdrop: "#ffdcd6" },
  lime: { label: "Lime", outline: "#3f7a14", body: "#a5db3c", shade: "#7fc026", light: "#e9f7b0", blush: "#ffa08a", mark: "#72ab28", blob: "#4cb82a", accent: "#15803d", backdrop: "#e6f5c0" },
  lemon: { label: "Lemon", outline: "#a66a00", body: "#ffd93d", shade: "#f2b01e", light: "#fff0b1", blush: "#ff9a7a", mark: "#d3a21f", blob: "#f5b400", accent: "#8f6200", backdrop: "#fff3bf" },
  pomelo: { label: "Pomelo", outline: "#8a5a14", body: "#fff0b5", shade: "#f1d98a", light: "#fff9e1", blush: "#ffab8f", mark: "#d99b38", blob: "#d99b38", accent: "#855814", backdrop: "#fbe6b0" },
  bell_pepper: { label: "Pepper", outline: "#14532d", body: "#40ad57", shade: "#2b8f45", light: "#a8e36a", blush: "#ff9a8a", mark: "#2a8042", blob: "#2f9e44", accent: "#1b6e2d", backdrop: "#d3f0d2" },
  blueberry: { label: "Blueberry", outline: "#27337a", body: "#5b78e6", shade: "#4760c9", light: "#bdc9f5", blush: "#ffb3c0", mark: "#4156b0", blob: "#5b78e6", accent: "#3447b5", backdrop: "#dde4ff" },
  peach: { label: "Peach", outline: "#c0504a", body: "#ffc0aa", shade: "#f9a08e", light: "#ffeedd", blush: "#ff7f8e", mark: "#e0887a", blob: "#ffb39e", accent: "#a8503f", backdrop: "#ffe8df" },
  watermelon: { label: "Watermelon", outline: "#165c2e", body: "#62c46a", shade: "#46a857", light: "#e9f7c4", blush: "#ff9a8a", mark: "#1f7d3c", blob: "#3dbb6a", accent: "#0f7a5a", backdrop: "#d9f2d6" },
  grape: { label: "Grape", outline: "#4b2a8a", body: "#9c6ae6", shade: "#7f50cc", light: "#d7c3f5", blush: "#ffb0d0", mark: "#744ab8", blob: "#9c6ae6", accent: "#6b3fc4", backdrop: "#ebe0ff" },
  pineapple: { label: "Pineapple", outline: "#8a5a00", body: "#f5b82e", shade: "#dd9a1a", light: "#fbe3ab", blush: "#ff9a7a", mark: "#c27f10", blob: "#f5b82e", accent: "#a15c00", backdrop: "#ffeab8" },
  cherry: { label: "Cherry", outline: "#6e0f2c", body: "#d02a52", shade: "#ac1c44", light: "#ecaaba", blush: "#ff8fa3", mark: "#4a0d22", blob: "#d02a52", accent: "#a3123f", backdrop: "#ffd9e0" },
  melon: { label: "Melon", outline: "#2f8a6a", body: "#b4ecd2", shade: "#8fd9b8", light: "#fbffe6", blush: "#ffab9f", mark: "#72bb9e", blob: "#8fdcb8", accent: "#1d7d68", backdrop: "#dcf7ea" },
  dragon_fruit: { label: "Dragon fruit", outline: "#9c1257", body: "#f2559f", shade: "#d93a86", light: "#fabbd9", blush: "#ffb3d4", mark: "#c7347b", blob: "#f2559f", accent: "#b8186b", backdrop: "#ffdcee" },
  pear: { label: "Pear", outline: "#6b7a1e", body: "#dbe66e", shade: "#c2d154", light: "#f1f5c5", blush: "#ffab8f", mark: "#a39a3c", blob: "#cfdc55", accent: "#5f6f12", backdrop: "#f1f6c4" },
  mangosteen: { label: "Mangosteen", outline: "#3a1438", body: "#7a3a78", shade: "#5f2a60", light: "#ffe9c4", blush: "#ff9fb0", mark: "#5a2758", blob: "#8e4a8c", accent: "#6d2a6b", backdrop: "#eedcf0" },
  persimmon: { label: "Persimmon", outline: "#8a2c0c", body: "#f5682a", shade: "#d9501c", light: "#fbc3aa", blush: "#ffa08a", mark: "#4a2412", blob: "#f5682a", accent: "#ad3311", backdrop: "#ffe0cf" },
  coconut: { label: "Coconut", outline: "#6b4423", body: "#fffdf5", shade: "#ece3d0", light: "#fffefb", blush: "#ffb0b0", mark: "#9a6a3c", blob: "#9a6a3c", accent: "#6b4a2e", backdrop: "#efe2cf" },
  sky: { label: "Sky", outline: "#1d5a8a", body: "#86cdf5", shade: "#5fb3e6", light: "#e6f6fe", blush: "#ffb3c0", mark: "#3489c9", blob: "#4fb3ea", accent: "#0b69a3", backdrop: "#dcf0fc" },
  teal: { label: "Teal", outline: "#0d5c55", body: "#4cc9b9", shade: "#2aad9d", light: "#d9f7f2", blush: "#ffab9a", mark: "#148a7d", blob: "#22b3a3", accent: "#0f766e", backdrop: "#d5f3ee" },
  sakura: { label: "Sakura", outline: "#a3365f", body: "#ffc6da", shade: "#f7a6c2", light: "#fff1f6", blush: "#ff7aa2", mark: "#e2799e", blob: "#ff9cc0", accent: "#b4325f", backdrop: "#ffe8f0" },
  graphite: { label: "Graphite", outline: "#26262b", body: "#8f919c", shade: "#73757f", light: "#e6e6ea", blush: "#ffb3c0", mark: "#55575f", blob: "#8f919c", accent: "#52525b", backdrop: "#e6e6ea" },
};

const JELLY_COLORS: ReadonlyMap<JellyColorId, JellyColor> = new Map(
  JELLY_COLOR_IDS.map((id) => {
    const { label, outline, body, shade, light, blush, mark, blob, accent, backdrop } = COLOR_TABLE[id];
    const color: JellyColor = Object.freeze({
      id,
      label,
      roles: Object.freeze({ outline, body, shade, light, blush, mark }),
      blob,
      accent,
      accentForeground: WHITE,
      backdrop,
    });
    return [id, color] as const;
  }),
);

export const SLIME_SHAPE_LABELS: Readonly<Record<PmFruit, string>> = {
  grapefruit: "Grapefruit pig",
  orange: "Orange cat",
  kiwi: "Kiwi bear",
  strawberry: "Strawberry bunny",
  lime: "Lime frog",
  lemon: "Lemon chick",
  pomelo: "Pomelo puppy",
  bell_pepper: "Pepper dino",
  blueberry: "Blueberry penguin",
  peach: "Peach monkey",
  watermelon: "Watermelon tiger",
  grape: "Grape mouse",
  pineapple: "Pineapple hedgehog",
  cherry: "Cherry ladybug",
  melon: "Melon whale",
  dragon_fruit: "Dragon fruit axolotl",
  pear: "Pear giraffe",
  mangosteen: "Mangosteen owl",
  persimmon: "Persimmon fox",
  coconut: "Coconut cow",
};

interface Sprite {
  colors: Readonly<Record<string, string>>;
  roles?: Readonly<Record<string, SlimeRole>>;
  bodyTop: number;
  rows: readonly string[];
}

const BASE_ROLES: Readonly<Record<string, SlimeRole>> = { o: "outline", b: "body", s: "shade", c: "light", p: "blush" };

const SPRITES: Readonly<Record<PmFruit, Sprite>> = {
  grapefruit: {
    colors: { o: "#a3342e", b: "#ff8f80", s: "#f06e62", e: EYE, p: "#f4567a", c: "#ffc7ba", n: "#b0403a" },
    roles: { n: "mark" },
    bodyTop: 3,
    rows: [
      "............",
      "oo........oo",
      "opo......opo",
      ".oboooooobo.",
      ".obbbbbbbbo.",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "obbeccccebbo",
      "obpcnccncpbo",
      "obbbbbbbbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  orange: {
    colors: { o: "#9c3d0c", b: "#ff9a2e", s: "#ec7420", e: EYE, p: "#ff7f6e", n: "#d9482b", g: LEAF, G: LEAF_DARK },
    bodyTop: 3,
    rows: [
      "............",
      "......g.....",
      "..o..G...o..",
      ".oboooooobo.",
      ".obbbbbbbbo.",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "obbebbbbebbo",
      "obpbbnnbbpbo",
      "obbbbbbbbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  kiwi: {
    colors: { o: "#4a2a16", b: "#a97b4e", s: "#86593a", e: EYE, p: "#e98a78", k: "#a6d340", c: "#f1e6c4" },
    roles: { k: "mark" },
    bodyTop: 3,
    rows: [
      "............",
      "..o......o..",
      ".oko....oko.",
      ".oboooooobo.",
      ".obbbbbbbbo.",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "obbebeebebbo",
      "obpbccccbpbo",
      "obbbbbbbbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  strawberry: {
    colors: { o: "#8a1230", b: "#f24a4a", s: "#cc2f45", e: EYE, w: WHITE, p: "#ffb4b4", g: "#6cc35a", G: "#2f9150", y: "#ffe7a6" },
    bodyTop: 3,
    rows: [
      "..oo....oo..",
      ".obpo..opbo.",
      ".obpo..opbo.",
      ".oGggggggGo.",
      "obgGbggbGgbo",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "obbebbbbebbo",
      "obpbbwwbbpbo",
      "obybbbbbbyso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  lime: {
    colors: { o: "#3f7a14", b: "#a5db3c", s: "#7fc026", e: EYE, p: "#ffa08a", c: "#e9f7b0" },
    bodyTop: 2,
    rows: [
      "............",
      ".ooo....ooo.",
      "obbbo..obbbo",
      "obebboobbebo",
      "obebbbbbbebo",
      "obbbbbbbbbbo",
      "obpbbbbbbpbo",
      "obbebbbbebbo",
      "obbbeeeebbbo",
      "obbccccccbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  lemon: {
    colors: { o: "#a66a00", b: "#ffd93d", s: "#f2b01e", e: EYE, p: "#ff9a7a", f: "#ff8a1e", g: LEAF, G: LEAF_DARK },
    bodyTop: 3,
    rows: [
      "............",
      "....o..g....",
      ".....oG.....",
      "...oooooo...",
      "..obbbbbbo..",
      ".obbbbbbbbo.",
      ".obebbbbebo.",
      "obbebffbebbo",
      ".opbbbbbbpo.",
      ".obbbbbbbso.",
      "..osssssso..",
      "...oooooo...",
    ],
  },
  pomelo: {
    colors: { o: "#8a5a14", b: "#fff0b5", s: "#f1d98a", e: EYE, p: "#ffab8f", t: "#d99b38", n: EYE, r: "#ff7d8e" },
    roles: { t: "mark" },
    bodyTop: 2,
    rows: [
      "............",
      "....oooo....",
      "..oobbbboo..",
      ".ottbbbbtto.",
      "ottbbbbbbtto",
      "ottbbbbbbtto",
      "otbebbbbebto",
      "otbebnnbebto",
      "obpbbrrbbpbo",
      "obbbbbbbbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  bell_pepper: {
    colors: { o: "#14532d", b: "#40ad57", s: "#2b8f45", e: EYE, p: "#ff9a8a", k: "#a8e36a", w: WHITE },
    roles: { k: "light" },
    bodyTop: 3,
    rows: [
      "............",
      ".....oo.....",
      "..o.okko.o..",
      ".okookkooko.",
      ".obbbbbbbbo.",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "obbebbbbebbo",
      "obpbeeeebpbo",
      "obbbwbbwbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  blueberry: {
    colors: { o: "#27337a", b: "#5b78e6", s: "#4760c9", e: EYE, p: "#ffb3c0", w: WHITE, f: "#ff9a2e" },
    bodyTop: 3,
    rows: [
      "............",
      "....o..o....",
      "....oooo....",
      "..oooooooo..",
      ".obbbbbbbbo.",
      "obbwwbbwwbbo",
      "obwewwwwewbo",
      "obwewffwewbo",
      "obpwwwwwwpbo",
      "obbwwwwwwbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  peach: {
    colors: { o: "#c0504a", b: "#ffc0aa", s: "#f9a08e", e: EYE, p: "#ff7f8e", c: "#ffeedd", n: "#c0504a", g: LEAF, G: LEAF_DARK },
    roles: { n: "outline" },
    bodyTop: 3,
    rows: [
      "............",
      ".....gg.....",
      "......G.....",
      "..oooooooo..",
      ".obbbbbbbbo.",
      "opbccbbccbpo",
      "opceccccecpo",
      ".ocecnnceco.",
      ".opccccccpo.",
      ".obbccccbso.",
      "..osssssso..",
      "...oooooo...",
    ],
  },
  watermelon: {
    colors: { o: "#165c2e", b: "#62c46a", s: "#46a857", e: EYE, p: "#ff9a8a", k: "#1f7d3c", c: "#e9f7c4", n: "#ff5a76" },
    roles: { k: "mark" },
    bodyTop: 3,
    rows: [
      "............",
      "..o......o..",
      ".oko....oko.",
      ".oboooooobo.",
      ".obbkbbkbbo.",
      "obbbkbbkbbbo",
      "obbebbbbebbo",
      "okbebccbebko",
      "obpbcnncbpbo",
      "okbbccccbbko",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  grape: {
    colors: { o: "#4b2a8a", b: "#9c6ae6", s: "#7f50cc", e: EYE, p: "#ffb0d0", n: "#ff8fb3", g: LEAF, G: LEAF_DARK },
    bodyTop: 3,
    rows: [
      "............",
      ".oo...g..oo.",
      "oppo.G..oppo",
      "oppooooooppo",
      ".oobbbbbboo.",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "obbebbbbebbo",
      "obpbbnnbbpbo",
      "obbbbbbbbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  pineapple: {
    colors: { o: "#8a5a00", b: "#f5b82e", s: "#dd9a1a", e: EYE, p: "#ff9a7a", k: "#c27f10", n: EYE, g: LEAF, G: LEAF_DARK },
    roles: { k: "mark" },
    bodyTop: 3,
    rows: [
      "...g.gg.g...",
      "...gGggGg...",
      "....GggG....",
      "..oooooooo..",
      ".okbkbbkbko.",
      "obkbkbbkbkbo",
      "obbebbbbebbo",
      "obbebbbbebbo",
      "obpbbnnbbpbo",
      "obbbbbbbbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  cherry: {
    colors: { o: "#6e0f2c", b: "#d02a52", s: "#ac1c44", e: EYE, p: "#ff8fa3", k: "#4a0d22", t: "#6f8f2e" },
    roles: { k: "mark" },
    bodyTop: 3,
    rows: [
      "..t......t..",
      "...t....t...",
      "....t..t....",
      "..oooooooo..",
      ".okbbbbbbko.",
      "obbbbkkbbbbo",
      "obbebbbbebbo",
      "obbebbbbebbo",
      "obpbbeebbpbo",
      "obbkbbbbkbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  melon: {
    colors: { o: "#2f8a6a", b: "#b4ecd2", s: "#8fd9b8", e: EYE, p: "#ffab9f", c: "#fbffe6", a: "#6cc8ee" },
    bodyTop: 3,
    rows: [
      "...aa..aa...",
      "..a..aa..a..",
      ".....aa.....",
      "..oooooooo..",
      ".obbbbbbbbo.",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "obbebbbbebbo",
      "obpbbeebbpbo",
      "obccccccccso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  dragon_fruit: {
    colors: { o: "#9c1257", b: "#f2559f", s: "#d93a86", e: EYE, p: "#ffb3d4", g: LEAF, G: LEAF_DARK },
    bodyTop: 3,
    rows: [
      "............",
      ".....gg.....",
      "....gGGg....",
      "..oooooooo..",
      "gobbbbbbbbog",
      ".obbbbbbbbo.",
      "gobebbbbebog",
      ".obebbbbebo.",
      "gopbbeebbpog",
      ".obbbbbbbso.",
      "..osssssso..",
      "...oooooo...",
    ],
  },
  pear: {
    colors: { o: "#6b7a1e", b: "#dbe66e", s: "#c2d154", e: EYE, p: "#ffab8f", k: "#a39a3c", t: "#7a5a2a", n: EYE },
    roles: { k: "mark" },
    bodyTop: 2,
    rows: [
      "...t....t...",
      "...o....o...",
      "...oooooo...",
      ".oobbbbbboo.",
      "..obkbbbbo..",
      ".obbbbbkbbo.",
      ".obebbbbebo.",
      "obbebbbbebbo",
      "obpbbnnbbpbo",
      "obkbbbbbbkso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  mangosteen: {
    colors: { o: "#3a1438", b: "#7a3a78", s: "#5f2a60", e: EYE, p: "#ff9fb0", c: "#ffe9c4", f: "#ff9a2e", g: "#a6d36a", G: "#5f9a3c" },
    bodyTop: 3,
    rows: [
      "............",
      "...gg..gg...",
      "..gGGggGGg..",
      "..oooooooo..",
      ".obbbbbbbbo.",
      "obcccbbcccbo",
      "obcecbbcecbo",
      "obcecffcecbo",
      "obpccffccpbo",
      "obbbbbbbbbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  persimmon: {
    colors: { o: "#8a2c0c", b: "#f5682a", s: "#d9501c", e: EYE, p: "#ffa08a", k: "#4a2412", w: "#fff6ea", n: EYE, g: "#9bbf4a", G: "#5f8a2e" },
    roles: { k: "mark" },
    bodyTop: 3,
    rows: [
      "............",
      "..k......k..",
      ".obo.gg.obo.",
      ".obooGGoobo.",
      ".obbbbbbbbo.",
      "obbbbbbbbbbo",
      "obbebbbbebbo",
      "owwebbbbewwo",
      "owpwbnnbwpwo",
      "obwwwwwwwbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
  coconut: {
    colors: { o: "#6b4423", b: "#fffdf5", s: "#ece3d0", e: EYE, p: "#ffb0b0", t: "#9a6a3c", h: "#e8c48a", m: "#ffc2c2", n: "#c97a7a" },
    roles: { t: "mark" },
    bodyTop: 3,
    rows: [
      "............",
      "..h......h..",
      "..hh....hh..",
      "..oooooooo..",
      "oottbbbbbboo",
      "ottbbbbtttbo",
      "obbebbbtetbo",
      "obbebbbbetbo",
      "obpmmmmmmpbo",
      "obbmnmmnmbso",
      ".oossssssoo.",
      "...oooooo...",
    ],
  },
};

const PIECE: Sprite = {
  colors: { o: "", b: "", s: "", c: "", e: EYE },
  bodyTop: 2,
  rows: [
    "............",
    "............",
    "..oooooooo..",
    "..occcccco..",
    "..ocecceco..",
    "..ocecceco..",
    "..occcccco..",
    "..occccbbo..",
    "..occcbboo..",
    "..oooooo....",
    "............",
    "............",
  ],
};

const ROUTER_BELL_COLORS = {
  o: "#8a5300",
  b: "#ffcb3d",
  s: "#e9a417",
  w: "#fff1a8",
  e: EYE,
  p: "#ff9a7a",
  g: LEAF,
  G: LEAF_DARK,
  k: "#c98800",
  c: "#ff7a1a",
} as const;
/** The Router bell's honey body, the hue of its pastel send button. */
export const ROUTER_BELL_BODY = ROUTER_BELL_COLORS.b;
const ROUTER_BELL_ROWS = [
  "...gg..GG...",
  "....gggG....",
  ".....oo.....",
  "....oooo....",
  "...obwbbo...",
  "..obwbbbbo..",
  "..obebbebo..",
  "..obebbebo..",
  "..obpbbpso..",
  ".obbbbbbsso.",
  "okkkkkkkkkko",
  ".ooooccoooo.",
] as const;

const ROUTER_BELL_BODY_TOP = 2;
export const ROUTER_BELL_LIFT = (ROUTER_BELL_BODY_TOP + SLIME_GRID) / 2 - SLIME_GRID / 2;
export const ROUTER_BELL_PIVOT_ROW = 3;

const GATE_BELL_ROWS = ["..oo..", ".obbo.", ".obbo.", "obbbbo", "oooooo", "..cc.."] as const;

type Cell = readonly [number, number];

function cellsOf(rows: readonly string[], ch: string): Cell[] {
  const cells: Cell[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === ch) cells.push([x, y]);
  });
  return cells;
}

function outlinePath(cells: readonly Cell[]): string {
  const edges = new Map<string, [number, number, number, number]>();
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const back = `${x2},${y2}>${x1},${y1}`;
    if (edges.has(back)) edges.delete(back);
    else edges.set(`${x1},${y1}>${x2},${y2}`, [x1, y1, x2, y2]);
  };
  for (const [x, y] of cells) {
    add(x, y, x + 1, y);
    add(x + 1, y, x + 1, y + 1);
    add(x + 1, y + 1, x, y + 1);
    add(x, y + 1, x, y);
  }
  const from = new Map<string, [number, number, number, number][]>();
  for (const edge of edges.values()) {
    const key = `${edge[0]},${edge[1]}`;
    const list = from.get(key);
    if (list === undefined) from.set(key, [edge]);
    else list.push(edge);
  }
  let d = "";
  while (from.size > 0) {
    const start = from.keys().next().value!;
    const points: [number, number][] = [];
    let key = start;
    do {
      const list = from.get(key)!;
      const edge = list.pop()!;
      if (list.length === 0) from.delete(key);
      points.push([edge[0], edge[1]]);
      key = `${edge[2]},${edge[3]}`;
    } while (key !== start);
    const corners = points.filter(([x, y], i) => {
      const [px, py] = points[(i - 1 + points.length) % points.length]!;
      const [nx, ny] = points[(i + 1) % points.length]!;
      return (x - px) * (ny - y) !== (y - py) * (nx - x);
    });
    d += `${corners.map(([x, y], i) => (i === 0 ? `M${x} ${y}` : x === corners[i - 1]![0] ? `V${y}` : `H${x}`)).join("")}Z`;
  }
  return d;
}

export function pixelArtPaths(rows: readonly string[], fills: Readonly<Record<string, string>>): readonly SlimePath[] {
  const paths: SlimePath[] = [];
  for (const [ch, fill] of Object.entries(fills)) {
    const cells = cellsOf(rows, ch);
    if (cells.length > 0) paths.push(Object.freeze({ fill, d: outlinePath(cells) }));
  }
  return Object.freeze(paths);
}

function roleOf(sprite: Sprite, ch: string): SlimeRole | undefined {
  return sprite.roles?.[ch] ?? BASE_ROLES[ch];
}

function fillsOf(sprite: Sprite, color: JellyColor): Record<string, string> {
  const fills: Record<string, string> = {};
  for (const [ch, original] of Object.entries(sprite.colors)) {
    const role = roleOf(sprite, ch);
    fills[ch] = role === undefined ? original : color.roles[role];
  }
  return fills;
}

const spriteOf = (look: SlimeLook, kind: SlimeKind): Sprite => (kind === "piece" ? PIECE : SPRITES[look.fruit]);

export function isPmFruit(value: unknown): value is PmFruit {
  return isOneOf(PM_FRUITS, value);
}

export function isJellyColorId(value: unknown): value is JellyColorId {
  return isOneOf(JELLY_COLOR_IDS, value);
}

export function jellyColorOf(id: JellyColorId): JellyColor {
  return JELLY_COLORS.get(id)!;
}

const LOOKS = new Map<string, SlimeLook>();

export function slimeLookOf(fruit: PmFruit, color: JellyColorId): SlimeLook {
  const key = `${fruit}:${color}`;
  let look = LOOKS.get(key);
  if (look === undefined) {
    look = Object.freeze({ fruit, color });
    LOOKS.set(key, look);
  }
  return look;
}

export function defaultLookOf(pmId: PmId): SlimeLook {
  const fruit = pmFruitOf(pmId);
  return slimeLookOf(fruit, fruit);
}

export function resolvePmLook(pm: Pick<Pm, "id" | "avatarFruit" | "avatarColor">): SlimeLook {
  const fruit = isPmFruit(pm.avatarFruit) ? pm.avatarFruit : pmFruitOf(pm.id);
  const color = isJellyColorId(pm.avatarColor) ? pm.avatarColor : fruit;
  return slimeLookOf(fruit, color);
}

export function pickNewPmLook(taken: readonly SlimeLook[], pmId: PmId): SlimeLook {
  const used = new Set(taken.map((look) => look.fruit));
  const free = PM_FRUITS.find((fruit) => !used.has(fruit));
  return free === undefined ? defaultLookOf(pmId) : slimeLookOf(free, free);
}

export function lookKey(look: SlimeLook): string {
  return `${look.fruit}:${look.color}`;
}

export function parseLookKey(key: string): SlimeLook | null {
  const [fruit, color, ...rest] = key.split(":");
  if (rest.length > 0 || !isPmFruit(fruit) || !isJellyColorId(color)) return null;
  return slimeLookOf(fruit, color);
}

const PATHS = new Map<string, readonly SlimePath[]>();

export function slimePaths(look: SlimeLook, kind: SlimeKind): readonly SlimePath[] {
  const key = kind === "piece" ? `piece:${look.color}` : `main:${look.fruit}:${look.color}`;
  let paths = PATHS.get(key);
  if (paths === undefined) {
    const sprite = spriteOf(look, kind);
    paths = pixelArtPaths(sprite.rows, fillsOf(sprite, jellyColorOf(look.color)));
    PATHS.set(key, paths);
  }
  return paths;
}

const lastRowOf = (rows: readonly string[]) => rows.findLastIndex((row) => /[^.]/.test(row));

export function opticalLiftOf(fruit: PmFruit, kind: SlimeKind): number {
  if (kind === "piece") return 0;
  const { rows, bodyTop } = SPRITES[fruit];
  return (bodyTop + lastRowOf(rows) + 1) / 2 - SLIME_GRID / 2;
}

const firstRowOf = (rows: readonly string[]) => rows.findIndex((row) => /[^.]/.test(row));

// A tile's edges show every row's margin, so ears and leaves count here, unlike opticalLiftOf.
export function silhouetteLiftOf(fruit: PmFruit): number {
  const { rows } = SPRITES[fruit];
  return (firstRowOf(rows) + lastRowOf(rows) + 1) / 2 - SLIME_GRID / 2;
}

const svgOf = (paths: readonly SlimePath[], size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${paths.map((p) => `<path d="${p.d}" fill="${p.fill}"/>`).join("")}</svg>\n`;

export function slimeSvg(look: SlimeLook, kind: SlimeKind): string {
  return svgOf(slimePaths(look, kind), SLIME_GRID);
}

const ROUTER_BELL_PATHS = pixelArtPaths(ROUTER_BELL_ROWS, ROUTER_BELL_COLORS);
const GATE_BELL_PATHS = pixelArtPaths(GATE_BELL_ROWS, { o: ROUTER_BELL_COLORS.o, b: ROUTER_BELL_COLORS.b, c: ROUTER_BELL_COLORS.c });

export function routerBellPaths(): readonly SlimePath[] {
  return ROUTER_BELL_PATHS;
}

export function gateBellPaths(): readonly SlimePath[] {
  return GATE_BELL_PATHS;
}

export const GATE_BELL_GRID = GATE_BELL_ROWS.length;

export function routerBellSvg(): string {
  return svgOf(ROUTER_BELL_PATHS, SLIME_GRID);
}

const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

const boxCellsCache = new Map<number, number>();

function bitmapBoxCells(padCells: number): number {
  let box = boxCellsCache.get(padCells);
  if (box === undefined) {
    const half = SLIME_GRID / 2;
    const far = Math.max(
      ...PM_FRUITS.flatMap((fruit) =>
        SPRITES[fruit].rows.flatMap((row, y) =>
          [...row].flatMap((ch, x) => (ch === "." ? [] : [Math.hypot(Math.max(half - x, x + 1 - half), Math.max(half - y, y + 1 - half))])),
        ),
      ),
    );
    box = Math.ceil((far + padCells) * 2);
    boxCellsCache.set(padCells, box);
  }
  return box;
}

export function slimeBitmap(look: SlimeLook, targetPx: number, padCells: number): { size: number; rgb: Uint8Array } {
  const box = bitmapBoxCells(padCells);
  const cell = Math.max(1, Math.round(targetPx / box));
  const size = box * cell;
  const offset = Math.round(((box - SLIME_GRID) * cell) / 2);
  const color = jellyColorOf(look.color);
  const sprite = SPRITES[look.fruit];
  const fills = fillsOf(sprite, color);
  const rgb = new Uint8Array(size * size * 3);
  const fill = (x0: number, y0: number, w: number, h: number, hex: string) => {
    const [r, g, b] = hexRgb(hex);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * size + x) * 3;
        rgb[i] = r;
        rgb[i + 1] = g;
        rgb[i + 2] = b;
      }
    }
  };
  fill(0, 0, size, size, color.backdrop);
  sprite.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch !== ".") fill(offset + x * cell, offset + y * cell, cell, cell, fills[ch]!);
    }
  });
  return { size, rgb };
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = hexRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
