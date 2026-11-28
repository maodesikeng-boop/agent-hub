import { ArrowUp, Check, Copy, FileText, Loader2, PencilLine, Play } from "../ui/icons.ts";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FILE_EXPIRED_TEXT, groupDeliverables, previewKindOf, sentFilesOfDeliverables, sentFileUrl, type Deliverable, type SentFile } from "../../shared/index.ts";
import { DELIVERABLE_MEDIA_HEIGHT_REM } from "../deliverable-size.ts";
import { layoutCardDeliverables } from "../deliverables-layout.ts";
import { useClient } from "../device-scope.tsx";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { COPIED_RESET_MS, copyText } from "./CodeBlock.tsx";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";
import { Markdown } from "./Markdown.tsx";

export const INLINE_LINK_CLASS =
  "touch-target inline-flex cursor-pointer items-center gap-1 text-link underline decoration-link/40 transition-colors hover:decoration-link focus-visible:outline-2 focus-visible:outline-border-focus";

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
          "relative box-content h-(--deliverable-media-height) shrink-0 overflow-hidden rounded-sm border border-border bg-panel focus-visible:outline-2 focus-visible:outline-border-focus",
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
              className={cn("w-full", segment.isListItem && "border-l border-border pl-3")}
            />
          )}
        </div>
      ))}
      <DeliverableFiles deliverables={layout.trailing} className="w-full" />
      {hasExtra && <div className={cn("flex w-full min-w-0 flex-col gap-2", textClassName)}>{extra}</div>}
    </div>
  );
});

const NOTE_MAX_HEIGHT_PX = 144;

export interface CardNoteFormProps {
  disabled: boolean;
  pending: boolean;
  value?: string;
  onChange?: (value: string) => void;
  onFocus?: () => void;
  onSubmitNote: (rawNote: string) => void;
  className?: string;
  inputClassName?: string;
  buttonSize?: "sm";
  /** `row` is the last row of a decision card or reply popover: full-bleed with concentric bottom corners. */
  variant?: "field" | "row";
  label?: string;
  placeholder?: string;
  /** Why the note cannot be sent as typed; blocks sending and marks the field invalid. */
  invalid?: string;
}

export function CardNoteForm({
  disabled,
  pending,
  value: controlledValue,
  onChange: controlledOnChange,
  onFocus,
  onSubmitNote,
  className,
  inputClassName,
  buttonSize,
  variant = "field",
  label = "Your reply",
  placeholder = "Reply or add a note…",
  invalid,
}: CardNoteFormProps) {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [localNote, setLocalNote] = useState("");
  const note = controlledValue ?? localNote;
  const setNote = (next: string) => {
    if (controlledOnChange !== undefined) controlledOnChange(next);
    else setLocalNote(next);
  };

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    if (note === "") {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    if (el.scrollHeight > 0) {
      const borderY = Math.max(0, el.offsetHeight - el.clientHeight);
      el.style.height = `${Math.min(el.scrollHeight + borderY, NOTE_MAX_HEIGHT_PX)}px`;
    }
  }, [note]);

  const canSend = !disabled && invalid === undefined && note.trim() !== "";
  const small = buttonSize === "sm";
  const row = variant === "row";
  return (
    <div
      data-card-reply={variant}
      className={cn(
        row
          ? cn(
              "-mx-4 -mb-4 flex items-end gap-3 border-t border-border py-1.5 pr-1.5 pl-4 transition-shadow",
              invalid === undefined ? "focus-within:shadow-[inset_0_0_0_1px_var(--border-focus)]" : "shadow-[inset_0_0_0_1px_var(--danger)]",
            )
          : "mt-3 flex items-end gap-1.5 rounded-sm border border-border-strong bg-background py-1 pr-1 pl-3 shadow-[var(--shadow-tile)] transition-[border-color,box-shadow] focus-within:field-focus",
        disabled && "opacity-60",
        className,
      )}
    >
      {row && (
        <span aria-hidden="true" className={cn("mt-1 flex w-4 shrink-0 items-center self-start text-muted-foreground", small ? "h-5" : "h-6")}>
          <PencilLine className="size-pixel-sm" />
        </span>
      )}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={textareaRef}
        id={id}
        rows={1}
        value={note}
        disabled={disabled}
        onFocus={onFocus}
        onChange={(e) => setNote(e.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid === undefined ? undefined : true}
        title={invalid}
        className={cn(
          "max-h-36 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-default pointer-coarse:min-h-11 pointer-coarse:py-2.5",
          small ? "min-h-7 py-1 text-minor leading-5" : "min-h-8 py-1 text-body leading-6",
          inputClassName,
        )}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && canSend) {
            e.preventDefault();
            onSubmitNote(note);
          }
        }}
      />
      <Button type="button" variant="send" size="icon-sm" aria-label="Send" disabled={!canSend} onClick={() => onSubmitNote(note)} className={cn("shrink-0", small ? "size-7" : "size-7.5")}>
        {pending ? <Loader2 className="size-4" aria-hidden="true" /> : <ArrowUp className="size-4" strokeWidth={1.75} aria-hidden="true" />}
      </Button>
    </div>
  );
}

export function UnsentDraftBanner({
  draft,
  onDismiss,
  compact = false,
  className,
}: {
  draft: string;
  onDismiss: () => void;
  compact?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const CopyIcon = copied ? Check : Copy;
  return (
    <div
      data-unsent-draft
      className={cn("rounded-sm bg-panel", compact ? "mt-2 p-2" : "mt-3 p-2.5", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-minor font-medium text-foreground">
          <PencilLine className="size-pixel-sm shrink-0 text-brand-ink" aria-hidden="true" />
          <span>Unsent reply</span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void copyText(draft).then(() => {
                setCopied(true);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
              });
            }}
          >
            <CopyIcon className="size-pixel-sm" aria-hidden="true" />
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
      <p className="mt-1.5 rounded-sm border border-border bg-background px-2.5 py-1.5 text-minor whitespace-pre-wrap select-text [overflow-wrap:anywhere] text-foreground">
        {draft}
      </p>
    </div>
  );
}
