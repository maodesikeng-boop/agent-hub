// 项目经理群头像（docs/feishu-design.md「自动建群」、docs/slime-cohesion-design.md）：项目经理群的头像和网页上它的头像是同一只史莱姆（造型 × 颜色）。
// 不变量：
// - 项目经理 → 形象只在 shared/slimes.ts 的 resolvePmLook（网页也按它取），这里不另写一份；
// - 图片不存文件：按形象现画 PNG（slimeBitmap + sharp，只在要用时动态加载），同一个形象画出来逐字节相同，画过的记在内存里（有上限）；
// - 同一个形象只上传一次（image_type avatar），image_key 和 PNG 内容的 SHA-256 记在 feishu_avatars（键是 lookKey），各群共用；
//   像素稿或颜色改了（哈希对不上）重传，已建的群原地换头像（chat-sync.ts 的 syncChats）。
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import { FEISHU_AVATAR_RENDER_CACHE_MAX } from "../../shared/limits.ts";
import { lookKey, slimeBitmap, type SlimeLook } from "../../shared/slimes.ts";
import type { FeishuStore } from "./store.ts";

/** 群头像的目标边长；实际边长是画布格数的整数倍，取最接近它的（约 1026）。 */
const FEISHU_AVATAR_TARGET_PX = 1024;
/** 群头像里离圆心最远的像素角到圆边留几格（飞书把方图裁成圆）。 */
const FEISHU_AVATAR_PAD_CELLS = 0.75;

export interface FeishuAvatarImage {
  png: Buffer;
  /** png 内容的 SHA-256（十六进制）。 */
  sha256: string;
}

const rendered = new LRUCache<string, FeishuAvatarImage>({ max: FEISHU_AVATAR_RENDER_CACHE_MAX });

/**
 * 这个形象的群头像：shared/slimes.ts 的 slimeBitmap 用 sharp 编成 PNG（约 1026×1026，满铺这个颜色的浅底）。
 * 后置：同一个形象每次得到逐字节相同的 png，sha256 是它的十六进制哈希；换了颜色或造型，哈希不同。
 */
export async function renderFeishuAvatar(look: SlimeLook): Promise<FeishuAvatarImage> {
  const key = lookKey(look);
  const hit = rendered.get(key);
  if (hit !== undefined) return hit;
  const { size, rgb } = slimeBitmap(look, FEISHU_AVATAR_TARGET_PX, FEISHU_AVATAR_PAD_CELLS);
  const { default: sharp } = await import("sharp");
  const png = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).png({ palette: true, compressionLevel: 9, effort: 10 }).toBuffer();
  const image = { png, sha256: createHash("sha256").update(png).digest("hex") };
  rendered.set(key, image);
  return image;
}

export interface FeishuAvatarCache {
  /**
   * hash 是这个形象现在那张图的 sha256（renderFeishuAvatar）。
   * 后置：这张图传过返回记下的 image_key；没传过、或记下的是另一张图，调 upload 传一次、记下再返回。
   * 同一张图并发调用只传一次。
   */
  imageKeyOf(look: SlimeLook, hash: string, upload: (look: SlimeLook) => Promise<FeishuImageKey>): Promise<FeishuImageKey>;
}

export function createFeishuAvatarCache(store: Pick<FeishuStore, "avatarKey" | "saveAvatarKey">, now: () => number): FeishuAvatarCache {
  const inflight = new Map<string, Promise<FeishuImageKey>>();
  return {
    imageKeyOf(look, hash, upload) {
      const saved = store.avatarKey(look, hash);
      if (saved !== null) return Promise.resolve(saved);
      const slot = `${lookKey(look)}:${hash}`;
      const running = inflight.get(slot);
      if (running !== undefined) return running;
      const task = upload(look).then((key) => {
        store.saveAvatarKey(look, key, hash, now());
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
