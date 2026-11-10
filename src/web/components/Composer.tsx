import { ArrowUp, CircleAlert, FileText, Info, Paperclip, Square, X } from "lucide-react";
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { useStore } from "zustand";
import { MAX_MESSAGE_BYTES } from "../../shared/index.ts";
import { type ComposerSource, useComposerSuggest } from "../composer-suggest.ts";
import { fitsBetweenButtons, isWrapped } from "../composer-layout.ts";
import { byteLength, errorLine, errorTitle } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { formatBytes, readDropped, useNoticeAutoHide, type ComposerNotice, type DraftSlot, type StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import type { StopControl } from "../useStop.ts";
import { ComposerMenu, optionId } from "./ComposerMenu.tsx";

const MAX_HEIGHT_PX = 180;

/** 聊天输入框外框：1px 中性灰边框 + 轻阴影；聚焦时外沿一圈很淡的强调色光晕（docs/ui-standard.md 第 7 条），边框不变 */
const FRAME_CLASS =
  "rounded-[26px] border border-border bg-background shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-shadow duration-150 ease-out focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_14%,transparent),0_2px_10px_rgba(0,0,0,0.05)] motion-reduce:transition-none";

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
  stop: stopProp,
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
  /** 现在不能发（比如 Worker 还在准备）：输入框、加文件和发送按钮都不可用；“停止”不受它管。 */
  disabled?: boolean;
  stop?: StopControl;
  /** 对话所在的设备连不上（联机，devices.ts）：离线时整个输入框不可用、占位写原因；重连中能打字，发送等连上。 */
  link?: ComposerLink | null;
  /** 输入 “/” 命令、“@” 文件时弹出的列表从哪来（见 composer-suggest.ts）；不给就不弹。 */
  source?: ComposerSource;
  onChange: (value: string) => void;
  onSend: (text: string, files: File[]) => void | Promise<void>;
  /** 出现时把焦点放进来（打开、切换对话时，docs/ui-standard.md 第 16 条）；不可用时不放。 */
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
  const multiline = wrapped || files.length > 0;
  const layoutWas = useRef(multiline);
  const settledValue = useRef<string | null>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  // “/”“@” 弹出列表：光标位置要自己记（打字、点、方向键都会动它）；选中后文字换掉，光标放到空格后
  const [cursor, setCursor] = useState(0);
  const pendingCursor = useRef<number | null>(null);
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
  });

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus({ preventScroll: true });
    // 只在出现时放一次；对话切换时整个页面换了一个（key），会重新放
  }, []);

  // 输入框跟着内容长高，到上限后出滚动条；顺便判断单行 / 多行布局
  const prevValue = useRef<string | null>(null);
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
    if (pendingCursor.current !== null) {
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
  }, [value, multiline]);

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
        {files.length > 0 && (
          <ul aria-label="Files to send" className="flex flex-wrap gap-2 px-5 pt-3">
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
            aria-activedescendant={suggest.menu && suggest.menu.items.length > 0 ? optionId(menuId, suggest.menu.activeIndex) : undefined}
            onChange={(e) => {
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
}: Omit<ComponentProps<typeof Composer>, "value" | "onChange"> & { draft: DraftSlot }) {
  const value = useStore(draft.store);
  return <Composer value={value} onChange={draft.set} {...rest} />;
});