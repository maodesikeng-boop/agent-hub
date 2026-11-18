// 水果群头像（docs/feishu-design.md「自动建群」）：项目经理群的头像和网页上它的头像是同一个水果横切面。
// 不变量：
// - 项目经理 → 水果的对应和网页 src/web/lib/palette.ts 的 paletteOf(pmId) 一致（按编号对颜色表长度取余）；
//   实现步骤把水果顺序从 palette.ts 提到 src/shared 的一处，两边都引它，不各写一份；
// - 同一个水果只上传一次（image_type avatar），image_key 记在 feishu_avatars，各群共用。
import type { PmId } from "../../shared/domain.ts";
import type { FeishuImageKey } from "../../shared/feishu.ts";
import type { FeishuStore } from "./store.ts";

/** 和 palette.ts 的 fruit 字段同名。 */
export type PmFruit = "grapefruit" | "orange" | "kiwi" | "strawberry" | "lime" | "lemon" | "pomelo" | "bell_pepper";

/** 后置：和网页 paletteOf(pmId).fruit 相同。 */
export function pmFruitOf(pmId: PmId): PmFruit {
  throw new Error("未实现");
}

/**
 * 前置：assetsDir 是随守护进程一起分发的头像目录（实现步骤定：开发时是仓库里的切片图，安装包里随 daemon 目录带上）。
 * 后置：这个水果完整横切面图片的绝对路径（webp，≤ 4096×4096，飞书头像支持）。
 */
export function pmFruitImagePath(assetsDir: string, fruit: PmFruit): string {
  throw new Error("未实现");
}

export interface FeishuAvatarCache {
  /** 后置：已传过返回记下的 image_key；没传过调 upload 传一次、记下再返回。同一个水果并发调用只传一次。 */
  imageKeyOf(fruit: PmFruit, upload: (fruit: PmFruit) => Promise<FeishuImageKey>): Promise<FeishuImageKey>;
}

export function createFeishuAvatarCache(store: Pick<FeishuStore, "avatarKey" | "saveAvatarKey">, now: () => number): FeishuAvatarCache {
  throw new Error("未实现");
}
