// 卡片下面的交付物（shared/deliverables.ts）：对话里的提问卡、右栏的门禁卡、总助的拍板卡和简报都用这一个组件，界面规则见 docs/ui-standard.md 第 22 条。
import { FileText, Play } from "lucide-react";
import { memo, useState } from "react";
import { FILE_EXPIRED_TEXT, groupDeliverables, previewKindOf, sentFileUrl, type Deliverable } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { cn } from "../lib/utils.ts";
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";

/** 行内蓝色链接（总助简报的链接行也用）：颜色、下划线同 Markdown 里的链接，触屏热区照第 19 条。 */
export const INLINE_LINK_CLASS =
  "touch-target inline-flex cursor-pointer items-center gap-1 rounded-xl text-link underline decoration-link/40 transition-colors outline-none hover:decoration-link focus-visible:ring-2 focus-visible:ring-ring/50";

function usePreview(item: Deliverable): PreviewFile {
  const client = useClient();
  return {
    name: item.name,
    mime: item.mime,
    size: item.size,
    url: client.url(sentFileUrl({ id: item.id, name: item.name })),
    target: item.origin === null ? null : { kind: "sent", messageId: item.origin.messageId, index: item.origin.index },
  };
}

function DocumentLink({ item }: { item: Deliverable }) {
  const [open, setOpen] = useState(false);
  const preview = usePreview(item);
  return (
    <>
      <button type="button" data-file-link className={INLINE_LINK_CLASS} onClick={() => setOpen(true)}>
        <FileText className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{item.label}</span>
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** 图片、视频的缩略图：固定 96px 高，视频取第一帧盖播放键、不自动播；副本被清理了换成“文件已过期”的卡片。 */
function MediaThumb({ item }: { item: Deliverable }) {
  const [open, setOpen] = useState(false);
  const preview = usePreview(item);
  const [expired, markExpired] = useFileExpired(preview.url, false);
  if (expired) return <FileCard name={item.label} mime={item.mime} detail={FILE_EXPIRED_TEXT} className="h-24 shrink-0" />;
  const video = previewKindOf(item.name, item.mime) === "video";
  return (
    <>
      <button
        type="button"
        aria-label={item.label}
        onClick={() => setOpen(true)}
        className={cn(
          "relative h-24 shrink-0 overflow-hidden rounded-xl border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          video ? "cursor-pointer" : "cursor-zoom-in",
        )}
      >
        {video ? (
          // #t=0.1：iOS Safari 只预载元数据时不画画面，带上起点才显示第一帧
          <video src={`${preview.url}#t=0.1`} preload="metadata" muted playsInline onError={markExpired} className="block aspect-video h-24 w-auto max-w-40 object-cover" />
        ) : (
          <img src={preview.url} alt={item.label} loading="lazy" onError={markExpired} className="block h-24 w-auto max-w-40 object-cover" />
        )}
        {video && (
          <span data-play-badge className="absolute inset-0 m-auto flex size-9 items-center justify-center rounded-full bg-black/55 text-white">
            <Play className="size-4 translate-x-px fill-current" aria-hidden="true" />
          </span>
        )}
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * 文档类一行蓝色文件链接（图标 + 标签），图片和视频一行 96px 高的缩略图（视频盖播放键），点任何一个都打开预览窗（FilePreview）：
 * 图片看大图，视频用原生播放器播，md 渲染，pdf、html 内联。副本被清理了（取文件 404）显示“文件已过期”，不留破图。
 * 文件地址按外层 DeviceScope 的设备取（别的设备的条目要包在那台设备的 DeviceScope 里）。
 * deliverables 为空时什么都不渲染。className 给外边距（和正文隔 8px）。
 */
export const DeliverableFiles = memo(function DeliverableFiles({ deliverables, className }: { deliverables: readonly Deliverable[]; className?: string }) {
  if (deliverables.length === 0) return null;
  const { documents, media } = groupDeliverables(deliverables);
  return (
    <div data-deliverables className={cn("flex min-w-0 flex-col gap-2", className)}>
      {documents.length > 0 && (
        <div data-deliverable-documents className="flex flex-wrap items-center gap-x-3 gap-y-1 text-minor">
          {documents.map((item) => (
            <DocumentLink key={item.id} item={item} />
          ))}
        </div>
      )}
      {media.length > 0 && (
        <div data-deliverable-media className="flex gap-2 overflow-x-auto">
          {media.map((item) => (
            <MediaThumb key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});
