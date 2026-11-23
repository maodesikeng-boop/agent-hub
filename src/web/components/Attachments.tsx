import { FileText, Play } from "../ui/icons.ts";
import { useEffect, useState, type ReactNode } from "react";
import { FILE_EXPIRED_TEXT, isImageMime, previewKindOf, sentFileMime, uploadUrl, type Attachment } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { cn } from "../lib/utils.ts";
import { formatBytes } from "../upload.ts";
import { FilePreview, inlineUrl, type PreviewFile } from "./FilePreview.tsx";

const CARD = "flex items-center gap-2.5 border border-border-strong bg-panel py-1.5 pr-3.5 pl-1.5";

// A 404 means the daemon's file cleanup removed it; non-image cards need a HEAD probe because the browser never fetches them.
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
  const videoUrl = preview !== undefined && previewKindOf(name, mime) === "video" ? `${inlineUrl(preview.url)}#t=0.1` : undefined;
  const body = (
    <>
      {imageUrl !== undefined ? (
        <img src={imageUrl} alt={name} loading="lazy" onError={markExpired} className="size-10 shrink-0 border border-border bg-background object-cover" />
      ) : videoUrl !== undefined ? (
        <span className="relative size-10 shrink-0 overflow-hidden border border-border bg-black">
          <video src={videoUrl} preload="metadata" muted playsInline aria-hidden="true" tabIndex={-1} className="size-full object-cover" />
          <span data-play-badge className="absolute inset-0 m-auto flex size-5 items-center justify-center bg-black/55 text-white">
            <Play className="size-pixel-sm translate-x-px fill-current" aria-hidden="true" />
          </span>
        </span>
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground">
          <FileText className="size-pixel" aria-hidden="true" />
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
        className={cn(CARD, "cursor-pointer transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus", className)}
      >
        {body}
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

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
