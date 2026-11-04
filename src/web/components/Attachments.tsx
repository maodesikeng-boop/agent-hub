import { FileText } from "lucide-react";
import { isImageMime, uploadUrl, type Attachment } from "../../shared/index.ts";
import { formatBytes } from "../upload.ts";

/** 消息里的附件：图片是小缩略图，别的是文件图标；都带文件名和大小，点开看大图或下载。没有附件什么也不画。 */
export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="附件" className="mt-1.5 flex max-w-[80%] flex-wrap justify-end gap-2">
      {attachments.map((a) => (
        <li key={a.id} className="min-w-0">
          <a
            href={uploadUrl(a)}
            target="_blank"
            rel="noreferrer"
            {...(isImageMime(a.mime) ? {} : { download: a.name })}
            className="flex items-center gap-2.5 rounded-2xl bg-muted py-1.5 pr-3.5 pl-1.5 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {isImageMime(a.mime) ? (
              <img src={uploadUrl(a)} alt={a.name} loading="lazy" className="size-10 shrink-0 rounded-xl bg-background object-cover" />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
                <FileText className="size-5" aria-hidden="true" />
              </span>
            )}
            <span className="min-w-0">
              <span className="block max-w-[200px] truncate text-[13.5px] font-medium">{a.name}</span>
              <span className="block text-xs text-muted-foreground">{formatBytes(a.size)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
