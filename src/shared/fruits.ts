// 项目经理的水果（docs/ui-standard.md 第 4 条、docs/feishu-design.md「自动建群」）：水果名录、顺序和配色只在这一处，
// 网页头像与配色（web/lib/palette.ts）、飞书群头像（daemon/feishu/avatars.ts）、画头像的脚本（scripts/render-avatars.ts）都按它取。
// 头像在仓库根目录的 assets/avatars/，由 scripts/render-avatars.ts 生成：每种水果一只史莱姆小动物（<水果>.svg，项目经理）、
// 它压薄的纸片分身（<水果>_piece.svg，Piece）和衬满铺底色的群头像（<水果>.png，飞书只收位图）。
// 打包时整个目录随守护进程带走（scripts/stage-runtime-common.ts），网页由 vite 打包。

/**
 * 顺序就是分配顺序（pmFruitOf 按编号取余）：前 8 种是最早的那批，位置不动；后 12 种按“相邻两个颜色差别大”排。
 * - blob：水果主色（明亮原色，不放文字）。
 * - accent：这个会话里的 `--primary`：同一个色相深一档，既当白字的底色也当白底上的文字色，对白色的对比度 ≥ 4.5:1（web/lib/palette.test.ts 逐色校验）。
 * - accentForeground：放在 accent 上的字。
 */
export const FRUITS = [
  { fruit: "grapefruit", name: "粉红西柚", blob: "#ff6b57", accent: "#c83220", accentForeground: "#ffffff" },
  { fruit: "orange", name: "橙", blob: "#ff7a1a", accent: "#c2410c", accentForeground: "#ffffff" },
  { fruit: "kiwi", name: "奇异果", blob: "#5fb327", accent: "#3b6e14", accentForeground: "#ffffff" },
  { fruit: "strawberry", name: "草莓", blob: "#e6392e", accent: "#b91c1c", accentForeground: "#ffffff" },
  { fruit: "lime", name: "青柠", blob: "#4cb82a", accent: "#15803d", accentForeground: "#ffffff" },
  { fruit: "lemon", name: "柠檬", blob: "#f5b400", accent: "#8f6200", accentForeground: "#ffffff" },
  { fruit: "pomelo", name: "白柚", blob: "#d99b38", accent: "#855814", accentForeground: "#ffffff" },
  { fruit: "bell_pepper", name: "青椒", blob: "#2f9e44", accent: "#1b6e2d", accentForeground: "#ffffff" },
  { fruit: "blueberry", name: "蓝莓", blob: "#5b78e6", accent: "#3447b5", accentForeground: "#ffffff" },
  { fruit: "peach", name: "水蜜桃", blob: "#ffb39e", accent: "#a8503f", accentForeground: "#ffffff" },
  { fruit: "watermelon", name: "西瓜", blob: "#3dbb6a", accent: "#0f7a5a", accentForeground: "#ffffff" },
  { fruit: "grape", name: "葡萄", blob: "#9c6ae6", accent: "#6b3fc4", accentForeground: "#ffffff" },
  { fruit: "pineapple", name: "菠萝", blob: "#f5b82e", accent: "#a15c00", accentForeground: "#ffffff" },
  { fruit: "cherry", name: "樱桃", blob: "#d02a52", accent: "#a3123f", accentForeground: "#ffffff" },
  { fruit: "melon", name: "蜜瓜", blob: "#8fdcb8", accent: "#1d7d68", accentForeground: "#ffffff" },
  { fruit: "dragon_fruit", name: "火龙果", blob: "#f2559f", accent: "#b8186b", accentForeground: "#ffffff" },
  { fruit: "pear", name: "青梨", blob: "#cfdc55", accent: "#5f6f12", accentForeground: "#ffffff" },
  { fruit: "mangosteen", name: "山竹", blob: "#8e4a8c", accent: "#6d2a6b", accentForeground: "#ffffff" },
  { fruit: "persimmon", name: "柿子", blob: "#f5682a", accent: "#ad3311", accentForeground: "#ffffff" },
  { fruit: "coconut", name: "椰子", blob: "#9a6a3c", accent: "#6b4a2e", accentForeground: "#ffffff" },
] as const;

export type PmFruit = (typeof FRUITS)[number]["fruit"];
export type FruitStyle = (typeof FRUITS)[number];

export const PM_FRUITS: readonly PmFruit[] = FRUITS.map((f) => f.fruit);

/** 按 key（项目经理用它的编号）在水果表里轮着取：负数按绝对值，小数取整，不是数（NaN、无穷）回第一个。 */
export function pmFruitOf(key: number): PmFruit {
  const index = Number.isFinite(key) ? Math.abs(Math.trunc(key)) % PM_FRUITS.length : 0;
  return PM_FRUITS[index]!;
}

/** assets/avatars/ 下的文件名：main 是项目经理的主形象，piece 是 Piece 的纸片分身，feishu 是飞书群头像。 */
export function pmFruitAvatarFile(fruit: PmFruit, kind: "main" | "piece" | "feishu"): string {
  if (kind === "main") return `${fruit}.svg`;
  if (kind === "piece") return `${fruit}_piece.svg`;
  return `${fruit}.png`;
}
