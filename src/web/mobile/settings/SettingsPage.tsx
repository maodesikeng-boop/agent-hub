import { ArrowLeft, ChevronLeft } from "../../ui/icons.ts";
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
  home?: boolean;
  onBack?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-background pt-[var(--safe-top)]">
      <header
        className={cn(
          "h-14 shrink-0 items-center gap-1 border-b border-border px-4",
          home ? "flex" : "grid grid-cols-[1fr_minmax(0,auto)_1fr] px-2",
        )}
      >
        {home ? (
          <>
            {onBack !== undefined && (
              <Button variant="slot" size="icon" className="mr-1 shrink-0" aria-label="Back" onClick={onBack}>
                <ArrowLeft aria-hidden="true" />
              </Button>
            )}
            <h1 className="min-w-0 truncate text-title font-semibold">{title}</h1>
          </>
        ) : (
          <>
            <div className="justify-self-start">
              <BackToSettings onClick={onBack ?? (() => {})} />
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
        <div className="info-list grid grid-cols-1">{children}</div>
      </main>
      {footer && <div className="grid shrink-0 grid-cols-1 gap-2 border-t border-border px-4 pt-3 pb-[calc(var(--bottom-inset)+0.75rem)]">{footer}</div>}
    </div>
  );
}

function BackToSettings({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" className="shrink-0 gap-0.5 px-1.5 text-body font-normal" onClick={onClick}>
      <ChevronLeft className="size-pixel-sm" aria-hidden="true" />
      Settings
    </Button>
  );
}
