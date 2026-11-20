import type * as React from "react";
import { cn } from "../lib/utils.ts";

export function OptionRow({
  index,
  recommended = false,
  chosen = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"button">, "type"> & {
  index: number;
  recommended?: boolean;
  chosen?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-body leading-6 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
        chosen ? "border-transparent bg-sidebar-active" : "border-border bg-background hover:bg-sidebar-hover disabled:opacity-60 disabled:hover:bg-background",
        className,
      )}
      {...props}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-xl border border-border bg-sidebar text-xs font-medium text-muted-foreground">
        {String.fromCharCode(65 + index)}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
        <span className="min-w-0 [overflow-wrap:anywhere] [&_p]:m-0">{children}</span>
        {recommended && <span className="shrink-0 text-xs text-muted-foreground">Recommended</span>}
      </span>
    </button>
  );
}
