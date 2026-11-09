import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// 浮层（docs/ui-standard.md 第 11 条）：rounded-2xl、p-4、宽 280px，离窗口边至少 12px。
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({ className, sideOffset = 8, collisionPadding = 12, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("z-50 w-70 rounded-2xl border border-border bg-background p-4 outline-none", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
