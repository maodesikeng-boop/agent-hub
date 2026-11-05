import { formatQuotaReset } from "../format.ts";
import type { QuotaVendor, QuotaWindowUsage } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

function WindowRow({ window, exhausted }: { window: QuotaWindowUsage; exhausted: boolean }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[15px]">
        <span>{window.label}</span>
        <span className={cn("tabular-nums", exhausted ? "text-danger" : window.warning && "text-warn-foreground")}>{window.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.label}额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", exhausted ? "bg-danger" : window.warning ? "bg-warn-foreground" : "bg-foreground/60")}
          style={{ width: `${window.percent}%` }}
        />
      </div>
      {window.resetsAt !== null && <span className="text-[13.5px] text-muted-foreground tabular-nums">{formatQuotaReset(window.resetsAt)} 重置</span>}
    </div>
  );
}

/** 16px 的小圆环：已用的部分画成弧，颜色跟着文字走（currentColor）。 */
function Ring({ percent }: { percent: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
      {percent > 0 && <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray={`${(c * percent) / 100} ${c}`} />}
    </svg>
  );
}

/**
 * 左下角的额度按钮（docs/ui-standard.md 第 15 条）：ghost 按钮，小圆环 + 第一个厂商的第一个窗口的简写和已用百分比（“5h 37%”），
 * 用完写“额度用完”；快用完、用完换颜色。点开按厂商分组看每个窗口。没有数据不显示。
 */
export function QuotaPopover({ quota }: { quota: QuotaVendor[] }) {
  const head = quota[0];
  const window = head?.windows[0];
  if (!head || !window) return null;
  const exhausted = quota.some((vendor) => vendor.exhausted);
  const warning = quota.some((vendor) => vendor.windows[0]?.warning);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={exhausted ? "额度已用完" : `${window.label}额度已用 ${window.percent}%`}
          className={cn("shrink-0 gap-1.5 px-2.5 tabular-nums", exhausted ? "text-danger hover:text-danger" : warning && "text-warn-foreground hover:text-warn-foreground")}
        >
          <Ring percent={exhausted ? 100 : window.percent} />
          {exhausted ? "额度用完" : `${window.short} ${window.percent}%`}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="额度">
        <div className="grid gap-5">
          {quota.map((vendor) => (
            <section key={vendor.id} className="grid gap-4" aria-label={vendor.name}>
              <h3 className="text-[13.5px] font-medium text-muted-foreground">{vendor.name}</h3>
              {vendor.windows.map((w) => (
                <WindowRow key={w.key} window={w} exhausted={vendor.exhausted} />
              ))}
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
