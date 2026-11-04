import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

// 弹窗（docs/ui-standard.md 第 10 条）：rounded-2xl、p-6、内容之间 gap-6；标题 17px 半粗在左上，关闭按钮右上；
// 底部按钮放 DialogFooter（靠右，主按钮在最右）。宽度两档：简单设置 max-w-[440px]，表单默认 520px。
export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "title"> & { title: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/30" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        aria-describedby={undefined}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-48px)] w-[calc(100%-48px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-y-auto rounded-2xl border border-border bg-background p-6 outline-none",
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="text-[17px] font-semibold">{title}</DialogPrimitive.Title>
        {children}
        <DialogPrimitive.Close
          aria-label="关闭"
          className="absolute top-4 right-4 flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** 弹窗底部的按钮：靠右，按钮之间 gap-2，主按钮放最后。 */
export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex items-center justify-end gap-2", className)} {...props} />;
}
