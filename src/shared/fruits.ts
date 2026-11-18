// 项目经理的水果（docs/ui-standard.md 第 4 条、docs/feishu-design.md「自动建群」）：网页头像配色和飞书群头像共用这一份顺序。
// 图片在仓库根目录的 assets/avatars/：<水果>.webp 是完整横切面（项目经理），<水果>_wedge.webp 是果瓣（Worker）。
// 打包时整个目录随守护进程带走（scripts/stage-runtime-common.ts），网页由 vite 打包。水果的个数只看 PM_FRUITS.length。

export const PM_FRUITS = ["grapefruit", "orange", "kiwi", "strawberry", "lime", "lemon", "pomelo", "bell_pepper"] as const;
export type PmFruit = (typeof PM_FRUITS)[number];

/** 按 key（项目经理用它的编号）在水果表里轮着取，负数按绝对值。 */
export function pmFruitOf(key: number): PmFruit {
  return PM_FRUITS[Math.abs(key) % PM_FRUITS.length]!;
}

/** assets/avatars/ 下这个水果完整横切面的文件名。 */
export function pmFruitSliceFile(fruit: PmFruit): string {
  return `${fruit}.webp`;
}
