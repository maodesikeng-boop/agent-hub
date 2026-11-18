// 画水果头像：assets/avatars/ 下每种水果一只 12×12 格的史莱姆小动物（项目经理）、它压薄的纸片分身（Piece）和飞书群头像。
//   node scripts/render-avatars.ts
// 改了图案重跑一次，提交生成的文件；scripts/render-avatars.test.ts 守着“提交的文件和这里画的一样”。
//   <水果>.svg        主形象，透明底，画布正好 12×12 格，脚底踩在最后一行
//   <水果>_piece.svg  纸片分身：同一只小动物抽掉几行压薄，不画明暗，在 12×12 的画布里上下居中
//   <水果>.png        主形象衬满铺底色，每格放大整数倍到 1024px 左右（飞书群头像只收位图，由飞书裁圆）
// SVG 每种颜色一条 path，没有位图、滤镜、渐变和 id。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { PM_FRUITS, pmFruitAvatarFile, type PmFruit } from "../src/shared/fruits.ts";

export const AVATARS_DIR = join(import.meta.dirname, "..", "assets", "avatars");
const GRID = 12;
/** 飞书群头像的目标边长；实际边长是画布格数的整数倍，取最接近它的。 */
const FEISHU_TARGET_PX = 1024;
/** 群头像里离圆心最远的像素角到圆边留几格（飞书把方图裁成圆）。 */
const FEISHU_PAD_CELLS = 0.75;
const EYE = "#3a1e14";
const LEAF = "#8ed04f";
const LEAF_DARK = "#3f9a4c";

interface Sprite {
  /** 飞书群头像的满铺底色：水果主色的浅色。 */
  bg: string;
  /** 字符 → 颜色。约定：o 描边（和身体同色相的深色，不用纯黑），b 身体，s 暗面，e 眼睛和嘴，p 腮红和内耳，其余各水果自定。 */
  colors: Record<string, string>;
  /** 12 行，每行 12 个字符，`.` 是透明。 */
  main: string[];
  /** 纸片分身从上到下的每一行：数字是照抄主形象的第几行（暗面改回身体色），字符串是单独画的一行；底边自动补。 */
  piece: (number | string)[];
}

const SPRITES: Record<PmFruit, Sprite> = {
  // 粉红西柚 × 小猪：朝外撇的耳朵，带两个鼻孔的浅色大鼻子
  grapefruit: {
    bg: "#ffe1da",
    colors: { o: "#a3342e", b: "#ff8f80", s: "#f06e62", e: EYE, p: "#f4567a", c: "#ffc7ba", n: "#b0403a" },
    main: [
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
    piece: [1, 2, 3, 6, 7, 8],
  },
  // 橙 × 小猫：尖耳朵、头顶一片小叶子、红鼻头
  orange: {
    bg: "#ffe6c4",
    colors: { o: "#9c3d0c", b: "#ff9a2e", s: "#ec7420", e: EYE, p: "#ff7f6e", n: "#d9482b", g: LEAF, G: LEAF_DARK },
    main: [
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
    piece: [1, 2, 3, 6, 7, 8],
  },
  // 奇异果 × 小熊：圆耳朵里是果肉绿，浅色口鼻
  kiwi: {
    bg: "#e2efc2",
    colors: { o: "#4a2a16", b: "#a97b4e", s: "#86593a", e: EYE, p: "#e98a78", k: "#a6d340", c: "#f1e6c4" },
    main: [
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
    piece: [1, 2, 3, 6, 7, 8],
  },
  // 草莓 × 小兔：长耳朵、小门牙，萼片像小帽子，身上两颗籽
  strawberry: {
    bg: "#ffdcd6",
    colors: { o: "#8a1230", b: "#f24a4a", s: "#cc2f45", e: EYE, w: "#ffffff", p: "#ffb4b4", g: "#6cc35a", G: "#2f9150", y: "#ffe7a6" },
    main: [
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
    piece: [0, 2, 3, 6, 7, 8],
  },
  // 青柠 × 小青蛙：眼睛长在头顶两个鼓包里，咧开的大嘴，浅色肚皮
  lime: {
    bg: "#e6f5c0",
    colors: { o: "#3f7a14", b: "#a5db3c", s: "#7fc026", e: EYE, p: "#ffa08a", c: "#e9f7b0" },
    main: [
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
    piece: [1, 2, 3, 4, "obpebbbbepbo", 8],
  },
  // 柠檬 × 小鸡：柠檬两头的尖当小翅膀，头顶果蒂和一片叶子，橙色的喙
  lemon: {
    bg: "#fff3bf",
    colors: { o: "#a66a00", b: "#ffd93d", s: "#f2b01e", e: EYE, p: "#ff9a7a", f: "#ff8a1e", g: LEAF, G: LEAF_DARK },
    main: [
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
    piece: [1, 2, "..oooooooo..", 6, 7, 8],
  },
  // 白柚 × 小狗：柚子的尖顶，两只垂下来的棕耳朵，黑鼻头和小舌头
  pomelo: {
    bg: "#fbe6b0",
    colors: { o: "#8a5a14", b: "#fff0b5", s: "#f1d98a", e: EYE, p: "#ffab8f", t: "#d99b38", n: EYE, r: "#ff7d8e" },
    main: [
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
    piece: ["..oooooooo..", 3, 6, 7, 8],
  },
  // 青椒 × 小恐龙：头顶三根浅色的刺，咧嘴露出两颗小尖牙
  bell_pepper: {
    bg: "#d3f0d2",
    colors: { o: "#14532d", b: "#40ad57", s: "#2b8f45", e: EYE, p: "#ff9a8a", k: "#a8e36a", w: "#ffffff" },
    main: [
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
    piece: [1, 2, 3, 6, 7, 8],
  },
  // 蓝莓 × 小企鹅：头顶蓝莓的小冠，白脸白肚皮，橙色的喙
  blueberry: {
    bg: "#dde4ff",
    colors: { o: "#27337a", b: "#5b78e6", s: "#4760c9", e: EYE, p: "#ffb3c0", w: "#ffffff", f: "#ff9a2e" },
    main: [
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
    piece: [1, 2, ".oooooooooo.", 5, 6, 7, 8],
  },
  // 水蜜桃 × 小猴：两边的小耳朵，心形的浅色脸，头顶一片叶子
  peach: {
    bg: "#ffe8df",
    colors: { o: "#c0504a", b: "#ffc0aa", s: "#f9a08e", e: EYE, p: "#ff7f8e", c: "#ffeedd", n: "#c0504a", g: LEAF, G: LEAF_DARK },
    main: [
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
    piece: [1, 2, 3, 5, 6, 7, 8],
  },
  // 西瓜 × 小老虎：额头和脸颊的深绿条纹，圆耳朵，西瓜红的鼻头
  watermelon: {
    bg: "#d9f2d6",
    colors: { o: "#165c2e", b: "#62c46a", s: "#46a857", e: EYE, p: "#ff9a8a", k: "#1f7d3c", c: "#e9f7c4", n: "#ff5a76" },
    main: [
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
    piece: [1, 2, 3, "obbekbbkebbo", 7, 8],
  },
  // 葡萄 × 小老鼠：两只大圆耳朵，粉鼻头，头顶一片葡萄叶
  grape: {
    bg: "#ebe0ff",
    colors: { o: "#4b2a8a", b: "#9c6ae6", s: "#7f50cc", e: EYE, p: "#ffb0d0", n: "#ff8fb3", g: LEAF, G: LEAF_DARK },
    main: [
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
    piece: [1, 2, 3, 6, 7, 8],
  },
  // 菠萝 × 小刺猬：头顶一丛菠萝叶，额头一排刺一样的菱格，尖尖的黑鼻头
  pineapple: {
    bg: "#ffeab8",
    colors: { o: "#8a5a00", b: "#f5b82e", s: "#dd9a1a", e: EYE, p: "#ff9a7a", k: "#c27f10", n: EYE, g: LEAF, G: LEAF_DARK },
    main: [
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
    piece: [1, 2, ".okooooooko.", 6, 7, 8],
  },
  // 樱桃 × 小瓢虫：两根樱桃梗当触角，身上四颗深色的斑点
  cherry: {
    bg: "#ffd9e0",
    colors: { o: "#6e0f2c", b: "#d02a52", s: "#ac1c44", e: EYE, p: "#ff8fa3", k: "#4a0d22", t: "#6f8f2e" },
    main: [
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
    piece: [0, 1, 2, ".okooooooko.", 6, 7, 8],
  },
  // 蜜瓜 × 小鲸鱼：头顶喷出的水柱，弯弯的嘴，浅色肚皮
  melon: {
    bg: "#dcf7ea",
    colors: { o: "#2f8a6a", b: "#b4ecd2", s: "#8fd9b8", e: EYE, p: "#ffab9f", c: "#fbffe6", a: "#6cc8ee" },
    main: [
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
    piece: [0, 1, 2, ".oooooooooo.", 6, 7, 8],
  },
  // 火龙果 × 六角恐龙：两边各三根绿尖的外鳃，头顶一撮火龙果的鳞片
  dragon_fruit: {
    bg: "#ffdcee",
    colors: { o: "#9c1257", b: "#f2559f", s: "#d93a86", e: EYE, p: "#ffb3d4", g: LEAF, G: LEAF_DARK },
    main: [
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
    piece: [1, 2, 3, 6, 7, 8],
  },
  // 青梨 × 小长颈鹿：梨的窄头宽肚，头顶两只带棕色小球的角，身上几块斑
  pear: {
    bg: "#f1f6c4",
    colors: { o: "#6b7a1e", b: "#dbe66e", s: "#c2d154", e: EYE, p: "#ffab8f", k: "#a39a3c", t: "#7a5a2a", n: EYE },
    main: [
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
    piece: [0, 1, 2, 3, 6, 7, 8],
  },
  // 山竹 × 小猫头鹰：头顶山竹的绿萼片，两只浅色的大眼盘，橙色的喙
  mangosteen: {
    bg: "#eedcf0",
    colors: { o: "#3a1438", b: "#7a3a78", s: "#5f2a60", e: EYE, p: "#ff9fb0", c: "#ffe9c4", f: "#ff9a2e", g: "#a6d36a", G: "#5f9a3c" },
    main: [
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
    piece: [1, 2, ".oooooooooo.", 5, 6, 7, 8],
  },
  // 柿子 × 小狐狸：深色耳尖的尖耳朵，两耳之间一片柿蒂，白脸颊
  persimmon: {
    bg: "#ffe0cf",
    colors: { o: "#8a2c0c", b: "#f5682a", s: "#d9501c", e: EYE, p: "#ffa08a", k: "#4a2412", w: "#fff6ea", n: EYE, g: "#9bbf4a", G: "#5f8a2e" },
    main: [
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
    piece: [1, 2, 3, 6, 7, 8],
  },
  // 椰子 × 小奶牛：一对小角，椰壳色的花斑，带两个鼻孔的粉嘴
  coconut: {
    bg: "#efe2cf",
    colors: { o: "#6b4423", b: "#fffdf5", s: "#ece3d0", e: EYE, p: "#ffb0b0", t: "#9a6a3c", h: "#e8c48a", m: "#ffc2c2", n: "#c97a7a" },
    main: [
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
    piece: [1, 2, ".oooooooooo.", 6, 7, "obpmnmmnmpbo"],
  },
};

type Grid = string[][];

function parse(key: string, rows: string[], colors: Record<string, string>): Grid {
  rows.forEach((row, y) => {
    if (row.length !== GRID) throw new Error(`${key} 第 ${y} 行：应有 ${GRID} 个字符，实际 ${row.length}：${row}`);
    for (const ch of row) if (ch !== "." && colors[ch] === undefined) throw new Error(`${key} 第 ${y} 行：没有颜色 ${ch}`);
  });
  return rows.map((row) => [...row]);
}

function mainGrid(fruit: PmFruit): Grid {
  const { main, colors } = SPRITES[fruit];
  if (main.length !== GRID) throw new Error(`${fruit}.main：应有 ${GRID} 行，实际 ${main.length}`);
  if (!/[^.]/.test(main[GRID - 1]!)) throw new Error(`${fruit}.main：最后一行是空的，脚底没踩在基线上`);
  return parse(`${fruit}.main`, main, colors);
}

/** 纸片分身：照 piece 抽行，暗面改回身体色（纸片不画明暗），最后按末行的宽度补一条底边。 */
function pieceGrid(fruit: PmFruit): Grid {
  const { main, piece, colors } = SPRITES[fruit];
  const rows = piece.map((item) => (typeof item === "number" ? main[item]!.replaceAll("s", "b") : item));
  const last = rows.at(-1)!;
  const left = last.search(/[^.]/);
  const right = last.length - 1 - [...last].reverse().join("").search(/[^.]/);
  rows.push(".".repeat(left + 1) + "o".repeat(right - left - 1) + ".".repeat(GRID - right));
  if (rows.length >= GRID - 2) throw new Error(`${fruit}.piece：有 ${rows.length} 行，没比主形象薄`);
  return parse(`${fruit}.piece`, rows, colors);
}

const cellsOf = (grid: Grid, match: (ch: string) => boolean): [number, number][] =>
  grid.flatMap((row, y) => row.flatMap((ch, x): [number, number][] => (match(ch) ? [[x, y]] : [])));

/** 一种颜色的所有格子并成一个轮廓：相邻两格共用的边抵消，剩下的边首尾相接成闭合路径，内部没有接缝。 */
function outline(cells: [number, number][]): string {
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
    if (!from.has(key)) from.set(key, []);
    from.get(key)!.push(edge);
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

/** top：画布顶边在第几格（纸片分身行数少，取负数让它上下居中）。 */
function svg(grid: Grid, colors: Record<string, string>, top: number): string {
  const body = Object.entries(colors)
    .map(([ch, color]): [[number, number][], string] => [cellsOf(grid, (c) => c === ch), color])
    .filter(([cells]) => cells.length > 0)
    .map(([cells, color]) => `<path d="${outline(cells)}" fill="${color}"/>`)
    .join("");
  // crispEdges：头像边长不是格数的整数倍时，每条边吸附到屏幕像素，不出半透明的糊边
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${top} ${GRID} ${GRID}" shape-rendering="crispEdges">${body}</svg>\n`;
}

/** 后置：文件名 → SVG 文本，每种水果两个（主形象、纸片分身）。 */
export function avatarSvgs(): Map<string, string> {
  const files = new Map<string, string>();
  for (const fruit of PM_FRUITS) {
    const { colors } = SPRITES[fruit];
    const piece = pieceGrid(fruit);
    files.set(pmFruitAvatarFile(fruit, "main"), svg(mainGrid(fruit), colors, 0));
    files.set(pmFruitAvatarFile(fruit, "piece"), svg(piece, colors, -(GRID - piece.length) / 2));
  }
  return files;
}

/** 群头像的画布格数：圆心在主形象正中，取全部水果里离圆心最远的像素角，再留 FEISHU_PAD_CELLS 格。 */
function feishuBoxCells(): number {
  const half = GRID / 2;
  const far = Math.max(
    ...PM_FRUITS.flatMap((fruit) => cellsOf(mainGrid(fruit), (c) => c !== ".").map(([x, y]) => Math.hypot(Math.max(half - x, x + 1 - half), Math.max(half - y, y + 1 - half)))),
  );
  return Math.ceil((far + FEISHU_PAD_CELLS) * 2);
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** 后置：这个水果群头像的像素（RGB，逐行），边长 size；每格是 size / 画布格数 个整像素，没有插值。 */
export function feishuAvatarPixels(fruit: PmFruit): { size: number; data: Buffer } {
  const box = feishuBoxCells();
  const cell = Math.round(FEISHU_TARGET_PX / box);
  const size = box * cell;
  const offset = Math.round(((box - GRID) * cell) / 2);
  const { bg, colors } = SPRITES[fruit];
  const data = Buffer.alloc(size * size * 3);
  const fill = (x0: number, y0: number, w: number, h: number, color: string) => {
    const [r, g, b] = rgb(color);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * size + x) * 3;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
    }
  };
  fill(0, 0, size, size, bg);
  mainGrid(fruit).forEach((row, y) => row.forEach((ch, x) => ch !== "." && fill(offset + x * cell, offset + y * cell, cell, cell, colors[ch]!)));
  return { size, data };
}

async function main(): Promise<void> {
  mkdirSync(AVATARS_DIR, { recursive: true });
  for (const [name, text] of avatarSvgs()) writeFileSync(join(AVATARS_DIR, name), text);
  for (const fruit of PM_FRUITS) {
    const { size, data } = feishuAvatarPixels(fruit);
    await sharp(data, { raw: { width: size, height: size, channels: 3 } })
      .png({ palette: true, compressionLevel: 9, effort: 10 })
      .toFile(join(AVATARS_DIR, pmFruitAvatarFile(fruit, "feishu")));
  }
  const { size } = feishuAvatarPixels(PM_FRUITS[0]!);
  console.log(`${PM_FRUITS.length} 种水果：${PM_FRUITS.length * 2} 个 SVG、${PM_FRUITS.length} 张 ${size}×${size} 的 PNG → ${AVATARS_DIR}`);
}

if (import.meta.main) await main();
