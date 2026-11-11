import { ArrowUp, CircleAlert, FileText, Info, Paperclip, Square, X } from "lucide-react";
import { memo, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { useStore } from "zustand";
import { MAX_MESSAGE_BYTES, type WorkerPick } from "../../shared/index.ts";
import { type ComposerSource, useComposerSuggest } from "../composer-suggest.ts";
import { WORKER_COMMAND } from "../composer-trigger.ts";
import { fitsBetweenButtons, isWrapped } from "../composer-layout.ts";
import { byteLength, errorLine, errorTitle } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { formatBytes, readDropped, useNoticeAutoHide, type ComposerNotice, type DraftSlot, type StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import type { StopControl } from "../useStop.ts";
import { ComposerMenu, optionId } from "./ComposerMenu.tsx";
import { useWorkerPickLabels, WorkerPickParts } from "./WorkerPickTag.tsx";

const MAX_HEIGHT_PX = 180;

/**
 * 主指针是什么（docs/ui-standard.md 第 16 条、docs/mobile-ui-design.md 第 4 节）：fine 是鼠标、触控板，coarse 是手指（手机、iPad）。
 * 只在要用时读一次（聚焦、按键），不订阅、不进渲染；没有 matchMedia 的环境（测试）当电脑。
 */
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

/** 聊天输入框外框：1px 中性灰边框；平时的轻阴影和聚焦态（只多一团强调色的模糊光晕，边框不变，不套圈）都在 styles.css 的 .composer-frame（docs/ui-standard.md 第 7 条） */
const FRAME_CLASS = "composer-frame rounded-[26px] border border-border bg-background";

/** 回形针、文字区、按钮组在同一个网格里：单行时三者同一行；多行时文字区占满上一行，回形针和按钮组落到下一行（同一个文字区节点，不重建，光标不丢） */
const ROW_CLASS = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center px-2 py-1.25";
const ROW_MULTI_CLASS = "pb-2";
const TEXTAREA_CLASS =
  "block min-h-9 w-full min-w-0 resize-none bg-transparent px-3 py-1.5 text-body leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50 [field-sizing:content]";
const ATTACH_CLASS = ["col-start-1 row-start-1", "col-start-1 row-start-2"] as const;
const TEXT_CLASS = ["col-start-2 row-start-1", "col-span-3 col-start-1 row-start-1"] as const;
const ACTIONS_CLASS = ["col-start-3 row-start-1", "col-start-3 row-start-2"] as const;

/** “停止”键：和发送键同一个按钮（同位置、同大小），图标是方块；正在停止时不可点。 */
function StopButton({ stop }: { stop: StopControl }) {
  return (
    <Button size="icon" aria-label="Stop" disabled={stop.stopping} onClick={stop.onStop}>
      <Square className="size-4 fill-current" aria-hidden="true" />
    </Button>
  );
}

/** 待发文件、提示条右边的小 ×。 */
const CHIP_CLOSE_CLASS =
  "touch-target flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-sidebar-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50";

/** 点了不抢输入框的焦点（手机上软键盘不收起），和弹出列表的行一样；点击照常靠 onClick。 */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

/**
 * /hub:worker 选完的标签（docs/ui-standard.md 第 18 条）：排在待发文件那一排最前面，样子照文件标签；
 * 点标签本身重新选（onEdit），× 去掉（onRemove）。
 */
function WorkerPickChip({ pick, disabled, onEdit, onRemove }: { pick: WorkerPick; disabled: boolean; onEdit: () => void; onRemove: () => void }) {
  const labels = useWorkerPickLabels(pick);
  return (
    <li className="flex max-w-full items-center gap-2 rounded-full bg-muted py-1 pr-1 pl-3 text-minor">
      <button
        type="button"
        aria-label={`Worker model: ${labels.join(" ")}`}
        disabled={disabled}
        className="touch-target flex min-w-0 cursor-pointer items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={onEdit}
      >
        <WorkerPickParts labels={labels} />
      </button>
      <button type="button" aria-label="Remove" disabled={disabled} className={CHIP_CLOSE_CLASS} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={onRemove}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * 输入框上方的提示条：浅灰底、没有描边，左边一个小图标，右边 ×。加文件被拒的是灰字；发送失败的图标是红色、字是前景色。
 * 图标和字从框内 20px 开始，和待发文件、输入的文字对齐。
 */
function NoticeBar({ notice, onDismiss }: { notice: ComposerNotice; onDismiss: () => void }) {
  const failed = notice.kind === "failed";
  const Icon = failed ? CircleAlert : Info;
  return (
    <div
      role="alert"
      title={errorTitle(notice.message)}
      className="mx-3 mt-3 flex items-center gap-2 rounded-xl bg-sidebar py-1 pr-1 pl-2 text-minor leading-snug text-muted-foreground"
    >
      <Icon className={cn("size-3.5 shrink-0", failed && "text-danger")} aria-hidden="true" />
      <span className={cn("min-w-0 flex-1", failed && "text-foreground")}>{errorLine(notice.message)}</span>
      <button type="button" aria-label="Dismiss" className={CHIP_CLOSE_CLASS} onClick={onDismiss}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * 输入框：打字、回形针选文件（可多选）、粘贴截图/文件，待发文件列在输入框上方。不绑定哪个对话：
 * 文字和待发文件（staging，见 upload.ts 的 useStagingStore）都由调用者保存；
 * onSend 收到文字和待发的文件，只有文字时同步处理（返回 undefined），带文件时返回 Promise（上传、发出去），
 * 它 reject 的 Error.message 会显示在输入框上方，文字和文件都留着。
 * stop：agent 在忙、而且输入框里没有文字也没有待发文件时，发送键变成“停止”（同一个位置、同样大小，图标是方块）；
 * 一有内容就变回发送（照常排队）；正在停止时不可点。
 */
/** 设备连接对输入框的影响：readOnly 是只读的原因（离线），waiting 是能打字但发送要等连上（重连中）。 */
export interface ComposerLink {
  readOnly: string | null;
  waiting: boolean;
}

export function Composer({
  value,
  placeholder: placeholderProp,
  staging,
  workerPick = null,
  onWorkerPick,
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
  /** /hub:worker 选好的（标签显示它）；和文字一样由调用者按对话存（upload.ts 的 DraftSlot.pick）。 */
  workerPick?: WorkerPick | null;
  /** 选完、重选、点 × 时调；不给就不变标签，完整命令留在文字里。 */
  onWorkerPick?: (pick: WorkerPick | null) => void;
  /** 现在不能发（比如 Worker 还在准备）：输入框、加文件和发送按钮都不可用；“停止”不受它管。 */
  disabled?: boolean;
  stop?: StopControl;
  /** 二次 Esc 回退：把刚暂停或取消的最后一条用户消息恢复到草稿槽，成功返回 true。 */
  onRewind?: (stopping: boolean) => boolean;
  /** 递增一次表示刚回退恢复了草稿，需要聚焦输入框并把光标放到末尾。 */
  focusRev?: number;
  /** 对话所在的设备连不上（联机，devices.ts）：离线时整个输入框不可用、占位写原因；重连中能打字，发送等连上。 */
  link?: ComposerLink | null;
  /** 输入 “/” 命令、“@” 文件时弹出的列表从哪来（见 composer-suggest.ts）；不给就不弹。 */
  source?: ComposerSource;
  onChange: (value: string) => void;
  onSend: (text: string, files: File[]) => void | Promise<void>;
  /** 出现时把焦点放进来（打开、切换对话时，docs/ui-standard.md 第 16 条）；不可用时不放，触屏（不是鼠标）也不放，免得一进对话就弹键盘。 */
  autoFocus?: boolean;
}) {
  // 设备离线：和“不能发”一样整个不可用，占位写原因，也不能停
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

  // 发送键从空变有内容时轻微放大回弹 150ms（只在这一下；清空后重置，prefers-reduced-motion 下 CSS 不播）
  const [bounce, setBounce] = useState(false);
  const hadContent = useRef(hasContent);
  useEffect(() => {
    if (hasContent && !hadContent.current) setBounce(true);
    else if (!hasContent) setBounce(false);
    hadContent.current = hasContent;
  }, [hasContent]);

  // 单行 / 多行布局：文字超过一行（换行符或自动换行）、或有待发文件时是多行；由下面调高度的 useLayoutEffect 量出来，只在布尔值变化时才多渲染一次
  const [wrapped, setWrapped] = useState(false);
  const multiline = wrapped || files.length > 0 || workerPick !== null;
  const layoutWas = useRef(multiline);
  const settledValue = useRef<string | null>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  // “/”“@” 弹出列表：光标位置要自己记（打字、点、方向键都会动它）；选中后文字换掉，光标放到空格后
  const [cursor, setCursor] = useState(0);
  const pendingCursor = useRef<number | null>(null);
  /** 点标签重选前光标在哪（原有文字里的位置）：选完回到这里。 */
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
    // 最后一级选完：整段命令从文字里拿掉，换成标签（替换旧的）；光标回到原位（点标签重选前的位置，打字选的是命令原来的开头）
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
  });

  /** 点标签：在开头插入 /hub:worker 重新走一遍（原有文字另起一行接在后面，不被当成正在选的那一级），列表从厂商开始。 */
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
    // 只在出现时放一次；对话切换时整个页面换了一个（key），会重新放
  }, []);

  // 对话级 Esc 快捷键（docs/ui-standard.md 第 18 条）：按第一次 Esc 暂停，再按一次 Esc 把刚中断或取消的用户消息回退到输入框。
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

  // 输入框跟着内容长高，到上限后出滚动条；顺便判断单行 / 多行布局
  const prevValue = useRef<string | null>(null);
  const prevFocusRev = useRef(focusRev);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = prevValue.current;
    prevValue.current = value;
    const layoutChanged = layoutWas.current !== multiline;
    layoutWas.current = multiline;
    // 在末尾追加文字时内容只会持平或变高，直接读 scrollHeight 即可，不先把 height 塌缩为 auto（避免多行时每次按键触发整页同步回流）；
    // 首次挂载、删改文字、清空、或布局切换（文字区宽度变了）时才先设 auto 以便重新量。
    if (prev === null || value === "" || !value.startsWith(prev) || layoutChanged) {
      el.style.height = "auto";
    }
    const contentHeight = el.scrollHeight;
    const nextHeight = `${Math.min(contentHeight, MAX_HEIGHT_PX)}px`;
    if (el.style.height !== nextHeight) el.style.height = nextHeight;
    if (focusRev !== prevFocusRev.current) {
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
    // 单行 / 多行：空 → 单行；现在这个布局里放不下一行 → 多行；
    // 已是多行布局、内容只有一行时，只有“没有换行符、放得进回形针和发送键中间”才退回单行（canvas 量宽，不触发排版）。
    // 刚切到单行就又换行了（量得不准）说明退回错了：这段文字不再尝试退回，避免来回切。
    let nextWrapped: boolean;
    if (value === "") {
      nextWrapped = false;
    } else if (isWrapped(el, contentHeight)) {
      nextWrapped = true;
      if (layoutChanged && !multiline) settledValue.current = value;
    } else if (!multiline) {
      nextWrapped = false;
    } else {
      nextWrapped = value.includes("\n") || settledValue.current === value || !fitsBetweenButtons(el, value, [attachRef.current, actionsRef.current]);
    }
    setWrapped(nextWrapped);
  }, [value, multiline, focusRev, disabled]);

  const submit = () => {
    if (!canSend) return;
    staging.track(
      onSend(
        value.trim(),
        files.map((f) => f.file),
      ),
    );
  };

  return (
    <>
      {suggest.menu && <ComposerMenu id={menuId} menu={suggest.menu} onSelect={suggest.select} onHighlight={suggest.highlight} />}
      <div data-multiline={multiline} className={FRAME_CLASS}>
        {(files.length > 0 || workerPick !== null) && (
          <ul aria-label="Files to send" className="flex flex-wrap gap-2 px-5 pt-3">
            {workerPick !== null && onWorkerPick && (
              <WorkerPickChip
                pick={workerPick}
                disabled={busy || disabled}
                onEdit={repick}
                onRemove={() => {
                  repickCaret.current = null;
                  onWorkerPick(null);
                }}
              />
            )}
            {files.map(({ key, file }) => (
              <li key={key} className="flex max-w-full items-center gap-2 rounded-full bg-muted py-1 pr-1 pl-3 text-minor">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 truncate">{file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
                <button type="button" aria-label={`Remove ${file.name}`} disabled={busy} className={CHIP_CLOSE_CLASS} onClick={() => staging.remove(key)}>
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {notice !== null && <NoticeBar notice={notice} onDismiss={staging.dismissNotice} />}
        <div className={cn(ROW_CLASS, multiline && ROW_MULTI_CLASS)}>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose files"
            onChange={(e) => {
              staging.add(Array.from(e.target.files ?? []));
              e.target.value = ""; // 清掉，同一个文件还能再选
            }}
          />
          <Button
            ref={attachRef}
            variant="ghost"
            size="icon"
            aria-label="Add files"
            disabled={busy || disabled}
            onClick={() => picker.current?.click()}
            className={ATTACH_CLASS[+multiline]}
          >
            <Paperclip className="size-5" aria-hidden="true" />
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
            className={cn(TEXTAREA_CLASS, TEXT_CLASS[+multiline])}
            value={value}
            aria-autocomplete={source ? "list" : undefined}
            aria-controls={suggest.menu ? menuId : undefined}
            aria-activedescendant={suggest.menu && suggest.menu.items.length > 0 && suggest.menu.activeIndex >= 0 ? optionId(menuId, suggest.menu.activeIndex) : undefined}
            onChange={(e) => {
              if (!e.target.value.startsWith(`/${WORKER_COMMAND}`)) repickCaret.current = null;
              setCursor(e.target.selectionStart);
              onChange(e.target.value);
              if (notice !== null) staging.dismissNotice(); // 开始打字就不再挂着旧提示
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              // 粘贴截图或复制来的文件（文件夹会往里读）：加进待发列表；纯文字照常粘进去
              if (e.clipboardData.files.length === 0) return;
              e.preventDefault();
              readDropped(e.clipboardData, staging.add);
            }}
            onKeyDown={(e) => {
              // 弹出列表开着：↑↓ 选、Enter / Tab 确定（Enter 不发送）、Esc 关；没有匹配时 Enter 照常发送
              if (suggest.handleKey(e)) {
                e.preventDefault();
                return;
              }
              // 输入法选字时的 Enter 是确认，不是发送（keyCode 229 是部分浏览器在选字时的值）
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
              // 触屏键盘没有 Shift：Enter 就是换行，只用发送键发
              if (pointerMatches(POINTER_COARSE, false)) return;
              e.preventDefault();
              submit();
            }}
          />
          <div ref={actionsRef} className={cn("flex items-center gap-2 justify-self-end", ACTIONS_CLASS[+multiline])}>
            {tooLong && <span className="text-minor text-danger">Message too long</span>}
            {stop?.failed && showStop && <span className="text-minor text-danger">Couldn't stop</span>}
            {showStop ? (
              <StopButton stop={stop} />
            ) : (
              <Button size="icon" aria-label="Send" disabled={!canSend} onClick={submit} className={cn(bounce && "composer-send-bounce")}>
                <ArrowUp className="size-5" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** 独立订阅单个对话草稿的输入框：打字只重渲染它自己，不牵连 App、左栏、右栏和消息流。 */
export const DraftComposer = memo(function DraftComposer({
  draft,
  ...rest
}: Omit<ComponentProps<typeof Composer>, "value" | "onChange" | "focusRev"> & { draft: DraftSlot }) {
  const value = useStore(draft.store);
  const workerPick = useStore(draft.pick);
  const focusRev = useStore(draft.focusRev);
  return <Composer value={value} onChange={draft.set} workerPick={workerPick} onWorkerPick={draft.setPick} focusRev={focusRev} {...rest} />;
});