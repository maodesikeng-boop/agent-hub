// 史莱姆形象（docs/slime-cohesion-design.md）：项目经理的形象 = 造型 × 颜色，两样分开存、自由搭配。
// 不变量：
// - 造型的名录和顺序就是 shared/fruits.ts 的 PM_FRUITS（20 只水果史莱姆小动物，12×12 格像素稿）；颜色名录是 JELLY_COLOR_IDS，
//   前 20 种是各水果的原色（id 和水果同名），后面是新加的颜色。
// - 像素稿只用“角色字符”标颜色：描边、身体、暗面、浅色、腮红、花纹跟着颜色换；眼睛、叶子、喙、牙这类配件不换色。
// - 没存造型按编号取（pmFruitOf），没存颜色用这个造型自己的原色：老数据看起来和以前一模一样。
// - Piece 分身和造型无关：一张卷了角的便签小灵（P1），只有一双眼睛，跟着项目经理的颜色换色；
//   同一种颜色下 20 个造型的项目经理，分出来的 Piece 长得一样。
// - 网页头像、Piece 分身、总助嫩芽铃、拍板小铃、飞书群头像、应用图标都从这里画，不另存图片文件；同一个形象在哪画出来都一样。
import { isOneOf, type Pm, type PmId } from "./domain.ts";
import { PM_FRUITS, pmFruitOf, type PmFruit } from "./fruits.ts";

/** 像素稿的边长（格）。 */
export const SLIME_GRID = 12;

/** 新加的颜色（不对应任何水果）。 */
export const EXTRA_JELLY_COLOR_IDS = ["sky", "teal", "sakura", "graphite"] as const;
export type ExtraJellyColorId = (typeof EXTRA_JELLY_COLOR_IDS)[number];
export type JellyColorId = PmFruit | ExtraJellyColorId;

/** 颜色名录，顺序就是选择器里色板的顺序。 */
export const JELLY_COLOR_IDS: readonly JellyColorId[] = [...PM_FRUITS, ...EXTRA_JELLY_COLOR_IDS];

/** 跟着颜色换的角色。 */
export type SlimeRole = "outline" | "body" | "shade" | "light" | "blush" | "mark";

/** 一套果冻色。 */
export interface JellyColor {
  id: JellyColorId;
  /** 界面上的英文名：色板的读屏名字和悬停提示。 */
  label: string;
  /** 像素稿里各角色的颜色。 */
  roles: Readonly<Record<SlimeRole, string>>;
  /** 主色：明亮，不放文字。进度图标、果皮轨、色板圆点用它。 */
  blob: string;
  /** 会话的 --primary：对白色的对比度 ≥ 4.5:1（WCAG 2.x 1.4.3），既当白字的底色也当白底上的字色。 */
  accent: string;
  accentForeground: string;
  /** 满铺浅底：飞书群头像的底色。 */
  backdrop: string;
}

/** 一只史莱姆的形象。 */
export interface SlimeLook {
  fruit: PmFruit;
  color: JellyColorId;
}

/** 存在项目经理身上的两项（pm_looks 表的 fruit、color）：null 是“用默认”。 */
export interface PmLookSetting {
  fruit: PmFruit | null;
  color: JellyColorId | null;
}

/** main 是项目经理的主形象；piece 是 Piece 分身（和造型无关，只看颜色）。 */
export type SlimeKind = "main" | "piece";

/** 同一个像素字符的格子并成的一条路径，坐标是像素稿的格子。 */
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

// 前 20 种的角色色取各只加换色之前的稿：没有浅色字符的，浅色是身体掺 60% 白；没有花纹字符的，花纹是身体和描边各半（算好写成字面量）。
// blob、accent 是原来 shared/fruits.ts 的主色、强调色，backdrop 是原来飞书群头像的底色。
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

/** 造型的读屏名字（换形象浮层里每个格子的 aria-label 和悬停提示）。 */
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
  /** 字符 → 加换色之前的颜色；键的顺序就是画的顺序。约定：o 描边、b 身体、s 暗面、c 浅色、p 腮红跟着颜色换，e 眼睛。 */
  colors: Readonly<Record<string, string>>;
  /** 除 o b s c p 之外跟着颜色换的字符（花纹、和描边同色的嘴、当浅色用的刺）。 */
  roles?: Readonly<Record<string, SlimeRole>>;
  /** 身体（不算耳朵、叶子、触角、水柱）从第几行起：光学对齐按身体的上下中点算。 */
  bodyTop: number;
  /** 12 行，每行 12 个字符，`.` 是透明。脚底踩在最后一行。 */
  rows: readonly string[];
}

const BASE_ROLES: Readonly<Record<string, SlimeRole>> = { o: "outline", b: "body", s: "shade", c: "light", p: "blush" };

const SPRITES: Readonly<Record<PmFruit, Sprite>> = {
  // 粉红西柚 × 小猪：朝外撇的耳朵，带两个鼻孔的浅色大鼻子
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
  // 橙 × 小猫：尖耳朵、头顶一片小叶子、红鼻头
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
  // 奇异果 × 小熊：圆耳朵里是果肉绿，浅色口鼻
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
  // 草莓 × 小兔：长耳朵、小门牙，萼片像小帽子，身上两颗籽
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
  // 青柠 × 小青蛙：眼睛长在头顶两个鼓包里，咧开的大嘴，浅色肚皮
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
  // 柠檬 × 小鸡：柠檬两头的尖当小翅膀，头顶果蒂和一片叶子，橙色的喙
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
  // 白柚 × 小狗：柚子的尖顶，两只垂下来的棕耳朵，黑鼻头和小舌头
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
  // 青椒 × 小恐龙：头顶三根浅色的刺，咧嘴露出两颗小尖牙
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
  // 蓝莓 × 小企鹅：头顶蓝莓的小冠，白脸白肚皮，橙色的喙
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
  // 水蜜桃 × 小猴：两边的小耳朵，心形的浅色脸，头顶一片叶子
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
  // 西瓜 × 小老虎：额头和脸颊的深绿条纹，圆耳朵，西瓜红的鼻头
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
  // 葡萄 × 小老鼠：两只大圆耳朵，粉鼻头，头顶一片葡萄叶
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
  // 菠萝 × 小刺猬：头顶一丛菠萝叶，额头一排刺一样的菱格，尖尖的黑鼻头
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
  // 樱桃 × 小瓢虫：两根樱桃梗当触角，身上四颗深色的斑点
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
  // 蜜瓜 × 小鲸鱼：头顶喷出的水柱，弯弯的嘴，浅色肚皮
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
  // 火龙果 × 六角恐龙：两边各三根绿尖的外鳃，头顶一撮火龙果的鳞片
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
  // 青梨 × 小长颈鹿：梨的窄头宽肚，头顶两只带棕色小球的角，身上几块斑
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
  // 山竹 × 小猫头鹰：头顶山竹的绿萼片，两只浅色的大眼盘，橙色的喙
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
  // 柿子 × 小狐狸：深色耳尖的尖耳朵，两耳之间一片柿蒂，白脸颊
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
  // 椰子 × 小奶牛：一对小角，椰壳色的花斑，带两个鼻孔的粉嘴
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

// Piece 分身 P1 便签小灵：卷了角的小便签，纸面浅色、卷角露出身体色的背面，只有一双豆豆眼；在画布里上下居中。
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

// 总助嫩芽铃：铜金色小手铃，顶上两片嫩芽当提钮，铃身一张小脸，铃舌是一颗小橙果。不换色。
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

/** 嫩芽铃的身体（铃身，不算嫩芽）从第 2 行起：光学对齐时往上挪的格数，和项目经理的史莱姆同一个算法。 */
const ROUTER_BELL_BODY_TOP = 2;
export const ROUTER_BELL_LIFT = (ROUTER_BELL_BODY_TOP + SLIME_GRID) / 2 - SLIME_GRID / 2;
/** 摇摆的轴：提钮（第 2、3 行）中间那条线，离画布顶的格数。 */
export const ROUTER_BELL_PIVOT_ROW = 3;

// 任务图里“等你拍板”的小铃，6×6 格。
const GATE_BELL_ROWS = ["..oo..", ".obbo.", ".obbo.", "obbbbo", "oooooo", "..cc.."] as const;

type Cell = readonly [number, number];

function cellsOf(rows: readonly string[], ch: string): Cell[] {
  const cells: Cell[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === ch) cells.push([x, y]);
  });
  return cells;
}

/** 同一种字符的所有格子并成闭合轮廓：相邻两格共用的边抵消，剩下的边首尾相接，内部没有接缝；只有横竖线段。 */
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

/**
 * 一张像素稿按字符上色：每个字符的格子并成一条只有横竖线段的闭合路径，字符顺序就是 fills 的键序，没有格子的字符跳过、`.` 透明。
 * 任务进度图标这类别的像素小图也用它画。
 */
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

/** 后置：value 是名录里的造型 id 时为真。 */
export function isPmFruit(value: unknown): value is PmFruit {
  return isOneOf(PM_FRUITS, value);
}

/** 后置：value 是名录里的颜色 id 时为真。 */
export function isJellyColorId(value: unknown): value is JellyColorId {
  return isOneOf(JELLY_COLOR_IDS, value);
}

/** 后置：这种颜色的整套色值。同一个 id 每次返回同一个对象。 */
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

/** 后置：编号对应的默认形象，造型是 pmFruitOf(pmId)，颜色是这个造型的原色。同样的编号每次返回同一个对象。 */
export function defaultLookOf(pmId: PmId): SlimeLook {
  const fruit = pmFruitOf(pmId);
  return slimeLookOf(fruit, fruit);
}

/**
 * 后置：项目经理现在的形象。avatarFruit、avatarColor 缺了、是 null、或不在名录里（比如新版本设备传来的颜色），各自退回 defaultLookOf 的那一项。
 * 同样的造型和颜色每次返回同一个对象（memo 的子组件不重画）。
 */
export function resolvePmLook(pm: Pick<Pm, "id" | "avatarFruit" | "avatarColor">): SlimeLook {
  const fruit = isPmFruit(pm.avatarFruit) ? pm.avatarFruit : pmFruitOf(pm.id);
  const color = isJellyColorId(pm.avatarColor) ? pm.avatarColor : fruit;
  return slimeLookOf(fruit, color);
}

/**
 * 新建项目经理时分配的形象：不和 taken（没归档的项目经理现在的形象）撞造型。
 * 后置：取名录里第一个没被占的造型，配它的原色；20 种都占了，退回 defaultLookOf(pmId)。
 */
export function pickNewPmLook(taken: readonly SlimeLook[], pmId: PmId): SlimeLook {
  const used = new Set(taken.map((look) => look.fruit));
  const free = PM_FRUITS.find((fruit) => !used.has(fruit));
  return free === undefined ? defaultLookOf(pmId) : slimeLookOf(free, free);
}

/** 后置：形象的字符串键（如 "persimmon:sky"），飞书头像缓存按它认。parseLookKey(lookKey(x)) 等于 x。 */
export function lookKey(look: SlimeLook): string {
  return `${look.fruit}:${look.color}`;
}

/** 后置：lookKey 的反过来；造型或颜色不在名录里返回 null。 */
export function parseLookKey(key: string): SlimeLook | null {
  const [fruit, color, ...rest] = key.split(":");
  if (rest.length > 0 || !isPmFruit(fruit) || !isJellyColorId(color)) return null;
  return slimeLookOf(fruit, color);
}

const PATHS = new Map<string, readonly SlimePath[]>();

/**
 * 后置：这只史莱姆按 look 上色后的路径，一个像素字符一条，坐标落在 12×12 格内。同样的输入每次返回同一个数组。
 * main：原色（color 等于 fruit）画出来和加换色之前的头像逐格相同。
 * piece：只看 look.color，不看 look.fruit；只用描边、身体、暗面、浅色和眼睛，没有腮红、花纹、耳朵、叶子；在画布里上下居中。
 */
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

/**
 * 光学对齐要往上挪的格数：身体（不算耳朵、叶子、触角）的上下中点到画布中线的距离，Piece 分身是 0。
 * 后置：0 到 2 之间；头像框里按它上移后，各只的身体都在框的正中。
 */
export function opticalLiftOf(fruit: PmFruit, kind: SlimeKind): number {
  if (kind === "piece") return 0;
  const { rows, bodyTop } = SPRITES[fruit];
  return (bodyTop + lastRowOf(rows) + 1) / 2 - SLIME_GRID / 2;
}

const svgOf = (paths: readonly SlimePath[], size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${paths.map((p) => `<path d="${p.d}" fill="${p.fill}"/>`).join("")}</svg>\n`;

/** 后置：一张独立的 SVG 文本（viewBox 12×12，crispEdges，透明底，每个像素字符一条 path，没有 id、渐变、滤镜）。 */
export function slimeSvg(look: SlimeLook, kind: SlimeKind): string {
  return svgOf(slimePaths(look, kind), SLIME_GRID);
}

const ROUTER_BELL_PATHS = pixelArtPaths(ROUTER_BELL_ROWS, ROUTER_BELL_COLORS);
const GATE_BELL_PATHS = pixelArtPaths(GATE_BELL_ROWS, { o: ROUTER_BELL_COLORS.o, b: ROUTER_BELL_COLORS.b, c: ROUTER_BELL_COLORS.c });

/** 后置：总助嫩芽铃的路径，12×12 格，透明底；每次返回同一个数组。 */
export function routerBellPaths(): readonly SlimePath[] {
  return ROUTER_BELL_PATHS;
}

/** 后置：拍板小铃的路径，6×6 格（GATE_BELL_GRID），透明底；每次返回同一个数组。 */
export function gateBellPaths(): readonly SlimePath[] {
  return GATE_BELL_PATHS;
}

/** 拍板小铃的边长（格）。 */
export const GATE_BELL_GRID = GATE_BELL_ROWS.length;

/** 后置：总助嫩芽铃的独立 SVG 文本（viewBox 12×12，crispEdges，透明底）。 */
export function routerBellSvg(): string {
  return svgOf(ROUTER_BELL_PATHS, SLIME_GRID);
}

const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

const boxCellsCache = new Map<number, number>();

/** 群头像的画布格数：圆心在主形象正中，取全部造型里离圆心最远的像素角，再留 padCells 格（和造型、颜色无关，换形象时边长不变）。 */
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

/**
 * 满铺底色的主形象位图（飞书群头像只收位图，由飞书裁成圆）。
 * 后置：边长 size 是格子数的整数倍、最接近 targetPx；底色是 jellyColorOf(look.color).backdrop；每格整像素，没有插值；
 * 圆形裁切后离圆心最远的像素角到圆边至少留 padCells 格。rgb 逐行排列、每像素 3 字节；同样的输入每次得到逐字节相同的 rgb。
 */
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

/** WCAG 2.x 的对比度：(亮 + 0.05) / (暗 + 0.05)，两个 #rrggbb。https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
