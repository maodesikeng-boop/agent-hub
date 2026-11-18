// 水果群头像（docs/feishu-design.md「自动建群」）：项目经理群的头像和网页上它的头像是同一个水果横切面。
// 不变量：
// - 项目经理 → 水果的对应只在 shared/fruits.ts（网页 palette.ts 也按它取），这里不另写一份；
// - 图片在仓库根目录 assets/avatars/，打包时整个目录随守护进程带走（scripts/stage-runtime-common.ts）；
// - 同一个水果只上传一次（image_type avatar），image_key 记在 feishu_avatars，各群共用。
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import { pmFruitSliceFile, type PmFruit } from "../../shared/fruits.ts";
import type { FeishuStore } from "./store.ts";

export { pmFruitOf, type PmFruit } from "../../shared/fruits.ts";

/** 开发时是仓库里的 assets/avatars/，安装包里是 daemon/assets/avatars/（相对本文件的位置一样）。 */
export const FEISHU_AVATARS_DIR = fileURLToPath(new URL("../../../assets/avatars/", import.meta.url));

/** 后置：这个水果完整横切面图片的绝对路径（webp，≤ 4096×4096，飞书头像支持）。 */
export function pmFruitImagePath(assetsDir: string, fruit: PmFruit): string {
  return join(assetsDir, pmFruitSliceFile(fruit));
}

export interface FeishuAvatarCache {
  /** 后置：已传过返回记下的 image_key；没传过调 upload 传一次、记下再返回。同一个水果并发调用只传一次。 */
  imageKeyOf(fruit: PmFruit, upload: (fruit: PmFruit) => Promise<FeishuImageKey>): Promise<FeishuImageKey>;
}

export function createFeishuAvatarCache(store: Pick<FeishuStore, "avatarKey" | "saveAvatarKey">, now: () => number): FeishuAvatarCache {
  const inflight = new Map<PmFruit, Promise<FeishuImageKey>>();
  return {
    imageKeyOf(fruit, upload) {
      const saved = store.avatarKey(fruit);
      if (saved !== null) return Promise.resolve(saved);
      const running = inflight.get(fruit);
      if (running !== undefined) return running;
      const task = upload(fruit).then((key) => {
        store.saveAvatarKey(fruit, key, now());
        return key;
      });
      inflight.set(fruit, task);
      void task.then(
        () => inflight.delete(fruit),
        () => inflight.delete(fruit),
      );
      return task;
    },
  };
}
