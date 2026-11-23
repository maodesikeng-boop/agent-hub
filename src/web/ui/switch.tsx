import type * as React from "react";
import { cn } from "../lib/utils.ts";

export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "onClick" | "role"> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      className={cn(
        "touch-target relative inline-flex h-5.5 w-10 shrink-0 cursor-pointer items-center border-2 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-black/25 bg-primary" : "border-border-strong bg-hover",
        className,
      )}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("pointer-events-none block size-3.5 border border-black/15 bg-background transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")}
      />
    </button>
  );
}
