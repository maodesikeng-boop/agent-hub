// 卡片里交付物区（components/Deliverables.tsx 的 DeliverableFiles）的高度：渲染和放大弹窗的布局估算（task-graph-layout.ts）都读这里，只此一处。
import { groupDeliverables, type Deliverable } from "../shared/index.ts";

/** 缩略图（图片、视频、过期的文件卡）固定高度，rem；DeliverableFiles 把它写成 `--deliverable-media-height`，缩略图读这个变量。 */
export const DELIVERABLE_MEDIA_HEIGHT_REM = 6;

/** 文档行一行链接的高度：text-minor（0.84375rem）× 正文行高 1.6。 */
export const DELIVERABLE_DOC_ROW_HEIGHT_REM = 1.35;

/** 文档行和媒体行之间、文件区和上面的正文之间的间距（gap-2）。 */
export const DELIVERABLE_BLOCK_GAP_REM = 0.5;

/**
 * 文件区连同它和上面正文的间距占的高度（rem）。没有文件是 0。
 * 文档行按一行算：链接多到折行的高度取决于标签长短，估不出来。
 */
export function deliverablesHeightRem(deliverables: readonly Deliverable[]): number {
  if (deliverables.length === 0) return 0;
  const { documents, media } = groupDeliverables(deliverables);
  const rows = (documents.length > 0 ? DELIVERABLE_DOC_ROW_HEIGHT_REM : 0) + (media.length > 0 ? DELIVERABLE_MEDIA_HEIGHT_REM : 0);
  const gaps = DELIVERABLE_BLOCK_GAP_REM * (documents.length > 0 && media.length > 0 ? 2 : 1);
  return rows + gaps;
}
