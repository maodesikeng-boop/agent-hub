import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { MAX_MESSAGE_BYTES } from "../../shared/index.ts";
import { byteLength } from "../format.ts";
import { formatBytes, type StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import type { StopControl } from "../useStop.ts";

const MAX_HEIGHT_PX = 180;

/** “停止”键：和发送键同一个按钮（同位置、同大小），图标是方块；正在停止时不可点。 */
function StopButton({ stop }: { stop: StopControl }) {
  return (
    <Button size="icon" aria-label="停止" disabled={stop.stopping} onClick={stop.onStop}>
      <Square className="size-4 fill-current" aria-hidden="true" />
    </Button>
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
export function Composer({
  value,
  placeholder,
  staging,
  stop,
  onChange,
  onSend,
  disabled = false,
  autoFocus = false,
}: {
  value: string;
  placeholder: string;
  staging: StagedFiles;
  /** 现在不能发（比如 Worker 还在准备）：输入框、加文件和发送按钮都不可用；“停止”不受它管。 */
  disabled?: boolean;
  stop?: StopControl;
  onChange: (value: string) => void;
  onSend: (text: string, files: File[]) => void | Promise<void>;
  /** 出现时把焦点放进来（打开、切换对话时，docs/ui-standard.md 第 15 条）；不可用时不放。 */
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { files, busy, notice } = staging;
  const tooLong = byteLength(value) > MAX_MESSAGE_BYTES;
  const hasContent = value.trim() !== "" || files.length > 0;
  const canSend = !disabled && hasContent && !tooLong && !busy;
  const showStop = stop !== undefined && stop.busy && !hasContent;

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus({ preventScroll: true });
    // 只在出现时放一次；对话切换时整个页面换了一个（key），会重新放
  }, []);

  // 输入框跟着内容长高，到上限后出滚动条
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

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
    <div className="rounded-[26px] border border-border bg-background shadow-[0_2px_10px_rgba(0,0,0,0.05)] focus-within:border-foreground/25">
      {files.length > 0 && (
        <ul aria-label="待发送的文件" className="flex flex-wrap gap-2 px-5 pt-3">
          {files.map(({ key, file }) => (
            <li key={key} className="flex max-w-full items-center gap-2 rounded-full bg-muted py-1 pr-1 pl-3 text-[13.5px]">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 truncate">{file.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
              <button
                type="button"
                aria-label={`去掉 ${file.name}`}
                disabled={busy}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
                onClick={() => staging.remove(key)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice !== null && (
        <p role="alert" className="px-5 pt-2.5 text-[13px] text-danger">
          {notice}
        </p>
      )}
      <textarea
        ref={ref}
        rows={1}
        aria-label="输入消息"
        placeholder={placeholder}
        readOnly={busy}
        disabled={disabled}
        className="block min-h-9 w-full resize-none bg-transparent px-5 pt-3 pb-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          // 粘贴截图或复制来的文件：加进待发列表；纯文字照常粘进去
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length === 0) return;
          e.preventDefault();
          staging.add(pasted);
        }}
        onKeyDown={(e) => {
          // 输入法选字时的 Enter 是确认，不是发送（keyCode 229 是部分浏览器在选字时的值）
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          submit();
        }}
      />
      <div className="flex items-center gap-1 px-2 pt-1 pb-2">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="选择文件"
          onChange={(e) => {
            staging.add(Array.from(e.target.files ?? []));
            e.target.value = ""; // 清掉，同一个文件还能再选
          }}
        />
        <Button variant="ghost" size="icon" aria-label="添加文件" disabled={busy || disabled} onClick={() => picker.current?.click()}>
          <Paperclip className="size-5" aria-hidden="true" />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {tooLong && <span className="text-[13px] text-danger">消息太长</span>}
          {stop?.failed && showStop && <span className="text-[13.5px] text-danger">停止失败</span>}
          {showStop ? (
            <StopButton stop={stop} />
          ) : (
            <Button size="icon" aria-label="发送" disabled={!canSend} onClick={submit}>
              <ArrowUp className="size-5" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}