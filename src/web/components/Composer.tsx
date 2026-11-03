import { ArrowUp } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { MAX_MESSAGE_BYTES } from "../../shared/index.ts";
import { byteLength } from "../format.ts";
import { Button } from "../ui/button.tsx";

const MAX_HEIGHT_PX = 180;

export function Composer({
  value,
  placeholder,
  onChange,
  onSend,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const tooLong = byteLength(value) > MAX_MESSAGE_BYTES;
  const canSend = value.trim() !== "" && !tooLong;

  // 输入框跟着内容长高，到上限后出滚动条
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
  };

  return (
    <div className="flex items-end gap-2 rounded-[26px] border border-border bg-background py-2 pr-2 pl-5 shadow-[0_2px_10px_rgba(0,0,0,0.05)] focus-within:border-primary/40">
      <textarea
        ref={ref}
        rows={1}
        aria-label="输入消息"
        placeholder={placeholder}
        className="min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 输入法选字时的 Enter 是确认，不是发送（keyCode 229 是部分浏览器在选字时的值）
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          submit();
        }}
      />
      {tooLong && <span className="self-center text-[13px] text-danger">消息太长</span>}
      <Button size="icon" aria-label="发送" disabled={!canSend} onClick={submit}>
        <ArrowUp className="size-5" aria-hidden="true" />
      </Button>
    </div>
  );
}
