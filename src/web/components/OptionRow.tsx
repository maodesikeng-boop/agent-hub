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
        "flex min-h-11 w-full cursor-pointer items-start gap-3 border-2 px-3 py-2.5 text-left text-body leading-6 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:cursor-default",
        chosen ? "border-open-line bg-open" : "border-border-strong bg-background hover:bg-hover disabled:opacity-60 disabled:hover:bg-background",
        className,
      )}
      {...props}
    >
      <span className="flex size-6 shrink-0 items-center justify-center border-2 border-border-strong bg-panel text-xs font-medium text-foreground">
        {String.fromCharCode(65 + index)}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
        <span className="min-w-0 [overflow-wrap:anywhere] [&_p]:m-0">{children}</span>
        {recommended && <span className="tool-badge shrink-0 px-1.5 py-0.5 text-xs font-medium">Recommended</span>}
      </span>
    </button>
  );
}
