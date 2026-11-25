import type * as React from "react";
import { cn } from "../lib/utils.ts";
import { Check } from "../ui/icons.ts";

/** One full-bleed row of a decision card's option list. Rows part by hairlines, the letter is plain text, and Recommended is
 * a flat chip, so nothing inside the card draws a frame; the chosen row takes the open tone and a check. */
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
      data-chosen={chosen || undefined}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-baseline gap-3 rounded-none px-4 py-2.5 text-left text-body leading-6 transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:cursor-default motion-reduce:transition-none",
        chosen ? "bg-open" : "hover:bg-hover active:bg-hover disabled:opacity-60 disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    >
      <span className={cn("w-4 shrink-0 text-minor font-semibold", chosen ? "text-foreground" : "text-muted-foreground")}>{String.fromCharCode(65 + index)}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 [overflow-wrap:anywhere] [&_p]:m-0">{children}</span>
        {recommended && <span className="tool-badge shrink-0 px-1.5 text-xs leading-5 font-medium">Recommended</span>}
      </span>
      {chosen && <Check className="size-pixel-sm shrink-0 self-center text-foreground" aria-hidden="true" />}
    </button>
  );
}

/** The option list's frame: bleeds to the card's padded edges and draws the hairlines above and between rows. */
export const OPTION_LIST = "-mx-4 mt-3 divide-y divide-border border-t border-border";
