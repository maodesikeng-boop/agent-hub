// 输入框、多行输入、下拉（docs/ui-standard.md 第 6、7 条）：高 36px（h-9）、rounded-xl、15px 字、白底细边框；
// 聚焦只把边框加深（border-foreground/25，和聊天输入框一样），不用主色、不加光圈；不合规（aria-invalid）是红边框。
import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

const FIELD =
  "w-full rounded-xl border border-border bg-background px-3 text-[15px] outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-foreground/25 aria-invalid:border-danger disabled:cursor-default disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(FIELD, "min-h-24 resize-y py-2 leading-relaxed", className)} {...props} />;
}

/** 下拉：用浏览器自带的 select（键盘、读屏、手机上都是原生的），只换外观：宽度跟着内容，右边一个箭头。 */
export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <span className="relative inline-flex min-w-0">
      <select
        data-slot="select"
        className={cn(FIELD, "h-9 w-auto max-w-[260px] min-w-0 cursor-pointer appearance-none truncate pr-8", className)}
        {...props}
      />
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}
