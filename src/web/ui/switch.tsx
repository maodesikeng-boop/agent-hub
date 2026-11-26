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
        "touch-target relative inline-flex h-5.5 w-10 shrink-0 cursor-pointer items-center rounded-sm border px-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-black/20 bg-brand-ink" : "border-border-strong bg-hover",
        className,
      )}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("pointer-events-none block size-4 rounded-xs bg-background shadow-[0_1px_2px_rgb(28_25_23_/_0.24)] transition-transform duration-150 ease-out motion-reduce:transition-none", checked ? "translate-x-4.5" : "translate-x-0")}
      />
    </button>
  );
}
