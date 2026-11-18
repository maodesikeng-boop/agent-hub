import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PM_FRUITS, pmFruitAvatarFile } from "../src/shared/fruits.ts";
import { AVATARS_DIR, avatarSvgs, feishuAvatarPixels } from "./render-avatars.ts";

describe("render-avatars：assets/avatars 和脚本画的一样", () => {
  it("目录里正好是每种水果的主形象、纸片分身和群头像，没有别的文件（旧的 webp 位图已删）", () => {
    const expected = PM_FRUITS.flatMap((fruit) => (["main", "piece", "feishu"] as const).map((kind) => pmFruitAvatarFile(fruit, kind)));
    expect(readdirSync(AVATARS_DIR).sort()).toEqual(expected.sort());
  });

  it("提交的 SVG 和脚本现在画出来的逐字相同；纯矢量：只有 path，没有位图、渐变、滤镜和 id", () => {
    for (const [name, text] of avatarSvgs()) {
      expect(readFileSync(join(AVATARS_DIR, name), "utf8"), name).toBe(text);
      expect(text, name).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 -?[\d.]+ 12 12" shape-rendering="crispEdges">(<path d="[MHVZ\d ]+" fill="#[0-9a-f]{6}"\/>)+<\/svg>\n$/);
    }
  });

  it("描边不用纯黑；纸片分身比主形象矮（画布上下留空），主形象的脚底贴着画布底边", () => {
    for (const [name, text] of avatarSvgs()) {
      expect(text, name).not.toMatch(/fill="#000000"/);
      const rows = [...text.matchAll(/[MV](?:\d+ )?(\d+)/g)].map((m) => Number(m[1]));
      const top = Number(/viewBox="0 (-?[\d.]+)/.exec(text)![1]);
      if (name.endsWith("_piece.svg")) expect(top, name).toBeLessThanOrEqual(-1.5);
      else expect([top, Math.max(...rows)], name).toEqual([0, 12]);
    }
  });

  it("提交的群头像 PNG 解码后和脚本算的像素逐个相同：每格整数倍放大，约 1024px，满铺不透明", async () => {
    for (const fruit of PM_FRUITS) {
      const { size, data } = feishuAvatarPixels(fruit);
      const file = join(AVATARS_DIR, pmFruitAvatarFile(fruit, "feishu"));
      const decoded = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([decoded.info.width, decoded.info.height, decoded.info.channels], fruit).toEqual([size, size, 3]);
      expect(Math.abs(size - 1024), fruit).toBeLessThanOrEqual(16);
      expect((await sharp(file).metadata()).hasAlpha, fruit).toBe(false);
      expect(decoded.data.equals(data), fruit).toBe(true);
    }
  });
});
