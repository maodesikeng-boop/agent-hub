import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

const FIELD =
  "w-full rounded-xl border border-border bg-background px-3.5 text-[15px] outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(FIELD, "min-h-24 resize-y py-2.5 leading-relaxed", className)} {...props} />;
}

/** 下拉：用浏览器自带的 select（键盘、读屏、手机上都是原生的），只换外观。 */
export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="select" className={cn(FIELD, "h-10 cursor-pointer", className)} {...props} />;
}

/** 设置行右边的小号下拉（原生 select，换了外观）。 */
export function CompactSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <span className="relative inline-flex min-w-0">
      <select
        data-slot="select"
        className={cn(
          "h-8 max-w-[260px] min-w-0 cursor-pointer appearance-none truncate rounded-lg border border-border bg-background pr-8 pl-3 text-[14px] outline-none transition-colors hover:border-zinc-300 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-default disabled:opacity-50",
          className,
        )}
        {...props}
      />
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}

/** 设置行右边的小号输入框。 */
export function CompactInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD, "h-8 rounded-lg px-3 text-[14px]", className)} {...props} />;
}
