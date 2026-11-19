// 项目经理的造型名录（docs/slime-cohesion-design.md）：20 只水果史莱姆小动物，名录、顺序和默认分配只在这一处。
// 像素稿、颜色和画法在 shared/slimes.ts：网页头像、Piece 分身、飞书群头像、应用图标都从那里画，不存图片文件。

/** 顺序就是默认分配顺序（pmFruitOf 按编号取余）：前 8 种是最早的那批，位置不动；后 12 种按“相邻两个颜色差别大”排。 */
export const FRUITS = [
  { fruit: "grapefruit", name: "粉红西柚" },
  { fruit: "orange", name: "橙" },
  { fruit: "kiwi", name: "奇异果" },
  { fruit: "strawberry", name: "草莓" },
  { fruit: "lime", name: "青柠" },
  { fruit: "lemon", name: "柠檬" },
  { fruit: "pomelo", name: "白柚" },
  { fruit: "bell_pepper", name: "青椒" },
  { fruit: "blueberry", name: "蓝莓" },
  { fruit: "peach", name: "水蜜桃" },
  { fruit: "watermelon", name: "西瓜" },
  { fruit: "grape", name: "葡萄" },
  { fruit: "pineapple", name: "菠萝" },
  { fruit: "cherry", name: "樱桃" },
  { fruit: "melon", name: "蜜瓜" },
  { fruit: "dragon_fruit", name: "火龙果" },
  { fruit: "pear", name: "青梨" },
  { fruit: "mangosteen", name: "山竹" },
  { fruit: "persimmon", name: "柿子" },
  { fruit: "coconut", name: "椰子" },
] as const;

export type PmFruit = (typeof FRUITS)[number]["fruit"];

export const PM_FRUITS: readonly PmFruit[] = FRUITS.map((f) => f.fruit);

/** 按 key（项目经理用它的编号）在水果表里轮着取：负数按绝对值，小数取整，不是数（NaN、无穷）回第一个。 */
export function pmFruitOf(key: number): PmFruit {
  const index = Number.isFinite(key) ? Math.abs(Math.trunc(key)) % PM_FRUITS.length : 0;
  return PM_FRUITS[index]!;
}
