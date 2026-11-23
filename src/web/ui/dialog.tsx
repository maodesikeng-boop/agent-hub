import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "./icons.ts";
import type * as React from "react";
import { useAccentContainer } from "../lib/accent-scope.tsx";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

export const Dialog = DialogPrimitive.Root;

export const ZOOM_DIALOG = "h-auto max-h-[90dvh] w-fit max-w-[min(96vw,1400px)] min-w-[min(96vw,26rem)]";
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  titleClassName,
  fullScreen = false,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "title"> & {
  title: string;
  titleClassName?: string;
  fullScreen?: boolean;
}) {
  const container = useAccentContainer();
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-[rgb(28_25_23_/_0.34)]" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        aria-describedby={undefined}
        className={cn(
          fullScreen
            ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-panel pt-[var(--safe-top)] pb-[max(var(--safe-bottom),var(--kb-inset))] outline-none"
            : "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-48px)] w-[calc(100%-48px)] max-w-130 -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-hidden border-2 border-border-strong bg-background p-6 outline-none",
          className,
        )}
        {...props}
      >
        {fullScreen ? (
          <>
            <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b-2 border-border bg-background px-4">
              <DialogPrimitive.Title className={cn("min-w-0 truncate text-title font-semibold", titleClassName)}>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label="Close">
                  <X aria-hidden="true" />
                </Button>
              </DialogPrimitive.Close>
            </header>
            {children}
          </>
        ) : (
          <>
            <DialogPrimitive.Title className={cn("shrink-0 text-title font-semibold", titleClassName)}>{title}</DialogPrimitive.Title>
            {children}
            <DialogPrimitive.Close
              aria-label="Close"
              className="touch-target absolute top-4 right-4 flex size-8 cursor-pointer items-center justify-center text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]"
            >
              <X className="size-pixel" aria-hidden="true" />
            </DialogPrimitive.Close>
          </>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      // Extend 16px into the footer gap so scrolled content fades out instead of being cut off.
      className={cn("dialog-body-fade -mx-6 -mt-1 -mb-4 grid min-h-0 flex-1 content-start gap-6 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 pt-1 pb-4", className)}
      {...props}
    />
  );
}

export function DialogForm({ className, ...props }: React.ComponentProps<"form">) {
  return <form className={cn("flex min-h-0 flex-1 flex-col gap-6", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex shrink-0 items-center justify-end gap-2", className)} {...props} />;
}
