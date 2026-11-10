import type * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { useAccentContainer } from "../lib/accent-scope.tsx";
import { cn } from "../lib/utils.ts";

// 底部抽屉（docs/ui-standard.md 第 10 条“抽屉”）：手机外壳里的 Pieces 用它（docs/mobile-ui-design.md 第 3 节）。
// 底层是 vaul（shadcn Radix 版 Drawer 的底层）。它已停更，所以只在这一个文件里 import；以后换 Base UI 的 Drawer 只改这里，调用方不动。
// 只留 bottom 方向。进出动画是 vaul 自带的（仓库没装 tw-animate-css），这里不加动画类名。
export const Drawer = DrawerPrimitive.Root;
export const DrawerClose = DrawerPrimitive.Close;
export const DrawerTitle = DrawerPrimitive.Title;

/**
 * 抽屉内容：遮罩 bg-black/30（和 DialogContent 一样），rounded-t-2xl、border-t border-line、bg-surface-chat，
 * 最高 85dvh，底部垫安全区；顶上 36×4 的拖动条纯装饰。内容里要放一个 DrawerTitle（读屏用，界面不要标题时给 className="sr-only"）。
 */
export function DrawerContent({ className, children, ...props }: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  // 渲染进会话容器：bg-surface-chat、border-line 的颜色靠外壳上的 --fruit，渲染到 body 上就取不到
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
