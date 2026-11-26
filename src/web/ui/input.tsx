import type * as React from "react";
import { cn } from "../lib/utils.ts";

const FIELD =
  "w-full rounded-sm border border-border-strong bg-background px-3 text-body text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:field-focus aria-invalid:border-danger disabled:cursor-default disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD, "h-9 pointer-coarse:h-11", className)} {...props} />;
}

const BARE_FIELD =
  "info-field resize-none bg-transparent text-minor text-foreground field-sizing-content placeholder:font-sans placeholder:text-minor placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-50";

/** variant "bare": a borderless editor that lines up with Info rows and shows the row focus outline. */
export function Textarea({ className, variant = "field", ...props }: React.ComponentProps<"textarea"> & { variant?: "field" | "bare" }) {
  const base = variant === "bare" ? BARE_FIELD : cn(FIELD, "min-h-24 resize-y py-2 leading-relaxed");
  return <textarea data-slot="textarea" className={cn(base, className)} {...props} />;
}
