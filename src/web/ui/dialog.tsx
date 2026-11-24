import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "./icons.ts";
import type * as React from "react";
import { AccentScope, useAccentColor } from "../lib/accent-scope.tsx";
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
  page = false,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "title"> & {
  title: string;
  titleClassName?: string;
  fullScreen?: boolean;
  /** Covers the workspace beside the rail as a page of the workbench: the cream frame with no scrim, outline, or shadow.
   * The page draws its own close button in its header. */
  page?: boolean;
}) {
  const accent = useAccentColor();
  const content = (
    <>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn("fixed inset-0 z-50", page ? "bg-transparent" : "bg-[rgb(28_25_23_/_0.3)]")} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-fullscreen={fullScreen || undefined}
        data-page={page || undefined}
        aria-describedby={undefined}
        className={cn(
          fullScreen
            ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-panel pt-[var(--safe-top)] pb-[max(var(--safe-bottom),var(--kb-inset))] outline-none"
            : page
              ? "shell-frame fixed inset-y-0 right-0 left-18 z-50 flex flex-col overflow-hidden pt-[var(--safe-top)] pb-[var(--safe-bottom)] outline-none"
              : "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-48px)] w-[calc(100%-48px)] max-w-130 -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-hidden rounded-sm border border-border bg-background p-6 shadow-[var(--shadow-dialog)] outline-none",
          className,
        )}
        {...props}
      >
        {page ? (
          <>
            <DialogPrimitive.Title className={cn("sr-only", titleClassName)}>{title}</DialogPrimitive.Title>
            {children}
          </>
        ) : fullScreen ? (
          <>
            <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4">
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
    </>
  );
  return <DialogPrimitive.Portal>{accent === null ? content : <AccentScope color={accent}>{content}</AccentScope>}</DialogPrimitive.Portal>;
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
