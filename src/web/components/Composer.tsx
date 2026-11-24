import { CircleAlert, FileText, Info, Plus, Send, Square, Video, X } from "../ui/icons.ts";
import { memo, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { useStore } from "zustand";
import { MAX_MESSAGE_BYTES, previewKindOf, sentFileMime, type WorkerPick } from "../../shared/index.ts";
import { type ComposerSource, useComposerSuggest } from "../composer-suggest.ts";
import { WORKER_COMMAND } from "../composer-trigger.ts";
import { fitsBetweenButtons, fitsSingleRowWidth, isWrapped } from "../composer-layout.ts";
import { byteLength, errorLine, errorTitle } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { formatBytes, readDropped, useNoticeAutoHide, type ComposerNotice, type DraftSlot, type StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import type { StopControl } from "../useStop.ts";
import { ComposerMenu, optionId } from "./ComposerMenu.tsx";
import { useWorkerPickLabels, WorkerPickParts } from "./WorkerPickTag.tsx";

const MAX_HEIGHT_PX = 180;

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

const ROW_CLASS = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center px-2 py-1.25";
const ROW_MULTI_CLASS = "pb-2";
const TEXTAREA_CLASS =
  "block min-h-9 w-full min-w-0 resize-none bg-transparent px-3 py-1.5 pointer-coarse:py-2.5 text-body leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50";
const TEXT_CLASSES = [
  `${TEXTAREA_CLASS} col-start-2 row-start-1`,
  `${TEXTAREA_CLASS} col-span-3 col-start-1 row-start-1`,
] as const;
const ATTACH_CLASSES = [
  "col-start-1 row-start-1",
  "col-start-1 row-start-2",
] as const;
const ACTIONS_CLASSES = [
  "flex items-center gap-2 justify-self-end col-start-3 row-start-1",
  "flex items-center gap-2 justify-self-end col-start-3 row-start-2",
] as const;
const FRAME_CLASSES = [ROW_CLASS, `${ROW_CLASS} ${ROW_MULTI_CLASS}`] as const;

function StopButton({ stop }: { stop: StopControl }) {
  return (
    <Button size="icon" aria-label="Stop" disabled={stop.stopping} onClick={stop.onStop} className="disabled:text-send-disabled-ink">
      <Square className="size-3.5 fill-current" aria-hidden="true" />
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
    <ul aria-label="Files to send" className="flex flex-wrap gap-2 px-5 pt-3">
      {leadingChip}
      {workerPick !== null && (
        <WorkerPickChip pick={workerPick} disabled={busy || disabled} onEdit={onEditPick} onRemove={onRemovePick} />
      )}
      {files.map(({ key, file }) => {
        const FileIcon = previewKindOf(file.name, sentFileMime(file.name)) === "video" ? Video : FileText;
        return (
          <li key={key} className="flex max-w-full items-center gap-2 rounded-sm bg-panel py-1 pr-1 pl-3 text-minor">
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
  "touch-target flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:cursor-default disabled:opacity-50";

const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

function WorkerPickChip({ pick, disabled, onEdit, onRemove }: { pick: WorkerPick; disabled: boolean; onEdit: () => void; onRemove: () => void }) {
  const labels = useWorkerPickLabels(pick);
  return (
    <li className="flex max-w-full items-center gap-2 rounded-sm bg-panel py-1 pr-1 pl-3 text-minor">
      <button
        type="button"
        aria-label={`Worker model: ${labels.join(" ")}`}
        disabled={disabled}
        className="touch-target flex min-w-0 cursor-pointer items-center gap-2 outline-none focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-default"
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

function useElementClientWidth(ref: RefObject<HTMLElement | null>): RefObject<number> {
  const widthRef = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    widthRef.current = el.clientWidth;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      widthRef.current = el.clientWidth;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return widthRef;
}

function syncComposerHeightAndWrap(params: {
  el: HTMLTextAreaElement;
  value: string;
  prev: string | null;
  multiline: boolean;
  layoutChanged: boolean;
  lastHeightPx: number | null;
  clientWidthPx: number;
  settledValue: string | null;
  obstacleEls: (HTMLElement | null)[];
}): { heightPx: number; wrapped: boolean; settled: string | null } {
  const { el, value, prev, multiline, layoutChanged, lastHeightPx, clientWidthPx, settledValue, obstacleEls } = params;
  const atMaxHeight = !layoutChanged && multiline && lastHeightPx !== null && lastHeightPx >= MAX_HEIGHT_PX && prev !== null && value.startsWith(prev);
  if (atMaxHeight) {
    return { heightPx: lastHeightPx, wrapped: true, settled: settledValue };
  }
  const singleRowKnownFit =
    !multiline &&
    !layoutChanged &&
    value !== "" &&
    !value.includes("\n") &&
    prev !== null &&
    clientWidthPx > 0 &&
    lastHeightPx !== null &&
    fitsSingleRowWidth(el, value, clientWidthPx);
  if (singleRowKnownFit) {
    return { heightPx: lastHeightPx, wrapped: false, settled: settledValue };
  }
  // Single-line mode is already at 1-row height, and appending in multiline mode only grows content, so skip height:auto reset there.
  if (prev === null || value === "" || layoutChanged || (multiline && !value.startsWith(prev))) {
    el.style.height = "auto";
  }
  const contentHeight = el.scrollHeight;
  const heightPx = Math.min(contentHeight, MAX_HEIGHT_PX);
  const nextHeight = `${heightPx}px`;
  if (el.style.height !== nextHeight) el.style.height = nextHeight;
  if (value === "") return { heightPx, wrapped: false, settled: settledValue };
  if (isWrapped(el, contentHeight)) {
    return { heightPx, wrapped: true, settled: layoutChanged && !multiline ? value : settledValue };
  }
  if (!multiline) return { heightPx, wrapped: false, settled: settledValue };
  const wrapped = value.includes("\n") || settledValue === value || !fitsBetweenButtons(el, value, obstacleEls);
  return { heightPx, wrapped, settled: settledValue };
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
  sendTone = "accent",
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
  sendTone?: "accent" | "rail";
}) {
  const readOnly = link?.readOnly ?? null;
  const disabled = disabledProp || readOnly !== null;
  const placeholder = readOnly ?? placeholderProp;
  const stop = readOnly === null ? stopProp : undefined;
  const ref = useRef<HTMLTextAreaElement>(null);
  const clientWidthRef = useElementClientWidth(ref);
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

  const [wrapped, setWrapped] = useState(false);
  const hasLeadingChip = leadingChip !== null && leadingChip !== undefined && leadingChip !== false;
  const multiline = wrapped || files.length > 0 || workerPick !== null || hasLeadingChip;
  const layoutWas = useRef(multiline);
  const settledValue = useRef<string | null>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

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
    if (e.isComposing || e.keyCode === 229) return;
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

  const prevValue = useRef<string | null>(null);
  const prevFocusRev = useRef(focusRev);
  const lastHeightPx = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = prevValue.current;
    prevValue.current = value;
    const layoutChanged = layoutWas.current !== multiline;
    layoutWas.current = multiline;
    const focusChanged = focusRev !== prevFocusRev.current;
    const { heightPx, wrapped: nextWrapped, settled } = syncComposerHeightAndWrap({
      el,
      value,
      prev,
      multiline,
      layoutChanged,
      lastHeightPx: lastHeightPx.current,
      clientWidthPx: clientWidthRef.current,
      settledValue: settledValue.current,
      obstacleEls: [attachRef.current, actionsRef.current],
    });
    lastHeightPx.current = heightPx;
    settledValue.current = settled;
    setWrapped(nextWrapped);
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
  }, [value, multiline, focusRev, disabled, clientWidthRef]);

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
        {(files.length > 0 || workerPick !== null || hasLeadingChip) && (
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
        <div className={FRAME_CLASSES[+multiline]}>
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
            ref={attachRef}
            variant="ghost"
            size="icon"
            aria-label="Add files"
            disabled={busy || disabled}
            onClick={() => picker.current?.click()}
            className={ATTACH_CLASSES[+multiline]}
          >
            <Plus className="size-5" aria-hidden="true" />
          </Button>
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
            className={TEXT_CLASSES[+multiline]}
            value={value}
            aria-autocomplete={source ? "list" : undefined}
            aria-controls={menu ? menuId : undefined}
            aria-activedescendant={menu && menu.items.length > 0 && menu.activeIndex >= 0 ? optionId(menuId, menu.activeIndex) : undefined}
            onChange={(e) => {
              if (!e.target.value.startsWith(`/${WORKER_COMMAND}`)) repickCaret.current = null;
              setCursor(e.target.selectionStart);
              onChange(e.target.value);
              if (notice !== null) staging.dismissNotice();
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              if (e.clipboardData.files.length === 0) return;
              e.preventDefault();
              readDropped(e.clipboardData, staging.add);
            }}
            onKeyDown={(e) => {
              if (suggest.handleKey(e)) {
                e.preventDefault();
                return;
              }
              // Enter during IME composition confirms a candidate; some browsers report keyCode 229 there.
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (pointerMatches(POINTER_COARSE, false)) return;
              e.preventDefault();
              submit();
            }}
          />
          <div ref={actionsRef} className={ACTIONS_CLASSES[+multiline]}>
            {tooLong && <span className="text-minor text-danger">Message too long</span>}
            {stop?.failed && showStop && <span className="text-minor text-danger">Couldn't stop</span>}
            {showStop ? (
              <StopButton stop={stop} />
            ) : (
              <Button
                size="icon"
                aria-label="Send"
                disabled={!canSend || picking}
                onClick={submit}
                className={cn(
                  "disabled:text-send-disabled-ink",
                  sendTone === "rail" &&
                    "enabled:border-[rgb(138_83_0_/_0.34)] enabled:bg-rail enabled:text-rail-ink enabled:hover:bg-rail-hover enabled:hover:filter-none",
                  bounce && "composer-send-bounce",
                )}
              >
                <Send className="size-5" aria-hidden="true" />
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