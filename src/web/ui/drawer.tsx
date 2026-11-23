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
      <DrawerPrimitive.Overlay data-slot="drawer-overlay" className="fixed inset-0 z-50 bg-[rgb(28_25_23_/_0.34)]" />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        aria-describedby={undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col border-t-2 border-border-strong bg-background pb-[var(--safe-bottom)] outline-none",
          className,
        )}
        {...props}
      >
        <div aria-hidden="true" className="mx-auto my-2 h-1 w-9 shrink-0 bg-border-strong" />
        {children}
      </DrawerPrimitive.Content>
    </>
  );
  return <DrawerPrimitive.Portal>{accent === null ? content : <AccentScope color={accent}>{content}</AccentScope>}</DrawerPrimitive.Portal>;
}
