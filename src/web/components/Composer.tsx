import { useLayoutEffect, useRef } from "react";
import { MAX_MESSAGE_BYTES } from "../../shared/index.ts";
import { byteLength } from "../format.ts";

const MAX_HEIGHT_PX = 180;

export function Composer({
  value,
  onChange,
  onSend,
}: {
  value: string;
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
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        aria-label="输入消息"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 输入法选字时的 Enter 是确认，不是发送（keyCode 229 是部分浏览器在选字时的值）
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          submit();
        }}
      />
      {tooLong && <span className="composer-error">消息太长</span>}
      <button type="button" className="send-button" disabled={!canSend} onClick={submit}>
        发送
      </button>
    </div>
  );
}
