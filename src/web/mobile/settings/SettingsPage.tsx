// 手机设置的整屏骨架（docs/mobile-settings-design.md 第 2.1、2.3 节，docs/ui-standard.md 第 20 条）：
// 画布 bg-surface-sidebar，顶上垫刘海安全区；h-16 顶栏（一级：ghost ArrowLeft + 左对齐标题；二级：ghost “‹ Settings” + 居中标题）；
// 内容区 px-4、组间距 gap-6，自己纵向滚动，底部垫横条与软键盘（--bottom-inset）；可选一条固定在底部的主操作栏。
import { ArrowLeft, ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { Button } from "../../ui/button.tsx";

export function SettingsPage({
  title,
  home = false,
  onBack,
  footer,
  children,
}: {
  title: string;
  /** 一级主页：左上纯箭头回列表；子页：左上 “‹ Settings” 回一级主页。 */
  home?: boolean;
  onBack: () => void;
  /** 固定在底部的主操作（跨厂商同步的 Sync），不随内容滚走。 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-surface-sidebar pt-[var(--safe-top)]">
      <header
        className={cn(
          "h-16 shrink-0 items-center gap-1 px-2",
          home ? "flex" : "grid grid-cols-[1fr_minmax(0,auto)_1fr]",
        )}
      >
        {home ? (
          <>
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="Back" onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
            </Button>
            <h1 className="min-w-0 truncate text-title font-semibold">{title}</h1>
          </>
        ) : (
          <>
            {/* 三列网格 1fr / auto / 1fr：短标题在整屏正中，特大字号下长标题（Signed-in browsers）自动向右侧空白延展不提前截断 */}
            <div className="justify-self-start">
              <BackToSettings onClick={onBack} />
            </div>
            <h1 className="min-w-0 truncate text-center text-title font-semibold">{title}</h1>
            <div aria-hidden="true" />
          </>
        )}
      </header>
      <main
        className={cn(
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 pt-2",
          footer ? "pb-6" : "pb-[calc(var(--bottom-inset)+2rem)]",
        )}
      >
        <div className="grid grid-cols-1 gap-6">{children}</div>
      </main>
      {footer && <div className="grid shrink-0 grid-cols-1 gap-2 border-t border-border px-4 pt-3 pb-[calc(var(--bottom-inset)+0.75rem)]">{footer}</div>}
    </div>
  );
}

function BackToSettings({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" className="shrink-0 gap-0.5 px-1.5 text-body font-normal" onClick={onClick}>
      <ChevronLeft className="size-5" aria-hidden="true" />
      Settings
    </Button>
  );
}
