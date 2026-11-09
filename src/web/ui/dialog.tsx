import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { useAccentContainer } from "../lib/accent-scope.tsx";
import { cn } from "../lib/utils.ts";

// 弹窗（docs/ui-standard.md 第 10 条）：rounded-2xl、p-6、内容之间 gap-6；标题 17px 半粗在左上，关闭按钮右上；
// 底部按钮放 DialogFooter（靠右，主按钮在最右）。宽度三档：简单设置 max-w-110，表单默认 520px，双栏的全局设置 780px（SettingsDialog）。
// 弹窗自己不滚：内容可能超过一屏的放进 DialogBody（只有它滚），标题和 DialogFooter 一直在视野里。
export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  titleClassName,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "title"> & {
  title: string;
  /** 标题另放（设置弹窗的标题是右栏里当前分类的名字）时传 "sr-only"：读屏仍用它当弹窗名字。 */
  titleClassName?: string;
}) {
  const container = useAccentContainer();
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/30" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        aria-describedby={undefined}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-48px)] w-[calc(100%-48px)] max-w-130 -translate-x-1/2 -translate-y-1/2 flex-col gap-6 overflow-hidden rounded-2xl border border-border bg-background p-6 outline-none",
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className={cn("shrink-0 text-title font-semibold", titleClassName)}>{title}</DialogPrimitive.Title>
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute top-4 right-4 flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** 弹窗中间能滚的部分：各块之间 gap-6。左右、上下多留出一点再收回来，聚焦的圈不会被裁掉。 */
export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("-mx-6 -my-1 grid min-h-0 flex-1 content-start gap-6 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 py-1", className)}
      {...props}
    />
  );
}

/** 表单弹窗的 form：里面放 DialogBody（滚）、错误、DialogFooter（不滚）。 */
export function DialogForm({ className, ...props }: React.ComponentProps<"form">) {
  return <form className={cn("flex min-h-0 flex-1 flex-col gap-6", className)} {...props} />;
}

/** 弹窗底部的按钮：靠右，按钮之间 gap-2，主按钮放最后。 */
export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex shrink-0 items-center justify-end gap-2", className)} {...props} />;
}
