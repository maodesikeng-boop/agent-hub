import { describe, expect, it } from "vitest";
import { FRUITS, PM_FRUITS, pmFruitAvatarFile, pmFruitOf } from "./fruits.ts";

describe("shared/fruits：水果名录", () => {
  it("20 种，标识、名字、主色、强调色都不重复；最早的 8 种位置不动", () => {
    expect(FRUITS).toHaveLength(20);
    for (const key of ["fruit", "name", "blob", "accent"] as const) expect(new Set(FRUITS.map((f) => f[key])).size, key).toBe(FRUITS.length);
    expect(PM_FRUITS.slice(0, 8)).toEqual(["grapefruit", "orange", "kiwi", "strawberry", "lime", "lemon", "pomelo", "bell_pepper"]);
  });

  it("连着的 20 个项目经理编号各拿到不同的水果", () => {
    for (const start of [0, 1, 7, 33]) expect(new Set(Array.from({ length: 20 }, (_, i) => pmFruitOf(start + i))).size).toBe(20);
  });

  it("越界和不是数的 key 都能安全取到一个水果", () => {
    expect(pmFruitOf(-1)).toBe(PM_FRUITS[1]);
    expect(pmFruitOf(20)).toBe(PM_FRUITS[0]);
    expect(pmFruitOf(41.9)).toBe(PM_FRUITS[1]);
    for (const key of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(pmFruitOf(key)).toBe(PM_FRUITS[0]);
    expect(pmFruitOf(Number.MAX_SAFE_INTEGER)).toBe(PM_FRUITS[Number.MAX_SAFE_INTEGER % 20]);
  });

  it("pmFruitAvatarFile：主形象和纸片分身是 svg，飞书群头像是 png", () => {
    expect((["main", "piece", "feishu"] as const).map((kind) => pmFruitAvatarFile("kiwi", kind))).toEqual(["kiwi.svg", "kiwi_piece.svg", "kiwi.png"]);
  });
});
