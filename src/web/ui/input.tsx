import type * as React from "react";
import { cn } from "../lib/utils.ts";

const FIELD =
  "w-full rounded-sm border border-border-strong bg-background px-3 text-body text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:field-focus aria-invalid:border-danger disabled:cursor-default disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD, "h-9 pointer-coarse:h-11", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(FIELD, "min-h-24 resize-y py-2 leading-relaxed", className)} {...props} />;
}
