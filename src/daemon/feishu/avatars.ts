// 水果群头像（docs/feishu-design.md「自动建群」）：项目经理群的头像和网页上它的头像是同一只水果史莱姆小动物。
// 不变量：
// - 项目经理 → 水果的对应只在 shared/fruits.ts（网页 palette.ts 也按它取），这里不另写一份；
// - 图片在仓库根目录 assets/avatars/（scripts/render-avatars.ts 生成），打包时整个目录随守护进程带走（scripts/stage-runtime-common.ts）；
// - 同一张图只上传一次（image_type avatar），image_key 和图片内容的 SHA-256 记在 feishu_avatars，各群共用；
//   图片换了（哈希对不上）重传，已建的群原地换头像（service.ts 的 syncChats）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import { pmFruitAvatarFile, type PmFruit } from "../../shared/fruits.ts";
import type { SlimeLook } from "../../shared/slimes.ts";
import type { FeishuStore } from "./store.ts";

export { pmFruitOf, type PmFruit } from "../../shared/fruits.ts";

/** 开发时是仓库里的 assets/avatars/，安装包里是 daemon/assets/avatars/（相对本文件的位置一样）。 */
export const FEISHU_AVATARS_DIR = fileURLToPath(new URL("../../../assets/avatars/", import.meta.url));

/** 后置：这个水果群头像的绝对路径（满铺底色的 PNG，约 1024×1024；飞书群头像只收位图）。 */
export function pmFruitImagePath(assetsDir: string, fruit: PmFruit): string {
  return join(assetsDir, pmFruitAvatarFile(fruit, "feishu"));
}

/** 后置：这个水果群头像文件内容的 SHA-256（十六进制）。每次现读文件，不缓存：图片换了下一次对齐就能发现。文件读不到抛错。 */
export function feishuAvatarHash(assetsDir: string, fruit: PmFruit): string {
  return createHash("sha256").update(readFileSync(pmFruitImagePath(assetsDir, fruit))).digest("hex");
}

/**
 * 这个形象的群头像（docs/slime-cohesion-design.md）：shared/slimes.ts 的 slimeBitmap 用 sharp 编成 PNG（约 1026×1026，满铺这个颜色的浅底）。
 * 后置：同一个形象每次得到逐字节相同的 png，sha256 是它的十六进制哈希；换了颜色或造型，哈希不同。
 */
export async function renderFeishuAvatar(look: SlimeLook): Promise<{ png: Buffer; sha256: string }> {
  throw new Error("未实现");
}

export interface FeishuAvatarCache {
  /**
   * hash 是现在这张图的 feishuAvatarHash。
   * 后置：这张图传过返回记下的 image_key；没传过、或记下的是另一张图，调 upload 传一次、记下再返回。
   * 同一张图并发调用只传一次。
   */
  imageKeyOf(fruit: PmFruit, hash: string, upload: (fruit: PmFruit) => Promise<FeishuImageKey>): Promise<FeishuImageKey>;
}

export function createFeishuAvatarCache(store: Pick<FeishuStore, "avatarKey" | "saveAvatarKey">, now: () => number): FeishuAvatarCache {
  const inflight = new Map<string, Promise<FeishuImageKey>>();
  return {
    imageKeyOf(fruit, hash, upload) {
      const saved = store.avatarKey(fruit, hash);
      if (saved !== null) return Promise.resolve(saved);
      const slot = `${fruit}:${hash}`;
      const running = inflight.get(slot);
      if (running !== undefined) return running;
      const task = upload(fruit).then((key) => {
        store.saveAvatarKey(fruit, key, hash, now());
        return key;
      });
      inflight.set(slot, task);
      void task.then(
        () => inflight.delete(slot),
        () => inflight.delete(slot),
      );
      return task;
    },
  };
}
