import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import { PM_FRUITS } from "../../shared/fruits.ts";
import { createFeishuAvatarCache, FEISHU_AVATARS_DIR, feishuAvatarHash, pmFruitImagePath, pmFruitOf, type PmFruit } from "./avatars.ts";

describe("水果头像", () => {
  it("pmFruitOf 和网页 paletteOf(pmId).fruit 相同（覆盖编号 0 到颜色表长度的两倍）", () => {
    // 网页一侧 palette.test.ts 断言 paletteOf(key).fruit === pmFruitOf(key)，这里断言两边共用的顺序表
    for (let pmId = 0; pmId <= PM_FRUITS.length * 2; pmId++) expect(pmFruitOf(pmId)).toBe(PM_FRUITS[pmId % PM_FRUITS.length]);
  });

  it("pmFruitImagePath 指向存在的群头像：PNG、正方形、边长 1000px 以上、满铺不透明", async () => {
    for (const fruit of PM_FRUITS) {
      const path = pmFruitImagePath(FEISHU_AVATARS_DIR, fruit);
      expect(path.endsWith(`${fruit}.png`)).toBe(true);
      const meta = await sharp(path).metadata();
      expect([meta.format, meta.width === meta.height, meta.width >= 1000, meta.hasAlpha], path).toEqual(["png", true, true, false]);
    }
  });

  it("feishuAvatarHash 是图片文件内容的 SHA-256", () => {
    const path = pmFruitImagePath(FEISHU_AVATARS_DIR, "kiwi");
    expect(feishuAvatarHash(FEISHU_AVATARS_DIR, "kiwi")).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  });

  it("同一张图只上传一次，并发两次也只传一次；之后从 feishu_avatars 读", async () => {
    const store = fakeStore();
    const upload = vi.fn(async (f: PmFruit) => `img_${f}` as FeishuImageKey);
    const cache = createFeishuAvatarCache(store, () => 1);
    const [a, b] = await Promise.all([cache.imageKeyOf("kiwi", "h1", upload), cache.imageKeyOf("kiwi", "h1", upload)]);
    expect([a, b]).toEqual(["img_kiwi", "img_kiwi"]);
    expect(upload).toHaveBeenCalledTimes(1);
    const again = createFeishuAvatarCache(store, () => 2);
    expect(await again.imageKeyOf("kiwi", "h1", upload)).toBe("img_kiwi");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("图片内容变了（哈希不同）重传一次，记下新的 image_key", async () => {
    const store = fakeStore();
    store.saved.set("kiwi", { key: "img_old" as FeishuImageKey, hash: "h0" });
    let n = 0;
    const upload = vi.fn(async () => `img_new_${++n}` as FeishuImageKey);
    const cache = createFeishuAvatarCache(store, () => 1);
    expect(await cache.imageKeyOf("kiwi", "h1", upload)).toBe("img_new_1");
    expect(await cache.imageKeyOf("kiwi", "h1", upload)).toBe("img_new_1");
    expect(await cache.imageKeyOf("kiwi", "h2", upload)).toBe("img_new_2");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(store.saved.get("kiwi")).toEqual({ key: "img_new_2", hash: "h2" });
  });
});

function fakeStore() {
  const saved = new Map<PmFruit, { key: FeishuImageKey; hash: string }>();
  return {
    saved,
    avatarKey: (f: PmFruit, hash: string) => (saved.get(f)?.hash === hash ? saved.get(f)!.key : null),
    saveAvatarKey: (f: PmFruit, key: FeishuImageKey, hash: string) => void saved.set(f, { key, hash }),
  };
}

describe("按形象画群头像（docs/slime-cohesion-design.md）", () => {
  it.todo("renderFeishuAvatar：同一个形象两次得到逐字节相同的 PNG，sha256 是它的哈希");
  it.todo("renderFeishuAvatar：约 1026×1026，满铺这个颜色的浅底；原色的形象和加换色之前的群头像像素相同");
  it.todo("renderFeishuAvatar：换了颜色或造型，哈希不同");
  it.todo("头像缓存按形象认：同一个形象只传一次，换色后的新形象再传一次");
});
