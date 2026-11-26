import { ArrowUp, CircleAlert, FileText, Info, Plus, Square, Video, X } from "../ui/icons.ts";
import { memo, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { useStore } from "zustand";
import { MAX_MESSAGE_BYTES, previewKindOf, sentFileMime, type WorkerPick } from "../../shared/index.ts";
import { type ComposerSource, useComposerSuggest } from "../composer-suggest.ts";
import { WORKER_COMMAND } from "../composer-trigger.ts";
import { NATIVE_MULTILINE_SIZING, useComposerSoftWrap } from "../composer-layout.ts";
import { byteLength, errorLine, errorTitle } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { COMPOSER_MAX_HEIGHT_PX } from "../limits.ts";
import { formatBytes, readDropped, useNoticeAutoHide, type ComposerNotice, type DraftSlot, type StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import type { StopControl } from "../useStop.ts";
import { ComposerMenu, optionId } from "./ComposerMenu.tsx";
import { useWorkerPickLabels, WorkerPickParts } from "./WorkerPickTag.tsx";

const POINTER_FINE = "(pointer: fine)";
const POINTER_COARSE = "(pointer: coarse)";
const pointerMatches = (query: string, fallback: boolean) => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback);

const OPEN_OVERLAY_SELECTOR = [
  '[data-slot="dialog-content"]:not([data-state="closed"])',
  '[data-slot="popover-content"]:not([data-state="closed"])',
  '[data-slot="drawer-content"]:not([data-state="closed"])',
  '[role="dialog"]:not([data-state="closed"])',
  '[role="alertdialog"]:not([data-state="closed"])',
].join(", ");

function hasOpenOverlay(): boolean {
  return document.querySelector(OPEN_OVERLAY_SELECTOR) !== null;
}

function isOtherEditable(target: EventTarget | null, ownTextarea: HTMLTextAreaElement | null): boolean {
  if (!(target instanceof HTMLElement) || target === ownTextarea) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return type !== "button" && type !== "checkbox" && type !== "radio" && type !== "file" && type !== "submit" && type !== "reset";
  }
  return false;
}

const FRAME_CLASS = "composer-frame bg-background";

// The draft always spans the top row; + sits under its first letter and Send or Stop at the end of the row below. Only the
// sizing differs once the draft wraps: one fixed line, then the browser's own content sizing up to the height cap.
const ROW_CLASS = "relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-y-0.5 px-1.5 pt-1 pb-1.5";
const TEXT_TYPE = "px-2.5 text-body leading-6";
const TEXT_METRICS = `block min-h-10 w-full min-w-0 pt-2.5 pb-1.5 pointer-coarse:pt-3 pointer-coarse:pb-2 ${TEXT_TYPE}`;
const TEXTAREA_CLASS =
  `${TEXT_METRICS} resize-none bg-transparent outline-none placeholder:text-muted-foreground disabled:opacity-50`;
const MIRROR_CLASS = `composer-text-measure ${TEXT_METRICS} invisible overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word]`;
const TEXT_LIMIT = { maxHeight: COMPOSER_MAX_HEIGHT_PX };
const PROBE_CLASS = `composer-text-measure invisible absolute inset-x-0 top-0 h-[1em] ${TEXT_TYPE}`;
const TEXT_CELL = "col-start-1 col-end-4 row-start-1 row-end-2";
const SINGLE_ROW_HEIGHT_CLASS = "h-10 pointer-coarse:h-11";
const ATTACH_CLASS = "col-start-1 row-start-2 size-7.5 text-foreground";
const ACTIONS_CLASS = "flex items-center gap-2 justify-self-end col-start-3 row-start-2";
const SEND_SIZE = "size-7.5";

function StopButton({ stop }: { stop: StopControl }) {
  return (
    <Button variant="send" size="icon" aria-label="Stop" disabled={stop.stopping} onClick={stop.onStop} className={SEND_SIZE}>
      <Square className="size-3 fill-current" aria-hidden="true" />
    </Button>
  );
}

function ComposerChips({
  leadingChip,
  workerPick,
  files,
  disabled,
  busy,
  onEditPick,
  onRemovePick,
  onRemoveFile,
}: {
  leadingChip: React.ReactNode;
  workerPick: WorkerPick | null;
  files: StagedFiles["files"];
  disabled: boolean;
  busy: boolean;
  onEditPick: () => void;
  onRemovePick: () => void;
  onRemoveFile: (key: string) => void;
}) {
  return (
    <ul aria-label="Files to send" className="flex flex-wrap gap-2 px-4 pt-3">
      {leadingChip}
      {workerPick !== null && (
        <WorkerPickChip pick={workerPick} disabled={busy || disabled} onEdit={onEditPick} onRemove={onRemovePick} />
      )}
      {files.map(({ key, file }) => {
        const FileIcon = previewKindOf(file.name, sentFileMime(file.name)) === "video" ? Video : FileText;
        return (
          <li key={key} className="flex max-w-full items-center gap-2 rounded-xs bg-panel py-1 pr-1 pl-3 text-minor">
            <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate">{file.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
            <button type="button" aria-label={`Remove ${file.name}`} disabled={busy} className={CHIP_CLOSE_CLASS} onClick={() => onRemoveFile(key)}>
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const CHIP_CLOSE_CLASS =
  "touch-target flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:cursor-default disabled:opacity-50";

const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

function WorkerPickChip({ pick, disabled, onEdit, onRemove }: { pick: WorkerPick; disabled: boolean; onEdit: () => void; onRemove: () => void }) {
  const labels = useWorkerPickLabels(pick);
  return (
    <li className="flex max-w-full items-center gap-2 rounded-xs bg-panel py-1 pr-1 pl-3 text-minor">
      <button
        type="button"
        aria-label={`Worker model: ${labels.join(" ")}`}
        disabled={disabled}
        className="touch-target flex min-w-0 cursor-pointer items-center gap-2 focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-default"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={onEdit}
      >
        <WorkerPickParts labels={labels} inComposer />
      </button>
      <button type="button" aria-label="Remove" disabled={disabled} className={CHIP_CLOSE_CLASS} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={onRemove}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

function NoticeBar({ notice, onDismiss }: { notice: ComposerNotice; onDismiss: () => void }) {
  const failed = notice.kind === "failed";
  const Icon = failed ? CircleAlert : Info;
  return (
    <div
      role="alert"
      title={errorTitle(notice.message)}
      className={cn("mb-2 flex items-center gap-2 pr-3 pl-5 text-minor leading-snug", failed ? "text-danger" : "text-muted-foreground")}
    >
      <Icon className="size-pixel-sm shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{errorLine(notice.message)}</span>
      <button type="button" aria-label="Dismiss" className={CHIP_CLOSE_CLASS} onClick={onDismiss}>
        <X className="size-pixel-sm" aria-hidden="true" />
      </button>
    </div>
  );
}

export interface ComposerLink {
  readOnly: string | null;
  waiting: boolean;
}

export const Composer = memo(function Composer({
  value,
  placeholder: placeholderProp,
  staging,
  workerPick = null,
  onWorkerPick,
  leadingChip = null,
  onSelectTarget,
  onManageProviders,
  stop: stopProp,
  onRewind,
  focusRev = 0,
  source,
  onChange,
  onSend,
  disabled: disabledProp = false,
  link = null,
  autoFocus = false,
}: {
  value: string;
  placeholder: string;
  staging: StagedFiles;
  workerPick?: WorkerPick | null;
  onWorkerPick?: (pick: WorkerPick | null) => void;
  leadingChip?: React.ReactNode;
  onSelectTarget?: (targetKey: string, text: string) => void;
  onManageProviders?: () => void;
  disabled?: boolean;
  stop?: StopControl;
  onRewind?: (stopping: boolean) => boolean;
  focusRev?: number;
  link?: ComposerLink | null;
  source?: ComposerSource;
  onChange: (value: string) => void;
  onSend: (text: string, files: File[]) => void | Promise<void>;
  autoFocus?: boolean;
}) {
  const readOnly = link?.readOnly ?? null;
  const disabled = disabledProp || readOnly !== null;
  const placeholder = readOnly ?? placeholderProp;
  const stop = readOnly === null ? stopProp : undefined;
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { files, busy, notice } = staging;
  useNoticeAutoHide(staging);
  const tooLong = value.length * 3 > MAX_MESSAGE_BYTES && byteLength(value) > MAX_MESSAGE_BYTES;
  const hasContent = value.trim() !== "" || files.length > 0;
  const canSend = !disabled && !link?.waiting && hasContent && !tooLong && !busy;
  const showStop = stop !== undefined && stop.busy && !hasContent;
  const [bounce, setBounce] = useState(false);
  const hadContent = useRef(hasContent);
  useEffect(() => {
    if (hasContent && !hadContent.current) setBounce(true);
    else if (!hasContent) setBounce(false);
    hadContent.current = hasContent;
  }, [hasContent]);
  const probe = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState<{ value: string; multiline: boolean; height: number | null } | null>(null);
  const sizingValue = (composing?.value ?? value).slice(0, MAX_MESSAGE_BYTES);
  const hasNewline = sizingValue.includes("\n");
  const hasLeadingChip = leadingChip !== null && leadingChip !== undefined && leadingChip !== false;
  const hasChips = files.length > 0 || workerPick !== null || hasLeadingChip;
  const softWrapped = useComposerSoftWrap(probe, hasChips || hasNewline || composing !== null ? "" : sizingValue);
  const multiline = composing?.multiline ?? (hasChips || hasNewline || softWrapped);
  const nativeSizing = multiline && NATIVE_MULTILINE_SIZING;
  const [cursor, setCursor] = useState(0);
  const pendingCursor = useRef<number | null>(null);
  const repickCaret = useRef<number | null>(null);
  const menuId = useId();
  const suggest = useComposerSuggest({
    source,
    value,
    cursor,
    enabled: !disabled && !busy,
    onReplace: (text, at) => {
      pendingCursor.current = at;
      setCursor(at);
      onChange(text);
    },
    onPick:
      onWorkerPick &&
      ((pick, rest) => {
        const at = Math.min(repickCaret.current ?? 0, rest.length);
        repickCaret.current = null;
        onWorkerPick(pick);
        pendingCursor.current = at;
        setCursor(at);
        onChange(rest);
      }),
    onSelectTarget:
      onSelectTarget &&
      ((targetKey, rest, at) => {
        onSelectTarget(targetKey, rest);
        pendingCursor.current = at;
        setCursor(at);
        onChange(rest);
      }),
    onManageProviders,
  });

  const repick = () => {
    const el = ref.current;
    const head = `/${WORKER_COMMAND} `;
    const cmdPrefix = `/${WORKER_COMMAND}`;
    if (value === cmdPrefix || value.startsWith(head) || value.startsWith(`${cmdPrefix}\n`)) {
      const nl = value.indexOf("\n");
      const rest = nl < 0 ? "" : value.slice(nl + 1);
      onChange(rest === "" ? head : `${head}\n${rest}`);
    } else {
      repickCaret.current = el?.selectionStart ?? value.length;
      onChange(value === "" ? head : `${head}\n${value}`);
    }
    suggest.reopen();
    pendingCursor.current = head.length;
    setCursor(head.length);
    el?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (autoFocus && !disabled && pointerMatches(POINTER_FINE, true)) ref.current?.focus({ preventScroll: true });
  }, []);
  const handleGlobalKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (disabled) return;
    if (e.key !== "Escape" || e.defaultPrevented || e.repeat) return;
    if (composing !== null || e.isComposing || e.keyCode === 229) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target instanceof Node && !document.contains(e.target)) return;
    if (hasOpenOverlay() || isOtherEditable(e.target, ref.current)) return;
    if (suggest.menu !== null) {
      e.preventDefault();
      suggest.dismiss();
      return;
    }
    const canStop = stop?.canStop ?? (stop !== undefined && stop.busy && !stop.stopping);
    if (canStop) {
      e.preventDefault();
      stop!.onStop();
      return;
    }
    if (onRewind?.(stop?.stopping ?? false)) {
      e.preventDefault();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);
  const prevFocusRev = useRef(focusRev);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focusChanged = focusRev !== prevFocusRev.current;
    if (focusChanged) {
      prevFocusRev.current = focusRev;
      if (!disabled) {
        el.focus({ preventScroll: true });
        const end = el.value.length;
        el.setSelectionRange(end, end);
        el.scrollTop = el.scrollHeight;
        pendingCursor.current = null;
        setCursor(end);
      }
    } else if (pendingCursor.current !== null) {
      el.setSelectionRange(pendingCursor.current, pendingCursor.current);
      pendingCursor.current = null;
    }
  }, [value, focusRev, disabled]);
  const changeInput = (el: HTMLTextAreaElement) => {
    if (!el.value.startsWith(`/${WORKER_COMMAND}`)) repickCaret.current = null;
    setCursor(el.selectionStart);
    onChange(el.value);
    if (notice !== null) staging.dismissNotice();
  };
  const finishComposition = (el: HTMLTextAreaElement) => {
    if (composing === null) return;
    if (el.value !== value) changeInput(el);
    setComposing(null);
  };
  const submit = () => {
    if (!canSend) return;
    staging.track(
      onSend(
        value.trim(),
        files.map((f) => f.file),
      ),
    );
  };

  const menu = notice === null ? suggest.menu : null;
  const picking = menu !== null && menu.items.length > 0;
  return (
    <>
      {menu && <ComposerMenu id={menuId} menu={menu} onSelect={suggest.select} onHighlight={suggest.highlight} />}
      {notice !== null && <NoticeBar notice={notice} onDismiss={staging.dismissNotice} />}
      <div data-multiline={multiline} className={FRAME_CLASS}>
        {hasChips && (
          <ComposerChips
            leadingChip={leadingChip}
            workerPick={onWorkerPick ? workerPick : null}
            files={files}
            disabled={disabled}
            busy={busy}
            onEditPick={repick}
            onRemovePick={() => {
              repickCaret.current = null;
              onWorkerPick?.(null);
            }}
            onRemoveFile={staging.remove}
          />
        )}
        <div className={ROW_CLASS}>
          {multiline && !nativeSizing && (
            <div aria-hidden="true" className={`${MIRROR_CLASS} ${TEXT_CELL}`} style={TEXT_LIMIT}>
              {sizingValue}{"\u200b"}
            </div>
          )}
          <div aria-hidden="true" ref={probe} className={`${PROBE_CLASS} ${TEXT_CELL}`} />
          <textarea
            ref={ref}
            rows={1}
            aria-label="Message"
            placeholder={placeholder}
            readOnly={busy}
            disabled={disabled}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className={`${TEXTAREA_CLASS} ${TEXT_CELL} ${!multiline ? SINGLE_ROW_HEIGHT_CLASS : nativeSizing ? "" : "absolute inset-0 h-full"}`}
            style={nativeSizing ? { ...TEXT_LIMIT, fieldSizing: "content", height: composing?.height ?? undefined } : undefined}
            value={value}
            aria-autocomplete={source ? "list" : undefined}
            aria-controls={menu ? menuId : undefined}
            aria-activedescendant={menu && menu.items.length > 0 && menu.activeIndex >= 0 ? optionId(menuId, menu.activeIndex) : undefined}
            onChange={(e) => changeInput(e.currentTarget)}
            onCompositionStart={(e) => setComposing({
              value: e.currentTarget.value,
              multiline,
              height: nativeSizing ? e.currentTarget.getBoundingClientRect().height : null,
            })}
            onCompositionEnd={(e) => finishComposition(e.currentTarget)}
            onBlur={(e) => finishComposition(e.currentTarget)}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              if (e.clipboardData.files.length === 0) return;
              e.preventDefault();
              readDropped(e.clipboardData, staging.add);
            }}
            onKeyDown={(e) => {
              // Enter may confirm an IME candidate even when WebKit reports isComposing as false.
              if (composing !== null || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (suggest.handleKey(e)) {
                e.preventDefault();
                return;
              }
              if (e.key !== "Enter" || e.shiftKey) return;
              if (pointerMatches(POINTER_COARSE, false)) return;
              e.preventDefault();
              submit();
            }}
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose files"
            onChange={(e) => {
              staging.add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add files"
            disabled={busy || disabled}
            onClick={() => picker.current?.click()}
            className={ATTACH_CLASS}
          >
            <Plus className="size-4.5" strokeWidth={1.5} aria-hidden="true" />
          </Button>
          <div className={ACTIONS_CLASS}>
            {tooLong && <span className="text-minor text-danger">Message too long</span>}
            {stop?.failed && showStop && <span className="text-minor text-danger">Couldn't stop</span>}
            {showStop ? (
              <StopButton stop={stop} />
            ) : (
              <Button
                variant="send"
                size="icon"
                aria-label="Send"
                disabled={!canSend || picking}
                onClick={submit}
                className={cn(SEND_SIZE, bounce && "composer-send-bounce")}
              >
                <ArrowUp className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
});

export const DraftComposer = memo(function DraftComposer({
  draft,
  ...rest
}: Omit<ComponentProps<typeof Composer>, "value" | "onChange" | "focusRev"> & { draft: DraftSlot }) {
  const value = useStore(draft.store);
  const workerPick = useStore(draft.pick);
  const focusRev = useStore(draft.focusRev);
  return <Composer value={value} onChange={draft.set} workerPick={workerPick} onWorkerPick={draft.setPick} focusRev={focusRev} {...rest} />;
});
