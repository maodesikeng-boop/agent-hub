import { FileText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { isImageMime, sentFileMime, uploadUrl, type Attachment } from "../../shared/index.ts";
import { cn } from "../lib/utils.ts";
import { formatBytes } from "../upload.ts";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";

const CARD = "flex items-center gap-2.5 rounded-2xl bg-muted py-1.5 pr-3.5 pl-1.5";

/**
 * 一个文件的卡片：图片是小缩略图，别的是文件图标；文件名一行，下面一行写大小（或没存下来的原因）。
 * 有 preview 是个按钮，点了打开预览窗（FilePreview）；没有 preview（文件没存下来）只是个卡片，点不了。
 * 聊天框附件（AttachmentList）和 agent 发来的文件（Markdown 里的文件链接）共用。
 */
export function FileCard({
  name,
  mime,
  detail,
  preview,
  className,
}: {
  name: string;
  mime: string;
  detail: ReactNode;
  preview?: PreviewFile;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const image = preview !== undefined && isImageMime(mime);
  const body = (
    <>
      {image ? (
        <img src={preview.url} alt={name} loading="lazy" className="size-10 shrink-0 rounded-xl bg-background object-cover" />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
          <FileText className="size-5" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 text-left">
        <span className="block max-w-[200px] truncate text-[13.5px] font-medium">{name}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </>
  );
  if (preview === undefined) {
    return (
      <span data-file-card className={cn(CARD, className)}>
        {body}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        data-file-card
        onClick={() => setOpen(true)}
        className={cn(CARD, "cursor-pointer transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50", className)}
      >
        {body}
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** 消息里的附件：图片是小缩略图，别的是文件图标；都带文件名和大小，点开看预览（上传的文件和 agent 发来的文件同一个预览窗）。没有附件什么也不画。 */
export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="附件" className="mt-1.5 flex max-w-[80%] flex-wrap justify-end gap-2">
      {attachments.map((a) => (
        <li key={a.id} className="min-w-0">
          <FileCard
            name={a.name}
            mime={sentFileMime(a.name)}
            detail={formatBytes(a.size)}
            preview={{ name: a.name, mime: sentFileMime(a.name), size: a.size, url: uploadUrl(a), target: { kind: "upload", id: a.id } }}
          />
        </li>
      ))}
    </ul>
  );
}
