import type * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { useAccentContainer } from "../lib/accent-scope.tsx";
import { cn } from "../lib/utils.ts";

export const Drawer = DrawerPrimitive.Root;
export const DrawerClose = DrawerPrimitive.Close;
export const DrawerTitle = DrawerPrimitive.Title;

export function DrawerContent({ className, children, ...props }: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  const container = useAccentContainer();
  return (
    <DrawerPrimitive.Portal container={container}>
      <DrawerPrimitive.Overlay data-slot="drawer-overlay" className="fixed inset-0 z-50 bg-black/30" />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        aria-describedby={undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-line bg-surface-chat pb-[var(--safe-bottom)] outline-none",
          className,
        )}
        {...props}
      >
        <div aria-hidden="true" className="mx-auto my-2 h-1 w-9 shrink-0 rounded-full bg-border" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPrimitive.Portal>
  );
}
