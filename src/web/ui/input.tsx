import { ChevronDown, ChevronsUpDown } from "./icons.ts";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

const FIELD =
  "w-full rounded-xl border border-border bg-background px-3 text-body outline-none transition-colors placeholder:text-muted-foreground aria-invalid:border-danger disabled:cursor-default disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD, "h-9 pointer-coarse:h-11", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(FIELD, "min-h-24 resize-y py-2 leading-relaxed", className)} {...props} />;
}

export function Select({ className, variant = "field", ...props }: React.ComponentProps<"select"> & { variant?: "field" | "plain" }) {
  const Icon = variant === "plain" ? ChevronsUpDown : ChevronDown;
  return (
    <span className={cn("relative inline-flex min-w-0", variant === "plain" && "-mr-3")}>
      <select
        data-slot="select"
        className={cn(
          variant === "plain"
            ? "field-sizing-content rounded-xl bg-transparent pr-8 pl-3 text-body outline-none transition-colors hover:bg-sidebar-hover focus-visible:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
            : cn(FIELD, "pr-8"),
          "h-9 w-auto max-w-65 min-w-0 cursor-pointer appearance-none truncate pointer-coarse:h-11",
          className,
        )}
        {...props}
      />
      <Icon
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", variant === "plain" ? "right-3 size-3.5" : "right-2.5 size-4")}
        aria-hidden="true"
      />
    </span>
  );
}
