import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import { FEISHU_AVATAR_RENDER_CACHE_MAX } from "../../shared/limits.ts";
import { lookKey, slimeBitmap, type SlimeLook } from "../../shared/slimes.ts";
import type { FeishuStore } from "./store.ts";

const FEISHU_AVATAR_TARGET_PX = 1024;
const FEISHU_AVATAR_PAD_CELLS = 0.75;

export interface FeishuAvatarImage {
  png: Buffer;
  sha256: string;
}

const rendered = new LRUCache<string, FeishuAvatarImage>({ max: FEISHU_AVATAR_RENDER_CACHE_MAX });

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
