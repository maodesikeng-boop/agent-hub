import { FileText, Loader2, PencilLine, Play, Send } from "../ui/icons.ts";
import { memo, useId, useMemo, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { FILE_EXPIRED_TEXT, groupDeliverables, previewKindOf, sentFilesOfDeliverables, sentFileUrl, type Deliverable, type SentFile } from "../../shared/index.ts";
import { DELIVERABLE_MEDIA_HEIGHT_REM } from "../deliverable-size.ts";
import { layoutCardDeliverables } from "../deliverables-layout.ts";
import { useClient } from "../device-scope.tsx";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";
import { Markdown } from "./Markdown.tsx";

export const INLINE_LINK_CLASS =
  "touch-target inline-flex cursor-pointer items-center gap-1 text-link underline decoration-link/40 transition-colors outline-none hover:decoration-link focus-visible:outline-2 focus-visible:outline-border-focus";

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
        <FileText className="size-pixel-sm shrink-0" aria-hidden="true" />
        <span>{item.label}</span>
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

function MediaThumb({ item }: { item: Deliverable }) {
  const [open, setOpen] = useState(false);
  const preview = usePreview(item);
  const [expired, markExpired] = useFileExpired(preview.url, false);
  if (expired) return <FileCard name={item.label} mime={item.mime} detail={FILE_EXPIRED_TEXT} className="h-(--deliverable-media-height) shrink-0" />;
  const video = previewKindOf(item.name, item.mime) === "video";
  return (
    <>
      <button
        type="button"
        aria-label={item.label}
        onClick={() => setOpen(true)}
        className={cn(
          "relative box-content h-(--deliverable-media-height) shrink-0 overflow-hidden border-2 border-border-strong bg-panel outline-none focus-visible:outline-2 focus-visible:outline-border-focus",
          video ? "cursor-pointer" : "cursor-zoom-in",
        )}
      >
        {video ? (
          // iOS Safari paints no frame for preload="metadata" unless a start time is given.
          <video src={`${preview.url}#t=0.1`} preload="metadata" muted playsInline onError={markExpired} className="block aspect-video h-(--deliverable-media-height) w-auto max-w-40 object-cover" />
        ) : (
          <img src={preview.url} alt={item.label} loading="lazy" onError={markExpired} className="block h-(--deliverable-media-height) w-auto max-w-40 object-cover" />
        )}
        {video && (
          <span data-play-badge className="absolute inset-0 m-auto flex size-9 items-center justify-center bg-black/55 text-white">
            <Play className="size-pixel translate-x-px fill-current" aria-hidden="true" />
          </span>
        )}
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

export const DeliverableFiles = memo(function DeliverableFiles({ deliverables, className }: { deliverables: readonly Deliverable[]; className?: string }) {
  if (deliverables.length === 0) return null;
  const { documents, media } = groupDeliverables(deliverables);
  return (
    <div
      data-deliverables
      style={{ "--deliverable-media-height": `${DELIVERABLE_MEDIA_HEIGHT_REM}rem` } as CSSProperties}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {documents.length > 0 && (
        <div data-deliverable-documents className="flex flex-wrap items-center gap-x-3 gap-y-1 text-minor">
          {documents.map((item) => (
            <DocumentLink key={item.id} item={item} />
          ))}
        </div>
      )}
      {media.length > 0 && (
        <div data-deliverable-media className="flex flex-wrap gap-2">
          {media.map((item) => (
            <MediaThumb key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});

const NO_DELIVERABLES: readonly Deliverable[] = [];

export const CardBody = memo(function CardBody({
  text,
  titleText = "",
  deliverables = NO_DELIVERABLES,
  extra,
  files = sentFilesOfDeliverables(deliverables),
  messageId,
  className,
  textClassName,
}: {
  text: string;
  titleText?: string;
  deliverables?: readonly Deliverable[] | undefined;
  extra?: ReactNode;
  files?: SentFile[];
  messageId?: number;
  className?: string;
  textClassName?: string;
}) {
  const layout = useMemo(
    () => layoutCardDeliverables(text, deliverables, titleText),
    [text, deliverables, titleText],
  );
  const hasExtra = extra !== undefined && extra !== null && extra !== false;
  if (layout.segments.length === 0 && layout.trailing.length === 0 && !hasExtra) return null;

  return (
    <div data-card-body className={cn("flex min-w-0 flex-col items-start gap-2", className)}>
      {layout.segments.map((segment, index) => (
        <div key={index} className="flex w-full min-w-0 flex-col gap-1.5">
          <div className={cn("w-full min-w-0", textClassName)}>
            <Markdown text={segment.markdown} files={files} messageId={messageId} />
          </div>
          {segment.deliverables.length > 0 && (
            <DeliverableFiles
              deliverables={segment.deliverables}
              className={cn("w-full", segment.isListItem && "border-l-2 border-border-strong pl-3")}
            />
          )}
        </div>
      ))}
      <DeliverableFiles deliverables={layout.trailing} className="w-full" />
      {hasExtra && <div className={cn("flex w-full min-w-0 flex-col gap-2", textClassName)}>{extra}</div>}
    </div>
  );
});

export function CardNoteForm({
  disabled,
  pending,
  value: controlledValue,
  onChange: controlledOnChange,
  resetRev = 0,
  noteRef,
  onSubmitNote,
  tone = "default",
  className,
  inputClassName,
  buttonSize,
}: {
  disabled: boolean;
  pending: boolean;
  value?: string;
  onChange?: (value: string) => void;
  resetRev?: number;
  noteRef?: MutableRefObject<string>;
  onSubmitNote: (rawNote: string) => void;
  tone?: "default" | "open";
  className?: string;
  inputClassName?: string;
  buttonSize?: "sm";
}) {
  const id = useId();
  const [trackedRev, setTrackedRev] = useState(resetRev);
  const [localNote, setLocalNote] = useState("");
  if (controlledValue === undefined && trackedRev !== resetRev) {
    setTrackedRev(resetRev);
    setLocalNote("");
  }
  const note = controlledValue ?? localNote;
  const setNote = (next: string) => {
    if (noteRef !== undefined) noteRef.current = next;
    if (controlledOnChange !== undefined) controlledOnChange(next);
    else setLocalNote(next);
  };
  const canSend = !disabled && note.trim() !== "";
  return (
    <div
      data-card-reply
      className={cn(
        "mt-3 border-2 p-2.5",
        tone === "open" ? "border-open-line bg-background/85" : "border-border-strong bg-panel",
        className,
      )}
    >
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1.5 text-minor font-medium text-foreground">
        <PencilLine className="size-pixel-sm shrink-0 text-rail-ink" aria-hidden="true" />
        <span>Your reply</span>
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={note}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reply or note…"
          className={cn("min-w-0 flex-1 bg-background", buttonSize === "sm" && "h-8", inputClassName)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && canSend) {
              e.preventDefault();
              onSubmitNote(note);
            }
          }}
        />
        <Button
          type="button"
          {...(buttonSize !== undefined ? { size: buttonSize } : {})}
          disabled={!canSend}
          onClick={() => onSubmitNote(note)}
          className="shrink-0"
        >
          {pending ? <Loader2 className="size-pixel-sm" aria-hidden="true" /> : <Send className="size-pixel-sm" aria-hidden="true" />}
          Send
        </Button>
      </div>
    </div>
  );
}
