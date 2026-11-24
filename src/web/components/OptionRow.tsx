import type * as React from "react";
import { cn } from "../lib/utils.ts";

/** A choice button: raised until chosen, then an open tile; the keycap and the Recommended chip stay flat because they are labels. */
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
        "flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-sm px-3 py-2.5 text-left text-body leading-6 outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1 disabled:cursor-default",
        chosen ? "tile-open" : "btn-raised disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-xs bg-panel text-xs font-semibold text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
        {String.fromCharCode(65 + index)}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 [overflow-wrap:anywhere] [&_p]:m-0">{children}</span>
        {recommended && <span className="tool-badge shrink-0 px-1.5 text-xs leading-5 font-medium">Recommended</span>}
      </span>
    </button>
  );
}
