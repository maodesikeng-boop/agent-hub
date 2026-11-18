import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import { PM_FRUITS } from "../../shared/fruits.ts";
import { createFeishuAvatarCache, FEISHU_AVATARS_DIR, pmFruitImagePath, pmFruitOf, type PmFruit } from "./avatars.ts";

describe("水果头像", () => {
  it("pmFruitOf 和网页 paletteOf(pmId).fruit 相同（覆盖编号 0 到颜色表长度的两倍）", () => {
    // 网页一侧 palette.test.ts 断言 paletteOf(key).fruit === pmFruitOf(key)，这里断言两边共用的顺序表
    for (let pmId = 0; pmId <= PM_FRUITS.length * 2; pmId++) expect(pmFruitOf(pmId)).toBe(PM_FRUITS[pmId % PM_FRUITS.length]);
  });

  it("pmFruitImagePath 指向存在的完整横切面图片", () => {
    for (const fruit of PM_FRUITS) {
      const path = pmFruitImagePath(FEISHU_AVATARS_DIR, fruit);
      expect(path.endsWith(`${fruit}.webp`)).toBe(true);
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("同一个水果只上传一次，并发两次也只传一次；之后从 feishu_avatars 读", async () => {
    const saved = new Map<PmFruit, FeishuImageKey>();
    const store = { avatarKey: (f: PmFruit) => saved.get(f) ?? null, saveAvatarKey: (f: PmFruit, k: FeishuImageKey) => void saved.set(f, k) };
    const upload = vi.fn(async (f: PmFruit) => `img_${f}` as FeishuImageKey);
    const cache = createFeishuAvatarCache(store, () => 1);
    const [a, b] = await Promise.all([cache.imageKeyOf("kiwi", upload), cache.imageKeyOf("kiwi", upload)]);
    expect([a, b]).toEqual(["img_kiwi", "img_kiwi"]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(saved.get("kiwi")).toBe("img_kiwi");
    const again = createFeishuAvatarCache(store, () => 2);
    expect(await again.imageKeyOf("kiwi", upload)).toBe("img_kiwi");
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
