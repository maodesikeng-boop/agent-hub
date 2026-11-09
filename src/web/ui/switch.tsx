import type * as React from "react";
import { cn } from "../lib/utils.ts";

/** 开关：按钮加 role="switch"，精致尺寸 h-5 w-9（滑块 size-4），触屏热区撑到 44px（touch-target）。 */
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
        "touch-target relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-zinc-300",
        className,
      )}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")}
      />
    </button>
  );
}
