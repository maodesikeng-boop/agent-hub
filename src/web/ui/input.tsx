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
