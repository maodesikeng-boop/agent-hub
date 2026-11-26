import type * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { AccentScope, useAccentColor } from "../lib/accent-scope.tsx";
import { cn } from "../lib/utils.ts";

export const Drawer = DrawerPrimitive.Root;
export const DrawerTrigger = DrawerPrimitive.Trigger;
export const DrawerClose = DrawerPrimitive.Close;
export const DrawerTitle = DrawerPrimitive.Title;

export function DrawerContent({ className, children, ...props }: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  const accent = useAccentColor();
  const content = (
    <>
      <DrawerPrimitive.Overlay data-slot="drawer-overlay" className="fixed inset-0 z-50 bg-[rgb(28_25_23_/_0.3)]" />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        aria-describedby={undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-sm border-t border-border bg-background pb-[var(--safe-bottom)] shadow-[0_-8px_32px_-8px_rgb(28_25_23_/_0.24)] outline-none",
          className,
        )}
        {...props}
      >
        <div aria-hidden="true" className="mx-auto my-2 h-1 w-9 shrink-0 rounded-full bg-border-strong" />
        {children}
      </DrawerPrimitive.Content>
    </>
  );
  return <DrawerPrimitive.Portal>{accent === null ? content : <AccentScope color={accent}>{content}</AccentScope>}</DrawerPrimitive.Portal>;
}
