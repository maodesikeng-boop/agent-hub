import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import { PM_FRUITS, pmFruitOf } from "../../shared/fruits.ts";
import { jellyColorOf, lookKey, resolvePmLook, type SlimeLook } from "../../shared/slimes.ts";
import { createFeishuAvatarCache, renderFeishuAvatar } from "./avatars.ts";

const sha16 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);
const own = (fruit: (typeof PM_FRUITS)[number]): SlimeLook => ({ fruit, color: fruit });

describe("群头像和网页头像是同一只", () => {
  it("没换过形象的项目经理：造型是 pmFruitOf(编号)、原色，和网页 resolvePmLook 一样（覆盖编号 0 到名录长度的两倍）", () => {
    for (let pmId = 0; pmId <= PM_FRUITS.length * 2; pmId++) expect(resolvePmLook({ id: pmId })).toEqual(own(pmFruitOf(pmId)));
  });
});

describe("按形象画群头像（docs/slime-cohesion-design.md）", () => {
  it("renderFeishuAvatar：同一个形象两次得到逐字节相同的 PNG，sha256 是它的哈希", async () => {
    const look: SlimeLook = { fruit: "persimmon", color: "sky" };
    const a = await renderFeishuAvatar(look);
    const b = await renderFeishuAvatar({ ...look });
    expect(b.png.equals(a.png)).toBe(true);
    expect(a.sha256).toBe(createHash("sha256").update(a.png).digest("hex"));
  });

  it("renderFeishuAvatar：约 1026×1026，满铺这个颜色的浅底；原色的形象和加换色之前的群头像像素相同", async () => {
    const { png } = await renderFeishuAvatar({ fruit: "melon", color: "teal" });
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(["png", 1026, 1026, false]);
    const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const corner = `#${[...data.subarray(0, 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    expect(corner).toBe(jellyColorOf("teal").backdrop);
    // 加换色之前 assets/avatars/orange.png 解码后 RGB 的 sha256 前 16 位（scripts/render-avatars.ts 生成，已删）
    const original = await sharp((await renderFeishuAvatar(own("orange"))).png).removeAlpha().raw().toBuffer();
    expect(sha16(original)).toBe("5eecdd06afce0f8c");
  });

  it("renderFeishuAvatar：换了颜色或造型，哈希不同", async () => {
    const hashes = await Promise.all(
      [own("kiwi"), { fruit: "kiwi", color: "sakura" } as const, own("grape"), { fruit: "grape", color: "kiwi" } as const].map(async (look) => (await renderFeishuAvatar(look)).sha256),
    );
    expect(new Set(hashes).size).toBe(4);
  });

  it("头像缓存按形象认：同一个形象只传一次，换色后的新形象再传一次", async () => {
    const store = fakeStore();
    const upload = vi.fn(async (look: SlimeLook) => `img_${lookKey(look)}` as FeishuImageKey);
    const cache = createFeishuAvatarCache(store, () => 1);
    const kiwi = own("kiwi");
    const [a, b] = await Promise.all([cache.imageKeyOf(kiwi, "h1", upload), cache.imageKeyOf({ ...kiwi }, "h1", upload)]);
    expect([a, b]).toEqual(["img_kiwi:kiwi", "img_kiwi:kiwi"]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await createFeishuAvatarCache(store, () => 2).imageKeyOf(kiwi, "h1", upload)).toBe("img_kiwi:kiwi");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await cache.imageKeyOf({ fruit: "kiwi", color: "sky" }, "h2", upload)).toBe("img_kiwi:sky");
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("同一个形象画出来的图变了（哈希不同）重传一次，记下新的 image_key", async () => {
    const store = fakeStore();
    store.saved.set("kiwi:kiwi", { key: "img_old" as FeishuImageKey, hash: "h0" });
    let n = 0;
    const upload = vi.fn(async () => `img_new_${++n}` as FeishuImageKey);
    const cache = createFeishuAvatarCache(store, () => 1);
    expect(await cache.imageKeyOf(own("kiwi"), "h1", upload)).toBe("img_new_1");
    expect(await cache.imageKeyOf(own("kiwi"), "h1", upload)).toBe("img_new_1");
    expect(await cache.imageKeyOf(own("kiwi"), "h2", upload)).toBe("img_new_2");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(store.saved.get("kiwi:kiwi")).toEqual({ key: "img_new_2", hash: "h2" });
  });
});

function fakeStore() {
  const saved = new Map<string, { key: FeishuImageKey; hash: string }>();
  return {
    saved,
    avatarKey: (look: SlimeLook, hash: string) => (saved.get(lookKey(look))?.hash === hash ? saved.get(lookKey(look))!.key : null),
    saveAvatarKey: (look: SlimeLook, key: FeishuImageKey, hash: string) => void saved.set(lookKey(look), { key, hash }),
  };
}
