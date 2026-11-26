import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "./icons.ts";
import { useRef } from "react";
import type * as React from "react";
import { AccentScope, useAccentColor } from "../lib/accent-scope.tsx";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

export const Dialog = DialogPrimitive.Root;

export const ZOOM_DIALOG = "h-auto max-h-[90dvh] w-fit max-w-[min(96vw,1400px)] min-w-[min(96vw,26rem)]";
export const DialogClose = DialogPrimitive.Close;

type PointerDownOutside = NonNullable<React.ComponentProps<typeof DialogPrimitive.Content>["onPointerDownOutside"]>;

// A press on blank window chrome drags or zooms the native window, so it never dismisses a page; a control in the chrome
// (such as the top-bar Router input) still does, and keeps the focus the press gave it.
const keepWindowChrome: PointerDownOutside = (event) => {
  const target = event.detail.originalEvent.target;
  if (target instanceof Element && target.closest("[data-window-drag]") && !target.closest("[data-no-drag]")) event.preventDefault();
};

function chromeControlOf(target: EventTarget | null): HTMLElement | null {
  const control = target instanceof Element ? target.closest<HTMLElement>("[data-window-drag] [data-no-drag]") : null;
  if (control === null || control.matches("input, textarea, button")) return control;
  return control.querySelector<HTMLElement>("input, textarea, button");
}

export function DialogContent({
  className,
  children,
  title,
  titleClassName,
  fullScreen = false,
  page = false,
  onPointerDownOutside,
  onCloseAutoFocus,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "title"> & {
  title: string;
  titleClassName?: string;
  fullScreen?: boolean;
  /** Covers the workspace beside the rail and below the top bar as a page of the workbench: the frame wood with no scrim,
   * outline, or shadow. The page draws its own close button in its header, and the top bar keeps dragging the window. */
  page?: boolean;
}) {
  const accent = useAccentColor();
  const pressedChrome = useRef<HTMLElement | null>(null);
  const content = (
    <>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className={cn("fixed z-50", page ? "inset-x-0 top-[var(--topbar-height)] bottom-0 bg-transparent" : "inset-0 bg-[rgb(28_25_23_/_0.3)]")}
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-fullscreen={fullScreen || undefined}
        data-page={page || undefined}
        aria-describedby={undefined}
        onPointerDownOutside={
          page
            ? (event) => {
                onPointerDownOutside?.(event);
                keepWindowChrome(event);
                pressedChrome.current = event.defaultPrevented ? null : chromeControlOf(event.detail.originalEvent.target);
              }
            : onPointerDownOutside
        }
        onCloseAutoFocus={
          page
            ? (event) => {
                onCloseAutoFocus?.(event);
                const control = pressedChrome.current;
                pressedChrome.current = null;
                if (control === null || event.defaultPrevented) return;
                event.preventDefault();
                control.focus();
              }
            : onCloseAutoFocus
        }
        className={cn(
          fullScreen
            ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-panel pt-[var(--safe-top)] pb-[max(var(--safe-bottom),var(--kb-inset))] outline-none"
            : page
              ? "wood shell-frame fixed top-[var(--topbar-height)] right-0 bottom-0 left-18 z-50 flex flex-col overflow-hidden outline-none"
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
              className="touch-target absolute top-4 right-4 flex size-8 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]"
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
