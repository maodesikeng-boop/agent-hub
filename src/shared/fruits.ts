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

export function pmFruitOf(key: number): PmFruit {
  const index = Number.isFinite(key) ? Math.abs(Math.trunc(key)) % PM_FRUITS.length : 0;
  return PM_FRUITS[index]!;
}
