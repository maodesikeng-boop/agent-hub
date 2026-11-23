import { FileText, Loader2, Play } from "../ui/icons.ts";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { FILE_EXPIRED_TEXT, groupDeliverables, previewKindOf, sentFilesOfDeliverables, sentFileUrl, splitLead, type Deliverable, type SentFile } from "../../shared/index.ts";
import { DELIVERABLE_MEDIA_HEIGHT_REM } from "../deliverable-size.ts";
import { useClient } from "../device-scope.tsx";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";
import { Markdown } from "./Markdown.tsx";

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
          "relative h-(--deliverable-media-height) shrink-0 overflow-hidden rounded-xl border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
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
          <span data-play-badge className="absolute inset-0 m-auto flex size-9 items-center justify-center rounded-full bg-black/55 text-white">
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
        <div data-deliverable-media className="flex gap-2 overflow-x-auto">
          {media.map((item) => (
            <MediaThumb key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});

const NO_DELIVERABLES: readonly Deliverable[] = [];
const DETAILS_ONE_LINE_MAX_EM = 2.4;
const LEAD_LINE_HEIGHT_EM = 1.65;
const LEAD_FALLBACK_LINES = 3;
const FALLBACK_FONT_PX = 16;

export const CardBody = memo(function CardBody({
  text,
  deliverables = NO_DELIVERABLES,
  extra,
  files = sentFilesOfDeliverables(deliverables),
  messageId,
  className,
  textClassName,
}: {
  text: string;
  deliverables?: readonly Deliverable[] | undefined;
  extra?: ReactNode;
  files?: SentFile[];
  messageId?: number;
  className?: string;
  textClassName?: string;
}) {
  const { lead, details } = useMemo(() => splitLead(text), [text]);
  const hasExtra = extra !== undefined && extra !== null && extra !== false;
  const hasDetails = details !== "" || hasExtra;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState<{ key: string; oneLine: boolean } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const fitKey = `${width}\u0000${hasExtra}\u0000${details}`;
  const oneLine = fit?.key === fitKey ? fit.oneLine : null;
  const showDetails = hasDetails && (expanded || oneLine !== false);

  useLayoutEffect(() => {
    const box = leadRef.current;
    if (box === null || expanded) return;
    const measure = () => {
      const style = getComputedStyle(box);
      const lineHeight = LEAD_LINE_HEIGHT_EM * (Number.parseFloat(style.fontSize) || FALLBACK_FONT_PX);
      const lines = Number.parseInt(style.getPropertyValue("--card-lead-lines"), 10) || LEAD_FALLBACK_LINES;
      setOverflowing(box.scrollHeight > (lines + 1) * lineHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild !== null) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, [expanded, lead]);

  useLayoutEffect(() => {
    const box = bodyRef.current;
    if (box === null) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(box.clientWidth)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const box = detailsRef.current;
    if (oneLine !== null || box === null) return;
    const height = box.getBoundingClientRect().height;
    const fontPx = Number.parseFloat(getComputedStyle(box).fontSize) || FALLBACK_FONT_PX;
    setFit({ key: fitKey, oneLine: height > 0 && height < DETAILS_ONE_LINE_MAX_EM * fontPx });
  });

  if (lead === "" && !hasDetails && deliverables.length === 0) return null;
  return (
    <div ref={bodyRef} id={id} data-card-body className={cn("flex min-w-0 flex-col items-start gap-2", className)}>
      {lead !== "" && (
        <div
          ref={leadRef}
          data-card-lead
          data-overflowing={overflowing && !expanded ? "" : undefined}
          className={cn("w-full min-w-0", textClassName, overflowing && !expanded && "card-lead-clamp")}
        >
          <Markdown text={lead} files={files} messageId={messageId} />
        </div>
      )}
      <DeliverableFiles deliverables={deliverables} className="w-full" />
      {showDetails && (
        <div ref={detailsRef} data-card-details className={cn("flex w-full min-w-0 flex-col gap-2", textClassName)}>
          {details !== "" && <Markdown text={details} files={files} messageId={messageId} />}
          {extra}
        </div>
      )}
      {((hasDetails && oneLine === false) || overflowing) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          className="touch-target inline-flex cursor-pointer items-center rounded-full text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
});

export function CardNoteForm({
  disabled,
  pending,
  resetRev,
  noteRef,
  onSubmitNote,
  className = "mt-2.5 flex items-center gap-2",
  inputClassName = "min-w-0 flex-1",
  buttonSize,
}: {
  disabled: boolean;
  pending: boolean;
  resetRev: number;
  noteRef: MutableRefObject<string>;
  onSubmitNote: (rawNote: string) => void;
  className?: string;
  inputClassName?: string;
  buttonSize?: "sm";
}) {
  const [trackedRev, setTrackedRev] = useState(resetRev);
  const [note, setNote] = useState("");
  if (trackedRev !== resetRev) {
    setTrackedRev(resetRev);
    setNote("");
  }
  return (
    <div className={className}>
      <Input
        value={note}
        disabled={disabled}
        onChange={(e) => {
          noteRef.current = e.target.value;
          setNote(e.target.value);
        }}
        placeholder="Add a note, or type a custom reply…"
        aria-label="Add note"
        className={inputClassName}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && note.trim() !== "") {
            e.preventDefault();
            onSubmitNote(note);
          }
        }}
      />
      <Button
        type="button"
        {...(buttonSize !== undefined ? { size: buttonSize } : {})}
        disabled={disabled || note.trim() === ""}
        onClick={() => onSubmitNote(note)}
      >
        {pending && <Loader2 className="size-pixel-sm" aria-hidden="true" />}
        Send
      </Button>
    </div>
  );
}
