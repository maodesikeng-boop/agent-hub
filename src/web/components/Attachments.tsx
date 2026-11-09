import { FileText } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { FILE_EXPIRED_TEXT, isImageMime, sentFileMime, uploadUrl, type Attachment } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { cn } from "../lib/utils.ts";
import { formatBytes } from "../upload.ts";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";

const CARD = "flex items-center gap-2.5 rounded-2xl bg-muted py-1.5 pr-3.5 pl-1.5";

/**
 * 取文件接口返回 404 = 文件被定期清理删掉了（守护进程 file-cleanup.ts）：返回 [是否已过期, 标记过期]。
 * probe 为真时（非图片的卡片，浏览器不会自己取）发一个 HEAD 问一下；图片由 <img> 的 onError 标记。
 */
export function useFileExpired(url: string | undefined, probe: boolean): [boolean, () => void] {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!probe || url === undefined || typeof fetch !== "function") return;
    let live = true;
    fetch(url, { method: "HEAD" })
      .then((res) => live && res.status === 404 && setExpired(true))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url, probe]);
  return [expired, () => setExpired(true)];
}

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
  const [expired, markExpired] = useFileExpired(preview?.url, preview !== undefined && !isImageMime(mime));
  if (expired) preview = undefined;
  const imageUrl = preview !== undefined && isImageMime(mime) ? preview.url : undefined;
  const body = (
    <>
      {imageUrl !== undefined ? (
        <img src={imageUrl} alt={name} loading="lazy" onError={markExpired} className="size-10 shrink-0 rounded-xl bg-background object-cover" />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
          <FileText className="size-5" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 text-left">
        <span className="block max-w-50 truncate text-minor font-medium">{name}</span>
        <span className="block text-xs text-muted-foreground">{expired ? FILE_EXPIRED_TEXT : detail}</span>
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
  const client = useClient();
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="mt-1.5 flex max-w-[80%] flex-wrap justify-end gap-2">
      {attachments.map((a) => (
        <li key={a.id} className="min-w-0">
          <FileCard
            name={a.name}
            mime={sentFileMime(a.name)}
            detail={formatBytes(a.size)}
            preview={{ name: a.name, mime: sentFileMime(a.name), size: a.size, url: client.url(uploadUrl(a)), target: { kind: "upload", id: a.id } }}
          />
        </li>
      ))}
    </ul>
  );
}
