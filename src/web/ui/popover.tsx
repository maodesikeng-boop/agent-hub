import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

export const Popover = PopoverPrimitive.Root;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({ className, sideOffset = 8, collisionPadding = 12, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("z-50 w-max min-w-70 max-w-[min(22.5rem,var(--radix-popover-content-available-width))] max-h-(--radix-popover-content-available-height) overflow-y-auto overscroll-contain rounded-sm border border-border bg-background p-4 shadow-[var(--shadow-overlay)] outline-none", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
